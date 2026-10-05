import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createApp } from "../app.ts";
import { AuditLog } from "../auth/audit.ts";
import { LocalAuth } from "../auth/localAuth.ts";
import {
	ensureDefaultTenant,
	openStorage,
	type Storage,
} from "../storage/index.ts";

const PASSWORD = "correct horse battery";

let root: string;
let storage: Storage;
let auth: LocalAuth;
let audit: AuditLog;
let app: ReturnType<typeof createApp>;
let adminId: string;

beforeEach(async () => {
	root = mkdtempSync(join(tmpdir(), "routemon-backups-route-"));
	storage = await openStorage({ root });
	ensureDefaultTenant(storage.db, storage.tenantId);
	auth = new LocalAuth(storage.db, storage.tenantId);
	audit = new AuditLog(storage.db, storage.tenantId);
	const admin = await auth.createFirstAdmin({
		loginId: "admin",
		password: PASSWORD,
	});
	adminId = admin.id;
	await auth.createUser({
		loginId: "viewer",
		password: PASSWORD,
		role: "viewer",
	});
	app = createApp({
		auth,
		audit,
		backups: { db: storage.db, paths: storage.paths },
		secureCookie: false,
	});
});

afterEach(() => {
	storage.close();
	rmSync(root, { recursive: true, force: true });
});

async function login(identifier: string): Promise<string> {
	const response = await app.request("/api/auth/login", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ identifier, password: PASSWORD }),
	});
	return response.headers.get("set-cookie")?.split(";")[0] ?? "";
}

describe("Backup API", () => {
	test("Adminだけが一覧・作成・downloadできる", async () => {
		const viewerCookie = await login("viewer");
		const adminCookie = await login("admin");

		expect(
			(await app.request("/api/backups", { headers: { cookie: viewerCookie } }))
				.status,
		).toBe(403);
		expect(
			(
				await app.request("/api/backups", {
					method: "POST",
					headers: {
						cookie: viewerCookie,
						"content-type": "application/json",
					},
					body: JSON.stringify({ includeSyslog: false }),
				})
			).status,
		).toBe(403);

		const created = await app.request("/api/backups", {
			method: "POST",
			headers: {
				cookie: adminCookie,
				"content-type": "application/json",
			},
			body: JSON.stringify({ includeSyslog: false }),
		});
		expect(created.status).toBe(201);
		const createdBody = (await created.json()) as {
			backup: {
				id: string;
				sizeBytes: number;
				createdAt: string;
				includesSyslog: boolean;
				downloadUrl: string;
			};
		};
		expect(createdBody.backup).toMatchObject({
			includesSyslog: false,
			downloadUrl: expect.stringContaining("/api/backups/"),
		});
		expect(createdBody.backup.sizeBytes).toBeGreaterThan(0);
		expect(Date.parse(createdBody.backup.createdAt)).not.toBeNaN();

		// migration前の自動snapshotは一覧に混ぜない。
		writeFileSync(
			join(storage.paths.backups, "pre-upgrade-test.db"),
			"snapshot",
		);
		const listed = await app.request("/api/backups", {
			headers: { cookie: adminCookie },
		});
		expect(listed.status).toBe(200);
		const listedBody = (await listed.json()) as {
			backups: { id: string; sizeBytes: number; createdAt: string }[];
		};
		expect(listedBody.backups).toHaveLength(1);
		expect(listedBody.backups[0]).toMatchObject({
			id: createdBody.backup.id,
			sizeBytes: createdBody.backup.sizeBytes,
		});

		const viewerDownload = await app.request(
			`/api/backups/${createdBody.backup.id}/download`,
			{ headers: { cookie: viewerCookie } },
		);
		expect(viewerDownload.status).toBe(403);

		const download = await app.request(
			`/api/backups/${createdBody.backup.id}/download`,
			{ headers: { cookie: adminCookie } },
		);
		expect(download.status).toBe(200);
		expect(download.headers.get("content-type")).toBe("application/gzip");
		expect(download.headers.get("content-length")).toBe(
			String(createdBody.backup.sizeBytes),
		);
		expect(download.headers.get("content-disposition")).toContain(
			createdBody.backup.id,
		);
		expect((await download.arrayBuffer()).byteLength).toBe(
			createdBody.backup.sizeBytes,
		);

		const events = audit.list();
		expect(
			events.filter((event) => event.type === "BACKUP_CREATED"),
		).toHaveLength(1);
		expect(
			events.filter((event) => event.type === "BACKUP_DOWNLOADED"),
		).toHaveLength(1);
		expect(
			events.find((event) => event.type === "BACKUP_DOWNLOADED")?.actor_user_id,
		).toBe(adminId);

		const traversal = await app.request(
			`/api/backups/${encodeURIComponent(`../${createdBody.backup.id}`)}`,
			{ method: "DELETE", headers: { cookie: adminCookie } },
		);
		expect(traversal.status).toBe(404);
		expect(existsSync(join(storage.paths.backups, createdBody.backup.id))).toBe(
			true,
		);

		const viewerDelete = await app.request(
			`/api/backups/${createdBody.backup.id}`,
			{ method: "DELETE", headers: { cookie: viewerCookie } },
		);
		expect(viewerDelete.status).toBe(403);

		const deleted = await app.request(`/api/backups/${createdBody.backup.id}`, {
			method: "DELETE",
			headers: { cookie: adminCookie },
		});
		expect(deleted.status).toBe(200);
		expect(await deleted.json()).toEqual({ ok: true });
		expect(existsSync(join(storage.paths.backups, createdBody.backup.id))).toBe(
			false,
		);
		expect(
			(
				await app.request(`/api/backups/${createdBody.backup.id}/download`, {
					headers: { cookie: adminCookie },
				})
			).status,
		).toBe(404);
		const deletedEvents = audit
			.list()
			.filter((event) => event.type === "BACKUP_DELETED");
		expect(deletedEvents).toHaveLength(1);
		expect(deletedEvents[0]?.actor_user_id).toBe(adminId);
	});

	test("includeSyslogをarchiveへ反映し、入力を検証する", async () => {
		const adminCookie = await login("admin");
		await storage.syslog.append("d1", [
			{ ts: "2026-09-20T00:00:00.000Z", message: "backup test" },
		]);

		const invalid = await app.request("/api/backups", {
			method: "POST",
			headers: {
				cookie: adminCookie,
				"content-type": "application/json",
			},
			body: JSON.stringify({ includeSyslog: "yes" }),
		});
		expect(invalid.status).toBe(400);

		const created = await app.request("/api/backups", {
			method: "POST",
			headers: {
				cookie: adminCookie,
				"content-type": "application/json",
			},
			body: JSON.stringify({ includeSyslog: true }),
		});
		expect(created.status).toBe(201);
		const { backup } = (await created.json()) as {
			backup: { id: string; includesSyslog: boolean };
		};
		expect(backup.includesSyslog).toBe(true);
		const archive = join(storage.paths.backups, backup.id);
		expect(existsSync(archive)).toBe(true);
		expect(execFileSync("tar", ["-tzf", archive]).toString()).toContain(
			"./syslog/",
		);

		const missing = await app.request("/api/backups/missing.tar.gz/download", {
			headers: { cookie: adminCookie },
		});
		expect(missing.status).toBe(404);
	});
});
