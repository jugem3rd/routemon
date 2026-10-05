import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentGateway, MemoryDeviceStore } from "@routemon/gateway";
import { afterEach, beforeEach, expect, test } from "vitest";
import { createApp } from "../app.ts";
import { AuditLog } from "../auth/audit.ts";
import { LocalAuth } from "../auth/localAuth.ts";
import { nowIso } from "../storage/db.ts";
import {
	ensureDefaultTenant,
	openStorage,
	type Storage,
} from "../storage/index.ts";

const PASSWORD = "correct horse battery";

let root: string;
let storage: Storage;
let tenantId: string;
let app: ReturnType<typeof createApp>;

function addDevice(id: string, name: string) {
	const at = nowIso();
	storage.db
		.prepare(
			`INSERT INTO devices (id, tenant_id, name, lifecycle_status, created_at, updated_at)
			 VALUES (?, ?, ?, 'active', ?, ?)`,
		)
		.run(id, tenantId, name, at, at);
}

async function login(loginId: string) {
	const res = await app.request("/api/auth/login", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ identifier: loginId, password: PASSWORD }),
	});
	return res.headers.get("set-cookie")?.split(";")[0] ?? "";
}

beforeEach(async () => {
	root = mkdtempSync(join(tmpdir(), "routemon-site-tags-"));
	storage = await openStorage({ root });
	tenantId = ensureDefaultTenant(storage.db);
	addDevice("device-1", "RTX830-1");
	addDevice("device-2", "RTX830-2");

	const auth = new LocalAuth(storage.db, tenantId);
	await auth.createFirstAdmin({ loginId: "admin", password: PASSWORD });
	await auth.createUser({
		loginId: "viewer",
		password: PASSWORD,
		role: "viewer",
	});
	app = createApp({
		auth,
		audit: new AuditLog(storage.db, tenantId),
		devices: {
			db: storage.db,
			tenantId,
			gateway: new AgentGateway({
				store: new MemoryDeviceStore(),
				coalesceWaitMs: 1,
			}),
		},
		secureCookie: false,
	});
});

afterEach(() => {
	storage.close();
	rmSync(root, { recursive: true, force: true });
});

test("SiteとTagをAdminが管理でき、重複名は409になる", async () => {
	const admin = await login("admin");
	const viewer = await login("viewer");

	const viewerSites = await app.request("/api/sites", {
		headers: { cookie: viewer },
	});
	const viewerTags = await app.request("/api/tags", {
		headers: { cookie: viewer },
	});
	expect(viewerSites.status).toBe(200);
	expect(viewerTags.status).toBe(200);
	expect((await viewerSites.json()).sites).toEqual([]);
	expect((await viewerTags.json()).tags).toEqual([]);

	const denied = await app.request("/api/sites", {
		method: "POST",
		headers: { cookie: viewer, "content-type": "application/json" },
		body: JSON.stringify({ name: "本社" }),
	});
	expect(denied.status).toBe(403);

	const createdSite = await app.request("/api/sites", {
		method: "POST",
		headers: { cookie: admin, "content-type": "application/json" },
		body: JSON.stringify({ name: "本社", description: "主拠点" }),
	});
	expect(createdSite.status).toBe(201);
	const site = (await createdSite.json()).site;
	expect(site).toMatchObject({ name: "本社", description: "主拠点" });

	const duplicateSite = await app.request("/api/sites", {
		method: "POST",
		headers: { cookie: admin, "content-type": "application/json" },
		body: JSON.stringify({ name: "本社" }),
	});
	expect(duplicateSite.status).toBe(409);

	const editedSite = await app.request(`/api/sites/${site.id}`, {
		method: "PATCH",
		headers: { cookie: admin, "content-type": "application/json" },
		body: JSON.stringify({ name: "東京本社", description: null }),
	});
	expect(editedSite.status).toBe(200);
	expect((await editedSite.json()).site).toMatchObject({
		name: "東京本社",
		description: null,
	});

	const firstTag = await app.request("/api/tags", {
		method: "POST",
		headers: { cookie: admin, "content-type": "application/json" },
		body: JSON.stringify({ name: "本番" }),
	});
	const secondTag = await app.request("/api/tags", {
		method: "POST",
		headers: { cookie: admin, "content-type": "application/json" },
		body: JSON.stringify({ name: "VPN" }),
	});
	expect(firstTag.status).toBe(201);
	expect(secondTag.status).toBe(201);

	const duplicateTag = await app.request("/api/tags", {
		method: "POST",
		headers: { cookie: admin, "content-type": "application/json" },
		body: JSON.stringify({ name: "本番" }),
	});
	expect(duplicateTag.status).toBe(409);
});

test("DeviceにSiteと複数Tagを割り当て、一覧で絞り込める", async () => {
	const admin = await login("admin");
	const viewer = await login("viewer");
	const siteResponse = await app.request("/api/sites", {
		method: "POST",
		headers: { cookie: admin, "content-type": "application/json" },
		body: JSON.stringify({ name: "本社" }),
	});
	const site = (await siteResponse.json()).site;
	const tags = await Promise.all(
		["本番", "VPN"].map(async (name) => {
			const response = await app.request("/api/tags", {
				method: "POST",
				headers: { cookie: admin, "content-type": "application/json" },
				body: JSON.stringify({ name }),
			});
			return (await response.json()).tag;
		}),
	);

	const assigned = await app.request("/api/devices/device-1", {
		method: "PATCH",
		headers: { cookie: admin, "content-type": "application/json" },
		body: JSON.stringify({
			siteId: site.id,
			tagIds: [tags[0].id, tags[1].id],
		}),
	});
	expect(assigned.status).toBe(200);
	expect((await assigned.json()).device).toMatchObject({
		siteId: site.id,
		siteName: "本社",
		tags: [
			{ id: tags[1].id, name: "VPN" },
			{ id: tags[0].id, name: "本番" },
		],
	});

	const siteFiltered = await app.request(`/api/devices?siteId=${site.id}`, {
		headers: { cookie: viewer },
	});
	const tagFiltered = await app.request(`/api/devices?tagId=${tags[1].id}`, {
		headers: { cookie: viewer },
	});
	expect(
		(await siteFiltered.json()).devices.map(
			(device: { id: string }) => device.id,
		),
	).toEqual(["device-1"]);
	expect(
		(await tagFiltered.json()).devices.map(
			(device: { id: string }) => device.id,
		),
	).toEqual(["device-1"]);

	const detail = await app.request("/api/devices/device-1", {
		headers: { cookie: viewer },
	});
	expect((await detail.json()).device.tags).toHaveLength(2);

	const denied = await app.request("/api/devices/device-1", {
		method: "PATCH",
		headers: { cookie: viewer, "content-type": "application/json" },
		body: JSON.stringify({ tagIds: [] }),
	});
	expect(denied.status).toBe(403);

	const deletedSite = await app.request(`/api/sites/${site.id}`, {
		method: "DELETE",
		headers: { cookie: admin },
	});
	expect(deletedSite.status).toBe(200);
	expect(
		storage.db
			.prepare("SELECT site_id FROM devices WHERE id = ?")
			.get("device-1"),
	).toEqual({ site_id: null });

	const deletedTag = await app.request(`/api/tags/${tags[0].id}`, {
		method: "DELETE",
		headers: { cookie: admin },
	});
	expect(deletedTag.status).toBe(200);
	expect(
		storage.db
			.prepare("SELECT 1 FROM device_tags WHERE device_id = ? AND tag_id = ?")
			.get("device-1", tags[0].id),
	).toBeUndefined();
});
