import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	concatFrames,
	encodeFrame,
	FrameType,
	textEscape,
} from "@routemon/core";
import { AgentGateway } from "@routemon/gateway";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createApp } from "../app.ts";
import { AuditEventType, AuditLog } from "../auth/audit.ts";
import { LocalAuth } from "../auth/localAuth.ts";
import { createEnrollmentDeviceRoutes } from "../routes/enrollment.ts";
import {
	ensureDefaultTenant,
	openStorage,
	type Storage,
} from "../storage/index.ts";
import {
	planSupervisorSchedule,
	renderBootstrap,
	renderCliBlock,
} from "./bootstrap.ts";
import {
	CODE_TTL_MS,
	createDeviceStore,
	Enrollment,
	generateCode,
	InvalidCodeError,
} from "./enrollment.ts";

const PASSWORD = "correct horse battery";
const BASE_URL = "https://routemon.example.com";
const WATCHER_SOURCE_PATH = join(
	dirname(fileURLToPath(import.meta.url)),
	"../../../../agent/routemon_syslog_watcher.lua",
);
const SHA256_SOURCE_PATH = join(
	dirname(fileURLToPath(import.meta.url)),
	"../../../../agent/update/sha256.lua",
);
const SUPERVISOR_SOURCE_PATH = join(
	dirname(fileURLToPath(import.meta.url)),
	"../../../../agent/update/routemon_supervisor.lua",
);
const LOADER_SOURCE_PATH = join(
	dirname(fileURLToPath(import.meta.url)),
	"../../../../agent/update/routemon_loader.lua",
);

function normalizeLuaSource(source: string): string {
	return source
		.split(/\r?\n/)
		.map((line) => line.replace(/--.*$/, "").trim())
		.filter(Boolean)
		.join("\n");
}

function luaCodeWithoutStringsOrComments(source: string): string {
	return source
		.replace(/\[=\[[\s\S]*?\]=\]/g, "")
		.replace(/--[^\n]*/g, "")
		.replace(/'(?:[^']*)'/g, "''")
		.replace(/"(?:[^"]*)"/g, '""');
}

let root: string;
let storage: Storage;
let tenantId: string;
let auth: LocalAuth;
let audit: AuditLog;
let enrollment: Enrollment;
let now: number;
let adminId: string;

beforeEach(async () => {
	root = mkdtempSync(join(tmpdir(), "routemon-enroll-"));
	storage = await openStorage({ root });
	tenantId = ensureDefaultTenant(storage.db);
	now = Date.parse("2026-09-17T00:00:00.000Z");
	auth = new LocalAuth(storage.db, tenantId, () => now);
	audit = new AuditLog(storage.db, tenantId, () => now);
	enrollment = new Enrollment(storage.db, tenantId, audit, {
		gatewayUrl: `${BASE_URL}:8443`,
		agentVersion: "1.0.0",
		now: () => now,
	});
	adminId = (
		await auth.createFirstAdmin({ loginId: "admin", password: PASSWORD })
	).id;
});

afterEach(() => {
	storage.close();
	rmSync(root, { recursive: true, force: true });
});

describe("enrollment code", () => {
	test("表示形式と文字種", () => {
		const code = generateCode();
		expect(code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
		// 紛らわしい文字を含まない
		expect(code).not.toMatch(/[IO01]/);
		expect(generateCode()).not.toBe(code);
	});

	test("Pending Deviceを作り、Codeは平文で保存しない", () => {
		const pending = enrollment.createPendingDevice({
			name: "Kurume-01",
			userId: adminId,
		});
		const device = storage.db
			.prepare("SELECT lifecycle_status, name FROM devices WHERE id = ?")
			.get(pending.deviceId) as { lifecycle_status: string; name: string };
		expect(device).toEqual({ lifecycle_status: "pending", name: "Kurume-01" });

		const rows = storage.db
			.prepare("SELECT code_hash, expires_at FROM device_enrollments")
			.all() as {
			code_hash: string;
			expires_at: string;
		}[];
		expect(rows).toHaveLength(1);
		expect(rows[0]?.code_hash).not.toContain(pending.code);
		expect(Date.parse(rows[0]?.expires_at ?? "") - now).toBe(CODE_TTL_MS);
	});

	test("大文字小文字と前後の空白を無視して検証する", () => {
		const pending = enrollment.createPendingDevice({
			name: "d",
			userId: adminId,
		});
		expect(
			enrollment.verifyCode(` ${pending.code.toLowerCase()} `).deviceId,
		).toBe(pending.deviceId);
	});

	test("期限切れ・不正・使用済みのCodeを拒否する", () => {
		const pending = enrollment.createPendingDevice({
			name: "d",
			userId: adminId,
		});
		expect(() => enrollment.verifyCode("TEST-CODE")).toThrow(InvalidCodeError);

		enrollment.complete(pending.code);
		expect(() => enrollment.verifyCode(pending.code)).toThrow(InvalidCodeError);

		const other = enrollment.createPendingDevice({
			name: "d2",
			userId: adminId,
		});
		now += CODE_TTL_MS + 1000;
		expect(() => enrollment.verifyCode(other.code)).toThrow(InvalidCodeError);
	});

	test("再発行で旧Codeを失効させる", () => {
		const pending = enrollment.createPendingDevice({
			name: "d",
			userId: adminId,
		});
		const reissued = enrollment.issueCode(pending.deviceId, adminId);
		expect(reissued.code).not.toBe(pending.code);
		expect(() => enrollment.verifyCode(pending.code)).toThrow(InvalidCodeError);
		expect(enrollment.verifyCode(reissued.code).deviceId).toBe(
			pending.deviceId,
		);
	});
});

describe("complete", () => {
	test("credentialを発行し、Deviceをactiveにする", () => {
		const pending = enrollment.createPendingDevice({
			name: "d",
			userId: adminId,
		});
		const result = enrollment.complete(pending.code, {
			model: "RTX830",
			firmwareRevision: "15.02.30",
			serialNumber: "SN-TEST",
		});
		expect(result.deviceId).toBe(pending.deviceId);
		expect(result.gateway).toBe(`${BASE_URL}:8443`);
		expect(result.agentVersion).toBe("1.0.0");

		const device = storage.db
			.prepare(
				"SELECT lifecycle_status, model, firmware_revision, registered_at FROM devices WHERE id = ?",
			)
			.get(pending.deviceId) as Record<string, string>;
		expect(device.lifecycle_status).toBe("active");
		expect(device.model).toBe("RTX830");
		expect(device.registered_at).toBeTruthy();
	});

	test("Device Tokenを平文で保存しない", () => {
		const pending = enrollment.createPendingDevice({
			name: "d",
			userId: adminId,
		});
		const result = enrollment.complete(pending.code);
		const rows = storage.db
			.prepare("SELECT token_hash FROM device_credentials")
			.all() as {
			token_hash: string;
		}[];
		expect(rows[0]?.token_hash).not.toBe(result.deviceToken);
		expect(JSON.stringify(rows)).not.toContain(result.deviceToken);
	});

	test("同じCodeで2回目は発行しない(replay対策)", () => {
		const pending = enrollment.createPendingDevice({
			name: "d",
			userId: adminId,
		});
		enrollment.complete(pending.code);
		expect(() => enrollment.complete(pending.code)).toThrow(InvalidCodeError);
		expect(
			storage.db.prepare("SELECT COUNT(*) AS c FROM device_credentials").get(),
		).toEqual({ c: 1 });
	});

	test("発行したcredentialでAgent Gatewayの認証が通る", async () => {
		const pending = enrollment.createPendingDevice({
			name: "d",
			userId: adminId,
		});
		const result = enrollment.complete(pending.code);
		const store = createDeviceStore(storage.db);
		expect(await store.resolveCredential(result.deviceToken)).toBe(
			result.deviceId,
		);
		expect(await store.resolveCredential("wrong-token")).toBeNull();

		enrollment.revokeCredentials(result.deviceId, adminId);
		expect(await store.resolveCredential(result.deviceToken)).toBeNull();
	});

	test("disabledのDeviceはAgent Gatewayのsyncを拒否する", async () => {
		const pending = enrollment.createPendingDevice({
			name: "d",
			userId: adminId,
		});
		const result = enrollment.complete(pending.code);
		const store = createDeviceStore(storage.db);
		const gateway = new AgentGateway({ store, coalesceWaitMs: 1 });
		const request = {
			authorization: `Bearer ${result.deviceToken}`,
			waitSeconds: 0,
			body: textEscape(concatFrames([encodeFrame(FrameType.HEARTBEAT, 0)])),
		};

		expect((await gateway.handleSync(request)).status).toBe(200);
		storage.db
			.prepare("UPDATE devices SET lifecycle_status = 'disabled' WHERE id = ?")
			.run(result.deviceId);
		expect((await gateway.handleSync(request)).status).toBe(401);
	});

	test("再Enrollmentで旧credentialをrevokeする", async () => {
		const pending = enrollment.createPendingDevice({
			name: "d",
			userId: adminId,
		});
		const first = enrollment.complete(pending.code);
		const reissued = enrollment.issueCode(pending.deviceId, adminId);
		const second = enrollment.complete(reissued.code);
		const store = createDeviceStore(storage.db);
		expect(await store.resolveCredential(first.deviceToken)).toBeNull();
		expect(await store.resolveCredential(second.deviceToken)).toBe(
			pending.deviceId,
		);
	});

	test("Auditへ記録する", () => {
		const pending = enrollment.createPendingDevice({
			name: "d",
			userId: adminId,
		});
		enrollment.complete(pending.code);
		const types = audit.list().map((e) => e.type);
		expect(types).toContain(AuditEventType.DEVICE_PENDING_CREATED);
		expect(types).toContain(AuditEventType.DEVICE_ENROLLED);
		expect(JSON.stringify(audit.list())).not.toContain(pending.code);
	});

	test("進捗を取得できる", () => {
		const pending = enrollment.createPendingDevice({
			name: "d",
			userId: adminId,
		});
		expect(enrollment.status(pending.deviceId)).toMatchObject({
			lifecycle: "pending",
			hasActiveCredential: false,
		});
		enrollment.complete(pending.code);
		expect(enrollment.status(pending.deviceId)).toMatchObject({
			lifecycle: "active",
			hasActiveCredential: true,
			pendingCodeExpiresAt: null,
		});
	});
});

describe("bootstrap and CLI block", () => {
	test("埋め込むwatcher sourceは正本と同期している", () => {
		const source = renderBootstrap({
			baseUrl: BASE_URL,
			code: "TEST-CODE",
		});
		const embedded = source.match(/watcher:write\(\[=\[\n([\s\S]*?)\n\]=\]\)/);
		expect(embedded).not.toBeNull();

		expect(normalizeLuaSource(embedded?.[1] ?? "")).toBe(
			normalizeLuaSource(readFileSync(WATCHER_SOURCE_PATH, "utf8")),
		);
	});

	test("埋め込むSupervisor sourceは正本と同期している", () => {
		const source = renderBootstrap({
			baseUrl: BASE_URL,
			code: "TEST-CODE",
		});
		const embedded = source.match(
			/supervisor:write\(\[=\[\n([\s\S]*?)\n\]=\]\)/,
		);
		expect(embedded).not.toBeNull();

		expect(normalizeLuaSource(embedded?.[1] ?? "")).toBe(
			normalizeLuaSource(readFileSync(SUPERVISOR_SOURCE_PATH, "utf8")),
		);
	});

	test("埋め込むローダーsourceは正本と同期している(#159)", () => {
		const source = renderBootstrap({
			baseUrl: BASE_URL,
			code: "TEST-CODE",
		});
		const embedded = source.match(/loader:write\(\[=\[\n([\s\S]*?)\n\]=\]\)/);
		expect(embedded).not.toBeNull();

		expect(normalizeLuaSource(embedded?.[1] ?? "")).toBe(
			normalizeLuaSource(readFileSync(LOADER_SOURCE_PATH, "utf8")),
		);
	});

	test("Supervisorはslot a、ローダーは起動するpathへ置き、slotを初期化する(#159)", () => {
		const source = renderBootstrap({
			baseUrl: BASE_URL,
			code: "TEST-CODE",
		});
		expect(source).toContain("local SUPERVISOR = '/routemon_bootstrap.lua'");
		expect(source).toContain(
			"local SUPERVISOR_SLOT_A = '/routemon_supervisor_a.lua'",
		);
		expect(source).toContain("os.remove(SUPERVISOR_SLOT_B)");
		expect(
			renderBootstrap({
				baseUrl: BASE_URL,
				code: "TEST-CODE",
				supervisorSlotPath: "/custom_a.lua",
			}),
		).toContain("local SUPERVISOR_SLOT_A = '/custom_a.lua'");
	});

	test("埋め込むSHA-256 sourceは正本と同期している(#164)", () => {
		const source = renderBootstrap({
			baseUrl: BASE_URL,
			code: "TEST-CODE",
		});
		const embedded = source.match(/sha256:write\(\[=\[\n([\s\S]*?)\n\]=\]\)/);
		expect(embedded).not.toBeNull();

		expect(normalizeLuaSource(embedded?.[1] ?? "")).toBe(
			normalizeLuaSource(readFileSync(SHA256_SOURCE_PATH, "utf8")),
		);
	});

	test("EnrollmentはSHA-256を配置し、既知の入力で自己確認する(#164)", () => {
		const source = renderBootstrap({
			baseUrl: BASE_URL,
			code: "TEST-CODE",
		});
		expect(source).toContain("local SHA256 = '/routemon_sha256.lua'");
		expect(source).toContain(
			"ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
		);
		// 配置先を変えられる
		expect(
			renderBootstrap({
				baseUrl: BASE_URL,
				code: "TEST-CODE",
				sha256Path: "/custom_sha256.lua",
			}),
		).toContain("local SHA256 = '/custom_sha256.lua'");
	});

	test("Enrollmentはstable manifestの実versionをconfとstateへ書く", () => {
		const source = renderBootstrap({
			baseUrl: BASE_URL,
			code: "TEST-CODE",
		});
		expect(source).toContain(
			"/v1/agent/releases/' .. tostring(release) .. '/manifest",
		);
		expect(source).toContain(
			"local version = field(manifest.body or '', 'version')",
		);
		expect(source).toContain(
			"initial_version=' .. Q .. tostring(release) .. Q",
		);
		expect(source).toContain(
			"url = gateway .. '/v1/agent/releases/' .. tostring(release)",
		);
		expect(source).toContain("version=' .. Q .. tostring(version) .. Q .. '}'");
	});

	test("Supervisorは両slot不正時にstableを検証してslot aへ置き、health確認後に確定する", () => {
		const source = readFileSync(SUPERVISOR_SOURCE_PATH, "utf8");
		expect(source).toContain("local RECOVERY_RETRY = 300");
		expect(source).toContain(
			"not loadfile(SLOTS[st.active]) and not loadfile(SLOTS[other(st.active)])",
		);
		expect(source).toContain("install(conf, 'stable', 'a')");
		expect(source).toContain("st.active = 'a'");
		expect(source).toContain("st.version = actual_version");
		expect(source).toContain("st.candidate = 'a'");
		expect(source).toContain("st.recovery_pending = true");
		expect(source).toContain("st.recovery_needed = true");
		expect(source).toContain(
			"st.last_rollback = 'recovered_both_slots_invalid'",
		);
		expect(source).toContain("version == st.candidate_version");
		expect(source).toContain("read_file(HEALTH_FILE)");
		expect(source).toContain("st.recovery_needed = nil");
		const recoveryFailure = source.indexOf("log('recovery failed: ' .. err");
		const recoveryRetry = source.indexOf(
			"recovery_retry_at = os.time() + RECOVERY_RETRY",
			recoveryFailure,
		);
		expect(recoveryFailure).toBeGreaterThanOrEqual(0);
		expect(recoveryRetry).toBeGreaterThan(recoveryFailure);

		const sizeCheck = source.indexOf("#data ~= size");
		const hashCheck = source.indexOf("if got ~= hash then");
		const syntaxCheck = source.indexOf("if not loadfile(DOWNLOAD_TMP) then");
		const slotRemoval = source.indexOf("os.remove(dest)");
		const slotMove = source.indexOf("os.rename(DOWNLOAD_TMP, dest)");
		expect(sizeCheck).toBeGreaterThanOrEqual(0);
		expect(hashCheck).toBeGreaterThan(sizeCheck);
		expect(syntaxCheck).toBeGreaterThan(hashCheck);
		expect(slotRemoval).toBeGreaterThan(syntaxCheck);
		expect(slotMove).toBeGreaterThan(slotRemoval);
	});

	test("scheduleは既存Supervisor行を使い、未設定なら最小の空き番号を選ぶ", () => {
		expect(
			planSupervisorSchedule(
				"schedule at 2 +15 * lua /other.lua\nschedule at 7 +15 * lua /routemon_bootstrap.lua",
			),
		).toEqual({ existing: true });
		expect(planSupervisorSchedule("")).toEqual({
			existing: false,
			scheduleNumber: 1,
		});
		expect(
			planSupervisorSchedule(
				"schedule at 1 +15 * lua /other.lua\r\nschedule at 2 +15 * lua /another.lua\r\n",
			),
		).toEqual({ existing: false, scheduleNumber: 3 });

		const source = renderBootstrap({
			baseUrl: BASE_URL,
			code: "TEST-CODE",
		});
		expect(source).toContain(
			"local number = string.match(lower, '^%s*schedule%s+at%s+(%d+)')",
		);
		expect(source).toContain("while occupied[tostring(number)] do");
		expect(source).toContain(
			"schedule at ' .. number .. ' +15 * lua ' .. SUPERVISOR",
		);
	});

	test("既存taskの停止対象からEnrollment task自身を除外する", () => {
		const source = renderBootstrap({
			baseUrl: BASE_URL,
			code: "TEST-CODE",
		});
		const selfGuard = source.indexOf("and script ~= ENROLL_SELF then");
		const terminate = source.lastIndexOf("rt.command('terminate lua ' .. id)");

		expect(source).toContain("local ENROLL_SELF = '/routemon_enroll.lua'");
		expect(source).toContain(
			"local ok_tasks, running = rt.command('show status lua running')",
		);
		expect(selfGuard).toBeGreaterThanOrEqual(0);
		expect(terminate).toBeGreaterThan(selfGuard);
		expect(source).toContain("rt.command('lua ' .. SUPERVISOR)");
		expect(source).not.toContain("rt.command('lua ' .. AGENT)");
	});

	test("Supervisor起動成功後だけEnrollment sourceを削除する", () => {
		const source = renderBootstrap({
			baseUrl: BASE_URL,
			code: "TEST-CODE",
		});
		const start = source.indexOf(
			"local ok_start = rt.command('lua ' .. SUPERVISOR)",
		);
		const failure = source.indexOf("if not ok_start then", start);
		const started = source.indexOf(
			"print('routemon bootstrap: supervisor started')",
			failure,
		);
		const removal = source.indexOf("os.remove(ENROLL_SELF)", started);
		const failureBranch = source.slice(failure, started);

		expect(source).toContain("local ENROLL_SELF = '/routemon_enroll.lua'");
		expect(start).toBeGreaterThanOrEqual(0);
		expect(failure).toBeGreaterThan(start);
		expect(failureBranch).toContain("return");
		expect(started).toBeGreaterThan(failure);
		expect(removal).toBeGreaterThan(started);
		expect(source.match(/os\.remove\(ENROLL_SELF\)/g)).toHaveLength(1);
	});

	test("CLI blockは2行で、Codeとendpointが埋め込まれている", () => {
		const block = renderCliBlock({ baseUrl: BASE_URL, code: "TEST-CODE" });
		const lines = block.split("\n");
		expect(lines).toHaveLength(2);
		expect(lines[0]).toContain(`${BASE_URL}/v1/enrollment/bootstrap`);
		expect(lines[0]).toContain("TEST-CODE");
		expect(lines[1]).toBe("lua /routemon_enroll.lua");
		// RTX830のCLI: 外側は「"」、Lua側の文字列は「'」(docs/core/lua-api-notes.md)
		expect(lines[0]?.startsWith('lua -e "')).toBe(true);
		expect(lines[0]?.endsWith('"')).toBe(true);
		expect(block).not.toContain("\\");
	});

	test('Bootstrapのsourceに「"」とバックスラッシュを含まない', () => {
		const source = renderBootstrap({
			baseUrl: BASE_URL,
			code: "TEST-CODE",
		});
		expect(source).not.toContain('"');
		expect(source).not.toContain("\\");
		expect(source).not.toContain("?");
		expect(source).not.toContain("]]");
		expect(luaCodeWithoutStringsOrComments(source)).not.toMatch(/\b\d+\.\d+\b/);
		expect(
			luaCodeWithoutStringsOrComments(
				readFileSync(SUPERVISOR_SOURCE_PATH, "utf8"),
			),
		).not.toMatch(/\b\d+\.\d+\b/);
		expect(source).toContain("/v1/enrollment/complete");
		expect(source).toContain("routemon_device.conf");
		expect(source).toContain("routemon_syslog_watcher.lua");
		expect(source).toContain("routemon_bootstrap.lua");
		expect(source).toContain("rt.syslogwatch");
		expect(source).toContain("watcher syntax error");
		// Supervisor(#7)と同じpathへ保存しない
		expect(renderCliBlock({ baseUrl: BASE_URL, code: "X" })).not.toContain(
			"save_file = '/routemon_bootstrap.lua'",
		);
		// 正本のSupervisorを書いて構文検査し、既存Routemon taskを置き換えて起動する。
		expect(source).toContain("routemon_state.dat");
		expect(source).toContain("rt.command('save')");
		expect(source).toContain("supervisor started");
	});
});

describe("HTTP API", () => {
	function api() {
		return createApp({
			auth,
			audit,
			enrollment: { service: enrollment, baseUrl: BASE_URL },
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

	test("AdminがDeviceを追加するとCodeとCLI blockが返る", async () => {
		const app = api();
		const cookie = await login(app, "admin");
		const res = await app.request("/api/devices", {
			method: "POST",
			headers: { cookie, "content-type": "application/json" },
			body: JSON.stringify({ name: "Kurume-01" }),
		});
		expect(res.status).toBe(201);
		const body = await res.json();
		expect(body.enrollment.code).toMatch(/^[A-Z2-9]{4}-/);
		expect(body.enrollment.cliBlock).toContain(body.enrollment.code);
	});

	test("ViewerはDeviceを追加できない", async () => {
		await auth.createUser({
			loginId: "viewer",
			password: PASSWORD,
			role: "viewer",
		});
		const app = api();
		const cookie = await login(app, "viewer");
		const res = await app.request("/api/devices", {
			method: "POST",
			headers: { cookie, "content-type": "application/json" },
			body: JSON.stringify({ name: "x" }),
		});
		expect(res.status).toBe(403);
	});

	/** Router向けendpointはAgent向けlistenerに載る(§5)ため、別appで検証する。 */
	function routerApi() {
		const app = new Hono();
		app.route(
			"/",
			createEnrollmentDeviceRoutes(enrollment, { baseUrl: BASE_URL }),
		);
		return app;
	}

	test("RouterはCodeだけでBootstrapを取得でき、完了でcredentialを受け取る", async () => {
		const pending = enrollment.createPendingDevice({
			name: "d",
			userId: adminId,
		});
		const app = routerApi();

		const bootstrap = await app.request("/v1/enrollment/bootstrap", {
			headers: { authorization: `Bearer ${pending.code}` },
		});
		expect(bootstrap.status).toBe(200);
		const bootstrapBody = await bootstrap.text();
		expect(bootstrapBody).toContain("routemon bootstrap");
		expect(bootstrapBody).toContain("routemon_syslog_watcher.lua");

		const complete = await app.request("/v1/enrollment/complete", {
			method: "POST",
			headers: {
				authorization: `Bearer ${pending.code}`,
				"content-type": "application/json",
			},
			body: JSON.stringify({ model: "RTX830", firmwareRevision: "15.02.30" }),
		});
		expect(complete.status).toBe(200);
		const result = await complete.json();
		expect(result.deviceId).toBe(pending.deviceId);
		expect(result.deviceToken).toBeTruthy();
	});

	test("Codeが無い・不正・使用済みなら401", async () => {
		const pending = enrollment.createPendingDevice({
			name: "d",
			userId: adminId,
		});
		const app = routerApi();
		expect((await app.request("/v1/enrollment/bootstrap")).status).toBe(401);
		expect(
			(
				await app.request("/v1/enrollment/bootstrap", {
					headers: { authorization: "Bearer TEST-CODE" },
				})
			).status,
		).toBe(401);

		await app.request("/v1/enrollment/complete", {
			method: "POST",
			headers: { authorization: `Bearer ${pending.code}` },
		});
		const second = await app.request("/v1/enrollment/complete", {
			method: "POST",
			headers: { authorization: `Bearer ${pending.code}` },
		});
		expect(second.status).toBe(401);
	});
});
