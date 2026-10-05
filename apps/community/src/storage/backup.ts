/**
 * Online Backup / Restore(docs/community/storage-backup-design.md)。
 *
 * 稼働中DBはSQLite Backup APIでsnapshotを取り、secrets・CONFIG本文・settings・
 * manifestと一緒にtar.gzへまとめる。Raw SYSLOGは既定で含めない。
 */

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
	backupDatabase,
	type Db,
	migrate,
	nowIso,
	openDatabase,
	schemaVersion,
} from "./db.ts";
import type { DataPaths } from "./paths.ts";
import { ensureDataLayout } from "./paths.ts";

export const BACKUP_FORMAT = 1;
const BACKUP_ARCHIVE_SUFFIX = ".tar.gz";
const PRE_UPGRADE_PREFIX = "pre-upgrade-";
const PRE_UPGRADE_SUFFIX = ".db";

/** Instance Backupは件数と合計容量の両方で保持上限を設ける。 */
export const DEFAULT_BACKUP_GENERATIONS = 10;
export const DEFAULT_BACKUP_MAX_BYTES = 1024 * 1024 * 1024;

/** migration rollback用snapshotは直近の少数だけ残し、永続領域を占有し続けない。 */
export const DEFAULT_PRE_UPGRADE_GENERATIONS = 3;
export const DEFAULT_PRE_UPGRADE_MAX_BYTES = 256 * 1024 * 1024;

export type BackupRetentionPolicy = {
	maxGenerations: number;
	maxBytes: number;
};

export type PreUpgradeRetentionPolicy = {
	maxSnapshots: number;
	maxBytes: number;
};

export const DEFAULT_BACKUP_RETENTION: BackupRetentionPolicy = {
	maxGenerations: DEFAULT_BACKUP_GENERATIONS,
	maxBytes: DEFAULT_BACKUP_MAX_BYTES,
};

export const DEFAULT_PRE_UPGRADE_RETENTION: PreUpgradeRetentionPolicy = {
	maxSnapshots: DEFAULT_PRE_UPGRADE_GENERATIONS,
	maxBytes: DEFAULT_PRE_UPGRADE_MAX_BYTES,
};

export type BackupFile = {
	id: string;
	path: string;
	sizeBytes: number;
	createdAt: string;
};

export type BackupManifest = {
	backup_format: number;
	routemon_version: string;
	schema_version: string | null;
	created_at: string;
	includes_syslog: boolean;
};

export type CreateBackupOptions = {
	paths: DataPaths;
	db: Db;
	includeSyslog?: boolean;
	routemonVersion?: string;
	/** 出力先。既定は /data/backups/routemon-backup-<timestamp>-<uuid>.tar.gz */
	out?: string;
	/** テストや運用方針の差し替え用。既定はCommunityの保持方針。 */
	retention?: BackupRetentionPolicy;
};

export async function createBackup(
	options: CreateBackupOptions,
): Promise<string> {
	const { paths, db } = options;
	const includeSyslog = options.includeSyslog ?? false;
	const stamp = nowIso().replace(/[-:.]/g, "");
	const out =
		options.out ??
		join(paths.backups, `routemon-backup-${stamp}-${randomUUID()}.tar.gz`);
	const work = mkdtempSync(join(paths.tmp, "backup-"));
	try {
		await backupDatabase(db, join(work, "routemon.db"));
		cpSync(paths.secrets, join(work, "secrets"), { recursive: true });
		if (existsSync(paths.configBackups)) {
			cpSync(paths.configBackups, join(work, "config-backups"), {
				recursive: true,
			});
		}
		if (includeSyslog && existsSync(paths.syslog)) {
			cpSync(paths.syslog, join(work, "syslog"), { recursive: true });
		}
		const manifest: BackupManifest = {
			backup_format: BACKUP_FORMAT,
			routemon_version: options.routemonVersion ?? "0.0.0-dev",
			schema_version: schemaVersion(db),
			created_at: nowIso(),
			includes_syslog: includeSyslog,
		};
		writeFileSync(
			join(work, "manifest.json"),
			JSON.stringify(manifest, null, 2),
		);
		mkdirSync(join(out, ".."), { recursive: true });
		execFileSync("tar", ["-czf", out, "-C", work, "."]);
		pruneBackupFiles(paths, options.retention);
		return out;
	} finally {
		rmSync(work, { recursive: true, force: true });
	}
}

/**
 * 利用者が作成したarchiveだけを一覧する。migration前のsnapshotは.dbで保存されるため、
 * archive suffixで分けることで自動snapshotをGUIへ混ぜない。
 */
export function listBackupFiles(paths: DataPaths): BackupFile[] {
	return readdirSync(paths.backups, { withFileTypes: true })
		.filter(
			(entry) => entry.isFile() && entry.name.endsWith(BACKUP_ARCHIVE_SUFFIX),
		)
		.map((entry) => toBackupFile(paths, entry.name))
		.sort(
			(left, right) =>
				Date.parse(right.createdAt) - Date.parse(left.createdAt) ||
				right.id.localeCompare(left.id),
		);
}

/** Routeのidからpathを組み立てず、一覧に存在するregular fileだけを返す。 */
export function findBackupFile(
	paths: DataPaths,
	id: string,
): BackupFile | undefined {
	if (id !== basename(id) || !id.endsWith(BACKUP_ARCHIVE_SUFFIX))
		return undefined;
	return listBackupFiles(paths).find((backup) => backup.id === id);
}

/** 一覧と同じbasename/suffix検証を通ったarchiveだけを削除する。 */
export function deleteBackupFile(
	paths: DataPaths,
	id: string,
): BackupFile | undefined {
	const backup = findBackupFile(paths, id);
	if (!backup) return undefined;
	rmSync(backup.path, { force: true });
	return backup;
}

/**
 * Instance Backupを古いものから自動削除する。
 * 最新の1件は、単体で容量上限を超えていても残す。
 */
export function pruneBackupFiles(
	paths: DataPaths,
	policy: BackupRetentionPolicy = DEFAULT_BACKUP_RETENTION,
): { removed: BackupFile[]; removedBytes: number } {
	const backups = listBackupFiles(paths);
	const keepCount = positiveInteger(policy.maxGenerations);
	const maxBytes = nonNegativeNumber(policy.maxBytes);
	const keep = backups.slice(0, keepCount);
	const remove = backups.slice(keepCount);
	let keptBytes = keep.reduce((total, backup) => total + backup.sizeBytes, 0);

	while (keptBytes > maxBytes && keep.length > 1) {
		const oldest = keep.pop();
		if (!oldest) break;
		keptBytes -= oldest.sizeBytes;
		remove.push(oldest);
	}

	return removeFiles(remove);
}

/** migration前の自動snapshotを古いものから自動削除する。 */
export function prunePreUpgradeSnapshots(
	paths: DataPaths,
	policy: PreUpgradeRetentionPolicy = DEFAULT_PRE_UPGRADE_RETENTION,
): { removed: string[]; removedBytes: number } {
	const snapshots = listPreUpgradeSnapshots(paths);
	const keepCount = positiveInteger(policy.maxSnapshots);
	const maxBytes = nonNegativeNumber(policy.maxBytes);
	const keep = snapshots.slice(0, keepCount);
	const remove = snapshots.slice(keepCount);
	let keptBytes = keep.reduce(
		(total, snapshot) => total + snapshot.sizeBytes,
		0,
	);

	while (keptBytes > maxBytes && keep.length > 1) {
		const oldest = keep.pop();
		if (!oldest) break;
		keptBytes -= oldest.sizeBytes;
		remove.push(oldest);
	}

	const result = removeFiles(remove);
	return {
		removed: result.removed.map((snapshot) => snapshot.id),
		removedBytes: result.removedBytes,
	};
}

type RetentionFile = {
	id: string;
	path: string;
	sizeBytes: number;
	createdAt: string;
};

function listPreUpgradeSnapshots(paths: DataPaths): RetentionFile[] {
	return readdirSync(paths.backups, { withFileTypes: true })
		.filter(
			(entry) =>
				entry.isFile() &&
				entry.name.startsWith(PRE_UPGRADE_PREFIX) &&
				entry.name.endsWith(PRE_UPGRADE_SUFFIX),
		)
		.map((entry) => {
			const path = join(paths.backups, entry.name);
			const stat = statSync(path);
			return {
				id: entry.name,
				path,
				sizeBytes: stat.size,
				createdAt: stat.mtime.toISOString(),
			};
		})
		.sort(
			(left, right) =>
				Date.parse(right.createdAt) - Date.parse(left.createdAt) ||
				right.id.localeCompare(left.id),
		);
}

function removeFiles(files: RetentionFile[]): {
	removed: RetentionFile[];
	removedBytes: number;
} {
	for (const file of files) rmSync(file.path, { force: true });
	return {
		removed: files,
		removedBytes: files.reduce((total, file) => total + file.sizeBytes, 0),
	};
}

function positiveInteger(value: number): number {
	return Number.isFinite(value) ? Math.max(1, Math.trunc(value)) : 1;
}

function nonNegativeNumber(value: number): number {
	return Number.isFinite(value) ? Math.max(0, value) : 0;
}

function toBackupFile(paths: DataPaths, id: string): BackupFile {
	const path = join(paths.backups, id);
	const stat = statSync(path);
	return {
		id,
		path,
		sizeBytes: stat.size,
		// archiveのmtimeはtarが書き終わった時刻で、GUIの作成日時として扱う。
		createdAt: stat.mtime.toISOString(),
	};
}

export type RestoreOptions = {
	archive: string;
	paths: DataPaths;
	/** 既存のデータを上書きする場合はtrue(既定はroutemon.dbがあれば中断) */
	force?: boolean;
};

/**
 * 停止状態またはone-shot containerから実行する。manifestを検証し、DB・secrets・
 * CONFIG本文を復元してからmigrationを適用する。
 */
export async function restoreBackup(
	options: RestoreOptions,
): Promise<BackupManifest> {
	const { archive, paths } = options;
	if (!options.force && existsSync(paths.database)) {
		throw new Error(`refusing to overwrite existing data: ${paths.database}`);
	}
	const work = mkdtempSync(join(tmpdir(), "routemon-restore-"));
	try {
		execFileSync("tar", ["-xzf", archive, "-C", work]);
		const manifestFile = join(work, "manifest.json");
		if (!existsSync(manifestFile))
			throw new Error("manifest.json not found in backup archive");
		const manifest = JSON.parse(
			readFileSync(manifestFile, "utf8"),
		) as BackupManifest;
		if (manifest.backup_format !== BACKUP_FORMAT) {
			throw new Error(`unsupported backup format: ${manifest.backup_format}`);
		}
		if (!existsSync(join(work, "routemon.db")))
			throw new Error("routemon.db not found in backup archive");

		ensureDataLayout(paths);
		cpSync(join(work, "routemon.db"), paths.database);
		cpSync(join(work, "secrets"), paths.secrets, { recursive: true });
		if (existsSync(join(work, "config-backups"))) {
			cpSync(join(work, "config-backups"), paths.configBackups, {
				recursive: true,
			});
		}
		if (existsSync(join(work, "syslog"))) {
			cpSync(join(work, "syslog"), paths.syslog, { recursive: true });
		}

		const db = openDatabase(paths.database);
		try {
			migrate(db);
			db.pragma("integrity_check");
		} finally {
			db.close();
		}
		return manifest;
	} finally {
		rmSync(work, { recursive: true, force: true });
	}
}
