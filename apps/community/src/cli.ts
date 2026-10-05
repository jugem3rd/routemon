/**
 * Community CLI(docs/community/storage-backup-design.md)。
 *
 *   routemon backup [--include-syslog] [--out <file>]
 *   routemon restore <archive> [--force]
 *
 * 通常運用はGUIで行い、CLIはBackup / Restore等に限定する。
 */
import { createBackup, openStorage, restoreBackup } from "./storage/index.ts";
import { dataPaths } from "./storage/paths.ts";

const [command, ...args] = process.argv.slice(2);

function flag(name: string): boolean {
	return args.includes(`--${name}`);
}

function option(name: string): string | undefined {
	const index = args.indexOf(`--${name}`);
	return index >= 0 ? args[index + 1] : undefined;
}

switch (command) {
	case "backup": {
		const storage = await openStorage();
		try {
			const out = await createBackup({
				paths: storage.paths,
				db: storage.db,
				includeSyslog: flag("include-syslog"),
				out: option("out"),
			});
			console.log(out);
		} finally {
			storage.close();
		}
		break;
	}
	case "restore": {
		const archive = args[0];
		if (!archive || archive.startsWith("--")) {
			console.error("usage: routemon restore <archive> [--force]");
			process.exit(2);
		}
		const manifest = await restoreBackup({
			archive,
			paths: dataPaths(),
			force: flag("force"),
		});
		console.log(
			`restored backup created at ${manifest.created_at} (schema ${manifest.schema_version})`,
		);
		break;
	}
	default:
		console.error("usage: routemon <backup|restore> [options]");
		process.exit(2);
}
