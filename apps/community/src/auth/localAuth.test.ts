import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createApp } from "../app.ts";
import { SESSION_COOKIE } from "../routes/auth.ts";
import {
	ensureDefaultTenant,
	openStorage,
	type Storage,
} from "../storage/index.ts";
import { AuditEventType, AuditLog } from "./audit.ts";
import {
	AccountLockedError,
	AuthError,
	LastAdminError,
	LocalAuth,
} from "./localAuth.ts";
import {
	hashPassword,
	verifyPassword,
	WeakPasswordError,
} from "./passwords.ts";

const PASSWORD = "correct horse battery";
const OTHER_PASSWORD = "another good password";

let root: string;
let storage: Storage;
let auth: LocalAuth;
let audit: AuditLog;
let now: number;

beforeEach(async () => {
	root = mkdtempSync(join(tmpdir(), "routemon-auth-"));
	storage = await openStorage({ root });
	now = Date.parse("2026-09-16T00:00:00.000Z");
	auth = new LocalAuth(storage.db, ensureDefaultTenant(storage.db), () => now);
	audit = new AuditLog(storage.db, storage.tenantId, () => now);
});

afterEach(() => {
	storage.close();
	rmSync(root, { recursive: true, force: true });
});

async function admin() {
	return auth.createFirstAdmin({
		loginId: "admin",
		password: PASSWORD,
		displayName: "Admin",
	});
}

describe("password hashing", () => {
	test("同じpasswordでもhashは毎回異なり、検証できる", async () => {
		const a = await hashPassword(PASSWORD);
		const b = await hashPassword(PASSWORD);
		expect(a).not.toBe(b);
		expect(a.startsWith("scrypt$")).toBe(true);
		expect(a).not.toContain(PASSWORD);
		expect(await verifyPassword(PASSWORD, a)).toBe(true);
		expect(await verifyPassword("wrong password!", a)).toBe(false);
	});

	test("短いpasswordは拒否する", async () => {
		await expect(hashPassword("short")).rejects.toThrow(WeakPasswordError);
	});
});

describe("first admin", () => {
	test("最初のUserはAdminで、2人目は作れない", async () => {
		const user = await admin();
		expect(user.role).toBe("admin");
		await expect(
			auth.createFirstAdmin({ loginId: "other", password: PASSWORD }),
		).rejects.toThrow(AuthError);
	});

	test("passwordを平文で保存しない", async () => {
		await admin();
		const rows = storage.db
			.prepare("SELECT password_hash FROM local_auth_credentials")
			.all() as {
			password_hash: string;
		}[];
		expect(rows).toHaveLength(1);
		expect(rows[0]?.password_hash).not.toContain(PASSWORD);
	});
});

describe("login", () => {
	test("login / authenticate / logout", async () => {
		const user = await admin();
		const { session } = await auth.login("admin", PASSWORD);
		expect(auth.authenticate(session.token)?.id).toBe(user.id);
		auth.logout(session.token);
		expect(auth.authenticate(session.token)).toBeNull();
	});

	test("session tokenを平文で保存しない", async () => {
		await admin();
		const { session } = await auth.login("admin", PASSWORD);
		const rows = storage.db
			.prepare("SELECT token_hash FROM sessions")
			.all() as { token_hash: string }[];
		expect(rows[0]?.token_hash).not.toBe(session.token);
	});

	test("期限切れsessionは無効", async () => {
		await admin();
		const { session } = await auth.login("admin", PASSWORD);
		now += 13 * 60 * 60 * 1000;
		expect(auth.authenticate(session.token)).toBeNull();
		expect(
			storage.db.prepare("SELECT COUNT(*) AS c FROM sessions").get(),
		).toEqual({ c: 0 });
	});

	test("不明なUser・誤ったpasswordを区別せず拒否する", async () => {
		await admin();
		await expect(auth.login("admin", "wrong password!")).rejects.toThrow(
			AuthError,
		);
		await expect(auth.login("nobody", PASSWORD)).rejects.toThrow(AuthError);
	});

	test("失敗が続いたら一定時間lockし、時間経過で解除する", async () => {
		await admin();
		for (let i = 0; i < 10; i++) {
			await expect(auth.login("admin", "wrong password!")).rejects.toThrow(
				AuthError,
			);
		}
		await expect(auth.login("admin", PASSWORD)).rejects.toThrow(
			AccountLockedError,
		);
		now += 16 * 60 * 1000;
		await expect(auth.login("admin", PASSWORD)).resolves.toBeTruthy();
	});

	test("password変更で既存sessionを無効化する", async () => {
		const user = await admin();
		const { session } = await auth.login("admin", PASSWORD);
		await auth.setPassword(user.id, OTHER_PASSWORD);
		expect(auth.authenticate(session.token)).toBeNull();
		await expect(auth.login("admin", OTHER_PASSWORD)).resolves.toBeTruthy();
	});

	test("期限切れsessionを一括で消せる", async () => {
		await admin();
		await auth.login("admin", PASSWORD);
		now += 13 * 60 * 60 * 1000;
		expect(auth.purgeExpiredSessions()).toBe(1);
	});
});

describe("user management", () => {
	test("Adminがuserを追加・削除できる", async () => {
		await admin();
		const viewer = await auth.createUser({
			loginId: "viewer",
			password: PASSWORD,
			role: "viewer",
		});
		expect(auth.listUsers().map((u) => u.role)).toEqual(["admin", "viewer"]);
		auth.deleteUser(viewer.id);
		expect(auth.listUsers()).toHaveLength(1);
	});

	test("User一覧に作成日時と最終login日時を含める", async () => {
		const adminCreatedAt = new Date(now).toISOString();
		const created = await admin();
		now += 1_000;
		const loginAt = new Date(now).toISOString();
		const { session } = await auth.login("admin", PASSWORD);
		now += 2_000;
		expect(auth.authenticate(session.token)?.id).toBe(created.id);
		const viewerCreatedAt = new Date(now).toISOString();
		const viewer = await auth.createUser({
			loginId: "viewer",
			password: PASSWORD,
			role: "viewer",
		});

		const users = auth.listUsers();
		expect(users).toHaveLength(2);
		expect(users[0]).toMatchObject({
			id: created.id,
			createdAt: adminCreatedAt,
			lastLoginAt: loginAt,
		});
		expect(users[1]).toMatchObject({
			id: viewer.id,
			createdAt: viewerCreatedAt,
			lastLoginAt: null,
		});
	});

	test("最後のAdminは削除できない", async () => {
		const user = await admin();
		await auth.createUser({
			loginId: "viewer",
			password: PASSWORD,
			role: "viewer",
		});
		expect(() => auth.deleteUser(user.id)).toThrow(LastAdminError);
		const second = await auth.createUser({
			loginId: "admin2",
			password: PASSWORD,
			role: "admin",
		});
		auth.deleteUser(user.id);
		expect(auth.findUser(second.id)?.role).toBe("admin");
	});

	test("emailまたはlogin idが必要", async () => {
		await admin();
		await expect(
			auth.createUser({ password: PASSWORD, role: "viewer" }),
		).rejects.toThrow(AuthError);
	});
});

describe("HTTP API", () => {
	function api() {
		return createApp({
			auth,
			audit,
			secureCookie: false,
		});
	}

	async function login(
		app: ReturnType<typeof api>,
		identifier: string,
		password: string,
	) {
		const res = await app.request("/api/auth/login", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ identifier, password }),
		});
		const cookie = res.headers.get("set-cookie")?.split(";")[0] ?? "";
		return { res, cookie };
	}

	test("login後にmeが返り、logoutで無効になる", async () => {
		await admin();
		const app = api();
		const { res, cookie } = await login(app, "admin", PASSWORD);
		expect(res.status).toBe(200);
		expect(cookie.startsWith(`${SESSION_COOKIE}=`)).toBe(true);
		expect(res.headers.get("set-cookie")).toContain("HttpOnly");

		const me = await app.request("/api/auth/me", { headers: { cookie } });
		expect(me.status).toBe(200);
		expect((await me.json()).user.loginId).toBe("admin");

		await app.request("/api/auth/logout", {
			method: "POST",
			headers: { cookie },
		});
		expect(
			(await app.request("/api/auth/me", { headers: { cookie } })).status,
		).toBe(401);
	});

	test("未認証は401、Viewerは管理APIで403", async () => {
		await admin();
		await auth.createUser({
			loginId: "viewer",
			password: PASSWORD,
			role: "viewer",
		});
		const app = api();
		expect((await app.request("/api/users")).status).toBe(401);

		const { cookie } = await login(app, "viewer", PASSWORD);
		expect(
			(await app.request("/api/users", { headers: { cookie } })).status,
		).toBe(403);
		const created = await app.request("/api/users", {
			method: "POST",
			headers: { cookie, "content-type": "application/json" },
			body: JSON.stringify({
				loginId: "x",
				password: PASSWORD,
				role: "viewer",
			}),
		});
		expect(created.status).toBe(403);
	});

	test("自己削除は別Adminがいても409、他Userの削除は監査記録と成功する", async () => {
		const user = await admin();
		await auth.createUser({
			loginId: "admin2",
			password: PASSWORD,
			role: "admin",
		});
		const app = api();
		const { cookie } = await login(app, "admin", PASSWORD);
		const created = await app.request("/api/users", {
			method: "POST",
			headers: { cookie, "content-type": "application/json" },
			body: JSON.stringify({
				loginId: "viewer",
				password: PASSWORD,
				role: "viewer",
			}),
		});
		expect(created.status).toBe(201);
		const viewerId = (await created.json()).user.id;

		const selfDelete = await app.request(`/api/users/${user.id}`, {
			method: "DELETE",
			headers: { cookie },
		});
		expect(selfDelete.status).toBe(409);
		expect(await selfDelete.json()).toMatchObject({
			error: expect.stringContaining("自分自身"),
		});
		expect(auth.findUser(user.id)).not.toBeNull();

		const deleteOther = await app.request(`/api/users/${viewerId}`, {
			method: "DELETE",
			headers: { cookie },
		});
		expect(deleteOther.status).toBe(200);
		expect(auth.findUser(viewerId)).toBeNull();
		expect(
			audit.list({ type: AuditEventType.USER_DELETED, targetId: viewerId }),
		).toMatchObject([
			{
				actor_user_id: user.id,
				target_id: viewerId,
			},
		]);
	});

	test("唯一のAdmin自身も自己削除として409で拒否する", async () => {
		const user = await admin();
		const app = api();
		const { cookie } = await login(app, "admin", PASSWORD);

		const response = await app.request(`/api/users/${user.id}`, {
			method: "DELETE",
			headers: { cookie },
		});
		expect(response.status).toBe(409);
		expect(await response.json()).toMatchObject({
			error: expect.stringContaining("自分自身"),
		});
		expect(auth.findUser(user.id)).not.toBeNull();
		expect(audit.list({ type: AuditEventType.USER_DELETED })).toHaveLength(0);
	});

	test("User削除が失敗したら先に挿入した監査Eventもrollbackする", async () => {
		await admin();
		const viewer = await auth.createUser({
			loginId: "viewer",
			password: PASSWORD,
			role: "viewer",
		});
		const app = api();
		const { cookie } = await login(app, "admin", PASSWORD);
		storage.db.exec(`
			CREATE TRIGGER reject_user_delete
			BEFORE DELETE ON users
			WHEN OLD.id = '${viewer.id}'
			BEGIN
				SELECT RAISE(ABORT, 'delete rejected for atomicity test');
			END;
		`);

		const response = await app.request(`/api/users/${viewer.id}`, {
			method: "DELETE",
			headers: { cookie },
		});
		expect(response.status).toBe(500);
		expect(auth.findUser(viewer.id)).not.toBeNull();
		expect(
			audit.list({ type: AuditEventType.USER_DELETED, targetId: viewer.id }),
		).toHaveLength(0);
	});

	test("監査Eventの挿入が失敗したらUserを削除しない", async () => {
		await admin();
		const viewer = await auth.createUser({
			loginId: "viewer",
			password: PASSWORD,
			role: "viewer",
		});
		const app = api();
		const { cookie } = await login(app, "admin", PASSWORD);
		storage.db.exec(`
			CREATE TRIGGER reject_user_delete_audit
			BEFORE INSERT ON audit_events
			WHEN NEW.type = 'USER_DELETED'
			BEGIN
				SELECT RAISE(ABORT, 'audit rejected for atomicity test');
			END;
		`);

		const response = await app.request(`/api/users/${viewer.id}`, {
			method: "DELETE",
			headers: { cookie },
		});
		expect(response.status).toBe(500);
		expect(auth.findUser(viewer.id)).not.toBeNull();
		expect(
			audit.list({ type: AuditEventType.USER_DELETED, targetId: viewer.id }),
		).toHaveLength(0);
	});

	test("弱いpasswordは400", async () => {
		await admin();
		const app = api();
		const { cookie } = await login(app, "admin", PASSWORD);
		const res = await app.request("/api/users", {
			method: "POST",
			headers: { cookie, "content-type": "application/json" },
			body: JSON.stringify({
				loginId: "weak",
				password: "short",
				role: "viewer",
			}),
		});
		expect(res.status).toBe(400);
	});

	test("自分のpasswordは変更でき、他人のものはAdminだけ", async () => {
		await admin();
		const viewer = await auth.createUser({
			loginId: "viewer",
			password: PASSWORD,
			role: "viewer",
		});
		const adminUser = auth.listUsers().find((u) => u.role === "admin");
		const app = api();
		const viewerLogin = await login(app, "viewer", PASSWORD);
		const own = await app.request(`/api/users/${viewer.id}/password`, {
			method: "POST",
			headers: {
				cookie: viewerLogin.cookie,
				"content-type": "application/json",
			},
			body: JSON.stringify({ password: OTHER_PASSWORD }),
		});
		expect(own.status).toBe(200);

		const otherLogin = await login(app, "viewer", OTHER_PASSWORD);
		const forbidden = await app.request(
			`/api/users/${adminUser?.id}/password`,
			{
				method: "POST",
				headers: {
					cookie: otherLogin.cookie,
					"content-type": "application/json",
				},
				body: JSON.stringify({ password: OTHER_PASSWORD }),
			},
		);
		expect(forbidden.status).toBe(403);
	});

	test("誤ったpasswordは401、lock中は429", async () => {
		await admin();
		const app = api();
		for (let i = 0; i < 10; i++) {
			expect((await login(app, "admin", "wrong password!")).res.status).toBe(
				401,
			);
		}
		expect((await login(app, "admin", PASSWORD)).res.status).toBe(429);
	});
});
