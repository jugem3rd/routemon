import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AgentGateway, CommandTimeoutError } from "@routemon/gateway";
import { afterEach, beforeEach, expect, test } from "vitest";
import { nowIso } from "../storage/db.ts";
import {
	ensureDefaultTenant,
	openStorage,
	type Storage,
} from "../storage/index.ts";
import {
	MAX_ROUTE_TABLE_OUTPUT_BYTES,
	ROUTE_TABLE_RECONCILE_CHECK_MS,
	ROUTE_TABLE_RECONCILE_INTERVAL_MS,
	RouteTableCollector,
} from "./collector.ts";
import { RouteTableRepository } from "./repository.ts";

const IPV4_OUTPUT = [
	"Destination Gateway Interface Type",
	"default - PP[01] static",
	"198.51.100.0/24 198.51.100.1 LAN1 OSPF cost=10",
].join("\r\n");
const IPV4_CHANGED_OUTPUT = [
	"Destination Gateway Interface Type",
	"default - PP[01] static",
	"203.0.113.0/24 203.0.113.1 TUNNEL[1] RIP metric=2",
].join("\r\n");
const IPV4_PARTIAL_OUTPUT = [
	"Destination Gateway Interface Type",
	"198.51.100.0/24 198.51.100.1 LAN1 static",
	"malformed documentation fixture row",
].join("\r\n");
const IPV6_OUTPUT = [
	"Destination Gateway Interface Type",
	"2001:db8:1::/64 2001:db8::1 LAN1 static",
].join("\r\n");

type CommandResult = { success: boolean; output: Uint8Array } | Error;
type CommandCall = { deviceId: string; command: string; at: number };

let root: string;
let storage: Storage;
let tenantId: string;
let now: number;
let online: Set<string>;
let commandCalls: CommandCall[];
let queuedResults: CommandResult[];
let gateway: AgentGateway;
let repository: RouteTableRepository;

function addDevice(
	deviceId: string,
	lifecycleStatus: "active" | "disabled" = "active",
): void {
	const at = nowIso(new Date(now));
	storage.db
		.prepare(
			"INSERT INTO devices (id, tenant_id, name, lifecycle_status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
		)
		.run(deviceId, tenantId, deviceId, lifecycleStatus, at, at);
}

function output(text: string): Uint8Array {
	return new TextEncoder().encode(text);
}

function enqueue(...results: CommandResult[]): void {
	queuedResults.push(...results);
}

function successful(text: string): CommandResult {
	return { success: true, output: output(text) };
}

function defaultResult(command: string): CommandResult {
	return successful(command === "show ip route" ? IPV4_OUTPUT : IPV6_OUTPUT);
}

beforeEach(async () => {
	root = mkdtempSync(join(tmpdir(), "routemon-route-tables-"));
	storage = await openStorage({ root });
	tenantId = ensureDefaultTenant(storage.db);
	now = Date.UTC(2026, 0, 1);
	online = new Set();
	commandCalls = [];
	queuedResults = [];
	gateway = {
		presence: (deviceId: string) =>
			({
				deviceId,
				status: online.has(deviceId) ? "online" : "offline",
				lastSeenAt: online.has(deviceId) ? new Date(now) : null,
				observedSourceIp: undefined,
			}) as ReturnType<AgentGateway["presence"]>,
		sendCommand: async (deviceId: string, bytes: Uint8Array) => {
			const command = new TextDecoder().decode(bytes);
			commandCalls.push({ deviceId, command, at: now });
			const next = queuedResults.shift() ?? defaultResult(command);
			if (next instanceof Error) throw next;
			return next;
		},
	} as unknown as AgentGateway;
	repository = new RouteTableRepository(storage.db);
});

afterEach(() => {
	storage.close();
	rmSync(root, { recursive: true, force: true });
});

function collector(options: { intervalMs?: number } = {}) {
	return new RouteTableCollector({
		db: storage.db,
		tenantId,
		gateway,
		repository,
		intervalMs: options.intervalMs,
		now: () => now,
	});
}

test("成功snapshotを保存し、timeoutと失敗commandでは前回値を残す", async () => {
	addDevice("d1");
	online.add("d1");
	const routeCollector = collector();
	enqueue(successful(IPV4_OUTPUT), successful(IPV6_OUTPUT));
	await routeCollector.refresh("d1");
	const captured = routeCollector.get("d1");
	expect(captured.ipv4).toMatchObject({
		lastAttemptStatus: "complete",
		capturedAt: new Date(now).toISOString(),
		lastErrorCode: null,
	});
	expect(captured.ipv4?.routes).toHaveLength(2);
	expect(captured.ipv6?.routes).toHaveLength(1);

	now += 1_000;
	enqueue(successful(IPV4_CHANGED_OUTPUT), successful(IPV6_OUTPUT));
	await routeCollector.refresh("d1");
	const changedSnapshot = routeCollector.get("d1");
	const changed = changedSnapshot.ipv4;
	const previousIpv6 = changedSnapshot.ipv6;
	expect(previousIpv6?.capturedAt).toBe(new Date(now).toISOString());
	expect(previousIpv6?.changedAt).toBe(captured.ipv6?.changedAt);
	expect(changed?.changedAt).toBe(new Date(now).toISOString());
	expect(changed?.routes[1]?.destination).toBe("203.0.113.0/24");

	now += 1_000;
	enqueue(new CommandTimeoutError(), { success: false, output: output("") });
	await routeCollector.refresh("d1");
	const afterFailure = routeCollector.get("d1");

	expect(afterFailure.ipv4).toMatchObject({
		capturedAt: changed?.capturedAt,
		changedAt: changed?.changedAt,
		lastAttemptStatus: "failed",
		lastErrorCode: "timeout",
		routes: changed?.routes,
	});
	expect(afterFailure.ipv4?.lastAttemptAt).not.toBe(changed?.lastAttemptAt);
	expect(afterFailure.ipv6).toMatchObject({
		capturedAt: previousIpv6?.capturedAt,
		changedAt: previousIpv6?.changedAt,
		lastAttemptStatus: "failed",
		lastErrorCode: "command_failed",
		routes: previousIpv6?.routes,
	});
});

test("partialは未解析行と解析できた経路を保存し、その後の失敗でもsnapshotを保つ", async () => {
	addDevice("d1");
	online.add("d1");
	const routeCollector = collector();
	enqueue(successful(IPV4_PARTIAL_OUTPUT), successful(IPV6_OUTPUT));
	await routeCollector.refresh("d1");
	const partial = routeCollector.get("d1").ipv4;
	expect(partial).toMatchObject({
		lastAttemptStatus: "partial",
		lastErrorCode: null,
		unparsedLines: ["malformed documentation fixture row"],
	});
	expect(partial?.routes).toHaveLength(1);

	now += 1_000;
	enqueue(new CommandTimeoutError(), successful(IPV6_OUTPUT));
	await routeCollector.refresh("d1");
	expect(routeCollector.get("d1").ipv4).toMatchObject({
		capturedAt: partial?.capturedAt,
		changedAt: partial?.changedAt,
		lastAttemptStatus: "failed",
		lastErrorCode: "timeout",
		routes: partial?.routes,
		unparsedLines: partial?.unparsedLines,
	});
});

test("128 KiB超過とunrecognized_outputは成功snapshotを置き換えない", async () => {
	addDevice("d1");
	online.add("d1");
	const routeCollector = collector();
	enqueue(successful(IPV4_OUTPUT), successful(IPV6_OUTPUT));
	await routeCollector.refresh("d1");
	const original = routeCollector.get("d1").ipv4;

	const oversized = "x".repeat(MAX_ROUTE_TABLE_OUTPUT_BYTES + 1);
	now += 1_000;
	enqueue(successful(oversized), successful(IPV6_OUTPUT));
	await routeCollector.refresh("d1");
	expect(routeCollector.get("d1").ipv4).toMatchObject({
		capturedAt: original?.capturedAt,
		lastAttemptStatus: "failed",
		lastErrorCode: "output_too_large",
		routes: original?.routes,
	});

	now += 1_000;
	enqueue(
		successful("diagnostic output without a known route header"),
		successful(IPV6_OUTPUT),
	);
	await routeCollector.refresh("d1");
	expect(routeCollector.get("d1").ipv4).toMatchObject({
		capturedAt: original?.capturedAt,
		lastAttemptStatus: "failed",
		lastErrorCode: "unrecognized_output",
		routes: original?.routes,
	});
});

test("定期取得は起動直後に走らず、24時間周期をDevice IDの位相に分散する", async () => {
	now = 0;
	addDevice("d1");
	addDevice("d2");
	addDevice("d3");
	addDevice("disabled", "disabled");
	online = new Set(["d1", "d2", "d3", "disabled"]);
	const routeCollector = collector({ intervalMs: 1_000 });
	await routeCollector.sweep();
	expect(commandCalls).toHaveLength(0);

	for (now = 1; now <= 1_000; now += 1) {
		await routeCollector.sweep();
	}
	const firstCalls = commandCalls.filter(
		(call) => call.command === "show ip route",
	);
	expect(firstCalls.map((call) => call.deviceId).sort()).toEqual([
		"d1",
		"d2",
		"d3",
	]);
	expect(new Set(firstCalls.map((call) => call.at)).size).toBe(3);
	expect(commandCalls).toHaveLength(6);

	const d1FirstAt = firstCalls.find((call) => call.deviceId === "d1")?.at;
	expect(d1FirstAt).toBeDefined();
	const callsBeforeNextDay = commandCalls.filter(
		(call) => call.deviceId === "d1",
	).length;
	now = (d1FirstAt ?? now) + 1_000 - 1;
	await routeCollector.sweep();
	expect(commandCalls.filter((call) => call.deviceId === "d1")).toHaveLength(
		callsBeforeNextDay,
	);
	now += 1;
	await routeCollector.sweep();
	expect(commandCalls.filter((call) => call.deviceId === "d1")).toHaveLength(
		callsBeforeNextDay + 2,
	);
	expect(ROUTE_TABLE_RECONCILE_INTERVAL_MS).toBe(24 * 60 * 60 * 1000);
	expect(ROUTE_TABLE_RECONCILE_CHECK_MS).toBe(10 * 60 * 1000);
});

test("取得時刻にofflineならskipし、online復帰後のsweepで取得する", async () => {
	now = 0;
	addDevice("offline");
	const routeCollector = collector({ intervalMs: 1_000 });
	await routeCollector.sweep();
	for (now = 1; now <= 1_000; now += 1) {
		await routeCollector.sweep();
	}
	expect(commandCalls).toHaveLength(0);

	online.add("offline");
	now += 1;
	await routeCollector.sweep();
	expect(commandCalls.map((call) => call.command)).toEqual([
		"show ip route",
		"show ipv6 route",
	]);
});
