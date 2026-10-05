import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	cobsDecode,
	concatFrames,
	decodeFrames,
	encodeAgentStatus,
	encodeFrame,
	FrameType,
	textEscape,
} from "@routemon/core";
import { AgentGateway, MemoryDeviceStore } from "@routemon/gateway";
import { afterEach, beforeEach, expect, test } from "vitest";
import { AuditLog } from "../auth/audit.ts";
import { nowIso } from "../storage/db.ts";
import {
	ensureDefaultTenant,
	openStorage,
	type Storage,
} from "../storage/index.ts";
import { AgentUpdates, ReleaseNotFoundError } from "./agentUpdates.ts";

const DEVICE_ID = "d1";
const TOKEN = "device-token";

let root: string;
let releaseDir: string;
let storage: Storage;
let tenantId: string;
let gateway: AgentGateway;
let updates: AgentUpdates;

async function sync(frames: Uint8Array[] = []) {
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

beforeEach(async () => {
	root = mkdtempSync(join(tmpdir(), "routemon-update-"));
	storage = await openStorage({ root });
	releaseDir = storage.paths.agentReleases;
	writeFileSync(join(releaseDir, "0.3.0.lua"), "-- agent");
	writeFileSync(join(releaseDir, "0.4.0.lua"), "-- agent");
	writeFileSync(join(releaseDir, "stable.lua"), "local VERSION = '0.4.0'");
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
	updates = new AgentUpdates({
		db: storage.db,
		tenantId,
		gateway,
		audit: new AuditLog(storage.db, tenantId),
		releaseDir,
	});
});

afterEach(() => {
	storage.close();
	rmSync(root, { recursive: true, force: true });
});

test("AGENT_STATUSでversionとslotを記録する", async () => {
	updates.handleStatus(
		DEVICE_ID,
		encodeAgentStatus({ version: "0.3.0", slot: "a" }),
	);
	const state = updates.state(DEVICE_ID);
	expect(state.agentVersion).toBe("0.3.0");
	expect(state.agentSlot).toBe("a");
	expect(state.desiredAgentVersion).toBeNull();
	// desiredが無ければ通知しない
	expect(await sync()).toHaveLength(0);
});

test("desired versionが違えばUPDATE_AVAILABLEを送る", async () => {
	await sync(); // 接続済みにする
	updates.handleStatus(DEVICE_ID, encodeAgentStatus({ version: "0.3.0" }));
	updates.setDesiredVersion(DEVICE_ID, "0.4.0");

	const frames = await sync();
	expect(frames.map((f) => f.type)).toEqual([FrameType.UPDATE_AVAILABLE]);
	expect(new TextDecoder().decode(frames[0]?.payload)).toBe("0.4.0");

	// 目的のversionが動き始めたら通知しない
	updates.handleStatus(DEVICE_ID, encodeAgentStatus({ version: "0.4.0" }));
	expect(await sync()).toHaveLength(0);
});

test("未接続でもdesired versionは保存し、次のstatusで通知する", async () => {
	updates.setDesiredVersion(DEVICE_ID, "0.4.0");
	expect(updates.state(DEVICE_ID).desiredAgentVersion).toBe("0.4.0");

	await sync();
	updates.handleStatus(DEVICE_ID, encodeAgentStatus({ version: "0.3.0" }));
	expect((await sync()).map((f) => f.type)).toEqual([
		FrameType.UPDATE_AVAILABLE,
	]);
});

test("rollbackしたversionは再通知しない(Adminの再指定では送る)", async () => {
	await sync();
	updates.setDesiredVersion(DEVICE_ID, "0.4.0");
	await sync(); // 最初の通知を受け取る

	updates.handleStatus(
		DEVICE_ID,
		encodeAgentStatus({
			version: "0.3.0",
			slot: "a",
			rollback: "0.4.0 version_mismatch",
		}),
	);
	expect(await sync()).toHaveLength(0);

	// 次のstatusでも送らない
	updates.handleStatus(DEVICE_ID, encodeAgentStatus({ version: "0.3.0" }));
	expect(await sync()).toHaveLength(0);

	// Adminが明示的に指定すれば再試行する
	updates.setDesiredVersion(DEVICE_ID, "0.4.0");
	expect((await sync()).map((f) => f.type)).toEqual([
		FrameType.UPDATE_AVAILABLE,
	]);
});

test("存在しないreleaseは設定できない", () => {
	expect(() => updates.setDesiredVersion(DEVICE_ID, "9.9.9")).toThrow(
		ReleaseNotFoundError,
	);
	// path traversalも弾く
	expect(() => updates.setDesiredVersion(DEVICE_ID, "../secrets")).toThrow(
		ReleaseNotFoundError,
	);
	expect(() => updates.setDesiredVersion(DEVICE_ID, "stable")).toThrow(
		ReleaseNotFoundError,
	);
	expect(updates.releases()).toEqual(["0.3.0", "0.4.0"]);
});

test("rollbackはeventとして残り、同じ内容を二重に記録しない", () => {
	updates.handleStatus(
		DEVICE_ID,
		encodeAgentStatus({
			version: "0.3.0",
			slot: "a",
			rollback: "0.4.0 health_timeout",
		}),
	);
	updates.handleStatus(
		DEVICE_ID,
		encodeAgentStatus({
			version: "0.3.0",
			slot: "a",
			rollback: "0.4.0 health_timeout",
		}),
	);
	const events = storage.db
		.prepare(
			"SELECT detail_json FROM device_events WHERE device_id = ? AND type = 'agent.rollback'",
		)
		.all(DEVICE_ID) as { detail_json: string }[];
	expect(events).toHaveLength(1);
	expect(JSON.parse(events[0]?.detail_json ?? "{}").detail).toBe(
		"0.4.0 health_timeout",
	);
	expect(updates.state(DEVICE_ID)).toMatchObject({
		lastAgentReason: "0.4.0 health_timeout",
		lastAgentReasonType: "rollback",
	});
});

test("両slot復旧理由は復旧eventとして表示し、rollback versionを抑制しない", async () => {
	await sync();
	updates.setDesiredVersion(DEVICE_ID, "0.4.0");
	await sync();

	const recoveryStatus = encodeAgentStatus({
		version: "0.3.0",
		slot: "a",
		rollback: "recovered_both_slots_invalid",
	});
	updates.handleStatus(DEVICE_ID, recoveryStatus);

	expect((await sync()).map((frame) => frame.type)).toEqual([
		FrameType.UPDATE_AVAILABLE,
	]);
	updates.handleStatus(DEVICE_ID, recoveryStatus);
	expect((await sync()).map((frame) => frame.type)).toEqual([
		FrameType.UPDATE_AVAILABLE,
	]);
	expect(updates.state(DEVICE_ID)).toMatchObject({
		lastAgentReason: "recovered_both_slots_invalid",
		lastAgentReasonType: "recovery",
	});
	const events = storage.db
		.prepare(
			"SELECT type, severity, detail_json FROM device_events WHERE device_id = ? AND type = 'agent.recovered'",
		)
		.all(DEVICE_ID) as {
		type: string;
		severity: string;
		detail_json: string;
	}[];
	expect(events).toHaveLength(1);
	expect(events[0]).toMatchObject({
		type: "agent.recovered",
		severity: "info",
	});
	expect(JSON.parse(events[0]?.detail_json ?? "{}").detail).toBe(
		"recovered_both_slots_invalid",
	);
});

test("Supervisorのartifactは、Agentのrelease一覧に含めず、Supervisorの一覧に出す(#159)", () => {
	writeFileSync(join(releaseDir, "supervisor-1.0.1.lua"), "-- supervisor");
	writeFileSync(join(releaseDir, "supervisor-1.1.0.lua"), "-- supervisor");

	expect(updates.releases()).toEqual(["0.3.0", "0.4.0"]);
	expect(updates.supervisorReleases()).toEqual(["1.0.1", "1.1.0"]);
	// Agentのdesired versionとしては選べない(Agentではないartifact)
	expect(() =>
		updates.setDesiredVersion(DEVICE_ID, "supervisor-1.0.1"),
	).toThrow(ReleaseNotFoundError);
});

function supervisorStatus(
	supervisorVersion?: string,
	supervisorRollback?: string,
) {
	return encodeAgentStatus({
		version: "0.3.0",
		slot: "a",
		supervisorVersion,
		supervisorRollback,
	});
}

test("AGENT_STATUSで、動いているSupervisorのversionを記録する(#159)", () => {
	updates.handleStatus(DEVICE_ID, supervisorStatus("1.0.1"));
	expect(updates.state(DEVICE_ID).supervisorVersion).toBe("1.0.1");
	expect(updates.state(DEVICE_ID).desiredSupervisorVersion).toBeNull();
});

test("望ましいSupervisorのversionを設定すると、接続中のDeviceへsupervisor-<version>を送る(#159)", async () => {
	writeFileSync(join(releaseDir, "supervisor-1.1.0.lua"), "-- supervisor");
	await sync(); // 接続済みにする
	updates.handleStatus(DEVICE_ID, supervisorStatus("1.0.1"));

	updates.setDesiredSupervisorVersion(DEVICE_ID, "1.1.0");

	expect(updates.state(DEVICE_ID).desiredSupervisorVersion).toBe("1.1.0");
	const frames = await sync();
	expect(frames.map((f) => f.type)).toEqual([FrameType.UPDATE_AVAILABLE]);
	expect(new TextDecoder().decode(frames[0]?.payload)).toBe("supervisor-1.1.0");

	// 目的のversionが動き始めたら通知しない
	updates.handleStatus(DEVICE_ID, supervisorStatus("1.1.0"));
	expect(await sync()).toHaveLength(0);
});

test("存在しないSupervisorのversionと、不正なversionは設定できない(#159)", async () => {
	writeFileSync(join(releaseDir, "supervisor-1.1.0.lua"), "-- supervisor");
	await sync();

	expect(() => updates.setDesiredSupervisorVersion(DEVICE_ID, "9.9.9")).toThrow(
		ReleaseNotFoundError,
	);
	expect(() =>
		updates.setDesiredSupervisorVersion(DEVICE_ID, "../../etc/passwd"),
	).toThrow(ReleaseNotFoundError);
	expect(updates.state(DEVICE_ID).desiredSupervisorVersion).toBeNull();
	expect(await sync()).toHaveLength(0);
});

test("未接続でも望ましいSupervisorのversionは保存し、次のstatusで通知する(#159)", async () => {
	writeFileSync(join(releaseDir, "supervisor-1.1.0.lua"), "-- supervisor");
	updates.setDesiredSupervisorVersion(DEVICE_ID, "1.1.0");
	expect(updates.state(DEVICE_ID).desiredSupervisorVersion).toBe("1.1.0");

	await sync();
	updates.handleStatus(DEVICE_ID, supervisorStatus("1.0.1"));
	const frames = await sync();
	expect(frames.map((f) => f.type)).toEqual([FrameType.UPDATE_AVAILABLE]);
	expect(new TextDecoder().decode(frames[0]?.payload)).toBe("supervisor-1.1.0");
});

test("Supervisorのversionを報告しないAgentには、通知しない(#159)", async () => {
	writeFileSync(join(releaseDir, "supervisor-1.1.0.lua"), "-- supervisor");
	updates.setDesiredSupervisorVersion(DEVICE_ID, "1.1.0");
	await sync();
	// 古いAgent(Supervisorのversionを含まないstatus)
	updates.handleStatus(DEVICE_ID, encodeAgentStatus({ version: "0.2.0" }));
	expect(await sync()).toHaveLength(0);
});

test("戻したSupervisorのversionは再通知せず、rollbackのEventは1度だけ記録する。Adminの再指定では送る(#159)", async () => {
	writeFileSync(join(releaseDir, "supervisor-1.1.0.lua"), "-- supervisor");
	await sync();
	updates.handleStatus(DEVICE_ID, supervisorStatus("1.0.1"));
	updates.setDesiredSupervisorVersion(DEVICE_ID, "1.1.0");
	await sync(); // 最初の通知を受け取る

	// 候補が戻された。以降のstatusは、直前のrollbackを報告し続ける
	const rolledBack = supervisorStatus("1.0.1", "1.1.0 crashed");
	updates.handleStatus(DEVICE_ID, rolledBack);
	updates.handleStatus(DEVICE_ID, rolledBack);
	expect(await sync()).toHaveLength(0);

	const events = storage.db
		.prepare(
			"SELECT type, detail_json FROM device_events WHERE device_id = ? AND type = 'supervisor.rollback'",
		)
		.all(DEVICE_ID) as { type: string; detail_json: string }[];
	expect(events).toHaveLength(1);
	expect(JSON.parse(events[0]?.detail_json ?? "{}").detail).toBe(
		"1.1.0 crashed",
	);

	// Adminが同じversionを明示的に再指定したら、送る
	updates.setDesiredSupervisorVersion(DEVICE_ID, "1.1.0");
	expect((await sync()).map((f) => f.type)).toEqual([
		FrameType.UPDATE_AVAILABLE,
	]);
});
