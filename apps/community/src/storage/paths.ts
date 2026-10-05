/**
 * `/data`配下の永続領域(docs/community/storage-backup-design.md §4、
 * docs/community/architecture.md §4)。
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";

export type DataPaths = {
	root: string;
	database: string;
	secrets: string;
	masterKey: string;
	configBackups: string;
	syslog: string;
	agentReleases: string;
	backups: string;
	tmp: string;
};

export function dataPaths(
	root = process.env.ROUTEMON_DATA_DIR ?? "/data",
): DataPaths {
	return {
		root,
		database: join(root, "routemon.db"),
		secrets: join(root, "secrets"),
		masterKey: join(root, "secrets", "master.key"),
		configBackups: join(root, "config-backups"),
		syslog: join(root, "syslog"),
		agentReleases: join(root, "agent", "releases"),
		backups: join(root, "backups"),
		tmp: join(root, "tmp"),
	};
}

export function ensureDataLayout(paths: DataPaths): DataPaths {
	mkdirSync(paths.root, { recursive: true });
	mkdirSync(paths.secrets, { recursive: true, mode: 0o700 });
	for (const dir of [
		paths.configBackups,
		paths.syslog,
		paths.agentReleases,
		paths.backups,
		paths.tmp,
	]) {
		mkdirSync(dir, { recursive: true });
	}
	return paths;
}
