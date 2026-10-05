import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createApp } from "../app.ts";
import { nowIso } from "../storage/db.ts";
import {
	ensureDefaultTenant,
	openStorage,
	type Storage,
} from "../storage/index.ts";
import {
	DeviceNotFoundError,
	ForbiddenError,
	NativeGuiSessions,
} from "../webgui/sessions.ts";
import { AuditEventType, AuditLog } from "./audit.ts";
import { canUseNativeWebGui, isWriteOperation } from "./authorize.ts";
import { LastAdminError, LocalAuth, type User } from "./localAuth.ts";

const PASSWORD = "correct horse battery";

let root: string;
let storage: Storage;
let tenantId: string;
let auth: LocalAuth;
let audit: AuditLog;
let sessions: NativeGuiSessions;
let now: number;

beforeEach(async () => {
	root = mkdtempSync(join(tmpdir(), "routemon-rbac-"));
	storage = await openStorage({ root });
	tenantId = ensureDefaultTenant(storage.db);
	now = Date.parse("2026-09-16T00:00:00.000Z");
	auth = new LocalAuth(storage.db, tenantId, () => now);
	audit = new AuditLog(storage.db, tenantId, () => now);
	sessions = new NativeGuiSessions(storage.db, tenantId, audit, () => now);
});

afterEach(() => {
	storage.close();
	rmSync(root, { recursive: true, force: true });
});

async function setupUsers() {
	const admin = await auth.createFirstAdmin({
		loginId: "admin",
		password: PASSWORD,
	});
	const viewer = await auth.createUser({
		loginId: "viewer",
		password: PASSWORD,
		role: "viewer",
	});
	return { admin, viewer };
}

function seedDevice(id = "d1") {
	const at = nowIso(new Date(now));
	storage.db
		.prepare(
			"INSERT INTO devices (id, tenant_id, name, lifecycle_status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
		)
		.run(id, tenantId, "RTX830", "active", at, at);
	return id;
}

function api() {
	return createApp({
		auth,
		audit,
		webguiSessions: sessions,
		secureCookie: false,
	});
}

async function login(app: ReturnType<typeof api>, identifier: string) {
	const res = await app.request("/api/auth/login", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ identifier, password: PASSWORD }),
	});
	return res.headers.get("set-cookie")?.split(";")[0] ?? "";
}

describe("role model", () => {
	test("RoleはAdmin / Viewerだけを受け付ける", async () => {
		const { viewer } = await setupUsers();
		const app = api();
		const cookie = await login(app, "admin");
		const res = await app.request(`/api/users/${viewer.id}`, {
			method: "PATCH",
			headers: { cookie, "content-type": "application/json" },
			body: JSON.stringify({ role: "operator" }),
		});
		expect(res.status).toBe(400);
	});

	test("Role変更と、最後のAdminの降格拒否", async () => {
		const { admin, viewer } = await setupUsers();
		expect(auth.changeRole(viewer.id, "admin").role).toBe("admin");
		expect(auth.changeRole(viewer.id, "viewer").role).toBe("viewer");
		expect(() => auth.changeRole(admin.id, "viewer")).toThrow(LastAdminError);
	});

	test("Role変更をAuditへ残す", async () => {
		const { viewer } = await setupUsers();
		const app = api();
		const cookie = await login(app, "admin");
		const res = await app.request(`/api/users/${viewer.id}`, {
			method: "PATCH",
			headers: { cookie, "content-type": "application/json" },
			body: JSON.stringify({ role: "admin" }),
		});
		expect(res.status).toBe(200);
		const event = audit
			.list()
			.find((e) => e.type === AuditEventType.USER_ROLE_CHANGED);
		expect(event?.target_id).toBe(viewer.id);
		expect(JSON.parse(event?.detail_json ?? "{}")).toEqual({
			from: "viewer",
			to: "admin",
		});
	});
});

describe("server-side authorization", () => {
	test("読み取り以外はwrite operationとして扱う", () => {
		expect(isWriteOperation("GET")).toBe(false);
		expect(isWriteOperation("head")).toBe(false);
		for (const method of ["POST", "PATCH", "DELETE", "PUT"]) {
			expect(isWriteOperation(method)).toBe(true);
		}
	});

	test("ViewerはAdmin専用APIを実行できない", async () => {
		await setupUsers();
		const app = api();
		const cookie = await login(app, "viewer");
		const forbidden = [
			app.request("/api/users", { headers: { cookie } }),
			app.request("/api/audit-events", { headers: { cookie } }),
			app.request("/api/users/x", { method: "DELETE", headers: { cookie } }),
			app.request("/api/users/x", {
				method: "PATCH",
				headers: { cookie, "content-type": "application/json" },
				body: JSON.stringify({ role: "admin" }),
			}),
		];
		for (const res of await Promise.all(forbidden)) {
			expect(res.status).toBe(403);
		}
	});

	test("未認証はすべて401", async () => {
		await setupUsers();
		const app = api();
		const device = seedDevice();
		const res = await Promise.all([
			app.request("/api/users"),
			app.request("/api/audit-events"),
			app.request(`/api/devices/${device}/webgui-sessions`, { method: "POST" }),
		]);
		expect(res.map((r) => r.status)).toEqual([401, 401, 401]);
	});
});

describe("native webgui access", () => {
	test("AdminだけがNative WebGUIを使える", async () => {
		const { admin, viewer } = await setupUsers();
		expect(canUseNativeWebGui(admin)).toBe(true);
		expect(canUseNativeWebGui(viewer)).toBe(false);
		seedDevice();
		expect(() => sessions.start(viewer as User, "d1")).toThrow(ForbiddenError);
		expect(sessions.start(admin as User, "d1").deviceId).toBe("d1");
	});

	test("存在しないDeviceのsessionは作れない", async () => {
		const { admin } = await setupUsers();
		expect(() => sessions.start(admin as User, "missing")).toThrow(
			DeviceNotFoundError,
		);
	});

	test("session開始と終了をAuditへ残す(bodyは残さない)", async () => {
		const { admin } = await setupUsers();
		seedDevice();
		const session = sessions.start(admin as User, "d1");
		now += 5000;
		sessions.end(session.id);

		const types = audit.list().map((e) => e.type);
		expect(types).toContain(AuditEventType.NATIVE_GUI_SESSION_STARTED);
		expect(types).toContain(AuditEventType.NATIVE_GUI_SESSION_ENDED);
		const ended = audit
			.list()
			.find((e) => e.type === AuditEventType.NATIVE_GUI_SESSION_ENDED);
		expect(JSON.parse(ended?.detail_json ?? "{}")).toEqual({
			session_id: session.id,
			duration_ms: 5000,
		});
		expect(ended?.target_id).toBe("d1");
		expect(sessions.active()).toHaveLength(0);
	});

	test("ViewerはHTTPでもsessionを開始できない", async () => {
		await setupUsers();
		seedDevice();
		const app = api();
		const viewerCookie = await login(app, "viewer");
		const denied = await app.request("/api/devices/d1/webgui-sessions", {
			method: "POST",
			headers: { cookie: viewerCookie },
		});
		expect(denied.status).toBe(403);

		const adminCookie = await login(app, "admin");
		const allowed = await app.request("/api/devices/d1/webgui-sessions", {
			method: "POST",
			headers: { cookie: adminCookie },
		});
		expect(allowed.status).toBe(201);
		const sessionId = (await allowed.json()).session.id;
		expect(sessions.get(sessionId)).toBeTruthy();

		const ended = await app.request(`/api/webgui-sessions/${sessionId}`, {
			method: "DELETE",
			headers: { cookie: adminCookie },
		});
		expect(ended.status).toBe(200);
		expect(sessions.get(sessionId)).toBeUndefined();
	});
});

describe("audit log", () => {
	test("User作成・削除・password変更を記録する", async () => {
		await setupUsers();
		const app = api();
		const cookie = await login(app, "admin");
		const created = await app.request("/api/users", {
			method: "POST",
			headers: { cookie, "content-type": "application/json" },
			body: JSON.stringify({
				loginId: "extra",
				password: PASSWORD,
				role: "viewer",
			}),
		});
		const extraId = (await created.json()).user.id;
		await app.request(`/api/users/${extraId}/password`, {
			method: "POST",
			headers: { cookie, "content-type": "application/json" },
			body: JSON.stringify({ password: "another good password" }),
		});
		await app.request(`/api/users/${extraId}`, {
			method: "DELETE",
			headers: { cookie },
		});

		const types = audit.list().map((e) => e.type);
		expect(types).toContain(AuditEventType.USER_CREATED);
		expect(types).toContain(AuditEventType.USER_PASSWORD_CHANGED);
		expect(types).toContain(AuditEventType.USER_DELETED);
		// passwordそのものは記録しない
		expect(JSON.stringify(audit.list())).not.toContain(PASSWORD);
	});

	test("Adminは監査Eventを取得できる", async () => {
		await setupUsers();
		const app = api();
		const cookie = await login(app, "admin");
		audit.record({
			type: AuditEventType.COMMAND_EXECUTED,
			targetType: "device",
			targetId: "d1",
		});
		const res = await app.request("/api/audit-events?limit=10", {
			headers: { cookie },
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.events.length).toBeGreaterThan(0);
		// 表示用APIではdetail_json(CONFIG本文やsecretを含み得る)を返さない。
		expect(body.events[0]).not.toHaveProperty("detail_json");
	});

	test("監査Eventのdetailは種別ごとのallowlistに従う", async () => {
		await setupUsers();
		const app = api();
		const cookie = await login(app, "admin");
		audit.record({
			type: AuditEventType.COMMAND_EXECUTED,
			targetType: "device",
			targetId: "d1",
			detail: {
				job_id: "job-1",
				command: "show log",
				password: "must not be returned",
				extra: "not in the allowlist",
			},
		});

		const res = await app.request("/api/audit-events?limit=10", {
			headers: { cookie },
		});
		const body = await res.json();
		const event = body.events.find(
			(item: { type: string }) => item.type === AuditEventType.COMMAND_EXECUTED,
		);
		expect(event.detail).toEqual({ job_id: "job-1", command: "show log" });
		expect(event.detail).not.toHaveProperty("password");
		expect(event.detail).not.toHaveProperty("extra");
	});

	test("allowlistにない新しいEvent種別はdetailを返さない", async () => {
		await setupUsers();
		const app = api();
		const cookie = await login(app, "admin");
		audit.record({
			// AuditEventTypeへ追加しただけでallowlistへ追加していない将来の種別を表す。
			type: "FUTURE_EVENT",
			detail: {
				safeLookingValue: "still hidden",
				token: "must not be returned",
			},
		});

		const res = await app.request("/api/audit-events?limit=10", {
			headers: { cookie },
		});
		const body = await res.json();
		const event = body.events.find(
			(item: { type: string }) => item.type === "FUTURE_EVENT",
		);
		expect(event).not.toHaveProperty("detail");
		expect(event).not.toHaveProperty("detail_json");
	});

	test("監査Eventを日時・実行者・種別・対象で絞り込める", async () => {
		const { admin, viewer } = await setupUsers();
		const app = api();
		const cookie = await login(app, "admin");
		audit.record({
			type: "FILTERED_EVENT",
			actorUserId: admin.id,
			targetType: "device",
			targetId: "router-a",
		});
		audit.record({
			type: "OTHER_EVENT",
			actorUserId: viewer.id,
			targetType: "user",
			targetId: "user-a",
		});

		const res = await app.request(
			`/api/audit-events?actorUserId=${admin.id}&type=FILTERED_EVENT&target=router-a`,
			{ headers: { cookie } },
		);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.events).toHaveLength(1);
		expect(body.events[0]).toMatchObject({
			actor_user_id: admin.id,
			actor_name: "admin",
			type: "FILTERED_EVENT",
			target_type: "device",
			target_id: "router-a",
		});
	});
});
