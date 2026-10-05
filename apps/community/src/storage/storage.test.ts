import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
	createBackup,
	pruneBackupFiles,
	prunePreUpgradeSnapshots,
	restoreBackup,
} from "./backup.ts";
import { LocalConfigBackupStorage } from "./configBackupStorage.ts";
import { openDatabase, pendingMigrations, schemaVersion } from "./db.ts";
import { openStorage } from "./index.ts";
import { loadOrCreateMasterKey } from "./masterKey.ts";
import { dataPaths, ensureDataLayout } from "./paths.ts";
import { LocalSyslogStorage } from "./syslogStorage.ts";

let root: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "routemon-test-"));
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

function seedTenantAndDevice(db: ReturnType<typeof openDatabase>) {
	const at = "2026-09-16T00:00:00.000Z";
	db.prepare(
		"INSERT INTO tenants (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)",
	).run("t1", "Tenant", at, at);
	db.prepare(
		"INSERT INTO devices (id, tenant_id, name, lifecycle_status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
	).run("d1", "t1", "RTX830", "active", at, at);
}

describe("database", () => {
	test("WAL / foreign_keys / busy_timeoutを有効にする", async () => {
		const storage = await openStorage({ root });
		try {
			expect(storage.db.pragma("journal_mode", { simple: true })).toBe("wal");
			expect(storage.db.pragma("foreign_keys", { simple: true })).toBe(1);
			expect(storage.db.pragma("busy_timeout", { simple: true })).toBe(5000);
		} finally {
			storage.close();
		}
	});

	test("migrationを適用し、2回目は何もしない", async () => {
		const first = await openStorage({ root });
		const version = schemaVersion(first.db);
		expect(version).toMatch(/\.sql$/);
		expect(pendingMigrations(first.db)).toEqual([]);
		first.close();

		const second = await openStorage({ root });
		expect(schemaVersion(second.db)).toBe(version);
		second.close();
	});

	test("foreign keyとCHECK制約が効く", async () => {
		const storage = await openStorage({ root });
		try {
			expect(() =>
				storage.db
					.prepare(
						"INSERT INTO devices (id, tenant_id, name, lifecycle_status, created_at, updated_at) VALUES ('d', 'missing', 'x', 'active', '', '')",
					)
					.run(),
			).toThrow(/FOREIGN KEY/);
			seedTenantAndDevice(storage.db);
			expect(() =>
				storage.db
					.prepare(
						"INSERT INTO devices (id, tenant_id, name, lifecycle_status, created_at, updated_at) VALUES ('d2', 't1', 'x', 'bogus', '', '')",
					)
					.run(),
			).toThrow(/CHECK/);
		} finally {
			storage.close();
		}
	});

	test("Presenceの現在値をdevicesへ持たない", async () => {
		const storage = await openStorage({ root });
		try {
			const columns = (
				storage.db.pragma("table_info(devices)") as { name: string }[]
			).map((c) => c.name);
			for (const forbidden of [
				"online",
				"agent_online",
				"agent_offline",
				"realtime_last_seen",
				"current_gateway_id",
			]) {
				expect(columns).not.toContain(forbidden);
			}
		} finally {
			storage.close();
		}
	});
});

describe("master key", () => {
	test("初回に生成し、次回以降は同じkeyを読む", () => {
		const paths = ensureDataLayout(dataPaths(root));
		const first = loadOrCreateMasterKey(paths.masterKey);
		expect(first).toHaveLength(32);
		expect(loadOrCreateMasterKey(paths.masterKey)).toEqual(first);
		expect(statSync(paths.masterKey).mode & 0o777).toBe(0o600);
	});
});

describe("config backup storage", () => {
	test("本文を平文でfilesystemへ置かず、復号できる", async () => {
		const paths = ensureDataLayout(dataPaths(root));
		const storage = new LocalConfigBackupStorage(
			paths.configBackups,
			loadOrCreateMasterKey(paths.masterKey),
		);
		const config = new TextEncoder().encode(
			"ip route default gateway pp 1\npp select 1\n",
		);
		const stored = await storage.put("d1", "b1", config);

		const raw = readFileSync(join(paths.configBackups, stored.storageKey));
		expect(raw.includes(Buffer.from("ip route"))).toBe(false);
		expect(await storage.get(stored)).toEqual(config);
	});

	test("改ざんされた本文は復号に失敗する", async () => {
		const paths = ensureDataLayout(dataPaths(root));
		const storage = new LocalConfigBackupStorage(
			paths.configBackups,
			loadOrCreateMasterKey(paths.masterKey),
		);
		const stored = await storage.put(
			"d1",
			"b1",
			new TextEncoder().encode("hello"),
		);
		const file = join(paths.configBackups, stored.storageKey);
		const body = readFileSync(file);
		body[0] = (body[0] as number) ^ 0xff;
		writeFileSync(file, body);
		await expect(storage.get(stored)).rejects.toThrow();
	});

	test("世代管理: 同一内容は世代を増やさず、上限を超えた古い世代を消す", async () => {
		const storage = await openStorage({ root, configGenerations: 3 });
		try {
			seedTenantAndDevice(storage.db);
			const backups = storage.configBackups;
			const first = await backups.create({
				tenantId: "t1",
				deviceId: "d1",
				config: enc("config v1"),
			});
			const same = await backups.create({
				tenantId: "t1",
				deviceId: "d1",
				config: enc("config v1"),
			});
			expect(same.created).toBe(false);
			expect(same.id).toBe(first.id);

			for (const v of ["v2", "v3", "v4"]) {
				await backups.create({
					tenantId: "t1",
					deviceId: "d1",
					config: enc(`config ${v}`),
				});
			}
			const rows = backups.list("d1");
			expect(rows).toHaveLength(3);
			const newest = rows[0];
			if (!newest) throw new Error("no backup");
			expect(new TextDecoder().decode(await backups.read(newest.id))).toBe(
				"config v4",
			);
			// 消した世代の本文fileも残らない
			const removed = join(
				storage.paths.configBackups,
				"d1",
				`${first.id}.enc`,
			);
			expect(existsSync(removed)).toBe(false);
		} finally {
			storage.close();
		}
	});

	test("Device削除時にCONFIGとSYSLOGのDevice配下を消す", async () => {
		const storage = await openStorage({ root });
		try {
			seedTenantAndDevice(storage.db);
			await storage.configBackups.create({
				tenantId: "t1",
				deviceId: "d1",
				config: enc("config to delete"),
			});
			const orphan = join(storage.paths.configBackups, "d1", "orphan.enc");
			writeFileSync(orphan, "orphan");
			await storage.syslog.append("d1", [
				{ ts: "2026-09-16T00:00:00.000Z", message: "to delete" },
			]);

			await storage.deleteDeviceData("d1");
			expect(
				(
					storage.db
						.prepare(
							"SELECT COUNT(*) AS count FROM device_config_backups WHERE device_id = ?",
						)
						.get("d1") as { count: number }
				).count,
			).toBe(0);
			expect(existsSync(join(storage.paths.configBackups, "d1"))).toBe(false);
			expect(existsSync(orphan)).toBe(false);
			expect((await storage.syslog.usage("d1")).usedBytes).toBe(0);
		} finally {
			storage.close();
		}
	});
});

describe("syslog storage", () => {
	test("gzip NDJSONで保存し、使用量を返す", async () => {
		const paths = ensureDataLayout(dataPaths(root));
		const syslog = new LocalSyslogStorage(paths.syslog);
		await syslog.append("d1", [
			{ ts: "2026-09-16T01:02:03.000Z", message: "PP[01] PPPoE connected" },
			{ ts: "2026-09-16T01:02:04.000Z", message: "TUNNEL[1] up" },
		]);
		const usage = await syslog.usage();
		expect(usage.usedBytes).toBeGreaterThan(0);
		const dir = join(paths.syslog, "d1");
		const found = execFileSync("find", [dir, "-name", "*.ndjson.gz"])
			.toString()
			.trim()
			.split("\n");
		expect(found).toHaveLength(1);
		const text = execFileSync("gunzip", ["-c", found[0] as string]).toString();
		expect(text.trim().split("\n")).toHaveLength(2);
		expect(JSON.parse(text.split("\n")[0] as string).message).toBe(
			"PP[01] PPPoE connected",
		);
	});

	test("retentionを超えたchunkを消す", async () => {
		const paths = ensureDataLayout(dataPaths(root));
		const syslog = new LocalSyslogStorage(paths.syslog);
		const old = new Date("2026-08-01T00:00:00.000Z");
		await syslog.append("d1", [{ ts: old.toISOString(), message: "old" }], old);
		execFileSync("find", [
			paths.syslog,
			"-name",
			"*.ndjson.gz",
			"-exec",
			"touch",
			"-t",
			"202608010000",
			"{}",
			";",
		]);
		await syslog.append(
			"d1",
			[{ ts: "2026-09-16T00:00:00.000Z", message: "new" }],
			new Date("2026-09-16T00:00:00.000Z"),
		);

		const result = await syslog.cleanup(
			{
				retentionDays: 30,
				maxBytes: 5 * 1024 * 1024 * 1024,
				lowWatermark: 0.9,
			},
			new Date("2026-09-16T00:00:00.000Z"),
		);
		expect(result.removedBytes).toBeGreaterThan(0);
		const remaining = execFileSync("find", [
			paths.syslog,
			"-name",
			"*.ndjson.gz",
		])
			.toString()
			.trim()
			.split("\n");
		expect(remaining).toHaveLength(1);
	});

	test("容量上限を超えたらlow watermarkまで古いものから消す", async () => {
		const paths = ensureDataLayout(dataPaths(root));
		const syslog = new LocalSyslogStorage(paths.syslog);
		for (let i = 0; i < 10; i++) {
			await syslog.append(
				"d1",
				[{ ts: `2026-09-16T00:00:0${i}.000Z`, message: "x".repeat(200) }],
				new Date(`2026-09-16T00:00:0${i}.000Z`),
			);
		}
		const before = await syslog.usage();
		const target = Math.floor(before.usedBytes / 2);
		await syslog.cleanup(
			{ retentionDays: 3650, maxBytes: target, lowWatermark: 0.9 },
			new Date("2026-09-16T01:00:00.000Z"),
		);
		const after = await syslog.usage();
		expect(after.usedBytes).toBeLessThanOrEqual(target * 0.9);
	});
});

describe("backup and restore", () => {
	test("Backup作成後に保持上限を自動適用する", async () => {
		const storage = await openStorage({ root });
		try {
			const retention = {
				maxGenerations: 2,
				maxBytes: Number.MAX_SAFE_INTEGER,
			};
			for (const version of ["v1", "v2", "v3"]) {
				await createBackup({
					paths: storage.paths,
					db: storage.db,
					out: join(storage.paths.backups, `routemon-backup-${version}.tar.gz`),
					retention,
				});
			}
			expect(
				listFiles(storage.paths.backups).filter((name) =>
					name.endsWith(".tar.gz"),
				).length,
			).toBe(2);
		} finally {
			storage.close();
		}
	});

	test("Instance Backupとpre-upgrade snapshotを件数・容量で整理する", () => {
		const paths = ensureDataLayout(dataPaths(root));
		const writeWithTime = (name: string, size: number, at: string) => {
			const file = join(paths.backups, name);
			writeFileSync(file, Buffer.alloc(size, 1));
			const date = new Date(at);
			utimesSync(file, date, date);
		};

		writeWithTime("routemon-backup-v1.tar.gz", 4, "2026-09-16T00:00:00.000Z");
		writeWithTime("routemon-backup-v2.tar.gz", 4, "2026-09-17T00:00:00.000Z");
		writeWithTime("routemon-backup-v3.tar.gz", 4, "2026-09-18T00:00:00.000Z");
		writeWithTime("routemon-backup-v4.tar.gz", 4, "2026-09-19T00:00:00.000Z");

		const result = pruneBackupFiles(paths, {
			maxGenerations: 3,
			maxBytes: 8,
		});
		expect(result.removed.map((file) => file.id)).toEqual([
			"routemon-backup-v1.tar.gz",
			"routemon-backup-v2.tar.gz",
		]);
		expect(listFiles(paths.backups)).toEqual([
			"routemon-backup-v3.tar.gz",
			"routemon-backup-v4.tar.gz",
		]);

		writeWithTime("pre-upgrade-v1.db", 3, "2026-09-16T00:00:00.000Z");
		writeWithTime("pre-upgrade-v2.db", 2, "2026-09-17T00:00:00.000Z");
		writeWithTime("pre-upgrade-v3.db", 1, "2026-09-18T00:00:00.000Z");
		writeFileSync(join(paths.backups, "other.db"), "keep");

		const snapshots = prunePreUpgradeSnapshots(paths, {
			maxSnapshots: 3,
			maxBytes: 5,
		});
		expect(snapshots.removed).toEqual(["pre-upgrade-v1.db"]);
		expect(listFiles(paths.backups)).toEqual([
			"other.db",
			"pre-upgrade-v2.db",
			"pre-upgrade-v3.db",
			"routemon-backup-v3.tar.gz",
			"routemon-backup-v4.tar.gz",
		]);
	});

	test("backupからclean instanceへrestoreし、暗号化CONFIGを復号できる", async () => {
		const source = await openStorage({ root });
		seedTenantAndDevice(source.db);
		const created = await source.configBackups.create({
			tenantId: "t1",
			deviceId: "d1",
			config: enc("config v1"),
		});
		await source.syslog.append("d1", [
			{ ts: "2026-09-16T00:00:00.000Z", message: "syslog line" },
		]);
		const archive = await createBackup({
			paths: source.paths,
			db: source.db,
			routemonVersion: "0.1.0-test",
		});
		source.close();

		const target = mkdtempSync(join(tmpdir(), "routemon-restore-test-"));
		try {
			const manifest = await restoreBackup({
				archive,
				paths: dataPaths(target),
			});
			expect(manifest).toMatchObject({
				routemon_version: "0.1.0-test",
				includes_syslog: false,
			});
			expect(manifest.schema_version).toMatch(/\.sql$/);

			const restored = await openStorage({ root: target });
			try {
				expect(
					new TextDecoder().decode(
						await restored.configBackups.read(created.id),
					),
				).toBe("config v1");
				expect((await restored.syslog.usage()).usedBytes).toBe(0); // 既定ではSYSLOGを含めない
			} finally {
				restored.close();
			}
		} finally {
			rmSync(target, { recursive: true, force: true });
		}
	});

	test("--include-syslogでRaw SYSLOGも含める", async () => {
		const source = await openStorage({ root });
		await source.syslog.append("d1", [
			{ ts: "2026-09-16T00:00:00.000Z", message: "syslog line" },
		]);
		const archive = await createBackup({
			paths: source.paths,
			db: source.db,
			includeSyslog: true,
		});
		source.close();

		const target = mkdtempSync(join(tmpdir(), "routemon-restore-test-"));
		try {
			const manifest = await restoreBackup({
				archive,
				paths: dataPaths(target),
			});
			expect(manifest.includes_syslog).toBe(true);
			const restored = await openStorage({ root: target });
			try {
				expect((await restored.syslog.usage()).usedBytes).toBeGreaterThan(0);
			} finally {
				restored.close();
			}
		} finally {
			rmSync(target, { recursive: true, force: true });
		}
	});

	test("既存データがあるときのrestoreは中断する", async () => {
		const storage = await openStorage({ root });
		const archive = await createBackup({
			paths: storage.paths,
			db: storage.db,
		});
		storage.close();
		await expect(
			restoreBackup({ archive, paths: dataPaths(root) }),
		).rejects.toThrow(/refusing to overwrite/);
	});

	test("manifestが無いarchiveは受け付けない", async () => {
		const bogus = join(root, "bogus.tar.gz");
		const work = mkdtempSync(join(tmpdir(), "routemon-bogus-"));
		writeFileSync(join(work, "routemon.db"), "not a database");
		execFileSync("tar", ["-czf", bogus, "-C", work, "."]);
		rmSync(work, { recursive: true, force: true });
		const target = mkdtempSync(join(tmpdir(), "routemon-restore-test-"));
		try {
			await expect(
				restoreBackup({ archive: bogus, paths: dataPaths(target) }),
			).rejects.toThrow(/manifest/);
		} finally {
			rmSync(target, { recursive: true, force: true });
		}
	});

	test("新しいmigrationがある場合、適用前にpre-upgrade snapshotを作る", async () => {
		const migrations = mkdtempSync(join(tmpdir(), "routemon-migrations-"));
		writeFileSync(
			join(migrations, "001_init.sql"),
			"CREATE TABLE a (id TEXT PRIMARY KEY);",
		);
		const first = await openStorage({ root, migrationsDir: migrations });
		expect(schemaVersion(first.db)).toBe("001_init.sql");
		first.close();

		writeFileSync(
			join(migrations, "002_add_b.sql"),
			"CREATE TABLE b (id TEXT PRIMARY KEY);",
		);
		const second = await openStorage({ root, migrationsDir: migrations });
		try {
			expect(schemaVersion(second.db)).toBe("002_add_b.sql");
			const snapshots = execFileSync("find", [
				second.paths.backups,
				"-name",
				"pre-upgrade-*.db",
			])
				.toString()
				.trim();
			expect(snapshots).not.toBe("");
			// snapshotはmigration適用前の状態
			const snapshot = openDatabase(snapshots.split("\n")[0] as string);
			expect(schemaVersion(snapshot)).toBe("001_init.sql");
			snapshot.close();
		} finally {
			second.close();
			rmSync(migrations, { recursive: true, force: true });
		}
	});

	test("migrationが失敗したら起動しない", async () => {
		const migrations = mkdtempSync(join(tmpdir(), "routemon-migrations-"));
		writeFileSync(
			join(migrations, "001_init.sql"),
			"CREATE TABLE a (id TEXT PRIMARY KEY);",
		);
		writeFileSync(join(migrations, "002_broken.sql"), "CREATE TABLE ;;;");
		await expect(
			openStorage({ root, migrationsDir: migrations }),
		).rejects.toThrow();
		const db = openDatabase(dataPaths(root).database);
		expect(schemaVersion(db)).toBe("001_init.sql"); // 失敗したmigrationは記録されない
		db.close();
		rmSync(migrations, { recursive: true, force: true });
	});
});

function enc(text: string): Uint8Array {
	return new TextEncoder().encode(text);
}

function listFiles(directory: string): string[] {
	return readdirSync(directory).sort();
}
