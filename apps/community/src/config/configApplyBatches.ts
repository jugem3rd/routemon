/** 複数Deviceへ既存CONFIG Applyを順番に実行するServer operation (#94). */
import { randomUUID } from "node:crypto";
import { decodeConfig } from "@routemon/core";
import { DeviceNotConnectedError } from "@routemon/gateway";
import { AuditEventType, type AuditLog } from "../auth/audit.ts";
import { type Db, nowIso } from "../storage/db.ts";
import {
	type ConfigApplies,
	ConfigApplyStateError,
	ConfigApplyValidationError,
	normalizedConfigHash,
	validateConfigApplyTarget,
} from "./configApplies.ts";
import { createConfigDiff } from "./configDiff.ts";
import { type ConfigRisk, classifyConfigRisks } from "./configRisk.ts";
import {
	ConfigBackupNotFoundError,
	type ConfigSnapshots,
	DeviceNotFoundError,
	type IngestResult,
} from "./configSnapshots.ts";

export const MAX_CONFIG_APPLY_BATCH_DEVICES = 50;
export const CONFIG_APPLY_BATCH_PREPARE_TIMEOUT_MS = 2 * 60 * 1000;
export const CONFIG_APPLY_BATCH_CONFIRM_TTL_MS = 10 * 60 * 1000;
export const CONFIG_APPLY_BATCH_SAVE_CONFIRM_TIMEOUT_MS = 2 * 60 * 1000;

const ACTIVE_BATCH_STATUSES = [
	"preparing",
	"awaiting_confirmation",
	"running",
	"stopping",
] as const;

export type ConfigApplyBatchStatus =
	| (typeof ACTIVE_BATCH_STATUSES)[number]
	| "stopped"
	| "complete";
export type ConfigApplyBatchConfirmationMode = "batch" | "per_device";
export type ConfigApplyBatchSource = "checkpoint" | "devices";
export type ConfigApplyBatchItemStatus =
	| "preparing"
	| "prepared"
	| "no_change"
	| "excluded"
	| "queued"
	| "guarding"
	| "awaiting_confirmation"
	| "applying"
	| "applied"
	| "failed"
	| "skipped";
export type ConfigApplyEffect = "confirmed" | "not_applied" | "unknown";
export type ConfigApplyBatchSaveResult =
	| "not_requested"
	| "pending"
	| "confirmed"
	| "failed"
	| "unconfirmed";

export type ConfigApplyBatchPlanSummary = {
	changed: boolean;
	addedLines: number;
	removedLines: number;
	risks: ConfigRisk[];
	validation: {
		valid: boolean;
		code: string | null;
		model: {
			expected: string | null;
			actual: string | null;
			valid: boolean | null;
		};
		firmware: {
			expected: string | null;
			actual: string | null;
			valid: boolean | null;
		};
		lineCount: { actual: number; maximum: number; valid: boolean };
		sizeBytes: { actual: number; maximum: number; valid: boolean };
		supervisorAutostart: { present: boolean; valid: boolean };
	};
};

export type ConfigApplyBatchItemView = {
	id: string;
	sequence: number;
	deviceId: string | null;
	deviceName: string;
	targetBackupId: string;
	preparedBackupId: string | null;
	executionCheckBackupId: string | null;
	selectedForExecution: boolean;
	plan: ConfigApplyBatchPlanSummary | null;
	status: ConfigApplyBatchItemStatus;
	failureCode: string | null;
	applyId: string | null;
	applyEffect: ConfigApplyEffect | null;
	saveResult: ConfigApplyBatchSaveResult | null;
	requestedAt: string;
	confirmedAt: string | null;
	finishedAt: string | null;
};

export type ConfigApplyBatchView = {
	id: string;
	source: ConfigApplyBatchSource;
	sourceCheckpointId: string | null;
	sourceCheckpointName: string | null;
	confirmationMode: ConfigApplyBatchConfirmationMode;
	saveAfterApply: boolean;
	status: ConfigApplyBatchStatus;
	currentItemId: string | null;
	stopReason: string | null;
	planCompletedAt: string | null;
	confirmedAt: string | null;
	createdAt: string;
	updatedAt: string;
	finishedAt: string | null;
	items: ConfigApplyBatchItemView[];
};

export class ConfigApplyBatchNotFoundError extends Error {}
export class ConfigApplyBatchValidationError extends Error {
	readonly code: string;

	constructor(code: string, message = code) {
		super(message);
		this.code = code;
	}
}
export class ConfigApplyBatchConflictError extends Error {}

type BatchRow = {
	id: string;
	tenant_id: string;
	requested_by_user_id: string | null;
	source: ConfigApplyBatchSource;
	source_checkpoint_id: string | null;
	source_checkpoint_name: string | null;
	confirmation_mode: ConfigApplyBatchConfirmationMode;
	save_after_apply: number;
	status: ConfigApplyBatchStatus;
	current_item_id: string | null;
	stop_reason: string | null;
	plan_completed_at: string | null;
	confirmed_at: string | null;
	created_at: string;
	updated_at: string;
	finished_at: string | null;
};

type BatchItemRow = {
	id: string;
	batch_id: string;
	sequence: number;
	device_id: string | null;
	device_name: string;
	target_backup_id: string;
	target_content_hash: string;
	prepared_backup_id: string | null;
	prepared_config_hash: string | null;
	execution_check_backup_id: string | null;
	execution_check_config_hash: string | null;
	selected_for_execution: number;
	plan_summary: string | null;
	status: ConfigApplyBatchItemStatus;
	failure_code: string | null;
	apply_id: string | null;
	apply_effect: ConfigApplyEffect | null;
	save_result: ConfigApplyBatchSaveResult | null;
	requested_at: string;
	confirmed_at: string | null;
	created_at: string;
	updated_at: string;
	finished_at: string | null;
};

type DeviceTarget = {
	deviceId: string;
	backupId: string;
	deviceName: string;
	model: string | null;
	firmwareRevision: string | null;
	backupHash: string;
	backupFirmwareRevision: string | null;
};

export type ConfigApplyBatchCreateInput = {
	userId: string;
	confirmationMode?: ConfigApplyBatchConfirmationMode;
	saveAfterApply?: boolean;
	source:
		| { type: "checkpoint"; checkpointId: string }
		| {
				type: "devices";
				items: Array<{ deviceId: string; backupId: string }>;
		  };
};

type ApplyChildState = {
	phase: string;
	apply_result: string | null;
	error_code: string | null;
	activated_at: string | null;
	verified_at: string | null;
	saved_at: string | null;
	save_after_apply: number;
	save_job_id: string | null;
	updated_at: string;
	job_status: string | null;
	job_finished_at: string | null;
};

export class ConfigApplyBatches {
	private readonly db: Db;
	private readonly tenantId: string;
	private readonly gateway: ConfigApplyBatchesGateway;
	private readonly snapshots: ConfigSnapshots;
	private readonly applies: ConfigApplies;
	private readonly audit: AuditLog;
	private readonly now: () => number;

	constructor(options: {
		db: Db;
		tenantId: string;
		gateway: ConfigApplyBatchesGateway;
		snapshots: ConfigSnapshots;
		applies: ConfigApplies;
		audit: AuditLog;
		now?: () => number;
	}) {
		this.db = options.db;
		this.tenantId = options.tenantId;
		this.gateway = options.gateway;
		this.snapshots = options.snapshots;
		this.applies = options.applies;
		this.audit = options.audit;
		this.now = options.now ?? Date.now;
	}

	/** 全Device・target・lockを検証してから親と全itemを一度に永続化する。 */
	create(input: ConfigApplyBatchCreateInput): ConfigApplyBatchView {
		const confirmationMode = input.confirmationMode ?? "batch";
		if (confirmationMode !== "batch" && confirmationMode !== "per_device") {
			throw new ConfigApplyBatchValidationError("invalid_confirmation_mode");
		}
		if (
			input.saveAfterApply !== undefined &&
			typeof input.saveAfterApply !== "boolean"
		) {
			throw new ConfigApplyBatchValidationError("invalid_save_after_apply");
		}
		const resolved = this.resolveTargets(input.source);
		const seen = new Set<string>();
		for (const target of resolved.targets) {
			if (seen.has(target.deviceId)) {
				throw new ConfigApplyBatchValidationError(
					"duplicate_device_ids",
					"a Device may appear only once in a Batch",
				);
			}
			seen.add(target.deviceId);
			if (this.gateway.presence(target.deviceId).status === "offline") {
				throw new ConfigApplyBatchValidationError(
					"device_offline",
					`Device ${target.deviceName} is offline`,
				);
			}
			const writeJob = this.db
				.prepare(
					`SELECT 1 FROM jobs WHERE tenant_id = ? AND device_id = ?
					 AND type IN ('config_save', 'reboot')
					 AND status IN ('queued', 'running') LIMIT 1`,
				)
				.get(this.tenantId, target.deviceId);
			if (writeJob) {
				throw new ConfigApplyBatchConflictError(
					`another write operation is already queued for ${target.deviceName}`,
				);
			}
		}

		const activeApply = this.db
			.prepare(
				`SELECT id FROM config_applies WHERE tenant_id = ?
				 AND phase IN ('prepare', 'confirm', 'transfer', 'activate', 'verify') LIMIT 1`,
			)
			.get(this.tenantId) as { id: string } | undefined;
		if (activeApply) {
			throw new ConfigApplyBatchConflictError(
				"another CONFIG Apply is already in progress for this Tenant",
			);
		}

		const id = randomUUID();
		const at = nowIso(new Date(this.now()));
		const items = resolved.targets.map((target, sequence) => ({
			id: randomUUID(),
			...target,
			sequence,
		}));
		this.db.transaction(() => {
			const existingLock = this.db
				.prepare(
					"SELECT owner_type, owner_id FROM config_apply_locks WHERE tenant_id = ?",
				)
				.get(this.tenantId) as
				| { owner_type: string; owner_id: string }
				| undefined;
			if (existingLock) {
				throw new ConfigApplyBatchConflictError(
					existingLock.owner_type === "batch"
						? `Batch ${existingLock.owner_id} already owns the Apply lock`
						: "another CONFIG Apply is already in progress for this Tenant",
				);
			}
			const stillActive = this.db
				.prepare(
					`SELECT id FROM config_applies WHERE tenant_id = ?
					 AND phase IN ('prepare', 'confirm', 'transfer', 'activate', 'verify') LIMIT 1`,
				)
				.get(this.tenantId);
			if (stillActive) {
				throw new ConfigApplyBatchConflictError(
					"another CONFIG Apply is already in progress for this Tenant",
				);
			}
			const revalidateTarget = this.db.prepare(
				`SELECT d.lifecycle_status, b.content_hash
			 FROM devices d
			 JOIN device_config_backups b ON b.device_id = d.id AND b.tenant_id = d.tenant_id
			 WHERE d.id = ? AND d.tenant_id = ? AND b.id = ?`,
			);
			for (const item of items) {
				const current = revalidateTarget.get(
					item.deviceId,
					this.tenantId,
					item.backupId,
				) as { lifecycle_status: string; content_hash: string } | undefined;
				if (!current || current.content_hash !== item.backupHash) {
					throw new DeviceNotFoundError("Device or backup not found");
				}
				if (current.lifecycle_status !== "active") {
					throw new ConfigApplyBatchValidationError(
						"device_not_active",
						`Device ${item.deviceName} is not active`,
					);
				}
			}
			this.db
				.prepare(
					`INSERT INTO config_apply_locks (tenant_id, owner_type, owner_id, acquired_at)
					 VALUES (?, 'batch', ?, ?)`,
				)
				.run(this.tenantId, id, at);
			this.db
				.prepare(
					`INSERT INTO config_apply_batches
					 (id, tenant_id, requested_by_user_id, source, source_checkpoint_id,
					  source_checkpoint_name, confirmation_mode, save_after_apply, status,
					  created_at, updated_at)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'preparing', ?, ?)`,
				)
				.run(
					id,
					this.tenantId,
					input.userId,
					resolved.source,
					resolved.checkpointId,
					resolved.checkpointName,
					confirmationMode,
					input.saveAfterApply ? 1 : 0,
					at,
					at,
				);
			const insertItem = this.db.prepare(
				`INSERT INTO config_apply_batch_items
				 (id, batch_id, sequence, device_id, device_name, target_backup_id,
				  target_content_hash, selected_for_execution, status, requested_at,
				  created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, 1, 'preparing', ?, ?, ?)`,
			);
			for (const item of items) {
				insertItem.run(
					item.id,
					id,
					item.sequence,
					item.deviceId,
					item.deviceName,
					item.backupId,
					item.backupHash,
					at,
					at,
					at,
				);
			}
			this.audit.record({
				type: AuditEventType.CONFIG_APPLY_BATCH_CREATED,
				actorUserId: input.userId,
				targetType: "config_apply_batch",
				targetId: id,
				detail: {
					batch_id: id,
					source: resolved.source,
					...(resolved.checkpointId
						? { checkpoint_id: resolved.checkpointId }
						: {}),
					device_count: items.length,
					confirmation_mode: confirmationMode,
					save_after_apply: input.saveAfterApply === true,
				},
			});
		})();

		for (const item of items) {
			try {
				this.snapshots.request(item.deviceId, "pre_apply", input.userId);
			} catch (error) {
				this.stopForPreparationFailure(
					id,
					item.id,
					errorCode(error, "prepare_request_failed"),
					input.userId,
				);
				break;
			}
		}
		return this.get(id);
	}

	list(): ConfigApplyBatchView[] {
		const rows = this.db
			.prepare(
				`SELECT * FROM config_apply_batches WHERE tenant_id = ?
				 ORDER BY created_at DESC, id DESC LIMIT 100`,
			)
			.all(this.tenantId) as BatchRow[];
		return rows.map((row) => this.view(row));
	}

	get(id: string): ConfigApplyBatchView {
		const row = this.batch(id);
		return this.view(row);
	}

	/** 計画確認前の実行順・対象を保存する。 */
	updatePlan(
		id: string,
		input: Array<{ itemId: string; selected: boolean }>,
		userId: string,
	): ConfigApplyBatchView {
		const batch = this.batch(id);
		if (
			batch.status !== "awaiting_confirmation" ||
			batch.confirmed_at !== null
		) {
			throw new ConfigApplyBatchConflictError(
				"Batch plan is no longer editable",
			);
		}
		const currentItems = this.items(id);
		if (
			!Array.isArray(input) ||
			input.length !== currentItems.length ||
			input.some(
				(item) =>
					typeof item.itemId !== "string" || typeof item.selected !== "boolean",
			) ||
			new Set(input.map((item) => item.itemId)).size !== currentItems.length ||
			input.some((item) => !currentItems.some((row) => row.id === item.itemId))
		) {
			throw new ConfigApplyBatchValidationError(
				"invalid_batch_plan",
				"plan must contain every Batch item exactly once",
			);
		}
		if (!input.some((item) => item.selected)) {
			throw new ConfigApplyBatchValidationError(
				"empty_batch_plan",
				"select at least one Device for execution",
			);
		}
		if (
			currentItems.some(
				(item) =>
					item.status !== "prepared" &&
					item.status !== "no_change" &&
					item.status !== "queued" &&
					item.status !== "awaiting_confirmation",
			)
		) {
			throw new ConfigApplyBatchConflictError("Batch plan has already started");
		}
		const at = nowIso(new Date(this.now()));
		this.db.transaction(() => {
			this.db
				.prepare(
					"UPDATE config_apply_batch_items SET sequence = -sequence - 1 WHERE batch_id = ?",
				)
				.run(id);
			const updateItem = this.db.prepare(
				`UPDATE config_apply_batch_items
				 SET sequence = ?, selected_for_execution = ?, status = ?, updated_at = ?
				 WHERE id = ? AND batch_id = ?`,
			);
			for (const [sequence, selection] of input.entries()) {
				const row = currentItems.find((item) => item.id === selection.itemId);
				const wasNoChange = row?.status === "no_change";
				const status = selection.selected
					? batch.confirmation_mode === "per_device"
						? sequence === input.findIndex((entry) => entry.selected)
							? "awaiting_confirmation"
							: "queued"
						: wasNoChange
							? "no_change"
							: "prepared"
					: "excluded";
				updateItem.run(
					sequence,
					selection.selected ? 1 : 0,
					status,
					at,
					selection.itemId,
					id,
				);
			}
			const firstSelected =
				input.find((selection) => selection.selected)?.itemId ?? null;
			this.db
				.prepare(
					"UPDATE config_apply_batches SET current_item_id = ?, updated_at = ? WHERE id = ? AND tenant_id = ?",
				)
				.run(
					batch.confirmation_mode === "per_device" ? firstSelected : null,
					at,
					id,
					this.tenantId,
				);
			this.audit.record({
				type: AuditEventType.CONFIG_APPLY_BATCH_PREPARED,
				actorUserId: userId,
				targetType: "config_apply_batch",
				targetId: id,
				detail: {
					batch_id: id,
					device_count: currentItems.length,
					result: "plan_updated",
				},
			});
		})();
		return this.get(id);
	}

	/** 計画全体を一度だけ確認するモードの実行承認。 */
	async confirmPlan(
		id: string,
		userId: string,
		acknowledged: boolean,
	): Promise<ConfigApplyBatchView> {
		if (acknowledged !== true) {
			throw new ConfigApplyBatchValidationError("acknowledgement_required");
		}
		const batch = this.batch(id);
		if (batch.confirmation_mode !== "batch") {
			throw new ConfigApplyBatchConflictError(
				"Device-by-Device confirmation is enabled for this Batch",
			);
		}
		this.requirePlanConfirmationAvailable(batch);
		const at = nowIso(new Date(this.now()));
		this.db.transaction(() => {
			this.db
				.prepare(
					`UPDATE config_apply_batches SET status = 'running', confirmed_at = ?,
					 current_item_id = NULL, updated_at = ? WHERE id = ? AND status = 'awaiting_confirmation'`,
				)
				.run(at, at, id);
			this.db
				.prepare(
					`UPDATE config_apply_batch_items SET status = 'queued', updated_at = ?
					 WHERE batch_id = ? AND selected_for_execution = 1
					   AND status IN ('prepared', 'no_change')`,
				)
				.run(at, id);
			this.db
				.prepare(
					`UPDATE config_apply_batch_items SET status = 'excluded', updated_at = ?
					 WHERE batch_id = ? AND selected_for_execution = 0
					   AND status <> 'excluded'`,
				)
				.run(at, id);
			this.audit.record({
				type: AuditEventType.CONFIG_APPLY_BATCH_CONFIRMED,
				actorUserId: userId,
				targetType: "config_apply_batch",
				targetId: id,
				detail: {
					batch_id: id,
					confirmation_mode: batch.confirmation_mode,
					device_count: this.items(id).filter(
						(item) => item.selected_for_execution === 1,
					).length,
				},
			});
		})();
		await this.startNext(id);
		return this.get(id);
	}

	/** Deviceごとに確認するモードで現在itemを承認する。 */
	async confirmItem(
		id: string,
		itemId: string,
		userId: string,
		acknowledged: boolean,
	): Promise<ConfigApplyBatchView> {
		if (acknowledged !== true) {
			throw new ConfigApplyBatchValidationError("acknowledgement_required");
		}
		const batch = this.batch(id);
		if (
			batch.confirmation_mode !== "per_device" ||
			batch.status !== "awaiting_confirmation" ||
			batch.current_item_id !== itemId
		) {
			throw new ConfigApplyBatchConflictError(
				"Batch item is not awaiting confirmation",
			);
		}
		const item = this.requireItem(id, itemId);
		if (
			this.now() - Date.parse(item.updated_at) >=
			CONFIG_APPLY_BATCH_CONFIRM_TTL_MS
		) {
			this.stopNow(id, "confirmation_expired", userId, itemId, "not_applied");
			throw new ConfigApplyBatchConflictError(
				"Batch item confirmation has expired",
			);
		}
		this.requireTenantBatchLock(id);
		const at = nowIso(new Date(this.now()));
		const updated = this.db
			.prepare(
				`UPDATE config_apply_batch_items SET status = 'guarding', confirmed_at = ?, updated_at = ?
				 WHERE id = ? AND batch_id = ? AND status = 'awaiting_confirmation'`,
			)
			.run(at, at, itemId, id);
		if (updated.changes === 0) {
			throw new ConfigApplyBatchConflictError(
				"Batch item is no longer awaiting confirmation",
			);
		}
		this.db
			.prepare(
				`UPDATE config_apply_batches SET status = 'running', confirmed_at = COALESCE(confirmed_at, ?),
				 updated_at = ? WHERE id = ? AND tenant_id = ?`,
			)
			.run(at, at, id, this.tenantId);
		this.audit.record({
			type: AuditEventType.CONFIG_APPLY_BATCH_CONFIRMED,
			actorUserId: userId,
			targetType: "config_apply_batch",
			targetId: id,
			detail: {
				batch_id: id,
				confirmation_mode: batch.confirmation_mode,
				device_count: 1,
			},
		});
		try {
			if (!item.device_id) throw new DeviceNotFoundError();
			this.snapshots.request(item.device_id, "pre_apply", userId);
		} catch (error) {
			this.stopForExecutionFailure(
				id,
				itemId,
				errorCode(error, "guard_request_failed"),
				userId,
			);
		}
		return this.get(id);
	}

	/** 確認前なら即時停止。子Applyが動作中なら終端化まで追跡する。 */
	async stop(id: string, userId: string): Promise<ConfigApplyBatchView> {
		const batch = this.batch(id);
		if (batch.status === "complete" || batch.status === "stopped") {
			throw new ConfigApplyBatchConflictError("Batch is already finished");
		}
		const item = batch.current_item_id
			? this.items(id).find(
					(candidate) => candidate.id === batch.current_item_id,
				)
			: undefined;
		if (item?.apply_id) {
			const child = this.applyChildState(item.apply_id);
			if (child?.phase === "confirm") {
				this.applies.failBatchChildBeforeLoad(id, item.id, userId);
			} else if (child?.phase === "failed") {
				await this.reconcileCurrent(id);
				return this.get(id);
			} else if (
				child &&
				["transfer", "activate", "verify", "complete"].includes(child.phase)
			) {
				const at = nowIso(new Date(this.now()));
				this.db
					.prepare(
						`UPDATE config_apply_batches SET status = 'stopping', stop_reason = 'admin_stopped', updated_at = ?
						 WHERE id = ? AND tenant_id = ?`,
					)
					.run(at, id, this.tenantId);
				await this.sweep();
				return this.get(id);
			}
		}
		this.stopNow(
			id,
			"admin_stopped",
			userId,
			item?.id,
			"not_applied",
			item?.apply_id ? "not_requested" : null,
		);
		return this.get(id);
	}

	/** pre_apply snapshotは準備中またはguard中の一itemだけが受け取る。 */
	async handleSnapshot(deviceId: string, result: IngestResult): Promise<void> {
		if (result.reason !== "pre_apply") return;
		const row = this.db
			.prepare(
				`SELECT i.id, i.batch_id, i.status FROM config_apply_batch_items i
				 JOIN config_apply_batches b ON b.id = i.batch_id
				 WHERE b.tenant_id = ? AND i.device_id = ?
				   AND b.status IN ('preparing', 'running')
				   AND i.status IN ('preparing', 'guarding')
				 ORDER BY i.created_at DESC LIMIT 1`,
			)
			.get(this.tenantId, deviceId) as
			| { id: string; batch_id: string; status: "preparing" | "guarding" }
			| undefined;
		if (!row) return;
		if (row.status === "preparing") {
			await this.handlePreparedSnapshot(row.batch_id, row.id, deviceId, result);
			return;
		}
		await this.handleGuardSnapshot(row.batch_id, row.id, deviceId, result);
	}

	/** operation/sweeperから呼び出す。自動再送・自動継続は行わない。 */
	async sweep(): Promise<void> {
		const batches = this.db
			.prepare(
				`SELECT * FROM config_apply_batches WHERE tenant_id = ?
				 AND status IN ('preparing', 'awaiting_confirmation', 'running', 'stopping')`,
			)
			.all(this.tenantId) as BatchRow[];
		for (const batch of batches) {
			if (batch.status === "preparing") {
				const expired = this.items(batch.id).find(
					(item) =>
						item.status === "preparing" &&
						this.now() - Date.parse(item.requested_at) >=
							CONFIG_APPLY_BATCH_PREPARE_TIMEOUT_MS,
				);
				if (expired) {
					this.stopForPreparationFailure(
						batch.id,
						expired.id,
						"prepare_timeout",
						batch.requested_by_user_id,
					);
				}
				continue;
			}
			if (batch.status === "awaiting_confirmation") {
				const current = batch.current_item_id
					? this.items(batch.id).find(
							(item) => item.id === batch.current_item_id,
						)
					: undefined;
				const createdAt =
					current?.status === "awaiting_confirmation"
						? current.updated_at
						: batch.plan_completed_at;
				if (
					createdAt &&
					this.now() - Date.parse(createdAt) >=
						CONFIG_APPLY_BATCH_CONFIRM_TTL_MS
				) {
					this.stopNow(
						batch.id,
						"confirmation_expired",
						batch.requested_by_user_id,
						current?.id,
						"not_applied",
					);
				}
				continue;
			}
			if (batch.status === "running" && batch.current_item_id) {
				const current = this.requireItem(batch.id, batch.current_item_id);
				if (
					current.status === "guarding" &&
					this.now() - Date.parse(current.updated_at) >=
						CONFIG_APPLY_BATCH_PREPARE_TIMEOUT_MS
				) {
					this.stopForExecutionFailure(
						batch.id,
						current.id,
						"guard_timeout",
						batch.requested_by_user_id,
					);
					continue;
				}
			}
			if (batch.status === "running" || batch.status === "stopping") {
				await this.reconcileCurrent(batch.id);
			}
		}
	}

	/** Server restart後は進行中Batchを再開せず、Apply結果を3群へ分類する。 */
	recoverAfterRestart(): number {
		const rows = this.db
			.prepare(
				`SELECT * FROM config_apply_batches WHERE tenant_id = ?
				 AND status IN ('preparing', 'awaiting_confirmation', 'running', 'stopping')`,
			)
			.all(this.tenantId) as BatchRow[];
		for (const batch of rows) {
			const item = batch.current_item_id
				? this.items(batch.id).find(
						(candidate) => candidate.id === batch.current_item_id,
					)
				: undefined;
			let effect: ConfigApplyEffect | null = null;
			let saveResult: ConfigApplyBatchSaveResult | null = null;
			if (item?.apply_id) {
				const child = this.applyChildState(item.apply_id);
				if (child?.phase === "complete" && child.apply_result === "matched") {
					effect = "confirmed";
					saveResult = child.save_after_apply
						? child.saved_at
							? "confirmed"
							: "unconfirmed"
						: "not_requested";
				} else if (child?.phase === "failed") {
					const applyWasVerifiedBeforeSaveFailure =
						child.verified_at !== null &&
						child.error_code !== "verify_mismatch" &&
						child.error_code !== "verify_unavailable" &&
						child.error_code !== "verify_timeout";
					effect = applyWasVerifiedBeforeSaveFailure
						? "confirmed"
						: child.activated_at
							? "unknown"
							: "not_applied";
					saveResult = applyWasVerifiedBeforeSaveFailure
						? "failed"
						: "not_requested";
				} else {
					effect = child?.activated_at ? "unknown" : "not_applied";
					saveResult = "not_requested";
				}
			}
			this.stopNow(
				batch.id,
				"server_restarted",
				batch.requested_by_user_id,
				item?.id,
				effect,
				saveResult,
			);
		}
		return rows.length;
	}

	private resolveTargets(source: ConfigApplyBatchCreateInput["source"]): {
		source: ConfigApplyBatchSource;
		checkpointId: string | null;
		checkpointName: string | null;
		targets: DeviceTarget[];
	} {
		if (source?.type === "checkpoint") {
			if (
				typeof source.checkpointId !== "string" ||
				source.checkpointId.length === 0
			) {
				throw new ConfigApplyBatchValidationError("invalid_checkpoint_id");
			}
			const checkpoint = this.db
				.prepare(
					"SELECT id, name FROM config_checkpoints WHERE id = ? AND tenant_id = ?",
				)
				.get(source.checkpointId, this.tenantId) as
				| { id: string; name: string }
				| undefined;
			if (!checkpoint)
				throw new ConfigApplyBatchNotFoundError("checkpoint not found");
			const rows = this.db
				.prepare(
					`SELECT i.device_id, i.device_name, i.backup_id, i.status,
					        b.content_hash, b.firmware_revision AS backup_firmware_revision,
					        d.name AS current_device_name, d.model, d.firmware_revision,
				        d.lifecycle_status
				 FROM config_checkpoint_items i
				 LEFT JOIN device_config_backups b ON b.id = i.backup_id
				 LEFT JOIN devices d ON d.id = i.device_id AND d.tenant_id = ?
				 WHERE i.checkpoint_id = ?
				 ORDER BY i.requested_at, i.id`,
				)
				.all(this.tenantId, checkpoint.id) as Array<{
				device_id: string | null;
				device_name: string;
				backup_id: string | null;
				status: string;
				content_hash: string | null;
				backup_firmware_revision: string | null;
				current_device_name: string | null;
				model: string | null;
				firmware_revision: string | null;
				lifecycle_status: string | null;
			}>;
			if (
				rows.length === 0 ||
				rows.length > MAX_CONFIG_APPLY_BATCH_DEVICES ||
				rows.some(
					(row) =>
						row.status !== "captured" ||
						!row.device_id ||
						!row.backup_id ||
						!row.content_hash ||
						!row.current_device_name ||
						row.lifecycle_status !== "active",
				)
			) {
				throw new ConfigApplyBatchValidationError(
					"checkpoint_incomplete",
					"Checkpoint must have a captured, available backup for every active Device",
				);
			}
			return {
				source: "checkpoint",
				checkpointId: checkpoint.id,
				checkpointName: checkpoint.name,
				targets: rows.map((row) => ({
					deviceId: row.device_id as string,
					backupId: row.backup_id as string,
					deviceName: row.device_name,
					model: row.model,
					firmwareRevision: row.firmware_revision,
					backupHash: row.content_hash as string,
					backupFirmwareRevision: row.backup_firmware_revision,
				})),
			};
		}

		if (source?.type !== "devices" || !Array.isArray(source.items)) {
			throw new ConfigApplyBatchValidationError("invalid_source");
		}
		if (
			source.items.length === 0 ||
			source.items.length > MAX_CONFIG_APPLY_BATCH_DEVICES ||
			source.items.some(
				(item) =>
					!item ||
					typeof item.deviceId !== "string" ||
					item.deviceId.length === 0 ||
					typeof item.backupId !== "string" ||
					item.backupId.length === 0,
			)
		) {
			throw new ConfigApplyBatchValidationError(
				"invalid_items",
				`select between 1 and ${MAX_CONFIG_APPLY_BATCH_DEVICES} Devices`,
			);
		}
		const targets = source.items.map(({ deviceId, backupId }) => {
			const row = this.db
				.prepare(
					`SELECT d.id AS device_id, d.name AS device_name, d.model,
					        d.firmware_revision, d.lifecycle_status,
					        b.id AS backup_id, b.content_hash AS backup_hash,
					        b.firmware_revision AS backup_firmware_revision
					 FROM devices d
				 JOIN device_config_backups b ON b.device_id = d.id AND b.tenant_id = d.tenant_id
				 WHERE d.id = ? AND d.tenant_id = ? AND b.id = ?`,
				)
				.get(deviceId, this.tenantId, backupId) as
				| {
						device_id: string;
						device_name: string;
						model: string | null;
						firmware_revision: string | null;
						lifecycle_status: string;
						backup_id: string;
						backup_hash: string;
						backup_firmware_revision: string | null;
				  }
				| undefined;
			if (!row) throw new DeviceNotFoundError("Device or backup not found");
			if (row.lifecycle_status !== "active") {
				throw new ConfigApplyBatchValidationError(
					"device_not_active",
					`Device ${row.device_name} is not active`,
				);
			}
			return {
				deviceId: row.device_id,
				backupId: row.backup_id,
				deviceName: row.device_name,
				model: row.model,
				firmwareRevision: row.firmware_revision,
				backupHash: row.backup_hash,
				backupFirmwareRevision: row.backup_firmware_revision,
			};
		});
		return {
			source: "devices",
			checkpointId: null,
			checkpointName: null,
			targets,
		};
	}

	private async handlePreparedSnapshot(
		batchId: string,
		itemId: string,
		deviceId: string,
		result: IngestResult,
	): Promise<void> {
		try {
			const item = this.requireItem(batchId, itemId);
			if (item.status !== "preparing") return;
			const targetRow = this.backupRow(deviceId, item.target_backup_id);
			if (!targetRow || targetRow.content_hash !== item.target_content_hash) {
				throw new ConfigApplyBatchValidationError("target_backup_unavailable");
			}
			const device = this.device(deviceId);
			const [target, prepared] = await Promise.all([
				this.snapshots.read(deviceId, item.target_backup_id),
				this.snapshots.read(deviceId, result.backupId),
			]);
			const validation = validationSummary(
				device,
				targetRow.firmware_revision,
				target.content,
			);
			const before = decodeConfig(prepared.content);
			const after = decodeConfig(target.content);
			const diff = createConfigDiff(before, after, {
				before: `prepared/${item.prepared_backup_id ?? result.backupId}`,
				after: `target/${item.target_backup_id}`,
			});
			const added = diff.lines.filter((line) => line.type === "added");
			const removed = diff.lines.filter((line) => line.type === "removed");
			const summary: ConfigApplyBatchPlanSummary = {
				changed: diff.changed,
				addedLines: added.length,
				removedLines: removed.length,
				risks: classifyConfigRisks(
					[...added, ...removed].map((line) => line.text),
				),
				validation,
			};
			const at = nowIso(new Date(this.now()));
			if (!validation.valid) {
				this.db
					.prepare(
						`UPDATE config_apply_batch_items SET prepared_backup_id = ?,
						 prepared_config_hash = ?, plan_summary = ?, updated_at = ?
						 WHERE id = ? AND batch_id = ? AND status = 'preparing'`,
					)
					.run(
						result.backupId,
						normalizedConfigHash(prepared.content),
						JSON.stringify(summary),
						at,
						itemId,
						batchId,
					);
				this.stopForPreparationFailure(
					batchId,
					itemId,
					validation.code ?? "target_invalid",
					this.batch(batchId).requested_by_user_id,
				);
				return;
			}
			validateConfigApplyTarget(device, targetRow, target.content);
			this.db
				.prepare(
					`UPDATE config_apply_batch_items
					 SET prepared_backup_id = ?, prepared_config_hash = ?, plan_summary = ?,
					     status = ?, updated_at = ?
					 WHERE id = ? AND batch_id = ? AND status = 'preparing'`,
				)
				.run(
					result.backupId,
					normalizedConfigHash(prepared.content),
					JSON.stringify(summary),
					diff.changed ? "prepared" : "no_change",
					at,
					itemId,
					batchId,
				);
			this.finishPreparationIfReady(batchId);
		} catch (error) {
			this.stopForPreparationFailure(
				batchId,
				itemId,
				errorCode(error, "prepare_failed"),
				this.batch(batchId).requested_by_user_id,
			);
		}
	}

	private async handleGuardSnapshot(
		batchId: string,
		itemId: string,
		deviceId: string,
		result: IngestResult,
	): Promise<void> {
		const batch = this.batch(batchId);
		if (batch.status !== "running" || batch.current_item_id !== itemId) return;
		const item = this.requireItem(batchId, itemId);
		if (item.status !== "guarding" || !item.prepared_config_hash) return;
		let guardContent: Uint8Array;
		try {
			guardContent = (await this.snapshots.read(deviceId, result.backupId))
				.content;
		} catch (error) {
			this.stopForExecutionFailure(
				batchId,
				itemId,
				errorCode(error, "guard_snapshot_unavailable"),
				batch.requested_by_user_id,
			);
			return;
		}
		const guardHash = normalizedConfigHash(guardContent);
		const at = nowIso(new Date(this.now()));
		this.db
			.prepare(
				`UPDATE config_apply_batch_items
				 SET execution_check_backup_id = ?, execution_check_config_hash = ?, updated_at = ?
				 WHERE id = ? AND batch_id = ? AND status = 'guarding'`,
			)
			.run(result.backupId, guardHash, at, itemId, batchId);
		if (guardHash !== item.prepared_config_hash) {
			this.stopForExecutionFailure(
				batchId,
				itemId,
				"prepared_config_changed",
				batch.requested_by_user_id,
			);
			return;
		}

		const summary = parsePlan(item.plan_summary);
		if (summary && !summary.changed) {
			this.finishNoChange(batchId, itemId);
			await this.startNext(batchId);
			return;
		}
		try {
			if (!item.device_id) throw new DeviceNotFoundError();
			const child = await this.applies.prepareBatchChild({
				batchId,
				batchItemId: itemId,
				deviceId,
				targetBackupId: item.target_backup_id,
				targetContentHash: item.target_content_hash,
				preApplyBackupId: result.backupId,
				userId: batch.requested_by_user_id ?? "",
			});
			await this.applies.confirm({
				deviceId,
				applyId: child.id,
				userId: batch.requested_by_user_id ?? "",
				saveAfterApply: batch.save_after_apply === 1,
				acknowledged: true,
				batchId,
			});
		} catch (error) {
			this.applies.failBatchChildBeforeLoad(
				batchId,
				itemId,
				batch.requested_by_user_id,
			);
			this.stopForExecutionFailure(
				batchId,
				itemId,
				errorCode(error, "apply_failed"),
				batch.requested_by_user_id,
			);
		}
	}

	private finishPreparationIfReady(batchId: string): void {
		const pending = this.db
			.prepare(
				`SELECT COUNT(*) AS count FROM config_apply_batch_items
				 WHERE batch_id = ? AND status = 'preparing'`,
			)
			.get(batchId) as { count: number };
		if (pending.count > 0) return;
		const at = nowIso(new Date(this.now()));
		this.db.transaction(() => {
			const changed = this.db
				.prepare(
					`UPDATE config_apply_batches SET status = 'awaiting_confirmation',
					 plan_completed_at = ?, updated_at = ? WHERE id = ? AND status = 'preparing'`,
				)
				.run(at, at, batchId);
			if (changed.changes === 0) return;
			const batch = this.batch(batchId);
			const items = this.items(batchId).filter(
				(item) => item.selected_for_execution === 1,
			);
			if (batch.confirmation_mode === "per_device") {
				this.db
					.prepare(
						`UPDATE config_apply_batch_items SET status = 'queued', updated_at = ?
						 WHERE batch_id = ? AND selected_for_execution = 1
						   AND status IN ('prepared', 'no_change')`,
					)
					.run(at, batchId);
			}
			if (batch.confirmation_mode === "per_device" && items[0]) {
				this.db
					.prepare(
						`UPDATE config_apply_batch_items SET status = 'awaiting_confirmation', updated_at = ?
						 WHERE id = ? AND batch_id = ? AND status = 'queued'`,
					)
					.run(at, items[0].id, batchId);
				this.db
					.prepare(
						"UPDATE config_apply_batches SET current_item_id = ?, updated_at = ? WHERE id = ?",
					)
					.run(items[0].id, at, batchId);
			}
			this.audit.record({
				type: AuditEventType.CONFIG_APPLY_BATCH_PREPARED,
				actorUserId: batch.requested_by_user_id,
				targetType: "config_apply_batch",
				targetId: batchId,
				detail: {
					batch_id: batchId,
					device_count: this.items(batchId).length,
					result: "ready",
				},
			});
		})();
	}

	private async startNext(batchId: string): Promise<void> {
		const batch = this.batch(batchId);
		if (batch.status !== "running") return;
		const next = this.db
			.prepare(
				`SELECT * FROM config_apply_batch_items
				 WHERE batch_id = ? AND status = 'queued' AND selected_for_execution = 1
				 ORDER BY sequence LIMIT 1`,
			)
			.get(batchId) as BatchItemRow | undefined;
		if (!next) {
			this.finishComplete(batchId);
			return;
		}
		const at = nowIso(new Date(this.now()));
		if (batch.confirmation_mode === "per_device") {
			this.db.transaction(() => {
				this.db
					.prepare(
						`UPDATE config_apply_batch_items SET status = 'awaiting_confirmation', updated_at = ?
						 WHERE id = ? AND batch_id = ? AND status = 'queued'`,
					)
					.run(at, next.id, batchId);
				this.db
					.prepare(
						"UPDATE config_apply_batches SET status = 'awaiting_confirmation', current_item_id = ?, updated_at = ? WHERE id = ?",
					)
					.run(next.id, at, batchId);
			})();
			return;
		}
		this.db.transaction(() => {
			this.db
				.prepare(
					`UPDATE config_apply_batch_items SET status = 'guarding', updated_at = ?
					 WHERE id = ? AND batch_id = ? AND status = 'queued'`,
				)
				.run(at, next.id, batchId);
			this.db
				.prepare(
					"UPDATE config_apply_batches SET current_item_id = ?, updated_at = ? WHERE id = ?",
				)
				.run(next.id, at, batchId);
		})();
		try {
			if (!next.device_id) throw new DeviceNotFoundError();
			this.snapshots.request(
				next.device_id,
				"pre_apply",
				batch.requested_by_user_id ?? undefined,
			);
		} catch (error) {
			this.stopForExecutionFailure(
				batchId,
				next.id,
				errorCode(error, "guard_request_failed"),
				batch.requested_by_user_id,
			);
		}
	}

	private async reconcileCurrent(batchId: string): Promise<void> {
		const batch = this.batch(batchId);
		if (!batch.current_item_id) {
			if (batch.status === "running") await this.startNext(batchId);
			return;
		}
		const item = this.requireItem(batchId, batch.current_item_id);
		if (!item.apply_id) return;
		const child = this.applyChildState(item.apply_id);
		if (!child) {
			this.stopForExecutionFailure(
				batchId,
				item.id,
				"apply_unavailable",
				batch.requested_by_user_id,
			);
			return;
		}
		if (child.phase === "failed") {
			const verifiedApplyFailedOnSave =
				child.verified_at !== null &&
				child.error_code !== "verify_mismatch" &&
				child.error_code !== "verify_unavailable" &&
				child.error_code !== "verify_timeout";
			const effect: ConfigApplyEffect = verifiedApplyFailedOnSave
				? "confirmed"
				: child.activated_at
					? "unknown"
					: "not_applied";
			this.failCurrentAndStop(
				batchId,
				item.id,
				child.error_code ?? "apply_failed",
				effect,
				batch.requested_by_user_id,
				verifiedApplyFailedOnSave ? "failed" : undefined,
			);
			return;
		}
		if (child.phase !== "complete" || child.apply_result !== "matched") return;
		if (batch.save_after_apply === 1) {
			if (child.saved_at) {
				this.finishApplied(batchId, item.id, "confirmed", "confirmed");
				if (batch.status === "stopping")
					this.finishStoppedAfterCurrent(batchId);
				else await this.startNext(batchId);
				return;
			}
			if (
				child.job_status === "failed" ||
				child.job_status === "timeout" ||
				child.job_status === "cancelled"
			) {
				this.failCurrentAndStop(
					batchId,
					item.id,
					"save_failed",
					"confirmed",
					batch.requested_by_user_id,
					"failed",
				);
				return;
			}
			if (
				child.job_status === "success" &&
				child.job_finished_at &&
				this.now() - Date.parse(child.job_finished_at) >=
					CONFIG_APPLY_BATCH_SAVE_CONFIRM_TIMEOUT_MS
			) {
				this.failCurrentAndStop(
					batchId,
					item.id,
					"save_confirmation_timeout",
					"confirmed",
					batch.requested_by_user_id,
					"unconfirmed",
				);
			}
			return;
		}
		this.finishApplied(batchId, item.id, "confirmed", "not_requested");
		if (batch.status === "stopping") this.finishStoppedAfterCurrent(batchId);
		else await this.startNext(batchId);
	}

	private applyChildState(applyId: string): ApplyChildState | undefined {
		return this.db
			.prepare(
				`SELECT ca.phase, ca.apply_result, ca.error_code, ca.activated_at, ca.verified_at,
				        ca.saved_at, ca.save_after_apply, ca.save_job_id, ca.updated_at,
				        j.status AS job_status, j.finished_at AS job_finished_at
				 FROM config_applies ca
				 LEFT JOIN jobs j ON j.id = ca.save_job_id AND j.tenant_id = ca.tenant_id
				 WHERE ca.id = ? AND ca.tenant_id = ?`,
			)
			.get(applyId, this.tenantId) as ApplyChildState | undefined;
	}

	private finishNoChange(batchId: string, itemId: string): void {
		const at = nowIso(new Date(this.now()));
		this.db
			.prepare(
				`UPDATE config_apply_batch_items SET status = 'no_change', apply_effect = NULL,
				 save_result = 'not_requested', finished_at = ?, updated_at = ?
				 WHERE id = ? AND batch_id = ? AND status = 'guarding'`,
			)
			.run(at, at, itemId, batchId);
	}

	private finishApplied(
		batchId: string,
		itemId: string,
		effect: ConfigApplyEffect,
		saveResult: ConfigApplyBatchSaveResult,
	): void {
		const at = nowIso(new Date(this.now()));
		this.db
			.prepare(
				`UPDATE config_apply_batch_items SET status = 'applied', apply_effect = ?,
				 save_result = ?, failure_code = NULL, finished_at = ?, updated_at = ?
				 WHERE id = ? AND batch_id = ? AND status = 'applying'`,
			)
			.run(effect, saveResult, at, at, itemId, batchId);
	}

	private stopForPreparationFailure(
		batchId: string,
		itemId: string,
		code: string,
		userId: string | null,
	): void {
		this.failCurrentAndStop(batchId, itemId, code, "not_applied", userId);
	}

	private stopForExecutionFailure(
		batchId: string,
		itemId: string,
		code: string,
		userId: string | null,
	): void {
		this.failCurrentAndStop(batchId, itemId, code, "not_applied", userId);
	}

	private failCurrentAndStop(
		batchId: string,
		itemId: string,
		code: string,
		effect: ConfigApplyEffect,
		userId: string | null,
		saveResult?: ConfigApplyBatchSaveResult,
	): void {
		const batch = this.batch(batchId);
		if (batch.status === "stopped" || batch.status === "complete") return;
		const at = nowIso(new Date(this.now()));
		const finalSaveResult = saveResult ?? "not_requested";
		this.db.transaction(() => {
			this.db
				.prepare(
					`UPDATE config_apply_batch_items SET status = 'failed', failure_code = ?,
					 apply_effect = ?, save_result = COALESCE(?, save_result), finished_at = ?, updated_at = ?
					 WHERE id = ? AND batch_id = ? AND status NOT IN ('applied', 'failed', 'skipped', 'excluded')`,
				)
				.run(code, effect, finalSaveResult, at, at, itemId, batchId);
			this.db
				.prepare(
					`UPDATE config_apply_batch_items SET status = 'skipped', apply_effect = 'not_applied',
					 failure_code = 'batch_stopped', finished_at = ?, updated_at = ?
					 WHERE batch_id = ? AND status IN ('preparing', 'prepared', 'no_change', 'queued', 'guarding', 'awaiting_confirmation')
					   AND id <> ? AND selected_for_execution = 1`,
				)
				.run(at, at, batchId, itemId);
			this.db
				.prepare(
					`UPDATE config_apply_batches SET status = 'stopped', stop_reason = ?,
					 current_item_id = ?, finished_at = ?, updated_at = ?
					 WHERE id = ? AND tenant_id = ?`,
				)
				.run(code, itemId, at, at, batchId, this.tenantId);
			this.db
				.prepare(
					"DELETE FROM config_apply_locks WHERE tenant_id = ? AND owner_type = 'batch' AND owner_id = ?",
				)
				.run(this.tenantId, batchId);
		})();
		this.recordBatchStopped(batchId, userId, code);
	}

	private stopNow(
		batchId: string,
		reason: string,
		userId: string | null,
		currentItemId?: string,
		currentEffect: ConfigApplyEffect | null = null,
		currentSaveResult: ConfigApplyBatchSaveResult | null = null,
	): void {
		const batch = this.batch(batchId);
		if (batch.status === "stopped" || batch.status === "complete") return;
		const at = nowIso(new Date(this.now()));
		const currentItem = currentItemId
			? this.requireItem(batchId, currentItemId)
			: undefined;
		const currentStatus =
			currentEffect === "confirmed"
				? "applied"
				: currentItem?.apply_id
					? "failed"
					: "skipped";
		this.db.transaction(() => {
			if (currentItemId) {
				this.db
					.prepare(
						`UPDATE config_apply_batch_items SET status = ?,
						 apply_effect = ?, save_result = COALESCE(?, save_result),
						 failure_code = ?, finished_at = ?, updated_at = ?
						 WHERE id = ? AND batch_id = ? AND status NOT IN ('applied', 'failed', 'skipped', 'excluded')`,
					)
					.run(
						currentStatus,
						currentEffect,
						currentSaveResult,
						reason,
						at,
						at,
						currentItemId,
						batchId,
					);
			}
			this.db
				.prepare(
					`UPDATE config_apply_batch_items SET status = 'skipped', apply_effect = 'not_applied',
					 failure_code = 'batch_stopped', finished_at = ?, updated_at = ?
					 WHERE batch_id = ? AND status IN ('preparing', 'prepared', 'no_change', 'queued', 'guarding', 'awaiting_confirmation')
					   AND selected_for_execution = 1 AND id <> COALESCE(?, '')`,
				)
				.run(at, at, batchId, currentItemId ?? null);
			this.db
				.prepare(
					`UPDATE config_apply_batches SET status = 'stopped', stop_reason = ?,
					 current_item_id = ?, finished_at = ?, updated_at = ? WHERE id = ? AND tenant_id = ?`,
				)
				.run(
					reason,
					currentItemId ?? batch.current_item_id,
					at,
					at,
					batchId,
					this.tenantId,
				);
			this.db
				.prepare(
					"DELETE FROM config_apply_locks WHERE tenant_id = ? AND owner_type = 'batch' AND owner_id = ?",
				)
				.run(this.tenantId, batchId);
		})();
		this.recordBatchStopped(batchId, userId, reason);
	}

	private finishStoppedAfterCurrent(batchId: string): void {
		const batch = this.batch(batchId);
		this.stopNow(
			batchId,
			batch.stop_reason ?? "admin_stopped",
			batch.requested_by_user_id,
		);
	}

	private finishComplete(batchId: string): void {
		const at = nowIso(new Date(this.now()));
		this.db.transaction(() => {
			this.db
				.prepare(
					`UPDATE config_apply_batches SET status = 'complete', current_item_id = NULL,
					 finished_at = ?, updated_at = ? WHERE id = ? AND tenant_id = ? AND status = 'running'`,
				)
				.run(at, at, batchId, this.tenantId);
			this.db
				.prepare(
					"DELETE FROM config_apply_locks WHERE tenant_id = ? AND owner_type = 'batch' AND owner_id = ?",
				)
				.run(this.tenantId, batchId);
			this.audit.record({
				type: AuditEventType.CONFIG_APPLY_BATCH_COMPLETED,
				actorUserId: this.batch(batchId).requested_by_user_id,
				targetType: "config_apply_batch",
				targetId: batchId,
				detail: {
					batch_id: batchId,
					result: "complete",
					device_count: this.items(batchId).filter(
						(item) => item.selected_for_execution === 1,
					).length,
				},
			});
		})();
	}

	private recordBatchStopped(
		batchId: string,
		userId: string | null,
		reason: string,
	): void {
		const already = this.db
			.prepare(
				`SELECT 1 FROM audit_events WHERE tenant_id = ? AND type = ? AND target_id = ? LIMIT 1`,
			)
			.get(this.tenantId, AuditEventType.CONFIG_APPLY_BATCH_STOPPED, batchId);
		if (already) return;
		this.audit.record({
			type: AuditEventType.CONFIG_APPLY_BATCH_STOPPED,
			actorUserId: userId,
			targetType: "config_apply_batch",
			targetId: batchId,
			detail: {
				batch_id: batchId,
				result: "stopped",
				stop_reason: reason,
				device_count: this.items(batchId).length,
			},
		});
	}

	private requirePlanConfirmationAvailable(batch: BatchRow): void {
		if (batch.status !== "awaiting_confirmation" || !batch.plan_completed_at) {
			throw new ConfigApplyBatchConflictError(
				"Batch plan is not ready for confirmation",
			);
		}
		if (
			this.now() - Date.parse(batch.plan_completed_at) >=
			CONFIG_APPLY_BATCH_CONFIRM_TTL_MS
		) {
			this.stopNow(
				batch.id,
				"confirmation_expired",
				batch.requested_by_user_id,
			);
			throw new ConfigApplyBatchConflictError(
				"Batch plan confirmation has expired",
			);
		}
		this.requireTenantBatchLock(batch.id);
	}

	private requireTenantBatchLock(batchId: string): void {
		const lock = this.db
			.prepare(
				"SELECT owner_type, owner_id FROM config_apply_locks WHERE tenant_id = ?",
			)
			.get(this.tenantId) as
			| { owner_type: string; owner_id: string }
			| undefined;
		if (lock?.owner_type !== "batch" || lock.owner_id !== batchId) {
			throw new ConfigApplyBatchConflictError(
				"Batch does not own the Tenant Apply lock",
			);
		}
	}

	private device(deviceId: string): {
		model: string | null;
		firmware_revision: string | null;
		lifecycle_status: string;
	} {
		const row = this.db
			.prepare(
				"SELECT model, firmware_revision, lifecycle_status FROM devices WHERE id = ? AND tenant_id = ?",
			)
			.get(deviceId, this.tenantId) as
			| {
					model: string | null;
					firmware_revision: string | null;
					lifecycle_status: string;
			  }
			| undefined;
		if (!row) throw new DeviceNotFoundError();
		return row;
	}

	private backupRow(
		deviceId: string,
		backupId: string,
	):
		| {
				id: string;
				content_hash: string;
				firmware_revision: string | null;
		  }
		| undefined {
		return this.db
			.prepare(
				`SELECT id, content_hash, firmware_revision FROM device_config_backups
				 WHERE id = ? AND device_id = ? AND tenant_id = ?`,
			)
			.get(backupId, deviceId, this.tenantId) as
			| { id: string; content_hash: string; firmware_revision: string | null }
			| undefined;
	}

	private batch(id: string): BatchRow {
		const row = this.db
			.prepare(
				"SELECT * FROM config_apply_batches WHERE id = ? AND tenant_id = ?",
			)
			.get(id, this.tenantId) as BatchRow | undefined;
		if (!row) throw new ConfigApplyBatchNotFoundError("Batch not found");
		return row;
	}

	private items(id: string): BatchItemRow[] {
		return this.db
			.prepare(
				"SELECT * FROM config_apply_batch_items WHERE batch_id = ? ORDER BY sequence",
			)
			.all(id) as BatchItemRow[];
	}

	private requireItem(batchId: string, itemId: string): BatchItemRow {
		const row = this.db
			.prepare(
				"SELECT * FROM config_apply_batch_items WHERE id = ? AND batch_id = ?",
			)
			.get(itemId, batchId) as BatchItemRow | undefined;
		if (!row) throw new ConfigApplyBatchNotFoundError("Batch item not found");
		return row;
	}

	private view(row: BatchRow): ConfigApplyBatchView {
		return {
			id: row.id,
			source: row.source,
			sourceCheckpointId: row.source_checkpoint_id,
			sourceCheckpointName: row.source_checkpoint_name,
			confirmationMode: row.confirmation_mode,
			saveAfterApply: row.save_after_apply === 1,
			status: row.status,
			currentItemId: row.current_item_id,
			stopReason: row.stop_reason,
			planCompletedAt: row.plan_completed_at,
			confirmedAt: row.confirmed_at,
			createdAt: row.created_at,
			updatedAt: row.updated_at,
			finishedAt: row.finished_at,
			items: this.items(row.id).map((item) => ({
				id: item.id,
				sequence: item.sequence,
				deviceId: item.device_id,
				deviceName: item.device_name,
				targetBackupId: item.target_backup_id,
				preparedBackupId: item.prepared_backup_id,
				executionCheckBackupId: item.execution_check_backup_id,
				selectedForExecution: item.selected_for_execution === 1,
				plan: parsePlan(item.plan_summary),
				status: item.status,
				failureCode: item.failure_code,
				applyId: item.apply_id,
				applyEffect: item.apply_effect,
				saveResult: item.save_result,
				requestedAt: item.requested_at,
				confirmedAt: item.confirmed_at,
				finishedAt: item.finished_at,
			})),
		};
	}
}

type ConfigApplyBatchesGateway = {
	presence(deviceId: string): { status: string };
};

function parsePlan(value: string | null): ConfigApplyBatchPlanSummary | null {
	if (!value) return null;
	try {
		return JSON.parse(value) as ConfigApplyBatchPlanSummary;
	} catch {
		return null;
	}
}

function validationSummary(
	device: { model: string | null; firmware_revision: string | null },
	backupFirmwareRevision: string | null,
	content: Uint8Array,
): ConfigApplyBatchPlanSummary["validation"] {
	const text = new TextDecoder("shift_jis").decode(content);
	const lines = text.replace(/\r\n?/g, "\n").split("\n");
	if (lines.at(-1) === "") lines.pop();
	const targetModel = /^#\s*(RTX\d+)\b/m.exec(text)?.[1] ?? null;
	const modelValid =
		targetModel && device.model
			? targetModel.toUpperCase() === device.model.toUpperCase()
			: null;
	const firmwareValid =
		backupFirmwareRevision && device.firmware_revision
			? normalizeRevision(backupFirmwareRevision) ===
				normalizeRevision(device.firmware_revision)
			: null;
	const lineCountValid = lines.length > 0 && lines.length < 2_000;
	const sizeValid = content.length > 0 && content.length <= 1024 * 1024;
	const supervisorPresent =
		/^schedule\s+at\s+.*\blua\s+\/routemon_bootstrap\.lua(?:\s|$)/m.test(text);
	let code: string | null = null;
	if (!sizeValid)
		code = content.length === 0 ? "target_empty" : "target_too_large";
	else if (!lineCountValid)
		code = lines.length === 0 ? "target_empty" : "target_too_many_lines";
	else if (!supervisorPresent) code = "supervisor_schedule_missing";
	else if (modelValid === false) code = "model_mismatch";
	else if (firmwareValid === false) code = "firmware_mismatch";
	return {
		valid: code === null,
		code,
		model: { expected: device.model, actual: targetModel, valid: modelValid },
		firmware: {
			expected: device.firmware_revision,
			actual: backupFirmwareRevision,
			valid: firmwareValid,
		},
		lineCount: { actual: lines.length, maximum: 1_999, valid: lineCountValid },
		sizeBytes: {
			actual: content.length,
			maximum: 1024 * 1024,
			valid: sizeValid,
		},
		supervisorAutostart: {
			present: supervisorPresent,
			valid: supervisorPresent,
		},
	};
}

function normalizeRevision(value: string): string {
	return value.trim().replace(/^rev\.?/i, "");
}

function errorCode(error: unknown, fallback: string): string {
	if (error instanceof ConfigApplyBatchValidationError) return error.code;
	if (error instanceof ConfigApplyValidationError) return error.code;
	if (error instanceof ConfigBackupNotFoundError) return "backup_unavailable";
	if (error instanceof DeviceNotFoundError) return "device_not_found";
	if (error instanceof DeviceNotConnectedError) return "device_offline";
	if (error instanceof ConfigApplyStateError) return "apply_state_conflict";
	return fallback;
}
