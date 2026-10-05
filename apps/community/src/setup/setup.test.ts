import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { createApp } from "../app.ts";
import { AuditLog } from "../auth/audit.ts";
import { LocalAuth } from "../auth/localAuth.ts";
import {
	ensureDefaultTenant,
	openStorage,
	type Storage,
} from "../storage/index.ts";
import { renderCaddyfile, writeCaddyfile } from "./caddy.ts";
import { checkConnectivity, Setup } from "./setup.ts";

const PASSWORD = "correct horse battery";

let root: string;
let storage: Storage;
let setup: Setup;
let auth: LocalAuth;
let app: ReturnType<typeof createApp>;

beforeEach(async () => {
	root = mkdtempSync(join(tmpdir(), "routemon-setup-"));
	storage = await openStorage({ root });
	const tenantId = ensureDefaultTenant(storage.db);
	auth = new LocalAuth(storage.db, tenantId);
	setup = new Setup(storage.db, auth);
	app = createApp({
		auth,
		audit: new AuditLog(storage.db, tenantId),
		setup,
		secureCookie: false,
	});
});

afterEach(() => {
	storage.close();
	rmSync(root, { recursive: true, force: true });
});

function completeBody() {
	return {
		instanceName: "本社ネットワーク",
		timezone: "Asia/Tokyo",
		publicBaseUrl: "https://routemon.example.com/",
		admin: { loginId: "admin", password: PASSWORD },
	};
}

async function postSetup(body: unknown) {
	return app.request("/api/setup", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
}

async function login(identifier: string) {
	const res = await app.request("/api/auth/login", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ identifier, password: PASSWORD }),
	});
	return res.headers.get("set-cookie")?.split(";")[0] ?? "";
}

test("未初期化ならstatusがfalse、完了後はtrueになる", async () => {
	expect(
		(await (await app.request("/api/setup/status")).json()).initialized,
	).toBe(false);

	const res = await postSetup(completeBody());
	expect(res.status).toBe(201);
	const status = await res.json();
	expect(status.initialized).toBe(true);
	expect(status.instanceName).toBe("本社ネットワーク");
	// 末尾のスラッシュは落とす
	expect(status.publicBaseUrl).toBe("https://routemon.example.com");

	// 最初のUserはAdmin
	const login = await app.request("/api/auth/login", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ identifier: "admin", password: PASSWORD }),
	});
	expect(login.status).toBe(200);
	expect((await login.json()).user.role).toBe("admin");
});

test("完了後のSetupは再実行できない", async () => {
	await postSetup(completeBody());
	const again = await postSetup({
		...completeBody(),
		admin: { loginId: "intruder", password: PASSWORD },
	});
	expect(again.status).toBe(409);
	// 乗っ取られたUserができていないこと
	expect(
		(
			await app.request("/api/auth/login", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ identifier: "intruder", password: PASSWORD }),
			})
		).status,
	).toBe(401);
});

test("必須項目が無ければ400", async () => {
	expect((await postSetup({ instanceName: "x" })).status).toBe(400);
	expect(setup.status().initialized).toBe(false);
});

test("完了後のconnectivity checkは匿名で実行できない", async () => {
	await postSetup(completeBody());
	const res = await app.request("/api/setup/connectivity", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ publicBaseUrl: "https://routemon.example.com" }),
	});
	expect(res.status).toBe(401);
});

test("SettingsのInstance名・Timezone・Public URLはAdminだけが変更できる", async () => {
	await postSetup(completeBody());
	await auth.createUser({
		loginId: "viewer",
		password: PASSWORD,
		role: "viewer",
	});
	const adminCookie = await login("admin");
	const viewerCookie = await login("viewer");

	const instance = await app.request("/api/settings/instance-name", {
		method: "POST",
		headers: { cookie: adminCookie, "content-type": "application/json" },
		body: JSON.stringify({ instanceName: "  新しいInstance  " }),
	});
	expect(instance.status).toBe(200);

	const timezone = await app.request("/api/settings/timezone", {
		method: "POST",
		headers: { cookie: adminCookie, "content-type": "application/json" },
		body: JSON.stringify({ timezone: "  Europe/Berlin  " }),
	});
	expect(timezone.status).toBe(200);

	const publicUrl = await app.request("/api/settings/public-url", {
		method: "POST",
		headers: { cookie: adminCookie, "content-type": "application/json" },
		body: JSON.stringify({ publicBaseUrl: "https://new.example.com/" }),
	});
	expect(publicUrl.status).toBe(200);
	expect(await publicUrl.json()).toMatchObject({
		instanceName: "新しいInstance",
		timezone: "Europe/Berlin",
		publicBaseUrl: "https://new.example.com",
	});

	const forbidden = await app.request("/api/settings/timezone", {
		method: "POST",
		headers: { cookie: viewerCookie, "content-type": "application/json" },
		body: JSON.stringify({ timezone: "UTC" }),
	});
	expect(forbidden.status).toBe(403);
});

test("connectivity checkは切り分けできる説明を返す", async () => {
	const checks = await checkConnectivity("https://routemon.invalid", {
		fetchImpl: (async () => {
			throw new Error("connect ECONNREFUSED");
		}) as unknown as typeof fetch,
	});
	const byName = Object.fromEntries(checks.map((c) => [c.name, c]));
	expect(byName.DNS?.status).toBe("error");
	expect(byName.DNS?.detail).toContain("DNS record");
	expect(byName.HTTPS?.status).toBe("error");
	expect(byName["Agent Endpoint"]?.status).toBe("error");
	// stack traceを出さない
	expect(JSON.stringify(checks)).not.toContain("at ");
});

test("Public URLからCaddy設定を生成する", () => {
	const targets = {
		app: "routemon:8080",
		agent: "routemon:8081",
		webgui: "routemon:8082",
		webguiPort: 8443,
	};
	const caddyfile = renderCaddyfile("https://routemon.example.com", targets);
	expect(caddyfile).toContain("routemon.example.com {");
	// Agent APIだけをAgent Gatewayへ渡す
	expect(caddyfile).toContain("path /v1/tunnel/* /v1/enrollment/* /v1/agent/*");
	expect(caddyfile).toContain("reverse_proxy routemon:8081");
	expect(caddyfile).toContain("reverse_proxy routemon:8080");
	// Native WebGUIは専用origin
	expect(caddyfile).toContain("routemon.example.com:8443");
	expect(caddyfile).toContain("reverse_proxy routemon:8082");

	const path = join(root, "caddy", "routemon.caddyfile");
	expect(writeCaddyfile(path, "https://routemon.example.com", targets)).toBe(
		true,
	);
	// 同じ内容なら書き直さない(不要なreloadを避ける)
	expect(writeCaddyfile(path, "https://routemon.example.com", targets)).toBe(
		false,
	);
	expect(readFileSync(path, "utf8")).toBe(caddyfile);
	expect(writeCaddyfile(path, "https://other.example.com", targets)).toBe(true);
});
