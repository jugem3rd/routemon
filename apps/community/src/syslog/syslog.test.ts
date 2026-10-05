import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	cobsDecode,
	concatFrames,
	decodeFrames,
	encodeFrame,
	type Frame,
	FrameType,
	textEscape,
} from "@routemon/core";
import { AgentGateway, MemoryDeviceStore } from "@routemon/gateway";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createApp } from "../app.ts";
import { AuditLog } from "../auth/audit.ts";
import { LocalAuth } from "../auth/localAuth.ts";
import { ConfigSnapshots } from "../config/configSnapshots.ts";
import { nowIso } from "../storage/db.ts";
import {
	DEFAULT_SYSLOG_POLICY,
	ensureDefaultTenant,
	openStorage,
	type Storage,
} from "../storage/index.ts";
import {
	CONFIG_CHANGE_DEBOUNCE_MS,
	DEFAULT_RESULT_LINES,
	isConfigSavedLine,
	MAX_RESULT_LINES,
	SyslogService,
	TimeRangeTooLargeError,
} from "./service.ts";

const TOKEN = "device-token";
const DEVICE_ID = "d1";
const PASSWORD = "correct horse battery";
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let root: string;
let storage: Storage;
let tenantId: string;
let gateway: AgentGateway;
let syslog: SyslogService;
let snapshots: ConfigSnapshots;
let auth: LocalAuth;
let audit: AuditLog;
let now: number;

/** Agentの代わりに1回syncし、Gatewayから届いたframeを返す。 */
async function sync(frames: Uint8Array[] = []): Promise<Frame[]> {
	const response = await gateway.handleSync({
		authorization: `Bearer ${TOKEN}`,
		waitSeconds: 0,
		body: textEscape(
			frames.length > 0
				? concatFrames(frames)
				: encodeFrame(FrameType.HEARTBEAT, 0),
		),
	});
	return decodeFrames(cobsDecode(response.body));
}

/** Shift_JISのSYSLOG batch(LF区切り)。 */
function batch(lines: string[]): Uint8Array {
	// 「説明:」を含む行でShift_JISの取り込みも確認する
	const encoded = lines.map((line) =>
		line === "JP"
			? Buffer.from([0x90, 0xe0, 0x96, 0xbe, 0x3a, 0x20, 0x4f, 0x4b])
			: Buffer.from(line, "latin1"),
	);
	return new Uint8Array(
		Buffer.concat(encoded.flatMap((line) => [line, Buffer.of(0x0a)])),
	);
}

beforeEach(async () => {
	root = mkdtempSync(join(tmpdir(), "routemon-syslog-"));
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
	now = Date.parse("2026-09-16T12:00:00.000Z");
	auth = new LocalAuth(storage.db, tenantId);
	audit = new AuditLog(storage.db, tenantId);
	snapshots = new ConfigSnapshots({
		db: storage.db,
		tenantId,
		backups: storage.configBackups,
		gateway,
		audit,
	});
	syslog = new SyslogService(gateway, storage.syslog, () => now, {
		configSnapshots: snapshots,
	});
});

afterEach(() => {
	vi.useRealTimers();
	storage.close();
	rmSync(root, { recursive: true, force: true });
});

describe("CONFIG変更検知", () => {
	test("CONFIG保存SYSLOGの形式だけを判定する", () => {
		expect(
			isConfigSavedLine(
				'2026/09/20 22:03:49: Configuration saved in "CONFIG0" by TELNET',
			),
		).toBe(true);
		expect(isConfigSavedLine('Configuration saved in "CONFIG1" by HTTPD')).toBe(
			true,
		);
		expect(
			isConfigSavedLine(
				'2026/09/20 22:03:49: Configuration changed in "CONFIG0" by TELNET',
			),
		).toBe(false);
		expect(isConfigSavedLine('Configuration saved in "CONFIG0"')).toBe(false);
	});

	test("最後の保存から30秒後にCONFIG_REQUESTを1回だけ送る", async () => {
		vi.useFakeTimers();
		try {
			await sync(); // Deviceを接続済みにする
			const saved =
				'2026/09/20 22:03:49: Configuration saved in "CONFIG0" by TELNET';

			await syslog.handleBatch(DEVICE_ID, batch([saved]));
			await vi.advanceTimersByTimeAsync(CONFIG_CHANGE_DEBOUNCE_MS - 1);
			await syslog.handleBatch(DEVICE_ID, batch([saved]));
			await vi.advanceTimersByTimeAsync(CONFIG_CHANGE_DEBOUNCE_MS - 1);
			expect(await sync()).toEqual([]);

			await vi.advanceTimersByTimeAsync(1);
			const frames = await sync();
			expect(frames.map((frame) => frame.type)).toEqual([
				FrameType.CONFIG_REQUEST,
			]);
			expect(new TextDecoder().decode(frames[0]?.payload)).toBe(
				"config_changed",
			);
		} finally {
			vi.clearAllTimers();
			vi.useRealTimers();
		}
	});

	test("debounce発火時に未接続ならCONFIG_REQUESTを破棄する", async () => {
		vi.useFakeTimers();
		try {
			await sync();
			await vi.advanceTimersByTimeAsync(45_001);
			await syslog.handleBatch(
				DEVICE_ID,
				batch([
					'2026/09/20 22:03:49: Configuration saved in "CONFIG0" by TELNET',
				]),
			);
			await vi.advanceTimersByTimeAsync(CONFIG_CHANGE_DEBOUNCE_MS);

			expect(await sync()).toEqual([]);
		} finally {
			vi.clearAllTimers();
			vi.useRealTimers();
		}
	});
});

describe("collection", () => {
	test("LF区切りのbatchを取り込み、Shift_JISをデコードする", async () => {
		const lines = await syslog.handleBatch(
			DEVICE_ID,
			batch(["PP[01] PPPoE connected", "JP", ""]),
		);
		expect(lines.map((l) => l.message)).toEqual([
			"PP[01] PPPoE connected",
			"説明: OK",
		]);
		expect(lines[0]?.ts).toBe("2026-09-16T12:00:00.000Z");

		const history = await syslog.history(DEVICE_ID, {
			from: new Date(now - 1000),
			to: new Date(now + 1000),
		});
		expect(history.map((l) => l.message)).toEqual([
			"PP[01] PPPoE connected",
			"説明: OK",
		]);
	});

	test("空のbatchは保存しない", async () => {
		expect(await syslog.handleBatch(DEVICE_ID, batch(["", "  "]))).toEqual([]);
		expect((await syslog.usage(DEVICE_ID)).usedBytes).toBe(0);
	});

	test("Device単位で保存する", async () => {
		await syslog.handleBatch(DEVICE_ID, batch(["for d1"]));
		await syslog.handleBatch("other", batch(["for other"]));
		const usage = await syslog.usage(DEVICE_ID);
		expect(usage.usedBytes).toBeGreaterThan(0);
		const history = await syslog.history(DEVICE_ID, {
			from: new Date(now - 1000),
			to: new Date(now + 1000),
		});
		expect(history.map((l) => l.message)).toEqual(["for d1"]);
	});
});

describe("live logs", () => {
	test("購読でAgentへLive modeを通知し、解除で戻す", async () => {
		await sync(); // Deviceを接続済みにする
		const received: string[] = [];
		const unsubscribe = syslog.subscribe(DEVICE_ID, (line) =>
			received.push(line.message),
		);

		const on = await sync();
		expect(on.map((f) => [f.type, f.payload[0]])).toEqual([
			[FrameType.SYSLOG_LIVE, 1],
		]);

		await syslog.handleBatch(DEVICE_ID, batch(["live line"]));
		expect(received).toEqual(["live line"]);

		unsubscribe();
		const off = await sync();
		expect(off.map((f) => [f.type, f.payload[0]])).toEqual([
			[FrameType.SYSLOG_LIVE, 0],
		]);
	});

	test("購読者が複数いる場合は最後の解除でoffにする", async () => {
		await sync();
		const a = syslog.subscribe(DEVICE_ID, () => {});
		const b = syslog.subscribe(DEVICE_ID, () => {});
		expect((await sync()).map((f) => f.type)).toEqual([FrameType.SYSLOG_LIVE]);
		a();
		expect(await sync()).toHaveLength(0);
		b();
		expect((await sync()).map((f) => f.payload[0])).toEqual([0]);
	});

	test("再接続後にLive modeを再通知できる", async () => {
		await sync();
		syslog.subscribe(DEVICE_ID, () => {});
		await sync(); // 最初の通知を受け取る
		syslog.resyncLive(DEVICE_ID);
		expect((await sync()).map((f) => f.payload[0])).toEqual([1]);
	});

	test("Agent未接続でも購読はできる", () => {
		expect(() => syslog.subscribe("offline-device", () => {})).not.toThrow();
	});
});

describe("history", () => {
	test("time rangeで絞り込む", async () => {
		await syslog.handleBatch(DEVICE_ID, batch(["old"]));
		now += 2 * 60 * 60 * 1000;
		await syslog.handleBatch(DEVICE_ID, batch(["new"]));

		const recent = await syslog.history(DEVICE_ID, {
			from: new Date(now - 60 * 60 * 1000),
			to: new Date(now + 1000),
		});
		expect(recent.map((l) => l.message)).toEqual(["new"]);
	});

	test("24時間を超える範囲は拒否する", async () => {
		await expect(
			syslog.history(DEVICE_ID, {
				from: new Date(now - 25 * 60 * 60 * 1000),
				to: new Date(now),
			}),
		).rejects.toThrow(TimeRangeTooLargeError);
	});

	test("件数の上限を超えない", async () => {
		await syslog.handleBatch(
			DEVICE_ID,
			batch(Array.from({ length: 50 }, (_, i) => `line ${i}`)),
		);
		const limited = await syslog.history(DEVICE_ID, {
			from: new Date(now - 1000),
			to: new Date(now + 1000),
			limit: 10,
		});
		expect(limited).toHaveLength(10);
		expect(MAX_RESULT_LINES).toBe(10_000);
	});

	test("keywordの部分一致とexcludeで絞り込む", async () => {
		await syslog.handleBatch(
			DEVICE_ID,
			batch(["PPPoE connected", "ppp disconnected", "TUNNEL up"]),
		);

		const result = await syslog.historyResult(DEVICE_ID, {
			from: new Date(now - 1000),
			to: new Date(now + 1000),
			keyword: "PPP",
			exclude: "disconnected",
		});
		expect(result).toEqual({
			lines: [{ ts: new Date(now).toISOString(), message: "PPPoE connected" }],
			truncated: false,
		});
	});

	test("既定limitは1,000行で、明示すれば10,000行まで取得できる", async () => {
		await syslog.handleBatch(
			DEVICE_ID,
			batch(
				Array.from({ length: MAX_RESULT_LINES + 1 }, (_, i) => `line ${i}`),
			),
		);

		const defaultResult = await syslog.historyResult(DEVICE_ID, {
			from: new Date(now - 1000),
			to: new Date(now + 1000),
		});
		expect(defaultResult.lines).toHaveLength(DEFAULT_RESULT_LINES);
		expect(defaultResult.truncated).toBe(true);

		const result = await syslog.historyResult(DEVICE_ID, {
			from: new Date(now - 1000),
			to: new Date(now + 1000),
			limit: MAX_RESULT_LINES,
		});
		expect(result.lines).toHaveLength(MAX_RESULT_LINES);
		expect(result.truncated).toBe(true);
	});
});

describe("HTTP API", () => {
	function api() {
		return createApp({
			auth,
			audit,
			syslog: { service: syslog, db: storage.db, tenantId },
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

	test("ViewerもSYSLOGを閲覧できる", async () => {
		await auth.createFirstAdmin({ loginId: "admin", password: PASSWORD });
		await auth.createUser({
			loginId: "viewer",
			password: PASSWORD,
			role: "viewer",
		});
		await syslog.handleBatch(DEVICE_ID, batch(["TUNNEL[1] up"]));

		const app = api();
		const cookie = await login(app, "viewer");
		const res = await app.request(
			`/api/devices/${DEVICE_ID}/syslog?from=${new Date(now - 1000).toISOString()}&to=${new Date(now + 1000).toISOString()}`,
			{ headers: { cookie } },
		);
		expect(res.status).toBe(200);
		expect((await res.json()).lines[0].message).toBe("TUNNEL[1] up");

		const usage = await app.request(
			`/api/devices/${DEVICE_ID}/syslog/storage`,
			{ headers: { cookie } },
		);
		const usageBody = await usage.json();
		expect(usageBody.usedBytes).toBeGreaterThan(0);
		expect(usageBody).toMatchObject({
			maxBytes: DEFAULT_SYSLOG_POLICY.maxBytes,
			retentionDays: DEFAULT_SYSLOG_POLICY.retentionDays,
			lowWatermark: DEFAULT_SYSLOG_POLICY.lowWatermark,
		});
	});

	test("未認証は401、存在しないDeviceは404、範囲が広すぎると400", async () => {
		await auth.createFirstAdmin({ loginId: "admin", password: PASSWORD });
		const app = api();
		expect((await app.request(`/api/devices/${DEVICE_ID}/syslog`)).status).toBe(
			401,
		);

		const cookie = await login(app, "admin");
		expect(
			(
				await app.request("/api/devices/missing/syslog", {
					headers: { cookie },
				})
			).status,
		).toBe(404);
		const wide = await app.request(
			`/api/devices/${DEVICE_ID}/syslog?from=${new Date(now - 48 * 60 * 60 * 1000).toISOString()}&to=${new Date(now).toISOString()}`,
			{ headers: { cookie } },
		);
		expect(wide.status).toBe(400);
	});

	test("keyword/excludeで絞り込み、同じ条件でdownloadできる", async () => {
		await auth.createFirstAdmin({ loginId: "admin", password: PASSWORD });
		await syslog.handleBatch(
			DEVICE_ID,
			batch(["PPPoE connected", "PPPoE disconnected", "TUNNEL up"]),
		);
		const app = api();
		const cookie = await login(app, "admin");
		const query = new URLSearchParams({
			from: new Date(now - 1000).toISOString(),
			to: new Date(now + 1000).toISOString(),
			keyword: "ppp",
			exclude: "disconnected",
		});

		const history = await app.request(
			`/api/devices/${DEVICE_ID}/syslog?${query.toString()}`,
			{ headers: { cookie } },
		);
		expect(history.status).toBe(200);
		expect(await history.json()).toMatchObject({
			lines: [{ message: "PPPoE connected" }],
			truncated: false,
		});

		const download = await app.request(
			`/api/devices/${DEVICE_ID}/syslog/download?${query.toString()}`,
			{ headers: { cookie } },
		);
		expect(download.status).toBe(200);
		expect(download.headers.get("content-type")).toContain("text/plain");
		expect(download.headers.get("content-disposition")).toContain(
			"syslog-d1.log",
		);
		const text = await download.text();
		expect(text).toContain("PPPoE connected");
		expect(text).not.toContain("disconnected");
		expect(text).not.toContain("TUNNEL");
		expect(text.startsWith("# truncated")).toBe(false);
	});

	test("10,000行で切り詰めたdownloadにはコメントを付ける", async () => {
		await auth.createFirstAdmin({ loginId: "admin", password: PASSWORD });
		await syslog.handleBatch(
			DEVICE_ID,
			batch(
				Array.from({ length: MAX_RESULT_LINES + 1 }, (_, i) => `line ${i}`),
			),
		);
		const app = api();
		const cookie = await login(app, "admin");
		const query = new URLSearchParams({
			from: new Date(now - 1000).toISOString(),
			to: new Date(now + 1000).toISOString(),
			limit: String(MAX_RESULT_LINES),
		});

		const download = await app.request(
			`/api/devices/${DEVICE_ID}/syslog/download?${query.toString()}`,
			{ headers: { cookie } },
		);
		expect(download.status).toBe(200);
		const text = await download.text();
		expect(text.startsWith("# truncated at 10000 lines\n")).toBe(true);
		expect(text.trimEnd().split("\n")).toHaveLength(MAX_RESULT_LINES + 1);
	});

	test("Live LogsをSSEで受け取れる", async () => {
		await auth.createFirstAdmin({ loginId: "admin", password: PASSWORD });
		await sync();
		const app = api();
		const cookie = await login(app, "admin");
		const controller = new AbortController();
		const res = await app.request(`/api/devices/${DEVICE_ID}/syslog/live`, {
			headers: { cookie },
			signal: controller.signal,
		});
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toContain("text/event-stream");

		const reader = (res.body as ReadableStream<Uint8Array>).getReader();
		await delay(20);
		await syslog.handleBatch(DEVICE_ID, batch(["live via sse"]));
		const chunk = await reader.read();
		const text = new TextDecoder().decode(chunk.value);
		expect(text).toContain("event: syslog");
		expect(text).toContain("live via sse");
		await reader.cancel();
		controller.abort();
	});
});
