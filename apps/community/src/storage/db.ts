/**
 * Community SQLite(docs/community/storage-backup-design.md、docs/community/database-design.md)。
 *
 * WAL、foreign_keys、busy_timeoutを有効にし、schema versionをmigrationで進める。
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

export type Db = Database.Database;

const MIGRATIONS_DIR = join(
	dirname(fileURLToPath(import.meta.url)),
	"migrations",
);
const BUSY_TIMEOUT_MS = 5000;

export function openDatabase(file: string): Db {
	const db = new Database(file);
	db.pragma("journal_mode = WAL");
	db.pragma("foreign_keys = ON");
	db.pragma(`busy_timeout = ${BUSY_TIMEOUT_MS}`);
	db.exec(
		"CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL)",
	);
	return db;
}

export function schemaVersion(db: Db): string | null {
	const row = db
		.prepare(
			"SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1",
		)
		.get() as { version: string } | undefined;
	return row?.version ?? null;
}

export function pendingMigrations(db: Db, dir = MIGRATIONS_DIR): string[] {
	const applied = new Set(
		(
			db.prepare("SELECT version FROM schema_migrations").all() as {
				version: string;
			}[]
		).map((r) => r.version),
	);
	return readdirSync(dir)
		.filter((name) => name.endsWith(".sql"))
		.sort()
		.filter((name) => !applied.has(name));
}

/** 未適用のmigrationを順に適用する。1つでも失敗したらその分は巻き戻す。 */
export function migrate(db: Db, dir = MIGRATIONS_DIR): string[] {
	const applied: string[] = [];
	for (const name of pendingMigrations(db, dir)) {
		const sql = readFileSync(join(dir, name), "utf8");
		db.transaction(() => {
			db.exec(sql);
			db.prepare(
				"INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)",
			).run(name, nowIso());
		})();
		applied.push(name);
	}
	return applied;
}

export function nowIso(at: Date = new Date()): string {
	return at.toISOString();
}

/**
 * 稼働中DBの一貫したsnapshotを取る(単純なファイルコピーはしない)。
 * better-sqlite3のbackup()はSQLite Backup APIを使う。
 */
export async function backupDatabase(
	db: Db,
	destination: string,
): Promise<void> {
	await db.backup(destination);
}
