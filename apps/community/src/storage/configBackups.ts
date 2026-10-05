/**
 * CONFIG Backupのmetadataと世代管理(docs/core/config-backup-design.md §5)。
 *
 * 保持世代数は設定で決める。Communityの既定は30世代。
 */
import { randomUUID } from "node:crypto";
import type { ConfigBackupStorage } from "@routemon/core";
import { type Db, nowIso } from "./db.ts";

export const DEFAULT_GENERATIONS = 30;

export class ConfigBackupInUseError extends Error {
	readonly batchId: string;

	constructor(batchId: string) {
		super(`CONFIG backup is used by active Batch ${batchId}`);
		this.batchId = batchId;
	}
}

export type ConfigBackupInput = {
	tenantId: string;
	deviceId: string;
	config: Uint8Array;
	capturedAt?: Date;
	source?: string;
	firmwareRevision?: string | null;
	hostname?: string | null;
	createdByUserId?: string | null;
	/** 内容比較に使うkey(省略時はCONFIG本文のhash、#6) */
	dedupeKey?: string;
};

export type ConfigBackupRow = {
	id: string;
	device_id: string;
	storage_key: string;
	nonce: string;
	encryption_version: number;
	content_hash: string;
	dedupe_key: string | null;
	size_bytes: number;
	captured_at: string;
};

type DeviceConfigBackupStorage = ConfigBackupStorage & {
	deleteDevice?: (deviceId: string) => Promise<void>;
};

export class ConfigBackups {
	private readonly db: Db;
	private readonly storage: DeviceConfigBackupStorage;
	private readonly generations: number;

	constructor(
		db: Db,
		storage: DeviceConfigBackupStorage,
		generations = DEFAULT_GENERATIONS,
	) {
		this.db = db;
		this.storage = storage;
		this.generations = generations;
	}

	/** 同じ内容なら新しい世代を作らない(docs/core/config-backup-design.md §4)。 */
	async create(
		input: ConfigBackupInput,
	): Promise<{ id: string; created: boolean }> {
		const id = randomUUID();
		const capturedAt = nowIso(input.capturedAt ?? new Date());
		const stored = await this.storage.put(input.deviceId, id, input.config);
		const dedupeKey = input.dedupeKey ?? stored.contentHash;
		const latest = this.latest(input.deviceId);
		if (latest && (latest.dedupe_key ?? latest.content_hash) === dedupeKey) {
			await this.storage.delete(stored.storageKey);
			return { id: latest.id, created: false };
		}
		try {
			this.db
				.prepare(
					`INSERT INTO device_config_backups
					 (id, tenant_id, device_id, storage_key, content_hash, dedupe_key, size_bytes, encryption_version, nonce,
					  firmware_revision, hostname, source, created_by_user_id, captured_at, created_at)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				)
				.run(
					id,
					input.tenantId,
					input.deviceId,
					stored.storageKey,
					stored.contentHash,
					dedupeKey,
					stored.sizeBytes,
					stored.encryptionVersion,
					stored.nonce,
					input.firmwareRevision ?? null,
					input.hostname ?? null,
					input.source ?? "manual",
					input.createdByUserId ?? null,
					capturedAt,
					nowIso(),
				);
		} catch (error) {
			// DBへmetadataを書けなかった本文fileは孤児にしない。
			await this.storage.delete(stored.storageKey);
			throw error;
		}
		await this.prune(input.deviceId);
		return { id, created: true };
	}

	async read(id: string): Promise<Uint8Array> {
		const row = this.db
			.prepare("SELECT * FROM device_config_backups WHERE id = ?")
			.get(id) as ConfigBackupRow | undefined;
		if (!row) throw new Error(`config backup not found: ${id}`);
		return this.storage.get({
			storageKey: row.storage_key,
			nonce: row.nonce,
			encryptionVersion: row.encryption_version,
		});
	}

	list(deviceId: string): ConfigBackupRow[] {
		return this.db
			.prepare(
				"SELECT * FROM device_config_backups WHERE device_id = ? ORDER BY captured_at DESC, created_at DESC",
			)
			.all(deviceId) as ConfigBackupRow[];
	}

	latest(deviceId: string): ConfigBackupRow | undefined {
		return this.list(deviceId).at(0);
	}

	/** 保持世代数を超えた古い世代を、metadataと本文の両方から削除する。 */
	async prune(deviceId: string): Promise<number> {
		const protectedIds = new Set(
			(
				this.db
					.prepare(
						`SELECT DISTINCT i.target_backup_id, i.prepared_backup_id,
						                i.execution_check_backup_id
						 FROM config_apply_batch_items i
						 JOIN config_apply_batches b ON b.id = i.batch_id
						 WHERE i.device_id = ?
						   AND b.status IN ('preparing', 'awaiting_confirmation', 'running', 'stopping')`,
					)
					.all(deviceId) as Array<{
					target_backup_id: string | null;
					prepared_backup_id: string | null;
					execution_check_backup_id: string | null;
				}>
			).flatMap((row) => [
				row.target_backup_id,
				row.prepared_backup_id,
				row.execution_check_backup_id,
			]),
		);
		const extra = this.list(deviceId)
			.slice(this.generations)
			.filter((row) => !protectedIds.has(row.id));
		for (const row of extra) {
			await this.storage.delete(row.storage_key);
			this.db
				.prepare("DELETE FROM device_config_backups WHERE id = ?")
				.run(row.id);
		}
		return extra.length;
	}

	/** Device削除時にmetadataと暗号化本文をまとめて消す。 */
	async deleteDevice(deviceId: string): Promise<number> {
		const activeBatch = this.db
			.prepare(
				`SELECT b.id FROM config_apply_batch_items i
				 JOIN config_apply_batches b ON b.id = i.batch_id
				 WHERE i.device_id = ?
				   AND b.status IN ('preparing', 'awaiting_confirmation', 'running', 'stopping')
				 LIMIT 1`,
			)
			.get(deviceId) as { id: string } | undefined;
		if (activeBatch) throw new ConfigBackupInUseError(activeBatch.id);
		const rows = this.list(deviceId);
		if (this.storage.deleteDevice) {
			// Local storageではDBにない孤児fileも同時に掃除する。
			await this.storage.deleteDevice(deviceId);
		} else {
			for (const row of rows) await this.storage.delete(row.storage_key);
		}
		this.db
			.prepare("DELETE FROM device_config_backups WHERE device_id = ?")
			.run(deviceId);
		return rows.length;
	}
}
