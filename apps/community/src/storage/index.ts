/**
 * 永続領域の初期化(docs/community/storage-backup-design.md)。
 *
 * `/data`を作り、SQLiteを開いてmigrationを適用し、master keyとstorageを用意する。
 * migration前にはpre-upgrade snapshotを取り、失敗した場合は通常起動させない。
 */
import { join } from "node:path";
import { pruneBackupFiles, prunePreUpgradeSnapshots } from "./backup.ts";
import { LocalConfigBackupStorage } from "./configBackupStorage.ts";
import { ConfigBackups, DEFAULT_GENERATIONS } from "./configBackups.ts";
import {
	backupDatabase,
	type Db,
	migrate,
	nowIso,
	openDatabase,
	pendingMigrations,
	schemaVersion,
} from "./db.ts";
import { loadOrCreateMasterKey } from "./masterKey.ts";
import { type DataPaths, dataPaths, ensureDataLayout } from "./paths.ts";
import { LocalSyslogStorage } from "./syslogStorage.ts";

export const DEFAULT_TENANT_ID = "default";

export type Storage = {
	paths: DataPaths;
	db: Db;
	tenantId: string;
	configBackups: ConfigBackups;
	syslog: LocalSyslogStorage;
	deleteDeviceData(deviceId: string): Promise<void>;
	close(): void;
};

export type OpenStorageOptions = {
	root?: string;
	configGenerations?: number;
	/** 既定は apps/community/src/storage/migrations(テスト用に差し替える) */
	migrationsDir?: string;
};

export async function openStorage(
	options: OpenStorageOptions = {},
): Promise<Storage> {
	const paths = ensureDataLayout(dataPaths(options.root));
	const db = openDatabase(paths.database);
	const before = schemaVersion(db);
	if (before && pendingMigrations(db, options.migrationsDir).length > 0) {
		const snapshot = join(
			paths.backups,
			`pre-upgrade-${nowIso().replace(/[:.]/g, "-")}.db`,
		);
		await backupDatabase(db, snapshot);
		console.log(`pre-upgrade snapshot: ${snapshot}`);
	}
	// Backupは作成時だけでなく、起動時にも上限を適用する。これにより、
	// 新しいBackupを作らないInstanceでも古いsnapshotが溜まり続けない。
	pruneBackupFiles(paths);
	prunePreUpgradeSnapshots(paths);
	const applied = migrate(db, options.migrationsDir);
	if (applied.length > 0) {
		console.log(`applied migrations: ${applied.join(", ")}`);
	}

	const masterKey = loadOrCreateMasterKey(paths.masterKey);
	const configStorage = new LocalConfigBackupStorage(
		paths.configBackups,
		masterKey,
	);
	const configBackups = new ConfigBackups(
		db,
		configStorage,
		options.configGenerations ?? DEFAULT_GENERATIONS,
	);
	const syslog = new LocalSyslogStorage(paths.syslog);
	return {
		paths,
		db,
		tenantId: DEFAULT_TENANT_ID,
		configBackups,
		syslog,
		deleteDeviceData: async (deviceId: string) => {
			await configBackups.deleteDevice(deviceId);
			await syslog.deleteDevice(deviceId);
		},
		close: () => db.close(),
	};
}

export { createBackup, restoreBackup } from "./backup.ts";
/** Communityは1 Instance = 1 Tenant(docs/product/service-policy.md §4)。 */
export function ensureDefaultTenant(
	db: Db,
	tenantId = DEFAULT_TENANT_ID,
	name = "Routemon",
): string {
	const at = nowIso();
	db.prepare(
		"INSERT OR IGNORE INTO tenants (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)",
	).run(tenantId, name, at, at);
	return tenantId;
}

export { DEFAULT_GENERATIONS } from "./configBackups.ts";
export { dataPaths, ensureDataLayout } from "./paths.ts";
export { DEFAULT_SYSLOG_POLICY } from "./syslogStorage.ts";
