/**
 * Agent A/B Update(#35、docs/core/agent-update-design.md)。
 *
 * - AgentはAGENT_STATUSでversion / slot / 直前のSupervisor理由を報告する
 * - desired versionと違えばUPDATE_AVAILABLEを返す(downloadと検証はRouter側のSupervisor)
 * - rollback / recoveryの理由はdevice_eventsへ残す
 *
 * Server側はRelease artifactの配布(`GET /v1/agent/releases/{version}[/manifest]`)と
 * desired versionの管理だけを持ち、更新手順そのものはRouter側に閉じる。
 */
import { randomUUID } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { type AgentStatus, decodeAgentStatus, FrameType } from "@routemon/core";
import type { AgentGateway } from "@routemon/gateway";
import { AuditEventType, type AuditLog } from "../auth/audit.ts";
import type { EventRecorder } from "../events/recorder.ts";
import { type Db, nowIso } from "../storage/db.ts";

export class DeviceNotFoundError extends Error {}
export class ReleaseNotFoundError extends Error {}

export type DeviceAgentState = {
	agentVersion: string | null;
	desiredAgentVersion: string | null;
	agentSlot: string | null;
	/** Agentが報告している、動いているSupervisorのversion(#159) */
	supervisorVersion: string | null;
	desiredSupervisorVersion: string | null;
	lastAgentReason?: string;
	lastAgentReasonType?: "rollback" | "recovery";
};

const BOTH_SLOTS_RECOVERY_REASON = "recovered_both_slots_invalid";
/** Supervisor自身の更新artifactは、`supervisor-<version>.lua`として同じrelease dirへ置く(#159) */
export const SUPERVISOR_RELEASE_PREFIX = "supervisor-";

export class AgentUpdates {
	private readonly db: Db;
	private readonly tenantId: string;
	private readonly gateway: AgentGateway;
	private readonly audit: AuditLog;
	private readonly releaseDir: string;
	private readonly now: () => number;
	private readonly events?: EventRecorder;

	constructor(options: {
		db: Db;
		tenantId: string;
		gateway: AgentGateway;
		audit: AuditLog;
		releaseDir: string;
		/** 指定すると、Eventの記録に抑制(1日の上限など、#158)を適用する */
		events?: EventRecorder;
		now?: () => number;
	}) {
		this.db = options.db;
		this.tenantId = options.tenantId;
		this.gateway = options.gateway;
		this.audit = options.audit;
		this.releaseDir = options.releaseDir;
		this.events = options.events;
		this.now = options.now ?? Date.now;
	}

	/** AGENT_STATUS frameを取り込み、必要なら更新を通知する。 */
	handleStatus(deviceId: string, payload: Uint8Array): AgentStatus {
		const status = decodeAgentStatus(payload);
		const device = this.state(deviceId);
		const at = nowIso(new Date(this.now()));
		this.db
			.prepare(
				"UPDATE devices SET agent_version = ?, agent_slot = ?, updated_at = ? WHERE id = ? AND tenant_id = ?",
			)
			.run(status.version, status.slot ?? null, at, deviceId, this.tenantId);
		if (status.supervisorVersion) {
			this.db
				.prepare(
					"UPDATE devices SET supervisor_version = ? WHERE id = ? AND tenant_id = ?",
				)
				.run(status.supervisorVersion, deviceId, this.tenantId);
		}
		this.handleSupervisorStatus(deviceId, device, status);

		const reasonType = isRecoveryReason(status.rollback)
			? "recovery"
			: "rollback";
		if (
			status.rollback &&
			(status.rollback !== device.lastAgentReason ||
				reasonType !== device.lastAgentReasonType)
		) {
			this.recordEvent(
				deviceId,
				reasonType === "recovery" ? "agent.recovered" : "agent.rollback",
				reasonType === "recovery" ? "info" : "warning",
				{
					detail: status.rollback,
					running_version: status.version,
				},
			);
		}

		// rollbackしたversionを再通知しない。同じcandidateを入れ直す無限ループになる
		// (RTX830実機で確認、#35)。もう一度試す場合はAdminが明示的に指定する。
		const previousRollback = isRecoveryReason(status.rollback)
			? undefined
			: (status.rollback ??
				(device.lastAgentReasonType === "rollback"
					? device.lastAgentReason
					: undefined));
		const rolledBack = previousRollback?.split(/\s+/)[0];
		const desired = device.desiredAgentVersion;
		if (desired && desired !== status.version && desired !== rolledBack) {
			this.notify(deviceId, desired);
		}
		return status;
	}

	/** 導入したいversionを設定する。接続中なら即通知する。 */
	setDesiredVersion(deviceId: string, version: string, userId?: string): void {
		const current = this.state(deviceId);
		if (!this.hasRelease(version)) {
			throw new ReleaseNotFoundError(`release not found: ${version}`);
		}
		this.db
			.prepare(
				"UPDATE devices SET desired_agent_version = ?, updated_at = ? WHERE id = ? AND tenant_id = ?",
			)
			.run(version, nowIso(new Date(this.now())), deviceId, this.tenantId);
		this.audit.record({
			type: AuditEventType.DEVICE_AGENT_VERSION_SET,
			actorUserId: userId,
			targetType: "device",
			targetId: deviceId,
			detail: { version, from: current.agentVersion },
		});
		if (version !== current.agentVersion) {
			try {
				this.notify(deviceId, version);
			} catch {
				// 未接続なら次のAGENT_STATUSで通知する
			}
		}
	}

	/**
	 * Supervisorのversionを、desiredへ揃える(#159)。Supervisorを報告するAgent(0.3.0以上)だけが対象。
	 * 直前に戻した(rollbackした)versionは再通知しない(同じ候補を入れ直し続けるループになる)。
	 */
	private handleSupervisorStatus(
		deviceId: string,
		device: DeviceAgentState,
		status: AgentStatus,
	): void {
		const rollback = status.supervisorRollback;
		if (rollback) {
			const last = this.db
				.prepare(
					"SELECT detail_json FROM device_events WHERE device_id = ? AND type = 'supervisor.rollback' ORDER BY occurred_at DESC, rowid DESC LIMIT 1",
				)
				.get(deviceId) as { detail_json: string | null } | undefined;
			const lastDetail = last?.detail_json
				? (JSON.parse(last.detail_json).detail as string)
				: undefined;
			if (rollback !== lastDetail) {
				this.recordEvent(deviceId, "supervisor.rollback", "warning", {
					detail: rollback,
					running_version: status.supervisorVersion,
				});
			}
		}
		const desired = device.desiredSupervisorVersion;
		const rolledBack = rollback?.split(/\s+/)[0];
		if (
			desired &&
			status.supervisorVersion &&
			desired !== status.supervisorVersion &&
			desired !== rolledBack
		) {
			try {
				this.notify(deviceId, `${SUPERVISOR_RELEASE_PREFIX}${desired}`);
			} catch {
				// 未接続なら、次のAGENT_STATUSで通知する
			}
		}
	}

	/** 配布できるSupervisorのversionの一覧(`supervisor-<version>.lua`の`<version>`)。 */
	supervisorReleases(): string[] {
		try {
			return readdirSync(this.releaseDir)
				.filter(
					(name) =>
						name.startsWith(SUPERVISOR_RELEASE_PREFIX) && name.endsWith(".lua"),
				)
				.map((name) => name.slice(SUPERVISOR_RELEASE_PREFIX.length, -4))
				.sort();
		} catch {
			return [];
		}
	}

	/**
	 * 導入したいSupervisorのversionを設定する(#159)。接続中なら、すぐにUPDATE_AVAILABLEへ
	 * `supervisor-<version>`を載せて通知する(未接続なら、次のAGENT_STATUSで通知する)。AgentがSupervisorへ
	 * 渡し、Supervisorが候補として起動し、健全と確認できたら確定する(失敗すれば旧slotへ戻る)。
	 * Adminの明示指定は、直前に戻したversionでも通知する。
	 */
	setDesiredSupervisorVersion(
		deviceId: string,
		version: string,
		userId?: string,
	): void {
		if (
			!/^[\w.+]+$/.test(version) ||
			!existsSync(
				join(this.releaseDir, `${SUPERVISOR_RELEASE_PREFIX}${version}.lua`),
			)
		) {
			throw new ReleaseNotFoundError(
				`supervisor release not found: ${version}`,
			);
		}
		const current = this.state(deviceId);
		this.db
			.prepare(
				"UPDATE devices SET desired_supervisor_version = ?, updated_at = ? WHERE id = ? AND tenant_id = ?",
			)
			.run(version, nowIso(new Date(this.now())), deviceId, this.tenantId);
		this.audit.record({
			type: AuditEventType.DEVICE_SUPERVISOR_UPDATE_REQUESTED,
			actorUserId: userId,
			targetType: "device",
			targetId: deviceId,
			detail: { version, from: current.supervisorVersion },
		});
		if (version !== current.supervisorVersion) {
			try {
				this.notify(deviceId, `${SUPERVISOR_RELEASE_PREFIX}${version}`);
			} catch {
				// 未接続なら、次のAGENT_STATUSで通知する
			}
		}
	}

	state(deviceId: string): DeviceAgentState {
		const row = this.db
			.prepare(
				"SELECT agent_version, desired_agent_version, agent_slot, supervisor_version, desired_supervisor_version FROM devices WHERE id = ? AND tenant_id = ?",
			)
			.get(deviceId, this.tenantId) as
			| {
					agent_version: string | null;
					desired_agent_version: string | null;
					agent_slot: string | null;
					supervisor_version: string | null;
					desired_supervisor_version: string | null;
			  }
			| undefined;
		if (!row) throw new DeviceNotFoundError(`device not found: ${deviceId}`);
		const lastReason = this.db
			.prepare(
				"SELECT type, detail_json FROM device_events WHERE device_id = ? AND type IN ('agent.rollback', 'agent.recovered') ORDER BY occurred_at DESC, rowid DESC LIMIT 1",
			)
			.get(deviceId) as
			| { type: string; detail_json: string | null }
			| undefined;
		const reason = lastReason?.detail_json
			? (JSON.parse(lastReason.detail_json).detail as string)
			: undefined;
		return {
			agentVersion: row.agent_version,
			desiredAgentVersion: row.desired_agent_version,
			agentSlot: row.agent_slot,
			supervisorVersion: row.supervisor_version,
			desiredSupervisorVersion: row.desired_supervisor_version,
			lastAgentReason: reason,
			lastAgentReasonType: reason
				? lastReason?.type === "agent.recovered"
					? "recovery"
					: "rollback"
				: undefined,
		};
	}

	/** 配布できるversionの一覧(release dirのファイル名)。 */
	releases(): string[] {
		return this.listReleaseFiles().sort();
	}

	private notify(deviceId: string, version: string): void {
		this.gateway.sendFrame(
			deviceId,
			FrameType.UPDATE_AVAILABLE,
			0,
			new TextEncoder().encode(version),
		);
	}

	private hasRelease(version: string): boolean {
		// pathを組み立てる前に、versionへpath区切りが入っていないことを確かめる
		if (version === "stable" || !/^[\w.+-]+$/.test(version)) return false;
		// Supervisorのartifactは、Agentのversionとしては選べない(#159)
		if (version.startsWith(SUPERVISOR_RELEASE_PREFIX)) return false;
		return existsSync(join(this.releaseDir, `${version}.lua`));
	}

	private listReleaseFiles(): string[] {
		try {
			return readdirSync(this.releaseDir)
				.filter(
					(name) =>
						name.endsWith(".lua") &&
						name !== "stable.lua" &&
						!name.startsWith(SUPERVISOR_RELEASE_PREFIX),
				)
				.map((name) => name.slice(0, -4));
		} catch {
			return [];
		}
	}

	private recordEvent(
		deviceId: string,
		type: string,
		severity: string,
		detail: Record<string, unknown>,
	): void {
		if (this.events) {
			this.events.record({ deviceId, type, severity, detail });
			return;
		}
		const at = nowIso(new Date(this.now()));
		this.db
			.prepare(
				`INSERT INTO device_events (id, tenant_id, device_id, type, severity, detail_json, occurred_at, created_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				randomUUID(),
				this.tenantId,
				deviceId,
				type,
				severity,
				JSON.stringify(detail),
				at,
				at,
			);
	}
}

function isRecoveryReason(reason: string | undefined): boolean {
	return reason === BOTH_SLOTS_RECOVERY_REASON;
}
