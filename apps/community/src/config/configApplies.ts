/**
 * CONFIG ApplyのServer側operation(#96、docs/core/config-restore-design.md §7)。
 *
 * CONFIG本文はbackup storageから都度読み出し、operation tableには保存しない。
 * Deviceのconfig_stateはRoutemonが未保存として管理しているかどうかだけを表す。
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
	type ConfigApplyResult as AgentConfigApplyResult,
	MAX_CONFIG_APPLY_CHUNK_BYTES,
	stripVolatileLines,
} from "@routemon/core";
import {
	type AgentGateway,
	type ConfigApplyHandle,
	DeviceNotConnectedError,
} from "@routemon/gateway";
import { AuditEventType, type AuditLog } from "../auth/audit.ts";
import {
	DeviceNotFoundError,
	DeviceOperationBusyError,
	type JobRow,
	type Jobs,
} from "../jobs/jobs.ts";
import { type Db, nowIso } from "../storage/db.ts";
import { type ConfigRisk, classifyConfigRisks } from "./configRisk.ts";
import {
	ConfigBackupNotFoundError,
	type ConfigSnapshots,
	type IngestResult,
	MAX_CONFIG_BYTES,
} from "./configSnapshots.ts";

const MAX_CONFIG_LINES = 2_000;
const CONFIRM_TTL_MS = 10 * 60 * 1000;
const VERIFY_TIMEOUT_MS = 5 * 60 * 1000;
const ACTIVE_PHASES = [
	"prepare",
	"confirm",
	"transfer",
	"activate",
	"verify",
] as const;

export type ConfigApplyPhase =
	| "prepare"
	| "confirm"
	| "transfer"
	| "activate"
	| "verify"
	| "complete"
	| "failed";

export type ConfigApplyResult =
	| "matched"
	| "mismatch"
	| "unavailable"
	| "failed"
	| null;

export type ConfigApplyRow = {
	id: string;
	tenant_id: string;
	device_id: string;
	target_backup_id: string | null;
	pre_apply_backup_id: string | null;
	target_content_hash: string;
	requested_by_user_id: string | null;
	save_after_apply: number;
	phase: ConfigApplyPhase;
	apply_result: ConfigApplyResult;
	save_job_id: string | null;
	discard_reboot_job_id: string | null;
	error_code: string | null;
	prepared_at: string;
	confirmed_at: string | null;
	activated_at: string | null;
	verified_at: string | null;
	finished_at: string | null;
	saved_at: string | null;
	discarded_at: string | null;
	created_at: string;
	updated_at: string;
};

export type ConfigApplyView = {
	id: string;
	deviceId: string;
	targetBackupId: string | null;
	preApplyBackupId: string | null;
	targetBackupAvailable: boolean;
	preApplyBackupAvailable: boolean;
	saveAfterApply: boolean;
	phase: ConfigApplyPhase;
	result: ConfigApplyResult;
	errorCode: string | null;
	saveJobId: string | null;
	discardRebootJobId: string | null;
	preparedAt: string;
	confirmedAt: string | null;
	activatedAt: string | null;
	verifiedAt: string | null;
	finishedAt: string | null;
	savedAt: string | null;
	discardedAt: string | null;
};

export class ConfigApplyNotFoundError extends Error {}
export class ConfigApplyBatchActiveError extends Error {
	readonly batchId: string;
	readonly batchStatus: string;
	readonly batchSource: string;

	constructor(batch: { id: string; status: string; source: string }) {
		super(`a CONFIG Apply batch is active (${batch.id})`);
		this.batchId = batch.id;
		this.batchStatus = batch.status;
		this.batchSource = batch.source;
	}
}
export class ConfigApplyValidationError extends Error {
	readonly code: string;

	constructor(code: string, message = code) {
		super(message);
		this.code = code;
	}
}
export class ConfigApplyStateError extends Error {}

type DeviceRow = {
	id: string;
	model: string | null;
	firmware_revision: string | null;
	lifecycle_status: "pending" | "active" | "disabled";
	config_state: "saved" | "unsaved";
};

type BackupMeta = {
	id: string;
	device_id: string;
	tenant_id: string;
	content_hash: string;
	size_bytes: number;
	firmware_revision: string | null;
};

type ApplyOptions = {
	now?: () => number;
};

export class ConfigApplies {
	private readonly db: Db;
	private readonly tenantId: string;
	private readonly gateway: AgentGateway;
	private readonly snapshots: ConfigSnapshots;
	private readonly jobs: Jobs;
	private readonly audit: AuditLog;
	private readonly now: () => number;

	constructor(
		options: {
			db: Db;
			tenantId: string;
			gateway: AgentGateway;
			snapshots: ConfigSnapshots;
			jobs: Jobs;
			audit: AuditLog;
		} & ApplyOptions,
	) {
		this.db = options.db;
		this.tenantId = options.tenantId;
		this.gateway = options.gateway;
		this.snapshots = options.snapshots;
		this.jobs = options.jobs;
		this.audit = options.audit;
		this.now = options.now ?? Date.now;
	}

	/** Prepareでpre_apply snapshotを要求し、確認待ちのoperationを作る。 */
	async prepare(input: {
		deviceId: string;
		targetBackupId: string;
		userId: string;
	}): Promise<ConfigApplyView> {
		this.assertTenantApplyAvailable();
		const device = this.device(input.deviceId);
		this.requireActiveDevice(device);
		this.requireOnline(input.deviceId);
		if (this.active(input.deviceId) || this.hasWriteJob(input.deviceId)) {
			throw new DeviceOperationBusyError(
				`CONFIG Apply is already in progress for ${input.deviceId}`,
			);
		}

		const target = this.backupMeta(input.deviceId, input.targetBackupId);
		if (!target) throw new ConfigBackupNotFoundError();
		const content = await this.snapshots.read(input.deviceId, target.id);
		validateConfigApplyTarget(device, target, content.content);
		const id = randomUUID();
		const at = nowIso(new Date(this.now()));
		// Confirm時にbackup metadataと本文が同じ世代であることを再検証するため、
		// volatile行を除かない保存本文のhashを保持する。
		const targetHash = target.content_hash;
		let inserted: { changes: number };
		try {
			inserted = this.db.transaction(() => {
				this.assertTenantApplyAvailable();
				this.db
					.prepare(
						`INSERT INTO config_apply_locks (tenant_id, owner_type, owner_id, acquired_at)
						 VALUES (?, 'single_apply', ?, ?)`,
					)
					.run(this.tenantId, id, at);
				return this.db
					.prepare(
						`INSERT INTO config_applies
						 (id, tenant_id, device_id, target_backup_id, target_content_hash,
						  requested_by_user_id, save_after_apply, phase, prepared_at,
						  created_at, updated_at)
						 VALUES (?, ?, ?, ?, ?, ?, 0, 'prepare', ?, ?, ?)`,
					)
					.run(
						id,
						this.tenantId,
						input.deviceId,
						target.id,
						targetHash,
						input.userId,
						at,
						at,
						at,
					);
			})();
		} catch (error) {
			const lock = this.currentTenantLock();
			if (lock?.owner_type === "batch") {
				throw this.batchActiveError(lock.owner_id);
			}
			if (lock) {
				throw new DeviceOperationBusyError(
					"another tenant CONFIG Apply is already in progress",
				);
			}
			if (
				error instanceof Error &&
				error.message.includes("config_applies_active_device")
			) {
				throw new DeviceOperationBusyError(
					`CONFIG Apply is already in progress for ${input.deviceId}`,
				);
			}
			throw error;
		}
		if (!inserted.changes) {
			throw new DeviceOperationBusyError(
				`CONFIG Apply is already in progress for ${input.deviceId}`,
			);
		}
		this.audit.record({
			type: AuditEventType.CONFIG_APPLY_REQUESTED,
			actorUserId: input.userId,
			targetType: "device",
			targetId: input.deviceId,
			detail: {
				apply_id: id,
				target_backup_id: target.id,
				save_after_apply: false,
			},
		});

		try {
			this.snapshots.request(input.deviceId, "pre_apply", input.userId);
		} catch (error) {
			this.fail(id, "prepare", "snapshot_request_failed", input.userId);
			throw error;
		}
		return this.getView(input.deviceId, id);
	}

	/** Batch lockの所有者と現在itemを検証して、guard snapshot付きの#62 childを作る。 */
	async prepareBatchChild(input: {
		batchId: string;
		batchItemId: string;
		deviceId: string;
		targetBackupId: string;
		targetContentHash: string;
		preApplyBackupId: string;
		userId: string;
	}): Promise<ConfigApplyView> {
		const lock = this.currentTenantLock();
		if (lock?.owner_type !== "batch" || lock.owner_id !== input.batchId) {
			throw new ConfigApplyStateError(
				"Batch does not own the Tenant Apply lock",
			);
		}
		const item = this.db
			.prepare(
				`SELECT i.id FROM config_apply_batch_items i
				 JOIN config_apply_batches b ON b.id = i.batch_id
				 WHERE i.id = ? AND i.batch_id = ? AND i.device_id = ?
				   AND b.tenant_id = ? AND b.status = 'running'
				   AND b.current_item_id = i.id AND i.status = 'guarding'`,
			)
			.get(input.batchItemId, input.batchId, input.deviceId, this.tenantId);
		if (!item)
			throw new ConfigApplyStateError("Batch item is not the current item");

		const device = this.device(input.deviceId);
		this.requireActiveDevice(device);
		this.requireOnline(input.deviceId);
		if (this.active(input.deviceId) || this.hasWriteJob(input.deviceId)) {
			throw new DeviceOperationBusyError(
				`CONFIG Apply is already in progress for ${input.deviceId}`,
			);
		}
		const target = this.backupMeta(input.deviceId, input.targetBackupId);
		if (!target || target.content_hash !== input.targetContentHash) {
			throw new ConfigBackupNotFoundError();
		}
		const targetContent = await this.snapshots.read(input.deviceId, target.id);
		await this.snapshots.read(input.deviceId, input.preApplyBackupId);
		validateConfigApplyTarget(device, target, targetContent.content);
		if (rawHash(targetContent.content) !== input.targetContentHash) {
			throw new ConfigApplyValidationError(
				"target_changed",
				"target backup changed",
			);
		}
		const id = randomUUID();
		const at = nowIso(new Date(this.now()));
		this.db.transaction(() => {
			const stillOwned = this.currentTenantLock();
			if (
				stillOwned?.owner_type !== "batch" ||
				stillOwned.owner_id !== input.batchId
			) {
				throw new ConfigApplyStateError("Batch lost the Tenant Apply lock");
			}
			this.db
				.prepare(
					`INSERT INTO config_applies
					 (id, tenant_id, device_id, target_backup_id, pre_apply_backup_id,
					  target_content_hash, requested_by_user_id, save_after_apply, phase,
					  prepared_at, created_at, updated_at)
					 VALUES (?, ?, ?, ?, ?, ?, ?, 0, 'confirm', ?, ?, ?)`,
				)
				.run(
					id,
					this.tenantId,
					input.deviceId,
					target.id,
					input.preApplyBackupId,
					input.targetContentHash,
					input.userId,
					at,
					at,
					at,
				);
			const linked = this.db
				.prepare(
					`UPDATE config_apply_batch_items
					 SET apply_id = ?, status = 'applying', save_result = ?,
					     apply_effect = NULL, updated_at = ?
					 WHERE id = ? AND batch_id = ? AND status = 'guarding'`,
				)
				.run(
					id,
					this.batchSaveAfterApply(input.batchId) ? "pending" : "not_requested",
					at,
					input.batchItemId,
					input.batchId,
				);
			if (linked.changes === 0) {
				throw new ConfigApplyStateError("Batch item is no longer guarding");
			}
		})();
		this.audit.record({
			type: AuditEventType.CONFIG_APPLY_REQUESTED,
			actorUserId: input.userId,
			targetType: "device",
			targetId: input.deviceId,
			detail: {
				apply_id: id,
				target_backup_id: target.id,
				save_after_apply: this.batchSaveAfterApply(input.batchId),
				batch_id: input.batchId,
				batch_item_id: input.batchItemId,
			},
		});
		return this.getView(input.deviceId, id);
	}

	/** Prepare中に届いたpre_apply snapshotをoperationへ紐付ける。 */
	async handleSnapshot(deviceId: string, result: IngestResult): Promise<void> {
		if (result.reason === "pre_apply") {
			const row = this.findActive(deviceId, "prepare");
			if (!row) return;
			const at = nowIso(new Date(this.now()));
			this.db
				.prepare(
					`UPDATE config_applies
					 SET pre_apply_backup_id = ?, phase = 'confirm', updated_at = ?
					 WHERE id = ? AND tenant_id = ?`,
				)
				.run(result.backupId, at, row.id, this.tenantId);
			return;
		}

		if (result.reason === "apply_verify") {
			const row = this.findActive(deviceId, "verify");
			if (!row) return;
			await this.finishVerification(row, result);
		}

		// 破棄再起動後は、再接続時のsnapshotとpre_applyを比較する。
		if (result.reason !== "apply_verify") {
			await this.finishDiscardIfMatching(deviceId, result.backupId);
		}
	}

	/** 確認済みtargetを再検証し、専用Apply streamを開始する。 */
	async confirm(input: {
		deviceId: string;
		applyId: string;
		userId: string;
		saveAfterApply: boolean;
		acknowledged: boolean;
		batchId?: string;
	}): Promise<ConfigApplyView> {
		if (input.acknowledged !== true) {
			throw new ConfigApplyValidationError(
				"acknowledgement_required",
				"acknowledged must be true",
			);
		}
		const device = this.device(input.deviceId);
		this.requireActiveDevice(device);
		this.requireOnline(input.deviceId);
		if (this.hasWriteJob(input.deviceId)) {
			throw new DeviceOperationBusyError(
				`another device operation is already queued for ${input.deviceId}`,
			);
		}
		const row = this.requireRow(input.deviceId, input.applyId);
		const batch = this.batchContext(row.id);
		if (batch && batch.batchId !== input.batchId) {
			throw new ConfigApplyStateError(
				"Batch child Apply can only be confirmed by its Batch operation",
			);
		}
		if (input.batchId && batch?.batchId !== input.batchId) {
			throw new ConfigApplyStateError("Batch child Apply does not match Batch");
		}
		if (batch) {
			const lock = this.currentTenantLock();
			const current = this.db
				.prepare(
					`SELECT b.status, b.current_item_id, i.id AS item_id
					 FROM config_apply_batch_items i
					 JOIN config_apply_batches b ON b.id = i.batch_id
					 WHERE i.apply_id = ? AND b.id = ? AND b.tenant_id = ?`,
				)
				.get(row.id, batch.batchId, this.tenantId) as
				| { status: string; current_item_id: string | null; item_id: string }
				| undefined;
			if (
				lock?.owner_type !== "batch" ||
				lock.owner_id !== batch.batchId ||
				current?.status !== "running" ||
				current.current_item_id !== current.item_id
			) {
				throw new ConfigApplyStateError(
					"Batch is no longer applying this item",
				);
			}
		}
		if (row.phase !== "confirm") {
			throw new ConfigApplyStateError(
				`CONFIG Apply cannot be confirmed in phase ${row.phase}`,
			);
		}
		if (this.now() - Date.parse(row.prepared_at) > CONFIRM_TTL_MS) {
			this.fail(row.id, "confirm", "confirmation_expired", input.userId);
			throw new ConfigApplyValidationError(
				"confirmation_expired",
				"CONFIG Apply confirmation has expired",
			);
		}

		const target = this.backupMeta(input.deviceId, row.target_backup_id);
		if (!target) {
			this.fail(row.id, "confirm", "target_backup_not_found", input.userId);
			throw new ConfigBackupNotFoundError();
		}
		const content = await this.snapshots.read(input.deviceId, target.id);
		validateConfigApplyTarget(device, target, content.content);
		if (rawHash(content.content) !== row.target_content_hash) {
			this.fail(row.id, "confirm", "target_changed", input.userId);
			throw new ConfigApplyValidationError(
				"target_changed",
				"target backup changed after prepare",
			);
		}
		if (batch) {
			const lock = this.currentTenantLock();
			const stillCurrent = this.db
				.prepare(
					`SELECT 1 FROM config_apply_batch_items i
					 JOIN config_apply_batches b ON b.id = i.batch_id
					 WHERE i.apply_id = ? AND i.batch_id = ? AND b.tenant_id = ?
					   AND b.status = 'running' AND b.current_item_id = i.id`,
				)
				.get(row.id, batch.batchId, this.tenantId);
			if (
				lock?.owner_type !== "batch" ||
				lock.owner_id !== batch.batchId ||
				!stillCurrent
			) {
				throw new ConfigApplyStateError(
					"Batch is no longer applying this item",
				);
			}
		}

		const at = nowIso(new Date(this.now()));
		const transitioned = this.db
			.prepare(
				`UPDATE config_applies
				 SET save_after_apply = ?, phase = 'transfer', confirmed_at = ?, updated_at = ?
				 WHERE id = ? AND tenant_id = ? AND phase = 'confirm'`,
			)
			.run(input.saveAfterApply ? 1 : 0, at, at, row.id, this.tenantId);
		if (transitioned.changes === 0) {
			throw new ConfigApplyStateError("CONFIG Apply was already confirmed");
		}

		const operationId = randomBytes(16);
		const targetSha256 = new Uint8Array(
			createHash("sha256").update(content.content).digest(),
		);
		let handle: ConfigApplyHandle | undefined;
		try {
			handle = this.gateway.startConfigApply(
				input.deviceId,
				{
					operationId,
					totalBytes: content.content.length,
					chunkBytes: MAX_CONFIG_APPLY_CHUNK_BYTES,
					targetSha256,
				},
				content.content,
				{
					onResult: (result) => {
						void this.handleGatewayResult(
							input.deviceId,
							row.id,
							input.userId,
							handle,
							result,
						);
					},
					onError: (error) => {
						this.fail(row.id, "transfer", applyErrorCode(error), input.userId);
					},
				},
			);
		} catch (error) {
			this.fail(row.id, "transfer", applyErrorCode(error), input.userId);
			throw error;
		}
		return this.getView(input.deviceId, row.id);
	}

	/** CONFIG Applyとは独立したsave操作。SYSLOG検知までsavedへ変更しない。 */
	async save(input: { deviceId: string; userId: string }): Promise<JobRow> {
		const device = this.device(input.deviceId);
		this.requireActiveDevice(device);
		return this.jobs.save({ deviceId: input.deviceId, userId: input.userId });
	}

	/** Batch停止とconfirmの競合でload前に残ったchild rowを終端化する。 */
	failBatchChildBeforeLoad(
		batchId: string,
		batchItemId: string,
		userId: string | null,
	): void {
		const row = this.db
			.prepare(
				`SELECT ca.id FROM config_applies ca
				 JOIN config_apply_batch_items i ON i.apply_id = ca.id
				 JOIN config_apply_batches b ON b.id = i.batch_id
				 WHERE i.id = ? AND i.batch_id = ? AND b.tenant_id = ? AND ca.phase = 'confirm'`,
			)
			.get(batchItemId, batchId, this.tenantId) as { id: string } | undefined;
		if (!row) return;
		this.fail(
			row.id,
			"confirm",
			"batch_stopped_before_load",
			userId,
			"confirm",
		);
	}

	/** Adminが明示した未保存変更の破棄再起動。自動では呼ばない。 */
	async discard(input: {
		deviceId: string;
		applyId: string;
		userId: string;
	}): Promise<{ apply: ConfigApplyView; job: JobRow }> {
		const device = this.device(input.deviceId);
		this.requireActiveDevice(device);
		if (device.config_state !== "unsaved") {
			throw new ConfigApplyStateError(
				"device has no Routemon-managed unsaved change",
			);
		}
		const row = this.requireRow(input.deviceId, input.applyId);
		if (row.phase !== "complete" && row.phase !== "failed") {
			throw new ConfigApplyStateError(
				`CONFIG Apply cannot be discarded in phase ${row.phase}`,
			);
		}
		const job = await this.jobs.reboot({
			deviceId: input.deviceId,
			userId: input.userId,
			save: false,
		});
		const at = nowIso(new Date(this.now()));
		this.db
			.prepare(
				`UPDATE config_applies
				 SET discard_reboot_job_id = ?, updated_at = ?
				 WHERE id = ? AND tenant_id = ?`,
			)
			.run(job.id, at, row.id, this.tenantId);
		this.audit.record({
			type: AuditEventType.CONFIG_APPLY_DISCARD_REQUESTED,
			actorUserId: input.userId,
			targetType: "device",
			targetId: input.deviceId,
			detail: { apply_id: row.id, job_id: job.id },
		});
		return { apply: this.getView(input.deviceId, row.id), job };
	}

	get(deviceId: string, applyId: string): ConfigApplyView {
		return this.getView(deviceId, applyId);
	}

	/** Apply metadataと、保持されている場合だけtarget/pre-apply diffを返す。 */
	async getDetails(
		deviceId: string,
		applyId: string,
		actorUserId?: string,
	): Promise<{
		apply: ConfigApplyView;
		diff: Awaited<ReturnType<ConfigSnapshots["diff"]>> | null;
		diffUnavailable: boolean;
		risks: ConfigRisk[] | null;
	}> {
		const apply = this.getView(deviceId, applyId);
		if (!apply.targetBackupId || !apply.preApplyBackupId) {
			return { apply, diff: null, diffUnavailable: true, risks: null };
		}
		const auditDiffViewed = () => {
			this.audit.record({
				type: AuditEventType.DEVICE_CONFIG_DIFF_VIEWED,
				actorUserId,
				targetType: "device",
				targetId: deviceId,
				detail: {
					backup_id: apply.targetBackupId,
					against_id: apply.preApplyBackupId,
				},
			});
		};
		if (apply.targetBackupId === apply.preApplyBackupId) {
			// Dedupeにより同じ世代を参照する場合は、差分なしとして扱う。
			auditDiffViewed();
			return { apply, diff: null, diffUnavailable: false, risks: null };
		}
		try {
			const diff = await this.snapshots.diff(
				deviceId,
				apply.targetBackupId,
				apply.preApplyBackupId,
			);
			auditDiffViewed();
			return {
				apply,
				diff,
				diffUnavailable: false,
				risks: classifyConfigRisks(
					diff.lines
						.filter((line) => line.type !== "context")
						.map((line) => line.text),
				),
			};
		} catch (error) {
			if (error instanceof ConfigBackupNotFoundError) {
				return { apply, diff: null, diffUnavailable: true, risks: null };
			}
			throw error;
		}
	}

	list(deviceId: string): ConfigApplyView[] {
		this.device(deviceId);
		const rows = this.db
			.prepare(
				"SELECT * FROM config_applies WHERE tenant_id = ? AND device_id = ? ORDER BY created_at DESC, id DESC",
			)
			.all(this.tenantId, deviceId) as ConfigApplyRow[];
		return rows.map(toView);
	}

	/** apply_verify待ちだけを終端化し、保存・再起動は行わずApply lockを解放する。 */
	expireVerificationOperations(): number {
		const cutoff = nowIso(new Date(this.now() - VERIFY_TIMEOUT_MS));
		const rows = this.db
			.prepare(
				`SELECT id, device_id, requested_by_user_id FROM config_applies
				 WHERE tenant_id = ? AND phase = 'verify' AND updated_at <= ?`,
			)
			.all(this.tenantId, cutoff) as Pick<
			ConfigApplyRow,
			"id" | "device_id" | "requested_by_user_id"
		>[];

		let expired = 0;
		for (const row of rows) {
			const at = nowIso(new Date(this.now()));
			const updated = this.db
				.prepare(
					`UPDATE config_applies
					 SET phase = 'failed', apply_result = 'unavailable', error_code = 'verify_timeout',
					     finished_at = ?, updated_at = ?
					 WHERE id = ? AND tenant_id = ? AND phase = 'verify' AND updated_at <= ?`,
				)
				.run(at, at, row.id, this.tenantId, cutoff);
			if (updated.changes === 0) continue;

			this.audit.record({
				type: AuditEventType.CONFIG_APPLY_FAILED,
				actorUserId: row.requested_by_user_id,
				targetType: "device",
				targetId: row.device_id,
				detail: {
					apply_id: row.id,
					phase: "verify",
					result: "unavailable",
					error_code: "verify_timeout",
				},
			});
			this.releaseSingleApplyLock(row.id);
			expired++;
		}
		return expired;
	}

	/** Server再起動後に、再開せずAdminの再確認へ戻す。 */
	recoverAfterRestart(): void {
		const rows = this.db
			.prepare(
				`SELECT id, device_id, requested_by_user_id, phase FROM config_applies
				 WHERE tenant_id = ? AND phase IN ('prepare', 'confirm', 'transfer', 'activate', 'verify')`,
			)
			.all(this.tenantId) as Pick<
			ConfigApplyRow,
			"id" | "device_id" | "requested_by_user_id" | "phase"
		>[];
		for (const row of rows) {
			this.fail(
				row.id,
				row.phase,
				"server_restarted",
				row.requested_by_user_id,
			);
		}
		// A verified Apply may still hold the Tenant mutex while waiting for CONFIG_SAVED.
		// After a restart its save result is unconfirmed, so do not leave the whole Tenant locked.
		this.db
			.prepare(
				"DELETE FROM config_apply_locks WHERE tenant_id = ? AND owner_type = 'single_apply'",
			)
			.run(this.tenantId);
	}

	/** #76の保存SYSLOGからDevice状態を解除する。外部telnet等のsaveも含む。 */
	handleConfigSaved(deviceId: string): void {
		this.device(deviceId);
		const at = nowIso(new Date(this.now()));
		this.db
			.prepare(
				"UPDATE devices SET config_state = 'saved', updated_at = ? WHERE id = ? AND tenant_id = ?",
			)
			.run(at, deviceId, this.tenantId);
		const pending = this.db
			.prepare(
				`SELECT * FROM config_applies
				 WHERE tenant_id = ? AND device_id = ? AND save_job_id IS NOT NULL
				   AND saved_at IS NULL ORDER BY created_at DESC`,
			)
			.all(this.tenantId, deviceId) as ConfigApplyRow[];
		if (pending.length === 0) {
			const saveJob = this.db
				.prepare(
					`SELECT id FROM jobs
					 WHERE tenant_id = ? AND device_id = ? AND type = 'config_save'
					 ORDER BY created_at DESC, id DESC LIMIT 1`,
				)
				.get(this.tenantId, deviceId) as { id: string } | undefined;
			if (saveJob) {
				this.audit.record({
					type: AuditEventType.CONFIG_SAVED,
					targetType: "device",
					targetId: deviceId,
					detail: { job_id: saveJob.id },
				});
				return;
			}
			this.audit.record({
				type: AuditEventType.CONFIG_SAVED_DETECTED,
				targetType: "device",
				targetId: deviceId,
			});
			return;
		}
		for (const row of pending) {
			this.db
				.prepare(
					"UPDATE config_applies SET saved_at = ?, updated_at = ? WHERE id = ? AND tenant_id = ?",
				)
				.run(at, at, row.id, this.tenantId);
			this.audit.record({
				type: AuditEventType.CONFIG_SAVED,
				targetType: "device",
				targetId: deviceId,
				detail: {
					apply_id: row.id,
					...this.batchAuditFields(row.id),
					job_id: row.save_job_id,
				},
			});
			this.releaseSingleApplyLock(row.id);
		}
	}

	private async handleGatewayResult(
		deviceId: string,
		applyId: string,
		userId: string,
		handle: ConfigApplyHandle | undefined,
		result: AgentConfigApplyResult,
	): Promise<void> {
		if (result.status === "ready" || result.status === "chunk_ack") {
			return;
		}
		if (result.status === "staged") {
			const at = nowIso(new Date(this.now()));
			const updated = this.db
				.prepare(
					`UPDATE config_applies
					 SET phase = 'activate', activated_at = ?, updated_at = ?
					 WHERE id = ? AND tenant_id = ? AND phase = 'transfer'`,
				)
				.run(at, at, applyId, this.tenantId);
			if (updated.changes === 0) return;
			try {
				handle?.activate();
			} catch (error) {
				this.fail(applyId, "activate", applyErrorCode(error), userId);
			}
			return;
		}
		if (result.status === "loaded") {
			const at = nowIso(new Date(this.now()));
			const updated = this.db
				.prepare(
					`UPDATE config_applies SET phase = 'verify', updated_at = ?
					 WHERE id = ? AND tenant_id = ? AND phase = 'activate'`,
				)
				.run(at, applyId, this.tenantId);
			if (updated.changes === 0) return;
			this.db
				.prepare(
					"UPDATE devices SET config_state = 'unsaved', updated_at = ? WHERE id = ? AND tenant_id = ?",
				)
				.run(at, deviceId, this.tenantId);
			try {
				this.snapshots.request(deviceId, "apply_verify", userId);
			} catch (error) {
				this.fail(applyId, "verify", applyErrorCode(error), userId);
			}
			return;
		}
		this.fail(
			applyId,
			result.status === "load_failed" ? "activate" : "transfer",
			result.errorCode,
			userId,
		);
	}

	private async finishVerification(
		row: ConfigApplyRow,
		result: IngestResult,
	): Promise<void> {
		try {
			if (!row.target_backup_id) throw new ConfigBackupNotFoundError();
			const target = await this.snapshots.read(
				row.device_id,
				row.target_backup_id,
			);
			const actual = await this.snapshots.read(row.device_id, result.backupId);
			const matched =
				normalizedConfigHash(actual.content) ===
				normalizedConfigHash(target.content);
			const at = nowIso(new Date(this.now()));
			const updated = this.db
				.prepare(
					`UPDATE config_applies
					 SET phase = ?, apply_result = ?, error_code = ?, verified_at = ?, finished_at = ?, updated_at = ?
					 WHERE id = ? AND tenant_id = ? AND phase = 'verify'`,
				)
				.run(
					matched ? "complete" : "failed",
					matched ? "matched" : "mismatch",
					matched ? null : "verify_mismatch",
					at,
					at,
					at,
					row.id,
					this.tenantId,
				);
			if (updated.changes === 0) return;
			if (matched) {
				this.audit.record({
					type: AuditEventType.CONFIG_APPLIED,
					actorUserId: row.requested_by_user_id,
					targetType: "device",
					targetId: row.device_id,
					detail: {
						apply_id: row.id,
						...this.batchAuditFields(row.id),
						target_backup_id: target.backup.id,
						pre_apply_backup_id: row.pre_apply_backup_id,
						apply_result: "matched",
					},
				});
				if (row.save_after_apply === 1) {
					await this.startSaveForApply(row);
				} else {
					this.releaseSingleApplyLock(row.id);
				}
				return;
			}
			this.audit.record({
				type: AuditEventType.CONFIG_APPLY_FAILED,
				actorUserId: row.requested_by_user_id,
				targetType: "device",
				targetId: row.device_id,
				detail: {
					apply_id: row.id,
					...this.batchAuditFields(row.id),
					phase: "verify",
					error_code: "verify_mismatch",
				},
			});
			this.releaseSingleApplyLock(row.id);
		} catch (_error) {
			this.fail(
				row.id,
				"verify",
				"verify_unavailable",
				row.requested_by_user_id,
				"verify",
			);
		}
	}

	private async startSaveForApply(row: ConfigApplyRow): Promise<void> {
		if (!row.requested_by_user_id) {
			this.fail(row.id, "complete", "missing_actor", null);
			return;
		}
		try {
			const job = await this.jobs.save({
				deviceId: row.device_id,
				userId: row.requested_by_user_id,
				applyId: row.id,
				...this.batchContext(row.id),
				onCreated: (jobId) => {
					this.db
						.prepare(
							"UPDATE config_applies SET save_job_id = ?, updated_at = ? WHERE id = ? AND tenant_id = ?",
						)
						.run(jobId, nowIso(new Date(this.now())), row.id, this.tenantId);
				},
			});
			if (job.status !== "success") {
				this.fail(
					row.id,
					"complete",
					job.status === "timeout" ? "save_timeout" : "save_failed",
					row.requested_by_user_id,
				);
			}
		} catch (error) {
			this.fail(
				row.id,
				"complete",
				applyErrorCode(error),
				row.requested_by_user_id,
			);
		}
	}

	private async finishDiscardIfMatching(
		deviceId: string,
		backupId: string,
	): Promise<void> {
		const row = this.db
			.prepare(
				`SELECT ca.*, j.status AS discard_job_status
				 FROM config_applies ca
				 JOIN jobs j ON j.id = ca.discard_reboot_job_id AND j.tenant_id = ca.tenant_id
				 WHERE ca.tenant_id = ? AND ca.device_id = ?
				   AND ca.discard_reboot_job_id IS NOT NULL AND ca.discarded_at IS NULL
				 ORDER BY ca.created_at DESC LIMIT 1`,
			)
			.get(this.tenantId, deviceId) as
			| (ConfigApplyRow & { discard_job_status: JobRow["status"] })
			| undefined;
		if (!row?.pre_apply_backup_id || row.discard_job_status !== "success")
			return;
		try {
			const before = await this.snapshots.read(
				deviceId,
				row.pre_apply_backup_id,
			);
			const after = await this.snapshots.read(deviceId, backupId);
			if (
				normalizedConfigHash(before.content) !==
				normalizedConfigHash(after.content)
			)
				return;
			const at = nowIso(new Date(this.now()));
			this.db.transaction(() => {
				this.db
					.prepare(
						"UPDATE devices SET config_state = 'saved', updated_at = ? WHERE id = ? AND tenant_id = ?",
					)
					.run(at, deviceId, this.tenantId);
				this.db
					.prepare(
						"UPDATE config_applies SET discarded_at = ?, updated_at = ? WHERE id = ? AND tenant_id = ?",
					)
					.run(at, at, row.id, this.tenantId);
			})();
			this.audit.record({
				type: AuditEventType.CONFIG_APPLY_DISCARDED,
				targetType: "device",
				targetId: deviceId,
				detail: { apply_id: row.id, job_id: row.discard_reboot_job_id },
			});
		} catch {
			// pre-apply backupがretentionで消えていれば、復旧を成功扱いにしない。
		}
	}

	private fail(
		applyId: string,
		phase: ConfigApplyPhase,
		errorCode: string,
		actorUserId: string | null,
		expectedPhase?: ConfigApplyPhase,
	): void {
		const current = this.db
			.prepare(
				"SELECT phase FROM config_applies WHERE id = ? AND tenant_id = ?",
			)
			.get(applyId, this.tenantId) as { phase: ConfigApplyPhase } | undefined;
		if (
			!current ||
			current.phase === "failed" ||
			(expectedPhase && current.phase !== expectedPhase)
		)
			return;
		const at = nowIso(new Date(this.now()));
		const updated = this.db
			.prepare(
				`UPDATE config_applies
				 SET phase = 'failed', apply_result = 'failed', error_code = ?, finished_at = ?, updated_at = ?
				 WHERE id = ? AND tenant_id = ? AND phase = ?`,
			)
			.run(errorCode, at, at, applyId, this.tenantId, current.phase);
		if (updated.changes === 0) return;
		this.audit.record({
			type: AuditEventType.CONFIG_APPLY_FAILED,
			actorUserId: actorUserId,
			targetType: "device",
			targetId: this.applyDeviceId(applyId),
			detail: {
				apply_id: applyId,
				...this.batchAuditFields(applyId),
				phase,
				error_code: errorCode,
			},
		});
		this.releaseSingleApplyLock(applyId);
	}

	private assertTenantApplyAvailable(): void {
		const lock = this.currentTenantLock();
		if (!lock) return;
		if (lock.owner_type === "batch") throw this.batchActiveError(lock.owner_id);
		throw new DeviceOperationBusyError(
			"another tenant CONFIG Apply is already in progress",
		);
	}

	private currentTenantLock():
		| { owner_type: "batch" | "single_apply"; owner_id: string }
		| undefined {
		return this.db
			.prepare(
				"SELECT owner_type, owner_id FROM config_apply_locks WHERE tenant_id = ?",
			)
			.get(this.tenantId) as
			| { owner_type: "batch" | "single_apply"; owner_id: string }
			| undefined;
	}

	private batchActiveError(batchId: string): ConfigApplyBatchActiveError {
		const batch = this.db
			.prepare(
				"SELECT id, status, source FROM config_apply_batches WHERE id = ? AND tenant_id = ?",
			)
			.get(batchId, this.tenantId) as
			| { id: string; status: string; source: string }
			| undefined;
		return new ConfigApplyBatchActiveError(
			batch ?? { id: batchId, status: "unknown", source: "unknown" },
		);
	}

	private batchSaveAfterApply(batchId: string): boolean {
		const row = this.db
			.prepare(
				"SELECT save_after_apply FROM config_apply_batches WHERE id = ? AND tenant_id = ?",
			)
			.get(batchId, this.tenantId) as { save_after_apply: number } | undefined;
		return row?.save_after_apply === 1;
	}

	private batchContext(
		applyId: string,
	): { batchId: string; batchItemId: string } | undefined {
		const row = this.db
			.prepare(
				`SELECT i.batch_id, i.id AS batch_item_id
				 FROM config_apply_batch_items i
				 JOIN config_apply_batches b ON b.id = i.batch_id
				 WHERE i.apply_id = ? AND b.tenant_id = ?`,
			)
			.get(applyId, this.tenantId) as
			| { batch_id: string; batch_item_id: string }
			| undefined;
		return row
			? { batchId: row.batch_id, batchItemId: row.batch_item_id }
			: undefined;
	}

	private batchAuditFields(applyId: string): Record<string, string> {
		const batch = this.batchContext(applyId);
		return batch
			? { batch_id: batch.batchId, batch_item_id: batch.batchItemId }
			: {};
	}

	private releaseSingleApplyLock(applyId: string): void {
		this.db
			.prepare(
				`DELETE FROM config_apply_locks
				 WHERE tenant_id = ? AND owner_type = 'single_apply' AND owner_id = ?`,
			)
			.run(this.tenantId, applyId);
	}

	private getView(deviceId: string, applyId: string): ConfigApplyView {
		return toView(this.requireRow(deviceId, applyId));
	}

	private requireRow(deviceId: string, applyId: string): ConfigApplyRow {
		const row = this.db
			.prepare(
				"SELECT * FROM config_applies WHERE id = ? AND tenant_id = ? AND device_id = ?",
			)
			.get(applyId, this.tenantId, deviceId) as ConfigApplyRow | undefined;
		if (!row)
			throw new ConfigApplyNotFoundError(`CONFIG Apply not found: ${applyId}`);
		return row;
	}

	private findActive(
		deviceId: string,
		phase: (typeof ACTIVE_PHASES)[number],
	): ConfigApplyRow | undefined {
		return this.db
			.prepare(
				"SELECT * FROM config_applies WHERE tenant_id = ? AND device_id = ? AND phase = ? ORDER BY created_at DESC LIMIT 1",
			)
			.get(this.tenantId, deviceId, phase) as ConfigApplyRow | undefined;
	}

	private active(deviceId: string): ConfigApplyRow | undefined {
		return this.db
			.prepare(
				`SELECT * FROM config_applies
				 WHERE tenant_id = ? AND device_id = ?
				   AND phase IN ('prepare', 'confirm', 'transfer', 'activate', 'verify')
				 LIMIT 1`,
			)
			.get(this.tenantId, deviceId) as ConfigApplyRow | undefined;
	}

	private hasWriteJob(deviceId: string): boolean {
		return Boolean(
			this.db
				.prepare(
					`SELECT 1 FROM jobs
					 WHERE tenant_id = ? AND device_id = ?
					   AND type IN ('config_save', 'reboot')
					   AND status IN ('queued', 'running')
					 LIMIT 1`,
				)
				.get(this.tenantId, deviceId),
		);
	}

	private applyDeviceId(applyId: string): string | null {
		const row = this.db
			.prepare(
				"SELECT device_id FROM config_applies WHERE id = ? AND tenant_id = ?",
			)
			.get(applyId, this.tenantId) as { device_id: string } | undefined;
		return row?.device_id ?? null;
	}

	private backupMeta(
		deviceId: string,
		backupId: string | null,
	): BackupMeta | undefined {
		if (!backupId) return undefined;
		return this.db
			.prepare(
				`SELECT id, device_id, tenant_id, content_hash, size_bytes, firmware_revision
				 FROM device_config_backups
				 WHERE id = ? AND device_id = ? AND tenant_id = ?`,
			)
			.get(backupId, deviceId, this.tenantId) as BackupMeta | undefined;
	}

	private device(deviceId: string): DeviceRow {
		const row = this.db
			.prepare(
				"SELECT id, model, firmware_revision, lifecycle_status, config_state FROM devices WHERE id = ? AND tenant_id = ?",
			)
			.get(deviceId, this.tenantId) as DeviceRow | undefined;
		if (!row) throw new DeviceNotFoundError(`device not found: ${deviceId}`);
		return row;
	}

	private requireActiveDevice(device: DeviceRow): void {
		if (device.lifecycle_status !== "active") {
			throw new ConfigApplyValidationError(
				"device_not_active",
				"device is not active",
			);
		}
	}

	private requireOnline(deviceId: string): void {
		if (this.gateway.presence(deviceId).status === "offline") {
			throw new DeviceNotConnectedError(`device not connected: ${deviceId}`);
		}
	}
}

function toView(row: ConfigApplyRow): ConfigApplyView {
	return {
		id: row.id,
		deviceId: row.device_id,
		targetBackupId: row.target_backup_id,
		preApplyBackupId: row.pre_apply_backup_id,
		targetBackupAvailable: row.target_backup_id !== null,
		preApplyBackupAvailable: row.pre_apply_backup_id !== null,
		saveAfterApply: row.save_after_apply === 1,
		phase: row.phase,
		result: row.apply_result,
		errorCode: row.error_code,
		saveJobId: row.save_job_id,
		discardRebootJobId: row.discard_reboot_job_id,
		preparedAt: row.prepared_at,
		confirmedAt: row.confirmed_at,
		activatedAt: row.activated_at,
		verifiedAt: row.verified_at,
		finishedAt: row.finished_at,
		savedAt: row.saved_at,
		discardedAt: row.discarded_at,
	};
}

export function normalizedConfigHash(content: Uint8Array): string {
	return createHash("sha256").update(stripVolatileLines(content)).digest("hex");
}

function rawHash(content: Uint8Array): string {
	return createHash("sha256").update(content).digest("hex");
}

export function validateConfigApplyTarget(
	device: Pick<DeviceRow, "model" | "firmware_revision">,
	backup: Pick<BackupMeta, "firmware_revision">,
	content: Uint8Array,
): void {
	if (content.length === 0) {
		throw new ConfigApplyValidationError(
			"target_empty",
			"target CONFIG is empty",
		);
	}
	if (content.length > MAX_CONFIG_BYTES) {
		throw new ConfigApplyValidationError(
			"target_too_large",
			"target CONFIG exceeds 1 MiB",
		);
	}
	const text = new TextDecoder("shift_jis").decode(content);
	const lines = text.replace(/\r\n?/g, "\n").split("\n");
	if (lines.at(-1) === "") lines.pop();
	if (lines.length === 0) {
		throw new ConfigApplyValidationError(
			"target_empty",
			"target CONFIG is empty",
		);
	}
	if (lines.length >= MAX_CONFIG_LINES) {
		throw new ConfigApplyValidationError(
			"target_too_many_lines",
			"target CONFIG has too many lines",
		);
	}
	if (
		!/^schedule\s+at\s+.*\blua\s+\/routemon_bootstrap\.lua(?:\s|$)/m.test(text)
	) {
		throw new ConfigApplyValidationError(
			"supervisor_schedule_missing",
			"Supervisor auto-start schedule is missing",
		);
	}
	const targetModel = /^#\s*(RTX\d+)\b/m.exec(text)?.[1];
	if (
		targetModel &&
		device.model &&
		targetModel.toUpperCase() !== device.model.toUpperCase()
	) {
		throw new ConfigApplyValidationError(
			"model_mismatch",
			"target model does not match device",
		);
	}
	if (
		backup.firmware_revision &&
		device.firmware_revision &&
		normalizeRevision(backup.firmware_revision) !==
			normalizeRevision(device.firmware_revision)
	) {
		throw new ConfigApplyValidationError(
			"firmware_mismatch",
			"target firmware revision does not match device",
		);
	}
}

function normalizeRevision(value: string): string {
	return value.trim().replace(/^rev\.?/i, "");
}

function applyErrorCode(error: unknown): string {
	if (error instanceof ConfigApplyValidationError) return error.code;
	if (error instanceof DeviceNotConnectedError) return "device_not_connected";
	if (error instanceof Error && error.message) {
		return error.message.slice(0, 120).replace(/[^a-zA-Z0-9_.-]+/g, "_");
	}
	return "apply_failed";
}
