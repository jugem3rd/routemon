/** 複数DeviceのCONFIG取得結果をcheckpointとして束ねる(#93)。 */
import { randomUUID } from "node:crypto";
import { DeviceNotConnectedError } from "@routemon/gateway";
import { AuditEventType, type AuditLog } from "../auth/audit.ts";
import { type Db, nowIso } from "../storage/db.ts";
import {
	type ConfigSnapshots,
	DeviceNotFoundError,
	type IngestResult,
} from "./configSnapshots.ts";

export const MAX_CHECKPOINT_DEVICES = 50;
export const CHECKPOINT_REQUEST_TIMEOUT_MS = 2 * 60 * 1000;
export const CHECKPOINT_SWEEP_INTERVAL_MS = 10_000;

export type ConfigCheckpointItemStatus = "pending" | "captured" | "failed";

export type ConfigCheckpointItem = {
	id: string;
	deviceId: string | null;
	deviceName: string;
	backupId: string | null;
	backupAvailable: boolean;
	status: ConfigCheckpointItemStatus;
	failureCode: string | null;
	requestedAt: string;
	capturedAt: string | null;
};

export type ConfigCheckpoint = {
	id: string;
	name: string;
	memo: string | null;
	createdAt: string;
	status: "pending" | "partial" | "captured" | "failed";
	capturedCount: number;
	pendingCount: number;
	failedCount: number;
	items: ConfigCheckpointItem[];
};

export class ConfigCheckpointValidationError extends Error {
	readonly code: string;

	constructor(code: string, message: string) {
		super(message);
		this.code = code;
	}
}

export class ConfigCheckpointNotFoundError extends Error {}
export class ConfigCheckpointBusyError extends Error {}

type CheckpointRow = {
	id: string;
	name: string;
	memo: string | null;
	created_at: string;
	item_id: string | null;
	device_id: string | null;
	device_name: string | null;
	backup_id: string | null;
	item_status: ConfigCheckpointItemStatus | null;
	failure_code: string | null;
	requested_at: string | null;
	captured_at: string | null;
};

export class ConfigCheckpoints {
	private readonly db: Db;
	private readonly tenantId: string;
	private readonly snapshots: ConfigSnapshots;
	private readonly audit: AuditLog;
	private readonly now: () => number;

	constructor(options: {
		db: Db;
		tenantId: string;
		snapshots: ConfigSnapshots;
		audit: AuditLog;
		now?: () => number;
	}) {
		this.db = options.db;
		this.tenantId = options.tenantId;
		this.snapshots = options.snapshots;
		this.audit = options.audit;
		this.now = options.now ?? Date.now;
	}

	/** WaiterをDBへ登録してからDeviceごとに再取得を要求する。 */
	create(input: {
		name: string;
		memo?: string | null;
		deviceIds: string[];
		userId: string;
	}): ConfigCheckpoint {
		const name = input.name.trim();
		const memo = input.memo?.trim() || null;
		if (name.length === 0 || name.length > 120) {
			throw new ConfigCheckpointValidationError(
				"invalid_name",
				"name must be between 1 and 120 characters",
			);
		}
		if (memo && memo.length > 4000) {
			throw new ConfigCheckpointValidationError(
				"invalid_memo",
				"memo must be 4000 characters or fewer",
			);
		}
		if (
			!Array.isArray(input.deviceIds) ||
			input.deviceIds.length === 0 ||
			input.deviceIds.length > MAX_CHECKPOINT_DEVICES ||
			input.deviceIds.some((id) => typeof id !== "string" || id.length === 0)
		) {
			throw new ConfigCheckpointValidationError(
				"invalid_device_ids",
				`select between 1 and ${MAX_CHECKPOINT_DEVICES} devices`,
			);
		}
		if (new Set(input.deviceIds).size !== input.deviceIds.length) {
			throw new ConfigCheckpointValidationError(
				"duplicate_device_ids",
				"deviceIds must not contain duplicates",
			);
		}

		const devices = this.findDevices(input.deviceIds);
		if (devices.length !== input.deviceIds.length) {
			throw new DeviceNotFoundError("one or more devices were not found");
		}
		const devicesById = new Map(devices.map((device) => [device.id, device]));
		const id = randomUUID();
		const at = nowIso(new Date(this.now()));
		const insertCheckpoint = this.db.prepare(
			`INSERT INTO config_checkpoints
			 (id, tenant_id, name, memo, created_by_user_id, created_at)
			 VALUES (?, ?, ?, ?, ?, ?)`,
		);
		const hasPending = this.db.prepare(
			"SELECT 1 FROM config_checkpoint_items WHERE device_id = ? AND status = 'pending' LIMIT 1",
		);
		const insertItem = this.db.prepare(
			`INSERT INTO config_checkpoint_items
			 (id, checkpoint_id, device_id, device_name, status, failure_code,
			  requested_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		);
		const items = input.deviceIds.map((deviceId) => {
			const device = devicesById.get(deviceId);
			if (!device) throw new DeviceNotFoundError();
			const busy = hasPending.get(deviceId) !== undefined;
			return {
				id: randomUUID(),
				deviceId,
				deviceName: device.name,
				status: busy ? ("failed" as const) : ("pending" as const),
				failureCode: busy ? "checkpoint_in_progress" : null,
			};
		});

		this.db.transaction(() => {
			insertCheckpoint.run(id, this.tenantId, name, memo, input.userId, at);
			for (const item of items) {
				insertItem.run(
					item.id,
					id,
					item.deviceId,
					item.deviceName,
					item.status,
					item.failureCode,
					at,
					at,
				);
			}
			this.audit.record({
				type: AuditEventType.CONFIG_CHECKPOINT_CREATED,
				actorUserId: input.userId,
				targetType: "config_checkpoint",
				targetId: id,
				detail: { device_count: items.length },
			});
		})();

		// All waiters are committed before the first request can produce an ingest.
		for (const item of items) {
			if (item.status !== "pending") continue;
			try {
				this.snapshots.request(item.deviceId, "checkpoint", input.userId);
			} catch (error) {
				const failureCode =
					error instanceof DeviceNotConnectedError
						? "device_offline"
						: error instanceof DeviceNotFoundError
							? "device_not_found"
							: "request_failed";
				this.fail(item.id, failureCode);
			}
		}
		return this.get(id);
	}

	list(): ConfigCheckpoint[] {
		this.expirePending();
		const rows = this.db
			.prepare(
				`SELECT c.id, c.name, c.memo, c.created_at,
				        i.id AS item_id, i.device_id, i.device_name, i.backup_id,
				        i.status AS item_status, i.failure_code, i.requested_at, i.captured_at
				 FROM config_checkpoints c
			 LEFT JOIN config_checkpoint_items i ON i.checkpoint_id = c.id
			 WHERE c.tenant_id = ?
			 ORDER BY c.created_at DESC, c.id DESC, i.device_name COLLATE NOCASE, i.id`,
			)
			.all(this.tenantId) as CheckpointRow[];
		return groupCheckpoints(rows);
	}

	get(id: string): ConfigCheckpoint {
		const checkpoint = this.list().find((item) => item.id === id);
		if (!checkpoint) throw new ConfigCheckpointNotFoundError();
		return checkpoint;
	}

	delete(id: string, userId: string): void {
		this.expirePending();
		const checkpoint = this.db
			.prepare(
				"SELECT id FROM config_checkpoints WHERE id = ? AND tenant_id = ?",
			)
			.get(id, this.tenantId) as { id: string } | undefined;
		if (!checkpoint) throw new ConfigCheckpointNotFoundError();
		const pending = this.db
			.prepare(
				"SELECT 1 FROM config_checkpoint_items WHERE checkpoint_id = ? AND status = 'pending' LIMIT 1",
			)
			.get(id);
		if (pending) throw new ConfigCheckpointBusyError();
		this.db.transaction(() => {
			this.audit.record({
				type: AuditEventType.CONFIG_CHECKPOINT_DELETED,
				actorUserId: userId,
				targetType: "config_checkpoint",
				targetId: id,
			});
			this.db
				.prepare(
					"DELETE FROM config_checkpoints WHERE id = ? AND tenant_id = ?",
				)
				.run(id, this.tenantId);
		})();
	}

	/** reason=checkpointで保存された世代を、唯一のDevice waiterへ結び付ける。 */
	handleSnapshot(deviceId: string, result: IngestResult): void {
		if (result.reason !== "checkpoint") return;
		const item = this.db
			.prepare(
				`SELECT i.id FROM config_checkpoint_items i
				 JOIN config_checkpoints c ON c.id = i.checkpoint_id
				 WHERE c.tenant_id = ? AND i.device_id = ? AND i.status = 'pending'
				 ORDER BY i.requested_at, i.id LIMIT 1`,
			)
			.get(this.tenantId, deviceId) as { id: string } | undefined;
		if (!item) return;
		const backup = this.db
			.prepare(
				`SELECT captured_at FROM device_config_backups
				 WHERE id = ? AND device_id = ? AND tenant_id = ?`,
			)
			.get(result.backupId, deviceId, this.tenantId) as
			| { captured_at: string }
			| undefined;
		if (!backup) {
			this.fail(item.id, "backup_unavailable");
			return;
		}
		const at = nowIso(new Date(this.now()));
		this.db
			.prepare(
				`UPDATE config_checkpoint_items
				 SET backup_id = ?, status = 'captured', failure_code = NULL,
				     captured_at = ?, updated_at = ?
				 WHERE id = ? AND status = 'pending'`,
			)
			.run(result.backupId, backup.captured_at, at, item.id);
	}

	/** Timed out waiters fail and release the per-Device lock. */
	expirePending(): number {
		const at = nowIso(new Date(this.now()));
		const cutoff = nowIso(new Date(this.now() - CHECKPOINT_REQUEST_TIMEOUT_MS));
		return this.db
			.prepare(
				`UPDATE config_checkpoint_items
				 SET status = 'failed', failure_code = 'response_timeout', updated_at = ?
				 WHERE status = 'pending' AND requested_at <= ?
				   AND checkpoint_id IN (
				     SELECT id FROM config_checkpoints WHERE tenant_id = ?
				   )`,
			)
			.run(at, cutoff, this.tenantId).changes;
	}

	/** A server restart clears in-memory Gateway queues, so old waiters cannot complete. */
	recoverAfterRestart(): number {
		const at = nowIso(new Date(this.now()));
		return this.db
			.prepare(
				`UPDATE config_checkpoint_items
				 SET status = 'failed', failure_code = 'server_restarted', updated_at = ?
				 WHERE status = 'pending' AND checkpoint_id IN (
				   SELECT id FROM config_checkpoints WHERE tenant_id = ?
				 )`,
			)
			.run(at, this.tenantId).changes;
	}

	private fail(itemId: string, failureCode: string): void {
		this.db
			.prepare(
				`UPDATE config_checkpoint_items
				 SET status = 'failed', failure_code = ?, updated_at = ?
				 WHERE id = ? AND status = 'pending' AND checkpoint_id IN (
				   SELECT id FROM config_checkpoints WHERE tenant_id = ?
				 )`,
			)
			.run(failureCode, nowIso(new Date(this.now())), itemId, this.tenantId);
	}

	private findDevices(deviceIds: string[]): { id: string; name: string }[] {
		const placeholders = deviceIds.map(() => "?").join(", ");
		return this.db
			.prepare(
				`SELECT id, name FROM devices WHERE tenant_id = ? AND id IN (${placeholders})`,
			)
			.all(this.tenantId, ...deviceIds) as { id: string; name: string }[];
	}
}

function groupCheckpoints(rows: CheckpointRow[]): ConfigCheckpoint[] {
	const checkpoints = new Map<string, ConfigCheckpoint>();
	for (const row of rows) {
		let checkpoint = checkpoints.get(row.id);
		if (!checkpoint) {
			checkpoint = {
				id: row.id,
				name: row.name,
				memo: row.memo,
				createdAt: row.created_at,
				status: "pending",
				capturedCount: 0,
				pendingCount: 0,
				failedCount: 0,
				items: [],
			};
			checkpoints.set(row.id, checkpoint);
		}
		if (!row.item_id || !row.item_status || !row.device_name) continue;
		const item: ConfigCheckpointItem = {
			id: row.item_id,
			deviceId: row.device_id,
			deviceName: row.device_name,
			backupId: row.backup_id,
			backupAvailable: row.item_status === "captured" && row.backup_id !== null,
			status: row.item_status,
			failureCode: row.failure_code,
			requestedAt: row.requested_at ?? row.created_at,
			capturedAt: row.captured_at,
		};
		checkpoint.items.push(item);
		if (item.status === "captured") checkpoint.capturedCount += 1;
		else if (item.status === "failed") checkpoint.failedCount += 1;
		else checkpoint.pendingCount += 1;
	}
	for (const checkpoint of checkpoints.values()) {
		if (checkpoint.pendingCount > 0) checkpoint.status = "pending";
		else if (checkpoint.failedCount === 0) checkpoint.status = "captured";
		else if (checkpoint.capturedCount > 0) checkpoint.status = "partial";
		else checkpoint.status = "failed";
	}
	return [...checkpoints.values()];
}
