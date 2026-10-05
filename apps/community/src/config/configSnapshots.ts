/**
 * CONFIG Snapshotの取り込みとDevice Profile更新(#6)。
 *
 *   CONFIG_BACKUP frame -> size検証 -> hash / dedupe(暗号化して保存) -> parse -> Device Profile
 *
 * raw CONFIGはsecretを含む前提で扱う。log・error responseへ本文を出さない
 * (docs/core/config-backup-design.md §7)。
 */
import { createHash } from "node:crypto";
import {
	type DeviceProfile,
	decodeConfig,
	decodeSnapshotPayload,
	FrameType,
	parseConfig,
	type SnapshotReason,
	stripVolatileLines,
} from "@routemon/core";
import type { AgentGateway } from "@routemon/gateway";
import { AuditEventType, type AuditLog } from "../auth/audit.ts";
import type {
	ConfigBackupRow,
	ConfigBackups,
} from "../storage/configBackups.ts";
import { type Db, nowIso } from "../storage/db.ts";
import { type ConfigDiff, createConfigDiff } from "./configDiff.ts";

/** RTX830のCONFIGは数十KB。桁違いのものは壊れているとみなして捨てる。 */
export const MAX_CONFIG_BYTES = 1024 * 1024;

export class DeviceNotFoundError extends Error {}
export class ConfigBackupNotFoundError extends Error {}
export class InvalidConfigDiffError extends Error {}

export type ProfileRow = {
	device_id: string;
	profile: string;
	config_hash: string;
	captured_at: string;
	updated_at: string;
};

export type IngestResult = {
	backupId: string;
	/** 前回と同じ内容なら false(世代を増やさず、profileも再計算しない) */
	created: boolean;
	reason: SnapshotReason;
};

export type ConfigBackupSummary = {
	id: string;
	capturedAt: string;
	sizeBytes: number;
	contentHash: string;
};

export type ConfigBackupContent = {
	backup: ConfigBackupSummary;
	content: Uint8Array;
};

export type ConfigDiffResult = ConfigDiff & {
	backup: ConfigBackupSummary;
	against: ConfigBackupSummary | null;
};

export class ConfigSnapshots {
	private readonly db: Db;
	private readonly tenantId: string;
	private readonly backups: ConfigBackups;
	private readonly gateway: AgentGateway;
	private readonly audit: AuditLog;
	private readonly now: () => number;

	constructor(options: {
		db: Db;
		tenantId: string;
		backups: ConfigBackups;
		gateway: AgentGateway;
		audit: AuditLog;
		now?: () => number;
	}) {
		this.db = options.db;
		this.tenantId = options.tenantId;
		this.backups = options.backups;
		this.gateway = options.gateway;
		this.audit = options.audit;
		this.now = options.now ?? Date.now;
	}

	/** AgentからのCONFIG_BACKUP frameを取り込む。 */
	async ingest(deviceId: string, payload: Uint8Array): Promise<IngestResult> {
		const device = this.device(deviceId);
		const snapshot = decodeSnapshotPayload(payload);
		if (
			snapshot.config.length === 0 ||
			snapshot.config.length > MAX_CONFIG_BYTES
		) {
			throw new Error(
				`config snapshot size out of range: ${snapshot.config.length} bytes`,
			);
		}
		const capturedAt = new Date(this.now());
		const result = await this.backups.create({
			tenantId: this.tenantId,
			deviceId,
			config: snapshot.config,
			capturedAt,
			source: snapshot.reason,
			// 取得ごとに変わるheader行を除いて比較する(#6)
			dedupeKey: createHash("sha256")
				.update(stripVolatileLines(snapshot.config))
				.digest("hex"),
			firmwareRevision: device.firmware_revision,
			hostname: device.hostname,
		});
		if (result.created) {
			const profile = parseConfig(snapshot.config, {
				model: device.model ?? undefined,
				firmwareRevision: device.firmware_revision ?? undefined,
			});
			const hash = this.backups.latest(deviceId)?.content_hash ?? "";
			this.saveProfile(deviceId, profile, hash, capturedAt);
			this.audit.record({
				type: AuditEventType.DEVICE_CONFIG_SNAPSHOT,
				targetType: "device",
				targetId: deviceId,
				detail: { reason: snapshot.reason, backup_id: result.id },
			});
		}
		return {
			backupId: result.id,
			created: result.created,
			reason: snapshot.reason,
		};
	}

	/** DeviceへCONFIGの再取得を要求する(応答は次のsyncでingestされる)。 */
	request(deviceId: string, reason: SnapshotReason, userId?: string): void {
		this.device(deviceId);
		this.gateway.sendFrame(
			deviceId,
			FrameType.CONFIG_REQUEST,
			0,
			new TextEncoder().encode(reason),
		);
		this.audit.record({
			type: AuditEventType.DEVICE_CONFIG_REQUESTED,
			actorUserId: userId,
			targetType: "device",
			targetId: deviceId,
			detail: { reason },
		});
	}

	profile(deviceId: string): (DeviceProfile & { capturedAt: string }) | null {
		const row = this.db
			.prepare("SELECT * FROM device_profiles WHERE device_id = ?")
			.get(deviceId) as ProfileRow | undefined;
		if (!row) return null;
		return {
			...(JSON.parse(row.profile) as DeviceProfile),
			capturedAt: row.captured_at,
		};
	}

	/** 世代一覧(本文は返さない)。 */
	list(deviceId: string): ConfigBackupSummary[] {
		this.device(deviceId);
		return this.backups.list(deviceId).map(toSummary);
	}

	/** 指定世代の本文を復号する。復号はConfigBackups.read()へ委譲する。 */
	async read(deviceId: string, backupId: string): Promise<ConfigBackupContent> {
		const row = this.findBackup(deviceId, backupId);
		return {
			backup: toSummary(row),
			content: await this.backups.read(row.id),
		};
	}

	/** 指定世代と、指定がなければその直前の世代を比較する。 */
	async diff(
		deviceId: string,
		backupId: string,
		againstId?: string,
	): Promise<ConfigDiffResult> {
		this.device(deviceId);
		const rows = this.backups.list(deviceId);
		const backup = rows.find((row) => row.id === backupId);
		if (!backup) throw new ConfigBackupNotFoundError();

		let against: ConfigBackupRow | undefined;
		if (againstId !== undefined) {
			if (againstId === backupId) throw new InvalidConfigDiffError();
			against = rows.find((row) => row.id === againstId);
			if (!against) throw new ConfigBackupNotFoundError();
		} else {
			const index = rows.findIndex((row) => row.id === backupId);
			// list()は新しい世代順なので、次の要素が1つ前の世代になる。
			against = rows[index + 1];
		}

		const [afterBytes, beforeBytes] = await Promise.all([
			this.backups.read(backup.id),
			against
				? this.backups.read(against.id)
				: Promise.resolve(new Uint8Array()),
		]);
		const diff = createConfigDiff(
			decodeConfig(beforeBytes),
			decodeConfig(afterBytes),
			{
				before: against ? `backup/${against.id}` : "/dev/null",
				after: `backup/${backup.id}`,
			},
		);
		return {
			...diff,
			backup: toSummary(backup),
			against: against ? toSummary(against) : null,
		};
	}

	private saveProfile(
		deviceId: string,
		profile: DeviceProfile,
		hash: string,
		capturedAt: Date,
	): void {
		const at = nowIso(capturedAt);
		this.db
			.prepare(
				`INSERT INTO device_profiles (device_id, tenant_id, profile, config_hash, captured_at, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?)
				 ON CONFLICT(device_id) DO UPDATE SET
				   profile = excluded.profile, config_hash = excluded.config_hash,
				   captured_at = excluded.captured_at, updated_at = excluded.updated_at`,
			)
			.run(
				deviceId,
				this.tenantId,
				JSON.stringify(profile),
				hash,
				at,
				nowIso(),
			);
	}

	private device(deviceId: string): {
		model: string | null;
		firmware_revision: string | null;
		hostname: string | null;
	} {
		const row = this.db
			.prepare(
				"SELECT model, firmware_revision, hostname FROM devices WHERE id = ? AND tenant_id = ?",
			)
			.get(deviceId, this.tenantId) as
			| {
					model: string | null;
					firmware_revision: string | null;
					hostname: string | null;
			  }
			| undefined;
		if (!row) throw new DeviceNotFoundError(`device not found: ${deviceId}`);
		return row;
	}

	private findBackup(deviceId: string, backupId: string): ConfigBackupRow {
		this.device(deviceId);
		const row = this.backups
			.list(deviceId)
			.find((item) => item.id === backupId);
		if (!row) throw new ConfigBackupNotFoundError();
		return row;
	}
}

function toSummary(row: ConfigBackupRow): ConfigBackupSummary {
	return {
		id: row.id,
		capturedAt: row.captured_at,
		sizeBytes: row.size_bytes,
		contentHash: row.content_hash,
	};
}
