import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { EventRecorder } from "../events/recorder.ts";
import type { Storage } from "../storage/index.ts";
import { ensureDefaultTenant, openStorage } from "../storage/index.ts";
import {
	classifySyslogLine,
	EventType,
	SyslogEventExtractor,
} from "./events.ts";

// YAMAHA公式の、RTXのログの実例(日時は2015年。文言は現行と同じ形式)
// - https://network.yamaha.com/setting/router_firewall/ts_router/internet_connect
// - https://network.yamaha.com/setting/router_firewall/ts_router/vpn_connect
const LINES = {
	pppoeConnect: "2015/04/24 12:01:34: PPPOE[01] PPPoE Connect",
	ipcpUp:
		"2015/04/24 13:29:47: PP[01] PPP/IPCP up  (Local: None, Remote: 203.0.113.2)",
	ipcpUpPlain: "2015/04/24 12:01:34: PP[01] PPP/IPCP up",
	localIp: "2015/04/24 12:01:34: PP[01] Local  PP IP address 203.0.113.1",
	localIpFailed: "2015/04/24 13:29:47: PP[01] Local  PP IP address 0.0.0.0",
	disconnectedAuth:
		"2015/04/01 15:06:16: PPPOE[01] Disconnected, cause [PPP: Authentication failed]",
	disconnectedPlain: "2015/04/01 15:06:16: PPPOE[02] Disconnected",
	tunnelUp: "2018/10/29 17:32:24: IP Tunnel[1] Up",
	tunnelDown: "2018/10/29 17:32:55: IP Tunnel[3] Down",
	// 無関係な行(Eventにしない)
	chapFailure:
		"2015/04/01 15:06:16: PP[01] RECV CHAP Failure in CS_OPEN/SS_CLOSED",
	filter:
		"2015/04/17 16:13:36: PP[01] Rejected at OUT(default) filter: UDP 192.168.1.1:10395 >",
	ike: "2015/04/17 14:41:29: [IKE] initiate ISAKMP phase to 203.0.113.2 (local address 192.168.1.1)",
	l2tp: "2018/10/22 14:43:29: [L2TP] TUNNEL[1] connected from 198.51.100.7",
	repeated: "2018/10/25 15:46:26: same message repeated 3 times",
	hexDump:
		"2015/04/24 12:01:34:   c0 21 01 01 00 0e 01 04  05 ae 05 06 c0 7f 33 92",
	configSaved:
		'2026/09/20 22:03:49: Configuration saved in "CONFIG0" by TELNET',
};

test("PPPoEの接続(IPCP up)をppp.upにする", () => {
	for (const line of [LINES.ipcpUp, LINES.ipcpUpPlain]) {
		expect(classifySyslogLine(line)).toEqual({
			kind: "event",
			event: {
				type: EventType.PppUp,
				severity: "info",
				detail: { pp: 1 },
				transitionKey: "ppp:1",
			},
		});
	}
});

test("PPPoEの切断をppp.downにし、理由があれば残す", () => {
	expect(classifySyslogLine(LINES.disconnectedAuth)).toEqual({
		kind: "event",
		event: {
			type: EventType.PppDown,
			severity: "warning",
			detail: { pp: 1, cause: "PPP: Authentication failed" },
			transitionKey: "ppp:1",
		},
	});
	expect(classifySyslogLine(LINES.disconnectedPlain)).toMatchObject({
		event: {
			type: EventType.PppDown,
			detail: { pp: 2 },
			transitionKey: "ppp:2",
		},
	});
});

test("IP Tunnelの接続と切断を、tunnel番号つきで分類する", () => {
	expect(classifySyslogLine(LINES.tunnelUp)).toMatchObject({
		event: {
			type: EventType.TunnelUp,
			severity: "info",
			detail: { tunnel: 1 },
			transitionKey: "tunnel:1",
		},
	});
	expect(classifySyslogLine(LINES.tunnelDown)).toMatchObject({
		event: {
			type: EventType.TunnelDown,
			severity: "warning",
			detail: { tunnel: 3 },
			transitionKey: "tunnel:3",
		},
	});
});

test("日時の接頭辞が無い行も分類できる", () => {
	expect(classifySyslogLine("IP Tunnel[2] Down")).toMatchObject({
		event: { type: EventType.TunnelDown },
	});
});

test("WANのIPアドレスの観測を返す。取得失敗の0.0.0.0は無視する", () => {
	expect(classifySyslogLine(LINES.localIp)).toEqual({
		kind: "ip",
		pp: 1,
		address: "203.0.113.1",
	});
	expect(classifySyslogLine(LINES.localIpFailed)).toBeNull();
});

test("無関係な行は、Eventにならない", () => {
	for (const line of [
		LINES.pppoeConnect,
		LINES.chapFailure,
		LINES.filter,
		LINES.ike,
		LINES.l2tp,
		LINES.repeated,
		LINES.hexDump,
		LINES.configSaved,
		"",
	]) {
		expect(classifySyslogLine(line), line).toBeNull();
	}
});

let root: string;
let storage: Storage;
let tenantId: string;
let now: number;
let recorder: EventRecorder;
let extractor: SyslogEventExtractor;

function events(deviceId = "dev-1") {
	return storage.db
		.prepare(
			"SELECT type, severity, detail_json FROM device_events WHERE device_id = ? ORDER BY rowid",
		)
		.all(deviceId) as { type: string; severity: string; detail_json: string }[];
}

beforeEach(async () => {
	root = mkdtempSync(join(tmpdir(), "routemon-syslog-events-"));
	storage = await openStorage({ root });
	tenantId = ensureDefaultTenant(storage.db);
	for (const id of ["dev-1", "dev-2"]) {
		storage.db
			.prepare(
				`INSERT INTO devices (id, tenant_id, name, lifecycle_status, created_at, updated_at)
				 VALUES (?, ?, ?, 'active', ?, ?)`,
			)
			.run(
				id,
				tenantId,
				id,
				"2026-10-06T00:00:00.000Z",
				"2026-10-06T00:00:00.000Z",
			);
	}
	now = Date.parse("2026-10-06T00:00:00Z");
	recorder = new EventRecorder({ db: storage.db, tenantId, now: () => now });
	extractor = new SyslogEventExtractor({ recorder });
});

afterEach(() => {
	storage.close();
	rmSync(root, { recursive: true, force: true });
});

test("batchの行から、対象のEventだけを記録する", () => {
	const count = extractor.process("dev-1", [
		LINES.filter,
		LINES.disconnectedAuth,
		LINES.hexDump,
		LINES.ipcpUp,
		LINES.tunnelDown,
	]);
	expect(count).toBe(3);
	expect(events().map((e) => e.type)).toEqual([
		"ppp.down",
		"ppp.up",
		"tunnel.down",
	]);
	expect(JSON.parse(events()[0]?.detail_json ?? "{}")).toEqual({
		pp: 1,
		cause: "PPP: Authentication failed",
	});
	// Raw SYSLOG行そのものは、Eventへ複製しない
	expect(JSON.stringify(events())).not.toContain("2015/04");
});

test("IPアドレスは、最初の観測では記録せず、変わったときだけip.changedにする", () => {
	extractor.process("dev-1", [LINES.localIp]);
	expect(events()).toHaveLength(0);

	// 同じアドレス、取得失敗(0.0.0.0)は変更ではない
	extractor.process("dev-1", [LINES.localIp, LINES.localIpFailed]);
	expect(events()).toHaveLength(0);

	extractor.process("dev-1", [
		"2015/04/25 03:00:00: PP[01] Local  PP IP address 203.0.113.99",
	]);
	expect(events().map((e) => e.type)).toEqual(["ip.changed"]);
	expect(JSON.parse(events()[0]?.detail_json ?? "{}")).toEqual({
		pp: 1,
		from: "203.0.113.1",
		to: "203.0.113.99",
	});
});

test("IPアドレスの基準は、Deviceごと・PPごとに持つ", () => {
	extractor.process("dev-1", [LINES.localIp]);
	// 別のDeviceの同じPP番号は、別の基準
	extractor.process("dev-2", [
		"2015/04/25 03:00:00: PP[01] Local  PP IP address 198.51.100.5",
	]);
	// 同じDeviceの別のPPも、別の基準
	extractor.process("dev-1", [
		"2015/04/25 03:00:00: PP[02] Local  PP IP address 198.51.100.9",
	]);
	expect(events("dev-1")).toHaveLength(0);
	expect(events("dev-2")).toHaveLength(0);
});

test("回線が不安定なDeviceは、フラッピングにまとめられる", () => {
	// 10分の間に、PPPの切断と接続を繰り返す
	for (let i = 0; i < 4; i++) {
		extractor.process("dev-1", [LINES.disconnectedAuth]);
		now += 30_000;
		extractor.process("dev-1", [LINES.ipcpUp]);
		now += 30_000;
	}
	const types = events().map((e) => e.type);
	// 5回目の状態変化でフラッピングにまとまり、以降の個別のEventは記録されない
	expect(types).toEqual([
		"ppp.down",
		"ppp.up",
		"ppp.down",
		"ppp.up",
		"event.flapping",
	]);
});

test("フラッピングの判定は、PPPとTunnelで別々に数える", () => {
	for (let i = 0; i < 3; i++) {
		extractor.process("dev-1", [LINES.disconnectedAuth, LINES.tunnelDown]);
		now += 10_000;
	}
	expect(events().some((e) => e.type === "event.flapping")).toBe(false);
});

test("forgetでIPアドレスの基準を捨てる", () => {
	extractor.process("dev-1", [LINES.localIp]);
	extractor.forget("dev-1");
	extractor.process("dev-1", [
		"2015/04/25 03:00:00: PP[01] Local  PP IP address 203.0.113.99",
	]);
	expect(events()).toHaveLength(0);
});
