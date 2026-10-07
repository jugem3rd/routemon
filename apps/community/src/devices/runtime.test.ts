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
import { afterEach, beforeEach, expect, test } from "vitest";
import { EventRecorder } from "../events/recorder.ts";
import { nowIso } from "../storage/db.ts";
import {
	ensureDefaultTenant,
	openStorage,
	type Storage,
} from "../storage/index.ts";
import { DeviceRuntime, parseBootTime } from "./runtime.ts";

const DEVICE_ID = "d1";
const TOKEN = "device-token";
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * RTX830の`show environment`のうち必要な行(実機出力より)。
 * Routerの出力はShift_JISなので、日本語を含む行はそのbyte列で持つ。
 */
const BOOT_LINE_SJIS = Uint8Array.from([
	0x8b, 0x4e, 0x93, 0xae, 0x8e, 0x9e, 0x8d, 0x8f, 0x3a, 0x20, 0x32, 0x30, 0x32,
	0x36, 0x2f, 0x30, 0x39, 0x2f, 0x31, 0x38, 0x20, 0x32, 0x32, 0x3a, 0x33, 0x30,
	0x3a, 0x33, 0x36, 0x20, 0x2b, 0x30, 0x39, 0x3a, 0x30, 0x30,
]);

const ENVIRONMENT_SJIS = new Uint8Array(
	Buffer.concat([
		Buffer.from("RTX830 Rev.15.02.30\nCPU:    0%(5sec)\n", "ascii"),
		Buffer.from(BOOT_LINE_SJIS),
		Buffer.from("\n", "ascii"),
	]),
);

let root: string;
let storage: Storage;
let tenantId: string;
let gateway: AgentGateway;
let runtime: DeviceRuntime;
let agentRunning = false;

/** Agentの代わり: COMMAND_REQUESTへShift_JISのbyte列で応答する。 */
function startFakeAgent(output: Uint8Array | null) {
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
				if (frame.type !== FrameType.COMMAND_REQUEST || output === null)
					continue;
				outgoing.push(
					encodeFrame(
						FrameType.COMMAND_RESPONSE,
						frame.streamId,
						new Uint8Array(Buffer.concat([Buffer.of(1), Buffer.from(output)])),
					),
				);
			}
			await delay(5);
		}
	})();
}

beforeEach(async () => {
	root = mkdtempSync(join(tmpdir(), "routemon-runtime-"));
	storage = await openStorage({ root });
	tenantId = ensureDefaultTenant(storage.db);
	const at = nowIso();
	storage.db
		.prepare(
			"INSERT INTO devices (id, tenant_id, name, lifecycle_status, created_at, updated_at) VALUES (?, ?, ?, 'active', ?, ?)",
		)
		.run(DEVICE_ID, tenantId, "RTX830", at, at);
	const store = new MemoryDeviceStore();
	store.add(DEVICE_ID, TOKEN);
	gateway = new AgentGateway({ store, coalesceWaitMs: 1 });
	runtime = new DeviceRuntime({
		db: storage.db,
		tenantId,
		gateway,
		events: new EventRecorder({ db: storage.db, tenantId }),
		timeoutMs: 500,
	});
});

afterEach(async () => {
	agentRunning = false;
	storage.close();
	rmSync(root, { recursive: true, force: true });
	await delay(20);
});

test("起動時刻をISO 8601へ変換する(Routerのoffsetを尊重する)", () => {
	expect(parseBootTime("起動時刻: 2026/09/18 22:30:36 +09:00")).toBe(
		"2026-09-18T13:30:36.000Z",
	);
	expect(parseBootTime("起動時刻: 2026/01/02 03:04:05")).toBe(
		"2026-01-02T03:04:05.000Z",
	);
	expect(parseBootTime("起動時刻がありません")).toBeNull();
});

test("観測した起動時刻をDeviceへ保存する", async () => {
	startFakeAgent(ENVIRONMENT_SJIS);
	await delay(30);

	const bootedAt = await runtime.probe(DEVICE_ID);
	expect(bootedAt).toBe("2026-09-18T13:30:36.000Z");

	const row = storage.db
		.prepare("SELECT booted_at, runtime_observed_at FROM devices WHERE id = ?")
		.get(DEVICE_ID) as { booted_at: string; runtime_observed_at: string };
	expect(row.booted_at).toBe("2026-09-18T13:30:36.000Z");
	expect(row.runtime_observed_at).toBeTruthy();
});

test("起動時刻が読めなければ更新しない", async () => {
	startFakeAgent(new Uint8Array(Buffer.from("CPU: 0%(5sec)\n", "ascii")));
	await delay(30);

	expect(await runtime.probe(DEVICE_ID)).toBeNull();
	const row = storage.db
		.prepare("SELECT booted_at FROM devices WHERE id = ?")
		.get(DEVICE_ID) as { booted_at: string | null };
	expect(row.booted_at).toBeNull();
});

test("未接続のDeviceはsweepで飛ばす", async () => {
	await expect(runtime.sweep()).resolves.toBeUndefined();
	const row = storage.db
		.prepare("SELECT booted_at FROM devices WHERE id = ?")
		.get(DEVICE_ID) as { booted_at: string | null };
	expect(row.booted_at).toBeNull();
});

function rebootEvents() {
	return storage.db
		.prepare(
			"SELECT severity, detail_json FROM device_events WHERE device_id = ? AND type = 'device.rebooted'",
		)
		.all(DEVICE_ID) as { severity: string; detail_json: string }[];
}

function setBootedAt(value: string) {
	storage.db
		.prepare("UPDATE devices SET booted_at = ? WHERE id = ?")
		.run(value, DEVICE_ID);
}

test("起動時刻が進んだら、device.rebootedを記録する(#6)", async () => {
	setBootedAt("2026-09-18T12:00:00.000Z");
	startFakeAgent(ENVIRONMENT_SJIS);
	await delay(30);

	await runtime.probe(DEVICE_ID);
	const events = rebootEvents();
	expect(events).toHaveLength(1);
	expect(events[0]?.severity).toBe("info");
	expect(JSON.parse(events[0]?.detail_json ?? "{}")).toEqual({
		booted_at: "2026-09-18T13:30:36.000Z",
		previous_booted_at: "2026-09-18T12:00:00.000Z",
	});

	// 同じ起動時刻の観測は、再起動ではない
	await runtime.probe(DEVICE_ID);
	expect(rebootEvents()).toHaveLength(1);
});

test("初めての観測と、時刻のずれ(NTP補正など)は、再起動にしない", async () => {
	startFakeAgent(ENVIRONMENT_SJIS);
	await delay(30);

	// 初めての観測(booted_atが空)
	await runtime.probe(DEVICE_ID);
	expect(rebootEvents()).toHaveLength(0);

	// 数十秒のずれ
	setBootedAt("2026-09-18T13:29:30.000Z");
	await runtime.probe(DEVICE_ID);
	expect(rebootEvents()).toHaveLength(0);

	// 起動時刻が過去へ戻った場合も、再起動にしない
	setBootedAt("2026-09-19T00:00:00.000Z");
	await runtime.probe(DEVICE_ID);
	expect(rebootEvents()).toHaveLength(0);
});
