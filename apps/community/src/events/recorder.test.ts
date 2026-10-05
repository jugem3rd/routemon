import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { nowIso } from "../storage/db.ts";
import {
	ensureDefaultTenant,
	openStorage,
	type Storage,
} from "../storage/index.ts";
import {
	EVENT_FLAPPING,
	EVENT_LIMIT_REACHED,
	EventRecorder,
} from "./recorder.ts";

const MIN = 60_000;
const DAY = 86_400_000;

let root: string;
let storage: Storage;
let tenantId: string;
let now: number;

function makeRecorder(options: ConstructorParameters<typeof EventRecorder>[0]) {
	return new EventRecorder({ ...options, now: () => now });
}

function addDevice(id: string) {
	const at = nowIso();
	storage.db
		.prepare(
			"INSERT INTO devices (id, tenant_id, name, lifecycle_status, created_at, updated_at) VALUES (?, ?, ?, 'active', ?, ?)",
		)
		.run(id, tenantId, id, at, at);
}

function types(deviceId = "d1"): string[] {
	return (
		storage.db
			.prepare(
				"SELECT type FROM device_events WHERE device_id = ? ORDER BY occurred_at, rowid",
			)
			.all(deviceId) as { type: string }[]
	).map((row) => row.type);
}

beforeEach(async () => {
	root = mkdtempSync(join(tmpdir(), "routemon-events-"));
	storage = await openStorage({ root });
	tenantId = ensureDefaultTenant(storage.db);
	addDevice("d1");
	addDevice("d2");
	// UTC日の途中(1日の上限の境界から離す)
	now = Date.parse("2026-10-04T12:00:00.000Z");
});

afterEach(() => {
	storage.close();
	rmSync(root, { recursive: true, force: true });
});

function ppp(recorder: EventRecorder, deviceId: string, type: string) {
	return recorder.record({
		deviceId,
		type,
		severity: "warning",
		transitionKey: "ppp",
	});
}

test("状態変化が少なければ、すべて個別に記録する", () => {
	const recorder = makeRecorder({ db: storage.db, tenantId });
	for (let i = 0; i < 4; i++) {
		expect(ppp(recorder, "d1", i % 2 ? "ppp.up" : "ppp.down")).toBe("recorded");
		now += MIN;
	}
	expect(types()).toHaveLength(4);
});

test("10分間に5回の状態変化で、個別の記録を止めて1件のFLAPPINGにまとめる", () => {
	const recorder = makeRecorder({ db: storage.db, tenantId });
	const results = [];
	for (let i = 0; i < 8; i++) {
		results.push(ppp(recorder, "d1", i % 2 ? "ppp.up" : "ppp.down"));
		now += MIN;
	}
	expect(results).toEqual([
		"recorded",
		"recorded",
		"recorded",
		"recorded",
		"flapping_started",
		"suppressed_flapping",
		"suppressed_flapping",
		"suppressed_flapping",
	]);
	expect(types()).toEqual([
		"ppp.down",
		"ppp.up",
		"ppp.down",
		"ppp.up",
		EVENT_FLAPPING,
	]);
});

test("窓の外の状態変化は数えない", () => {
	const recorder = makeRecorder({ db: storage.db, tenantId });
	for (let i = 0; i < 8; i++) {
		expect(ppp(recorder, "d1", "ppp.down")).toBe("recorded");
		now += 3 * MIN; // 窓(10分)の中には、常に3〜4回しか入らない
	}
	expect(types()).not.toContain(EVENT_FLAPPING);
});

test("状態変化が途絶えたら、個別の記録を再開する", () => {
	const recorder = makeRecorder({ db: storage.db, tenantId });
	for (let i = 0; i < 6; i++) {
		ppp(recorder, "d1", "ppp.down");
		now += MIN;
	}
	expect(ppp(recorder, "d1", "ppp.down")).toBe("suppressed_flapping");
	now += 10 * MIN; // 窓と同じ長さ、途絶える
	expect(ppp(recorder, "d1", "ppp.up")).toBe("recorded");
	expect(types().at(-1)).toBe("ppp.up");
});

test("対象とDeviceが違えば、フラッピングは別々に判定する", () => {
	const recorder = makeRecorder({ db: storage.db, tenantId });
	for (let i = 0; i < 6; i++) {
		ppp(recorder, "d1", "ppp.down");
		now += MIN / 2;
	}
	expect(ppp(recorder, "d2", "ppp.down")).toBe("recorded");
	expect(
		recorder.record({
			deviceId: "d1",
			type: "tunnel.down",
			severity: "warning",
			transitionKey: "tunnel",
		}),
	).toBe("recorded");
});

test("transitionKeyが無いEventは、フラッピングの対象にしない", () => {
	const recorder = makeRecorder({ db: storage.db, tenantId });
	for (let i = 0; i < 10; i++) {
		expect(
			recorder.record({
				deviceId: "d1",
				type: "agent.rollback",
				severity: "warning",
			}),
		).toBe("recorded");
	}
});

test("1日の上限を超えたら、上限のEventを1件だけ記録して、残りは捨てる", () => {
	const recorder = makeRecorder({ db: storage.db, tenantId, dailyCap: 5 });
	const results = [];
	for (let i = 0; i < 9; i++) {
		results.push(
			recorder.record({ deviceId: "d1", type: "x", severity: "info" }),
		);
		now += 1000;
	}
	expect(results.filter((r) => r === "recorded")).toHaveLength(5);
	expect(results.filter((r) => r === "suppressed_cap")).toHaveLength(4);
	expect(types().filter((t) => t === EVENT_LIMIT_REACHED)).toHaveLength(1);
	expect(types()).toHaveLength(6);
	// 他のDeviceには影響しない
	expect(recorder.record({ deviceId: "d2", type: "x", severity: "info" })).toBe(
		"recorded",
	);
});

test("1日の上限は、翌日(UTC)にリセットされる", () => {
	const recorder = makeRecorder({ db: storage.db, tenantId, dailyCap: 2 });
	for (let i = 0; i < 4; i++) {
		recorder.record({ deviceId: "d1", type: "x", severity: "info" });
	}
	now += DAY;
	expect(recorder.record({ deviceId: "d1", type: "x", severity: "info" })).toBe(
		"recorded",
	);
});

test("保持期間(90日)を過ぎたEventだけを削除する", () => {
	const recorder = makeRecorder({ db: storage.db, tenantId });
	const start = now;
	recorder.record({ deviceId: "d1", type: "old", severity: "info" });
	now = start + 30 * DAY;
	recorder.record({ deviceId: "d1", type: "mid", severity: "info" });
	now = start + 91 * DAY;
	recorder.record({ deviceId: "d1", type: "new", severity: "info" });

	expect(recorder.cleanup()).toBe(1);
	expect(types()).toEqual(["mid", "new"]);
});

test("cleanupは、大量のEventも削除できる", () => {
	const recorder = makeRecorder({
		db: storage.db,
		tenantId,
		dailyCap: 100_000,
	});
	const insert = storage.db.prepare(
		`INSERT INTO device_events (id, tenant_id, device_id, type, severity, detail_json, occurred_at, created_at)
		 VALUES (?, ?, 'd1', 'old', 'info', NULL, ?, ?)`,
	);
	const old = nowIso(new Date(now - 100 * DAY));
	storage.db.exec("BEGIN");
	for (let i = 0; i < 2500; i++) insert.run(`e${i}`, tenantId, old, old);
	storage.db.exec("COMMIT");
	expect(recorder.cleanup()).toBe(2500);
});
