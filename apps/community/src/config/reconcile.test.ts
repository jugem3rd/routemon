import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SnapshotReason } from "@routemon/core";
import type { AgentGateway } from "@routemon/gateway";
import { afterEach, beforeEach, expect, test } from "vitest";
import { nowIso } from "../storage/db.ts";
import {
	ensureDefaultTenant,
	openStorage,
	type Storage,
} from "../storage/index.ts";
import type { ConfigSnapshots } from "./configSnapshots.ts";
import { CONFIG_RECONCILE_INTERVAL_MS, ConfigReconciler } from "./reconcile.ts";

const INTERVAL_MS = 1_000;

let root: string;
let storage: Storage;
let tenantId: string;
let now: number;
let online = new Set<string>();
let requests: { deviceId: string; reason: SnapshotReason; at: number }[];
let gateway: Pick<AgentGateway, "presence">;
let configSnapshots: Pick<ConfigSnapshots, "request">;

function addDevice(
	deviceId: string,
	lifecycleStatus: "active" | "disabled" = "active",
): void {
	const at = nowIso();
	storage.db
		.prepare(
			"INSERT INTO devices (id, tenant_id, name, lifecycle_status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
		)
		.run(deviceId, tenantId, deviceId, lifecycleStatus, at, at);
}

beforeEach(async () => {
	root = mkdtempSync(join(tmpdir(), "routemon-reconcile-"));
	storage = await openStorage({ root });
	tenantId = ensureDefaultTenant(storage.db);
	now = 0;
	online = new Set();
	requests = [];
	gateway = {
		presence: (deviceId) => ({
			deviceId,
			status: online.has(deviceId) ? "online" : "offline",
		}),
	};
	configSnapshots = {
		request: (deviceId, reason) => {
			requests.push({ deviceId, reason, at: now });
		},
	};
});

afterEach(() => {
	storage.close();
	rmSync(root, { recursive: true, force: true });
});

test("activeかつonlineのDeviceだけを位相分散して取得する", async () => {
	addDevice("d1");
	addDevice("d2");
	addDevice("d3");
	addDevice("disabled", "disabled");
	online = new Set(["d1", "d2", "d3", "disabled"]);

	const reconciler = new ConfigReconciler({
		db: storage.db,
		tenantId,
		gateway,
		configSnapshots,
		intervalMs: INTERVAL_MS,
		now: () => now,
	});
	await reconciler.sweep();
	expect(requests).toHaveLength(0);

	for (now = 1; now <= INTERVAL_MS; now += 1) {
		await reconciler.sweep();
	}

	expect(requests.map((request) => request.deviceId).sort()).toEqual([
		"d1",
		"d2",
		"d3",
	]);
	expect(
		requests.every((request) => request.reason === "periodic_reconcile"),
	).toBe(true);
	// 同じ周期内の要求時刻が同一でないことを、固定IDで確認する。
	expect(new Set(requests.map((request) => request.at)).size).toBe(3);
});

test("取得時刻にofflineなら、onlineへ戻った後に1回だけ取得する", async () => {
	addDevice("offline");
	const reconciler = new ConfigReconciler({
		db: storage.db,
		tenantId,
		gateway,
		configSnapshots,
		intervalMs: INTERVAL_MS,
		now: () => now,
	});

	await reconciler.sweep();
	for (now = 1; now <= INTERVAL_MS; now += 1) {
		await reconciler.sweep();
	}
	expect(requests).toHaveLength(0);

	online.add("offline");
	now = INTERVAL_MS + 1;
	await reconciler.sweep();
	await reconciler.sweep();
	expect(requests).toEqual([
		{ deviceId: "offline", reason: "periodic_reconcile", at: INTERVAL_MS + 1 },
	]);
});

test("初回スイープは未来の位相へ予約し、再起動直後に要求しない", async () => {
	addDevice("d1");
	online.add("d1");
	const reconciler = new ConfigReconciler({
		db: storage.db,
		tenantId,
		gateway,
		configSnapshots,
	});

	await reconciler.sweep();
	const restarted = new ConfigReconciler({
		db: storage.db,
		tenantId,
		gateway,
		configSnapshots,
	});
	await restarted.sweep();

	expect(requests).toHaveLength(0);
	// 既定値は1日。位相を過ぎるまで待って初めて再取得される。
	expect(CONFIG_RECONCILE_INTERVAL_MS).toBe(24 * 60 * 60 * 1000);
});
