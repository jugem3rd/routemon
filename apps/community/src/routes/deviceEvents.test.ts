import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentGateway } from "@routemon/gateway";
import { afterEach, beforeEach, expect, test } from "vitest";
import { createApp } from "../app.ts";
import { AuditLog } from "../auth/audit.ts";
import { LocalAuth } from "../auth/localAuth.ts";
import { EventRecorder } from "../events/recorder.ts";
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
let now: number;
let recorder: EventRecorder;
let app: ReturnType<typeof createApp>;

function addDevice(id: string, targetTenantId = tenantId) {
	const at = nowIso(new Date(now));
	storage.db
		.prepare(
			"INSERT INTO devices (id, tenant_id, name, lifecycle_status, created_at, updated_at) VALUES (?, ?, ?, 'active', ?, ?)",
		)
		.run(id, targetTenantId, id, at, at);
}

async function login(loginId: string): Promise<string> {
	const response = await app.request("/api/auth/login", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ identifier: loginId, password: PASSWORD }),
	});
	return response.headers.get("set-cookie")?.split(";")[0] ?? "";
}

type EventsBody = {
	events: {
		id: string;
		type: string;
		severity: string;
		detail: Record<string, unknown> | null;
		occurredAt: string;
		seq: number;
	}[];
	hasMore: boolean;
};

async function get(path: string, cookie: string) {
	const response = await app.request(path, { headers: { cookie } });
	return {
		status: response.status,
		body: (await response.json()) as EventsBody,
	};
}

beforeEach(async () => {
	root = mkdtempSync(join(tmpdir(), "routemon-events-api-"));
	storage = await openStorage({ root });
	tenantId = ensureDefaultTenant(storage.db);
	now = Date.UTC(2026, 9, 6);
	addDevice("d1");
	addDevice("d2");
	const auth = new LocalAuth(storage.db, tenantId);
	await auth.createFirstAdmin({ loginId: "admin", password: PASSWORD });
	await auth.createUser({
		loginId: "viewer",
		password: PASSWORD,
		role: "viewer",
	});
	recorder = new EventRecorder({ db: storage.db, tenantId, now: () => now });
	app = createApp({
		auth,
		audit: new AuditLog(storage.db, tenantId, () => now),
		devices: {
			db: storage.db,
			tenantId,
			gateway: {} as AgentGateway,
		},
		secureCookie: false,
	});
});

afterEach(() => {
	storage.close();
	rmSync(root, { recursive: true, force: true });
});

test("Deviceのイベントを、新しい順に返す(Viewerも読める)", async () => {
	recorder.record({
		deviceId: "d1",
		type: "ppp.down",
		severity: "warning",
		detail: { pp: 1, cause: "x" },
	});
	now += 60_000;
	recorder.record({
		deviceId: "d1",
		type: "ppp.up",
		severity: "info",
		detail: { pp: 1 },
	});
	recorder.record({ deviceId: "d2", type: "tunnel.down", severity: "warning" });

	const viewer = await login("viewer");
	const { status, body } = await get("/api/devices/d1/events", viewer);
	expect(status).toBe(200);
	expect(body.events.map((e) => e.type)).toEqual(["ppp.up", "ppp.down"]);
	expect(body.events[1]?.detail).toEqual({ pp: 1, cause: "x" });
	expect(body.events[0]?.occurredAt).toBe("2026-10-06T00:01:00.000Z");
	expect(body.hasMore).toBe(false);
});

test("存在しないDevice、別TenantのDeviceは404。未ログインは401", async () => {
	const at = nowIso(new Date(now));
	storage.db
		.prepare(
			"INSERT INTO tenants (id, name, created_at, updated_at) VALUES ('other', 'Other', ?, ?)",
		)
		.run(at, at);
	addDevice("d-other", "other");

	const admin = await login("admin");
	expect((await get("/api/devices/nope/events", admin)).status).toBe(404);
	expect((await get("/api/devices/d-other/events", admin)).status).toBe(404);
	const anonymous = await app.request("/api/devices/d1/events");
	expect(anonymous.status).toBe(401);
});

test("limitで区切り、同じ時刻のEventも取りこぼさずに続きを取れる", async () => {
	// 同じ時刻に5件(1日の上限やフラッピングに掛からない種別)
	for (let i = 0; i < 5; i++) {
		recorder.record({ deviceId: "d1", type: `t.${i}`, severity: "info" });
	}
	const admin = await login("admin");
	const seen: string[] = [];
	let path = "/api/devices/d1/events?limit=2";
	for (let page = 0; page < 5; page++) {
		const { body } = await get(path, admin);
		seen.push(...body.events.map((e) => e.type));
		const last = body.events.at(-1);
		if (!body.hasMore || !last) break;
		path = `/api/devices/d1/events?limit=2&before=${encodeURIComponent(last.occurredAt)}&beforeSeq=${last.seq}`;
	}
	expect(seen).toEqual(["t.4", "t.3", "t.2", "t.1", "t.0"]);
});

test("typeで絞り込め、limitは上限を超えない", async () => {
	recorder.record({ deviceId: "d1", type: "ppp.down", severity: "warning" });
	recorder.record({ deviceId: "d1", type: "tunnel.down", severity: "warning" });
	const admin = await login("admin");
	const filtered = await get("/api/devices/d1/events?type=tunnel.down", admin);
	expect(filtered.body.events.map((e) => e.type)).toEqual(["tunnel.down"]);
	const huge = await get("/api/devices/d1/events?limit=100000", admin);
	expect(huge.status).toBe(200);
	const bad = await get("/api/devices/d1/events?limit=abc", admin);
	expect(bad.body.events).toHaveLength(2);
});
