/**
 * Instance BackupのHTTP API(docs/community/storage-backup-design.md §9、§14)。
 *
 * Backup archiveはDB・master key・暗号化CONFIGを含み得るため、一覧・作成・download・削除を
 * すべてAdmin専用にする。download本文は監査Eventへ記録せず、ファイルをstreamで返す。
 */
import { createReadStream } from "node:fs";
import { basename } from "node:path";
import { Readable } from "node:stream";
import { Hono } from "hono";
import { AuditEventType, type AuditLog } from "../auth/audit.ts";
import { type AuthEnv, requireAdmin, requireUser } from "../auth/authorize.ts";
import type { LocalAuth } from "../auth/localAuth.ts";
import {
	createBackup,
	deleteBackupFile,
	findBackupFile,
	listBackupFiles,
} from "../storage/backup.ts";
import type { Db } from "../storage/db.ts";
import type { DataPaths } from "../storage/paths.ts";

export type BackupApiItem = {
	id: string;
	sizeBytes: number;
	createdAt: string;
	downloadUrl: string;
	/** 作成直後のレスポンスだけで判明する。既存archiveの一覧では省略する。 */
	includesSyslog?: boolean;
};

function toBackupApiItem(
	backup: ReturnType<typeof listBackupFiles>[number],
	includeSyslog?: boolean,
): BackupApiItem {
	return {
		id: backup.id,
		sizeBytes: backup.sizeBytes,
		createdAt: backup.createdAt,
		downloadUrl: `/api/backups/${encodeURIComponent(backup.id)}/download`,
		...(includeSyslog === undefined ? {} : { includesSyslog: includeSyslog }),
	};
}

export function createBackupRoutes(
	auth: LocalAuth,
	paths: DataPaths,
	db: Db,
	audit: AuditLog,
) {
	const app = new Hono<AuthEnv>();
	const authenticated = requireUser(auth);

	app.get("/backups", authenticated, requireAdmin, (c) =>
		c.json(
			{
				backups: listBackupFiles(paths).map((backup) =>
					toBackupApiItem(backup),
				),
			},
			200,
			{ "cache-control": "no-store" },
		),
	);

	app.post("/backups", authenticated, requireAdmin, async (c) => {
		const raw = await c.req.json().catch(() => undefined);
		if (
			raw !== undefined &&
			(raw === null || typeof raw !== "object" || Array.isArray(raw))
		) {
			return c.json({ error: "request body must be an object" }, 400);
		}
		const body = (raw ?? {}) as Record<string, unknown>;
		const includeSyslog = body.includeSyslog ?? false;
		if (typeof includeSyslog !== "boolean") {
			return c.json({ error: "includeSyslog must be a boolean" }, 400);
		}

		const archive = await createBackup({
			paths,
			db,
			includeSyslog,
		});
		const backup = findBackupFile(paths, basename(archive));
		if (!backup) throw new Error("created backup was not found");

		audit.record({
			type: AuditEventType.BACKUP_CREATED,
			actorUserId: c.get("user").id,
			targetType: "backup",
			targetId: backup.id,
			detail: { includes_syslog: includeSyslog, size_bytes: backup.sizeBytes },
		});
		return c.json({ backup: toBackupApiItem(backup, includeSyslog) }, 201);
	});

	app.delete("/backups/:id", authenticated, requireAdmin, (c) => {
		const backup = deleteBackupFile(paths, c.req.param("id"));
		if (!backup) return c.json({ error: "backup not found" }, 404);

		audit.record({
			type: AuditEventType.BACKUP_DELETED,
			actorUserId: c.get("user").id,
			targetType: "backup",
			targetId: backup.id,
			detail: { size_bytes: backup.sizeBytes },
		});
		return c.json({ ok: true });
	});

	/** Backup archiveは大きくなり得るため、全体をUint8Arrayへ載せず返す。 */
	app.get("/backups/:id/download", authenticated, requireAdmin, (c) => {
		const backup = findBackupFile(paths, c.req.param("id"));
		if (!backup) return c.json({ error: "backup not found" }, 404);

		audit.record({
			type: AuditEventType.BACKUP_DOWNLOADED,
			actorUserId: c.get("user").id,
			targetType: "backup",
			targetId: backup.id,
			detail: { size_bytes: backup.sizeBytes },
		});

		return c.body(
			Readable.toWeb(
				createReadStream(backup.path),
			) as ReadableStream<Uint8Array>,
			200,
			{
				"content-type": "application/gzip",
				"content-disposition": `attachment; filename="${safeFilename(backup.id)}"`,
				"content-length": String(backup.sizeBytes),
				"cache-control": "no-store",
				"x-content-type-options": "nosniff",
			},
		);
	});

	return app;
}

function safeFilename(value: string): string {
	return value.replace(/[^A-Za-z0-9._-]/g, "_");
}
