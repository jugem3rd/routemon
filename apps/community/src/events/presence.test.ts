import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Presence } from "@routemon/gateway";
import { afterEach, beforeEach, expect, test } from "vitest";
import { nowIso } from "../storage/db.ts";
import {
	ensureDefaultTenant,
	openStorage,
	type Storage,
} from "../storage/index.ts";
import { PresenceEvents } from "./presence.ts";
import { EventRecorder } from "./recorder.ts";

let root: string;
let storage: Storage;
let tenantId: string;
let now: number;
let presenceEvents: PresenceEvents;

const status = (s: Presence["status"], lastSeenAt?: Date): Presence => ({
	deviceId: "dev-1",
	status: s,
	lastSeenAt,
});

function types() {
	return (
		storage.db
			.prepare("SELECT type FROM device_events ORDER BY rowid")
			.all() as { type: string }[]
	).map((row) => row.type);
}

beforeEach(async () => {
	root = mkdtempSync(join(tmpdir(), "routemon-presence-events-"));
	storage = await openStorage({ root });
	tenantId = ensureDefaultTenant(storage.db);
	const at = nowIso();
	storage.db
		.prepare(
			"INSERT INTO devices (id, tenant_id, name, lifecycle_status, created_at, updated_at) VALUES ('dev-1', ?, 'd', 'active', ?, ?)",
		)
		.run(tenantId, at, at);
	now = Date.parse("2026-10-06T00:00:00Z");
	presenceEvents = new PresenceEvents({
		recorder: new EventRecorder({ db: storage.db, tenantId, now: () => now }),
	});
});

afterEach(() => {
	storage.close();
	rmSync(root, { recursive: true, force: true });
});

test("offlineになったらagent.offline、onlineへ戻ったらagent.onlineを記録する", () => {
	presenceEvents.handle(status("online"));
	presenceEvents.handle(status("unstable"));
	presenceEvents.handle(status("offline", new Date("2026-10-05T23:58:00Z")));
	presenceEvents.handle(status("online"));
	expect(types()).toEqual(["agent.offline", "agent.online"]);
	const detail = storage.db
		.prepare(
			"SELECT detail_json FROM device_events WHERE type = 'agent.offline'",
		)
		.get() as { detail_json: string };
	expect(JSON.parse(detail.detail_json)).toEqual({
		last_seen_at: "2026-10-05T23:58:00.000Z",
	});
});

test("unstableを経由して、onlineへ戻ってもEventにしない", () => {
	presenceEvents.handle(status("online"));
	presenceEvents.handle(status("unstable"));
	presenceEvents.handle(status("online"));
	expect(types()).toEqual([]);
});

test("Server起動後の最初の観測は、基準になるだけでEventにしない", () => {
	presenceEvents.handle(status("online"));
	expect(types()).toEqual([]);
	presenceEvents.handle({ ...status("offline"), deviceId: "dev-2" });
	expect(types()).toEqual([]);
});

test("接続が不安定なDeviceは、フラッピングにまとめられる", () => {
	presenceEvents.handle(status("online"));
	for (let i = 0; i < 4; i++) {
		presenceEvents.handle(status("offline"));
		now += 20_000;
		presenceEvents.handle(status("online"));
		now += 20_000;
	}
	expect(types()).toEqual([
		"agent.offline",
		"agent.online",
		"agent.offline",
		"agent.online",
		"event.flapping",
	]);
});
