import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	concatFrames,
	encodeFrame,
	FrameType,
	textEscape,
} from "@routemon/core";
import {
	AgentGateway,
	hashCredential,
	MemoryDeviceStore,
} from "@routemon/gateway";
import { afterEach, beforeEach, expect, test } from "vitest";
import { createApp } from "../app.ts";
import { AuditLog } from "../auth/audit.ts";
import { LocalAuth } from "../auth/localAuth.ts";
import { createDeviceStore } from "../enrollment/enrollment.ts";
import { nowIso } from "../storage/db.ts";
import {
	ensureDefaultTenant,
	openStorage,
	type Storage,
} from "../storage/index.ts";

const PASSWORD = "correct horse battery";
const ONLINE_ID = "d-online";
const TOKEN = "device-token";

let root: string;
let storage: Storage;
let tenantId: string;
let gateway: AgentGateway;
let app: ReturnType<typeof createApp>;

function addDevice(id: string, name: string, siteId: string | null = null) {
	const at = nowIso();
	storage.db
		.prepare(
			`INSERT INTO devices (id, tenant_id, site_id, name, lifecycle_status, model, created_at, updated_at)
			 VALUES (?, ?, ?, ?, 'active', 'RTX830', ?, ?)`,
		)
		.run(id, tenantId, siteId, name, at, at);
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
	root = mkdtempSync(join(tmpdir(), "routemon-devices-"));
	storage = await openStorage({ root });
	tenantId = ensureDefaultTenant(storage.db);
	addDevice(ONLINE_ID, "RTX830-online");
	addDevice("d-quiet", "RTX830-quiet");
	storage.db
		.prepare(
			"INSERT INTO device_credentials (id, device_id, token_hash, status, created_at) VALUES (?, ?, ?, 'active', ?)",
		)
		.run("credential-online", ONLINE_ID, hashCredential(TOKEN), nowIso());

	const store = new MemoryDeviceStore();
	store.add(ONLINE_ID, TOKEN);
	gateway = new AgentGateway({ store, coalesceWaitMs: 1 });
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
			gateway,
			cleanupDeviceData: storage.deleteDeviceData,
		},
		secureCookie: false,
	});
	// 1度syncさせてPresenceをonlineにする
	await gateway.handleSync({
		authorization: `Bearer ${TOKEN}`,
		waitSeconds: 0,
		body: textEscape(concatFrames([encodeFrame(FrameType.HEARTBEAT, 0)])),
	});
});

afterEach(() => {
	storage.close();
	rmSync(root, { recursive: true, force: true });
});

test("Device一覧にPresenceが載る", async () => {
	const cookie = await login("viewer");
	const res = await app.request("/api/devices", { headers: { cookie } });
	expect(res.status).toBe(200);
	const { devices } = await res.json();
	expect(devices).toHaveLength(2);
	const online = devices.find((d: { id: string }) => d.id === ONLINE_ID);
	expect(online.presence.status).toBe("online");
	expect(online.presence.lastSeenAt).not.toBeNull();
	expect(online.model).toBe("RTX830");
	// 観測が無いDeviceはunknown(Gatewayはstateを永続化しない)
	expect(
		devices.find((d: { id: string }) => d.id === "d-quiet").presence.status,
	).toBe("unknown");
});

test("Dashboardは台数とPresenceの内訳を返す", async () => {
	const cookie = await login("admin");
	const res = await app.request("/api/dashboard", { headers: { cookie } });
	const body = await res.json();
	expect(body.deviceCount).toBe(2);
	expect(body.presence).toEqual({
		online: 1,
		unstable: 0,
		offline: 0,
		unknown: 1,
	});
	expect(body.recentJobs).toEqual([]);
});

test("詳細は存在しないDeviceで404、未認証は401", async () => {
	expect((await app.request("/api/devices")).status).toBe(401);
	const cookie = await login("viewer");
	expect(
		(await app.request("/api/devices/missing", { headers: { cookie } })).status,
	).toBe(404);
	const res = await app.request(`/api/devices/${ONLINE_ID}`, {
		headers: { cookie },
	});
	expect((await res.json()).device.name).toBe("RTX830-online");
});

test("AdminはDeviceの名前・Site・説明・メモを編集できる", async () => {
	const siteAt = nowIso();
	storage.db
		.prepare(
			"INSERT INTO sites (id, tenant_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
		)
		.run("site-1", tenantId, "本社", siteAt, siteAt);
	const admin = await login("admin");
	const res = await app.request(`/api/devices/${ONLINE_ID}`, {
		method: "PATCH",
		headers: { cookie: admin, "content-type": "application/json" },
		body: JSON.stringify({
			name: "本社 RTX830",
			siteId: "site-1",
			description: "主回線",
			notes: "保守メモ",
		}),
	});

	expect(res.status).toBe(200);
	expect((await res.json()).device).toMatchObject({
		name: "本社 RTX830",
		siteId: "site-1",
		siteName: "本社",
		description: "主回線",
		notes: "保守メモ",
	});

	const invalidSite = await app.request(`/api/devices/${ONLINE_ID}`, {
		method: "PATCH",
		headers: { cookie: admin, "content-type": "application/json" },
		body: JSON.stringify({ siteId: "missing-site" }),
	});
	expect(invalidSite.status).toBe(400);
});

test("Deviceの編集・無効化・削除はAdminのみ", async () => {
	const viewer = await login("viewer");
	const patch = await app.request(`/api/devices/${ONLINE_ID}`, {
		method: "PATCH",
		headers: { cookie: viewer, "content-type": "application/json" },
		body: JSON.stringify({ name: "拒否" }),
	});
	expect(patch.status).toBe(403);

	const disable = await app.request(`/api/devices/${ONLINE_ID}/disable`, {
		method: "POST",
		headers: { cookie: viewer },
	});
	expect(disable.status).toBe(403);

	const remove = await app.request(`/api/devices/${ONLINE_ID}`, {
		method: "DELETE",
		headers: { cookie: viewer },
	});
	expect(remove.status).toBe(403);
});

test("Deviceを無効化・有効化すると一覧のlifecycleが変わる", async () => {
	const admin = await login("admin");
	const dbGateway = new AgentGateway({
		store: createDeviceStore(storage.db),
		coalesceWaitMs: 1,
	});
	const syncRequest = {
		authorization: `Bearer ${TOKEN}`,
		waitSeconds: 0,
		body: textEscape(concatFrames([encodeFrame(FrameType.HEARTBEAT, 0)])),
	};
	const disable = await app.request(`/api/devices/${ONLINE_ID}/disable`, {
		method: "POST",
		headers: { cookie: admin },
	});
	expect(disable.status).toBe(200);
	expect((await disable.json()).device.lifecycle).toBe("disabled");
	expect((await dbGateway.handleSync(syncRequest)).status).toBe(401);

	const list = await app.request("/api/devices", {
		headers: { cookie: admin },
	});
	expect(
		(await list.json()).devices.find((d: { id: string }) => d.id === ONLINE_ID)
			.lifecycle,
	).toBe("disabled");

	const enable = await app.request(`/api/devices/${ONLINE_ID}/enable`, {
		method: "POST",
		headers: { cookie: admin },
	});
	expect(enable.status).toBe(200);
	expect((await enable.json()).device.lifecycle).toBe("active");
	expect((await dbGateway.handleSync(syncRequest)).status).toBe(200);
});

test("削除時にcredentialとCONFIG Backup・SYSLOGを消す", async () => {
	const deviceId = "d-delete";
	addDevice(deviceId, "削除対象");
	const at = nowIso();
	storage.db
		.prepare(
			"INSERT INTO device_credentials (id, device_id, token_hash, status, created_at) VALUES (?, ?, ?, 'active', ?)",
		)
		.run("credential-delete", deviceId, "hash-delete", at);
	await storage.configBackups.create({
		tenantId,
		deviceId,
		config: new TextEncoder().encode("config to delete"),
	});
	await storage.syslog.append(deviceId, [
		{ ts: "2026-09-16T00:00:00.000Z", message: "syslog to delete" },
	]);
	const admin = await login("admin");

	const res = await app.request(`/api/devices/${deviceId}`, {
		method: "DELETE",
		headers: { cookie: admin },
	});

	expect(res.status).toBe(200);
	expect(
		storage.db.prepare("SELECT 1 FROM devices WHERE id = ?").get(deviceId),
	).toBeUndefined();
	expect(
		storage.db
			.prepare("SELECT 1 FROM device_credentials WHERE device_id = ?")
			.get(deviceId),
	).toBeUndefined();
	expect(existsSync(join(storage.paths.configBackups, deviceId))).toBe(false);
	expect(existsSync(join(storage.paths.syslog, deviceId))).toBe(false);
});
