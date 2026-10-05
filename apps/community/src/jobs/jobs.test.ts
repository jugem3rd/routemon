import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	cobsDecode,
	concatFrames,
	decodeFrames,
	encodeFrame,
	FrameType,
	textEscape,
} from "@routemon/core";
import { AgentGateway, MemoryDeviceStore } from "@routemon/gateway";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createApp } from "../app.ts";
import { AuditEventType, AuditLog } from "../auth/audit.ts";
import { LocalAuth } from "../auth/localAuth.ts";
import { nowIso } from "../storage/db.ts";
import {
	ensureDefaultTenant,
	openStorage,
	type Storage,
} from "../storage/index.ts";
import {
	CommandNotAllowedError,
	DeviceNotFoundError,
	InvalidScheduleError,
	JobNotFoundError,
	Jobs,
} from "./jobs.ts";

const TOKEN = "device-token";
const DEVICE_ID = "d1";
const PASSWORD = "correct horse battery";
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let root: string;
let storage: Storage;
let tenantId: string;
let gateway: AgentGateway;
let audit: AuditLog;
let auth: LocalAuth;
let jobs: Jobs;
let agentRunning = false;

/** Agentの代わり: COMMAND_REQUESTへrt.command()相当の応答を返す。 */
function startFakeAgent(
	reply: (command: string) => { success: boolean; output: Buffer } | null,
) {
	agentRunning = true;
	void (async () => {
		const outgoing: Uint8Array[] = [];
		while (agentRunning) {
			const body = outgoing.splice(0, outgoing.length);
			const response = await gateway.handleSync({
				authorization: `Bearer ${TOKEN}`,
				waitSeconds: 0,
				body: textEscape(
					body.length > 0
						? concatFrames(body)
						: encodeFrame(FrameType.HEARTBEAT, 0),
				),
			});
			for (const frame of decodeFrames(cobsDecode(response.body))) {
				if (frame.type !== FrameType.COMMAND_REQUEST) continue;
				const command = new TextDecoder().decode(frame.payload);
				const result = reply(command);
				if (!result) continue; // 応答しない(timeoutの再現)
				outgoing.push(
					encodeFrame(
						FrameType.COMMAND_RESPONSE,
						frame.streamId,
						new Uint8Array(
							Buffer.concat([Buffer.of(result.success ? 1 : 0), result.output]),
						),
					),
				);
			}
			await delay(5);
		}
	})();
}

beforeEach(async () => {
	root = mkdtempSync(join(tmpdir(), "routemon-jobs-"));
	storage = await openStorage({ root });
	tenantId = ensureDefaultTenant(storage.db);
	const at = nowIso();
	storage.db
		.prepare(
			"INSERT INTO devices (id, tenant_id, name, lifecycle_status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
		)
		.run(DEVICE_ID, tenantId, "RTX830", "active", at, at);

	const store = new MemoryDeviceStore();
	store.add(DEVICE_ID, TOKEN);
	gateway = new AgentGateway({ store, coalesceWaitMs: 1 });
	audit = new AuditLog(storage.db, tenantId);
	auth = new LocalAuth(storage.db, tenantId);
	jobs = new Jobs(storage.db, tenantId, gateway, audit, {
		rebootAckTimeoutMs: 200,
		commandTimeoutMs: 300,
	});
});

afterEach(async () => {
	agentRunning = false;
	storage.close();
	rmSync(root, { recursive: true, force: true });
	await delay(20);
});

async function adminUser() {
	return auth.createFirstAdmin({ loginId: "admin", password: PASSWORD });
}

describe("command execution", () => {
	test("成功したcommandの出力をShift_JISとして取り込む", async () => {
		const admin = await adminUser();
		// 「説明: OK」をShift_JISで返す
		startFakeAgent(() => ({
			success: true,
			output: Buffer.from([0x90, 0xe0, 0x96, 0xbe, 0x3a, 0x20, 0x4f, 0x4b]),
		}));
		await delay(30);

		const job = await jobs.runCommand({
			deviceId: DEVICE_ID,
			command: "show status pp 1",
			userId: admin.id,
		});
		expect(job.status).toBe("success");
		expect(job.output).toBe("説明: OK");
		expect(job.request).toBe("show status pp 1");
		expect(job.requested_by_user_id).toBe(admin.id);
		expect(job.started_at).toBeTruthy();
		expect(job.finished_at).toBeTruthy();
	});

	test("rt.commandが失敗した場合はfailed", async () => {
		const admin = await adminUser();
		startFakeAgent(() => ({
			success: false,
			output: Buffer.from("Error: invalid command"),
		}));
		await delay(30);
		const job = await jobs.runCommand({
			deviceId: DEVICE_ID,
			command: "show bogus",
			userId: admin.id,
		});
		expect(job.status).toBe("failed");
		expect(job.output).toContain("invalid command");
	});

	test("応答が無ければtimeoutになり、再送しない", async () => {
		const admin = await adminUser();
		let requests = 0;
		startFakeAgent(() => {
			requests++;
			return null;
		});
		await delay(30);
		const job = await jobs.runCommand({
			deviceId: DEVICE_ID,
			command: "show config",
			userId: admin.id,
		});
		expect(job.status).toBe("timeout");
		expect(job.error).toContain("timed out");
		await delay(100);
		expect(requests).toBe(1);
	});

	test("Agentが繋がっていなければfailed", async () => {
		const admin = await adminUser();
		const job = await jobs.runCommand({
			deviceId: DEVICE_ID,
			command: "show environment",
			userId: admin.id,
		});
		expect(job.status).toBe("failed");
		expect(job.error).toContain("not connected");
	});

	test("実行をAuditへ残す", async () => {
		const admin = await adminUser();
		startFakeAgent(() => ({ success: true, output: Buffer.from("ok") }));
		await delay(30);
		await jobs.runCommand({
			deviceId: DEVICE_ID,
			command: "show log",
			userId: admin.id,
		});
		const event = audit
			.list()
			.find((e) => e.type === AuditEventType.COMMAND_EXECUTED);
		expect(event?.target_id).toBe(DEVICE_ID);
		expect(JSON.parse(event?.detail_json ?? "{}").command).toBe("show log");
	});
});

describe("reboot", () => {
	test("応答が返らなくてもsuccessにする(Routerが落ちるため)", async () => {
		const admin = await adminUser();
		const commands: string[] = [];
		startFakeAgent((command) => {
			commands.push(command);
			return null; // restartの応答は返らない
		});
		await delay(30);

		const job = await jobs.reboot({ deviceId: DEVICE_ID, userId: admin.id });
		expect(job.status).toBe("success");
		expect(job.type).toBe("reboot");
		expect(job.request).toBe("restart");
		expect(commands).toEqual(["restart"]);

		const events = storage.db
			.prepare(
				"SELECT type, actor_user_id FROM audit_events WHERE type = 'DEVICE_REBOOT_REQUESTED'",
			)
			.all() as { actor_user_id: string }[];
		expect(events).toHaveLength(1);
		expect(events[0]?.actor_user_id).toBe(admin.id);
	});

	test("saveを指定すると保存してから再起動する", async () => {
		const admin = await adminUser();
		const commands: string[] = [];
		startFakeAgent((command) => {
			commands.push(command);
			return command === "save"
				? { success: true, output: Buffer.from("saved") }
				: null;
		});
		await delay(30);

		const job = await jobs.reboot({
			deviceId: DEVICE_ID,
			userId: admin.id,
			save: true,
		});
		expect(job.status).toBe("success");
		expect(commands).toEqual(["save", "restart"]);
	});

	test("saveが失敗したら再起動しない", async () => {
		const admin = await adminUser();
		const commands: string[] = [];
		startFakeAgent((command) => {
			commands.push(command);
			return { success: false, output: Buffer.from("save failed") };
		});
		await delay(30);

		const job = await jobs.reboot({
			deviceId: DEVICE_ID,
			userId: admin.id,
			save: true,
		});
		expect(job.status).toBe("failed");
		expect(commands).toEqual(["save"]);
	});

	test("未接続なら失敗する", async () => {
		const admin = await adminUser();
		await expect(
			jobs.reboot({ deviceId: DEVICE_ID, userId: admin.id }),
		).rejects.toThrow(/not connected/);
	});
});

describe("予約再起動", () => {
	test("予約はqueuedのまま残り、時刻が来たら実行される", async () => {
		const admin = await adminUser();
		const commands: string[] = [];
		startFakeAgent((command) => {
			commands.push(command);
			return null;
		});
		await delay(30);

		const at = new Date(Date.now() + 60_000);
		const job = jobs.scheduleReboot({
			deviceId: DEVICE_ID,
			userId: admin.id,
			at,
		});
		expect(job.status).toBe("queued");
		expect(job.scheduled_at).toBe(at.toISOString());
		expect(jobs.pending(DEVICE_ID)).toHaveLength(1);

		// まだ時刻が来ていないので実行しない
		expect(await jobs.runDue()).toHaveLength(0);
		expect(commands).toEqual([]);

		// 時刻を過ぎたら実行する
		const due = new Jobs(storage.db, tenantId, gateway, audit, {
			rebootAckTimeoutMs: 200,
			now: () => Date.now() + 120_000,
		});
		const executed = await due.runDue();
		expect(executed).toHaveLength(1);
		expect(executed[0]?.status).toBe("success");
		expect(commands).toEqual(["restart"]);
		expect(jobs.pending(DEVICE_ID)).toHaveLength(0);
	});

	test("過去の時刻は受け付けない", async () => {
		const admin = await adminUser();
		expect(() =>
			jobs.scheduleReboot({
				deviceId: DEVICE_ID,
				userId: admin.id,
				at: new Date(Date.now() - 1000),
			}),
		).toThrow(InvalidScheduleError);
		expect(jobs.pending()).toHaveLength(0);
	});

	test("予約を取り消すと実行されない", async () => {
		const admin = await adminUser();
		const job = jobs.scheduleReboot({
			deviceId: DEVICE_ID,
			userId: admin.id,
			at: new Date(Date.now() + 60_000),
		});
		const cancelled = jobs.cancelScheduled(job.id, admin.id);
		expect(cancelled.status).toBe("cancelled");
		expect(jobs.pending(DEVICE_ID)).toHaveLength(0);

		// 取り消し済みは二度目を受け付けない
		expect(() => jobs.cancelScheduled(job.id, admin.id)).toThrow(
			InvalidScheduleError,
		);

		const due = new Jobs(storage.db, tenantId, gateway, audit, {
			now: () => Date.now() + 120_000,
		});
		expect(await due.runDue()).toHaveLength(0);
	});

	test("即時実行のJobは取り消せない", async () => {
		const admin = await adminUser();
		startFakeAgent(() => null);
		await delay(30);
		const job = await jobs.reboot({ deviceId: DEVICE_ID, userId: admin.id });
		expect(() => jobs.cancelScheduled(job.id, admin.id)).toThrow(
			JobNotFoundError,
		);
	});
});

describe("command restrictions", () => {
	test("既定の禁止commandを拒否する", async () => {
		const admin = await adminUser();
		expect(jobs.isAllowed("show status lua")).toBe(true);
		expect(jobs.isAllowed("terminate lua 1")).toBe(false);
		expect(jobs.isAllowed("  TERMINATE  LUA 2")).toBe(false);
		expect(jobs.isAllowed("no schedule at 1")).toBe(false);
		await expect(
			jobs.runCommand({
				deviceId: DEVICE_ID,
				command: "terminate lua 1",
				userId: admin.id,
			}),
		).rejects.toThrow(CommandNotAllowedError);
		expect(jobs.list()).toHaveLength(0); // Jobも作らない
	});

	test("空commandと長すぎるcommandを拒否する", async () => {
		const admin = await adminUser();
		await expect(
			jobs.runCommand({
				deviceId: DEVICE_ID,
				command: "   ",
				userId: admin.id,
			}),
		).rejects.toThrow(CommandNotAllowedError);
		await expect(
			jobs.runCommand({
				deviceId: DEVICE_ID,
				command: "x".repeat(4096),
				userId: admin.id,
			}),
		).rejects.toThrow(CommandNotAllowedError);
	});

	test("禁止commandは設定で変えられる", async () => {
		const custom = new Jobs(storage.db, tenantId, gateway, audit, {
			deniedCommands: [/^show config$/],
		});
		expect(custom.isAllowed("show config")).toBe(false);
		expect(custom.isAllowed("terminate lua 1")).toBe(true);
	});

	test("CONFIGの専用経路を迂回するcommandを拒否する", () => {
		expect(jobs.isAllowed("load file /tmp/config")).toBe(false);
		expect(jobs.isAllowed("save")).toBe(false);
		expect(jobs.isAllowed("restart")).toBe(false);
		expect(jobs.isAllowed("confirm")).toBe(false);
		expect(
			jobs.isAllowed("load file /tmp/config silent rollback-timer=300"),
		).toBe(false);
	});

	test("存在しないDeviceは拒否する", async () => {
		const admin = await adminUser();
		await expect(
			jobs.runCommand({
				deviceId: "missing",
				command: "show log",
				userId: admin.id,
			}),
		).rejects.toThrow(DeviceNotFoundError);
	});
});

describe("HTTP API", () => {
	function api() {
		return createApp({ auth, audit, jobs, secureCookie: false });
	}

	async function login(app: ReturnType<typeof api>, identifier: string) {
		const res = await app.request("/api/auth/login", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ identifier, password: PASSWORD }),
		});
		return res.headers.get("set-cookie")?.split(";")[0] ?? "";
	}

	test("Adminは実行でき、Viewerは実行できないが履歴は見られる", async () => {
		await adminUser();
		await auth.createUser({
			loginId: "viewer",
			password: PASSWORD,
			role: "viewer",
		});
		startFakeAgent(() => ({ success: true, output: Buffer.from("PP[01] up") }));
		await delay(30);

		const app = api();
		const adminCookie = await login(app, "admin");
		const created = await app.request(`/api/devices/${DEVICE_ID}/commands`, {
			method: "POST",
			headers: { cookie: adminCookie, "content-type": "application/json" },
			body: JSON.stringify({ command: "show status pp 1" }),
		});
		expect(created.status).toBe(201);
		const job = (await created.json()).job;
		expect(job.status).toBe("success");

		const viewerCookie = await login(app, "viewer");
		const denied = await app.request(`/api/devices/${DEVICE_ID}/commands`, {
			method: "POST",
			headers: { cookie: viewerCookie, "content-type": "application/json" },
			body: JSON.stringify({ command: "show status pp 1" }),
		});
		expect(denied.status).toBe(403);

		const history = await app.request(`/api/jobs?deviceId=${DEVICE_ID}`, {
			headers: { cookie: viewerCookie },
		});
		expect(history.status).toBe(200);
		expect((await history.json()).jobs).toHaveLength(1);

		const detail = await app.request(`/api/jobs/${job.id}`, {
			headers: { cookie: viewerCookie },
		});
		expect((await detail.json()).job.output).toBe("PP[01] up");
	});

	test("再起動はAdminのみ、未接続なら409", async () => {
		await adminUser();
		await auth.createUser({
			loginId: "viewer",
			password: PASSWORD,
			role: "viewer",
		});
		const app = api();

		// Agent未接続
		const adminCookie = await login(app, "admin");
		const offline = await app.request(`/api/devices/${DEVICE_ID}/reboot`, {
			method: "POST",
			headers: { cookie: adminCookie, "content-type": "application/json" },
			body: "{}",
		});
		expect(offline.status).toBe(409);

		startFakeAgent(() => null); // restartには応答しない
		await delay(30);
		const accepted = await app.request(`/api/devices/${DEVICE_ID}/reboot`, {
			method: "POST",
			headers: { cookie: adminCookie, "content-type": "application/json" },
			body: "{}",
		});
		expect(accepted.status).toBe(202);
		expect((await accepted.json()).job.status).toBe("success");

		const viewerCookie = await login(app, "viewer");
		const denied = await app.request(`/api/devices/${DEVICE_ID}/reboot`, {
			method: "POST",
			headers: { cookie: viewerCookie, "content-type": "application/json" },
			body: "{}",
		});
		expect(denied.status).toBe(403);
	});

	test("未認証は401、禁止commandは400、不明なJobは404", async () => {
		await adminUser();
		const app = api();
		expect((await app.request("/api/jobs")).status).toBe(401);

		const cookie = await login(app, "admin");
		const denied = await app.request(`/api/devices/${DEVICE_ID}/commands`, {
			method: "POST",
			headers: { cookie, "content-type": "application/json" },
			body: JSON.stringify({ command: "terminate lua 1" }),
		});
		expect(denied.status).toBe(400);
		expect(
			(await app.request("/api/jobs/unknown", { headers: { cookie } })).status,
		).toBe(404);
	});
});
