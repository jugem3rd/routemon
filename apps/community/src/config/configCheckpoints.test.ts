import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	cobsDecode,
	concatFrames,
	decodeFrames,
	encodeFrame,
	encodeSnapshotPayload,
	FrameType,
	textEscape,
} from "@routemon/core";
import { AgentGateway, MemoryDeviceStore } from "@routemon/gateway";
import { afterEach, beforeEach, expect, test } from "vitest";
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
	CHECKPOINT_REQUEST_TIMEOUT_MS,
	ConfigCheckpoints,
} from "./configCheckpoints.ts";
import { ConfigSnapshots } from "./configSnapshots.ts";

const PASSWORD = "correct horse battery";
const CONFIG_A = "ip lan1 address 192.0.2.1/24\n";
const CONFIG_B = "ip lan1 address 192.0.2.2/24\n";

let root: string;
let storage: Storage;
let tenantId: string;
let gateway: AgentGateway;
let deviceStore: MemoryDeviceStore;
let snapshots: ConfigSnapshots;
let checkpoints: ConfigCheckpoints;
let audit: AuditLog;
let auth: LocalAuth;
let now: number;
let tokens: Map<string, string>;
let adminCookie: string;
let viewerCookie: string;
let adminId: string;

beforeEach(async () => {
	root = mkdtempSync(join(tmpdir(), "routemon-checkpoint-"));
	storage = await openStorage({ root, configGenerations: 1 });
	tenantId = ensureDefaultTenant(storage.db);
	now = Date.parse("2026-09-20T00:00:00.000Z");
	tokens = new Map();
	audit = new AuditLog(storage.db, tenantId, () => now);
	auth = new LocalAuth(storage.db, tenantId, () => now);
	adminId = (
		await auth.createFirstAdmin({ loginId: "admin", password: PASSWORD })
	).id;
	await auth.createUser({
		loginId: "viewer",
		password: PASSWORD,
		role: "viewer",
	});
	deviceStore = new MemoryDeviceStore();
	gateway = new AgentGateway({
		store: deviceStore,
		coalesceWaitMs: 1,
		onFrame: (deviceId, frame) => {
			if (frame.type !== FrameType.CONFIG_BACKUP) return;
			void snapshots
				.ingest(deviceId, frame.payload)
				.then((result) => checkpoints.handleSnapshot(deviceId, result));
		},
	});
	snapshots = new ConfigSnapshots({
		db: storage.db,
		tenantId,
		backups: storage.configBackups,
		gateway,
		audit,
		now: () => now,
	});
	checkpoints = new ConfigCheckpoints({
		db: storage.db,
		tenantId,
		snapshots,
		audit,
		now: () => now,
	});
	adminCookie = await login("admin");
	viewerCookie = await login("viewer");
});

afterEach(() => {
	storage.close();
	rmSync(root, { recursive: true, force: true });
});

function app() {
	return createApp({
		auth,
		audit,
		configCheckpoints: checkpoints,
		secureCookie: false,
	});
}

async function login(identifier: string): Promise<string> {
	const response = await app().request("/api/auth/login", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ identifier, password: PASSWORD }),
	});
	return response.headers.get("set-cookie")?.split(";")[0] ?? "";
}

function seedDevice(id: string, online = true): void {
	const at = nowIso(new Date(now));
	storage.db
		.prepare(
			`INSERT INTO devices (id, tenant_id, name, lifecycle_status, created_at, updated_at)
			 VALUES (?, ?, ?, 'active', ?, ?)`,
		)
		.run(id, tenantId, `Router ${id}`, at, at);
	if (online) {
		const token = `test-token-${id}`;
		tokens.set(id, token);
		deviceStoreAdd(id, token);
	}
}

function deviceStoreAdd(deviceId: string, token: string): void {
	deviceStore.add(deviceId, token);
}

// Gateway sync mirrors the protocol's device-authenticated polling without connecting to a router.
async function sync(deviceId: string, frames: Uint8Array[] = []) {
	const token = tokens.get(deviceId);
	if (!token) throw new Error(`no simulated token for ${deviceId}`);
	const incoming = concatFrames([
		encodeFrame(FrameType.HEARTBEAT, 0),
		...frames,
	]);
	const response = await gateway.handleSync({
		authorization: `Bearer ${token}`,
		waitSeconds: 0,
		body: textEscape(incoming),
	});
	return response.status === 200 ? response.body : new Uint8Array();
}

async function returnedFrames(deviceId: string, frames: Uint8Array[] = []) {
	const body = await sync(deviceId, frames);
	return decodeFrames(cobsDecode(body));
}

async function respondWithConfig(deviceId: string, config: string) {
	await returnedFrames(deviceId, [
		encodeFrame(
			FrameType.CONFIG_BACKUP,
			0,
			encodeSnapshotPayload({
				reason: "checkpoint",
				config: new TextEncoder().encode(config),
			}),
		),
	]);
	for (let attempt = 0; attempt < 40; attempt += 1) {
		const item = checkpoints
			.list()
			.flatMap((checkpoint) => checkpoint.items)
			.find(
				(candidate) =>
					candidate.deviceId === deviceId && candidate.status === "captured",
			);
		if (item) return item;
		await new Promise((resolve) => setTimeout(resolve, 2));
	}
	throw new Error(`simulated CONFIG ingest did not complete for ${deviceId}`);
}

function createRequest(
	cookie: string,
	body: { name?: string; memo?: string; deviceIds: string[] },
) {
	return app().request("/api/config-checkpoints", {
		method: "POST",
		headers: { cookie, "content-type": "application/json" },
		body: JSON.stringify({ name: "VPN change preflight", ...body }),
	});
}

test("Adminは複数online Deviceの取得結果をcheckpointへまとめられる", async () => {
	seedDevice("d1");
	seedDevice("d2");
	await returnedFrames("d1");
	await returnedFrames("d2");

	const response = await createRequest(adminCookie, {
		deviceIds: ["d1", "d2"],
		memo: "設定変更前",
	});
	expect(response.status).toBe(201);
	const created = (await response.json()).checkpoint as {
		id: string;
		items: { deviceId: string; status: string }[];
	};
	expect(created.items.map((item) => item.status)).toEqual([
		"pending",
		"pending",
	]);

	for (const deviceId of ["d1", "d2"]) {
		const requested = await returnedFrames(deviceId);
		expect(requested.map((frame) => frame.type)).toContain(
			FrameType.CONFIG_REQUEST,
		);
		const frame = requested.find(
			(item) => item.type === FrameType.CONFIG_REQUEST,
		);
		expect(new TextDecoder().decode(frame?.payload)).toBe("checkpoint");
	}
	await respondWithConfig("d1", CONFIG_A);
	await respondWithConfig("d2", CONFIG_B);

	const checkpoint = checkpoints.get(created.id);
	expect(checkpoint.status).toBe("captured");
	expect(checkpoint.capturedCount).toBe(2);
	expect(checkpoint.items.map((item) => item.backupAvailable)).toEqual([
		true,
		true,
	]);
	expect(checkpoint.items.every((item) => item.capturedAt !== null)).toBe(true);
});

test("offline Deviceは失敗として記録しonline Deviceはcheckpointに残る", async () => {
	seedDevice("online");
	seedDevice("offline", false);
	await returnedFrames("online");

	const response = await createRequest(adminCookie, {
		deviceIds: ["online", "offline"],
	});
	expect(response.status).toBe(201);
	const { checkpoint: created } = (await response.json()) as {
		checkpoint: { id: string };
	};
	let checkpoint = checkpoints.get(created.id);
	expect(
		checkpoint.items.find((item) => item.deviceId === "online")?.status,
	).toBe("pending");
	expect(
		checkpoint.items.find((item) => item.deviceId === "offline")?.status,
	).toBe("failed");
	expect(
		checkpoint.items.find((item) => item.deviceId === "offline")?.failureCode,
	).toBe("device_offline");

	const requested = await returnedFrames("online");
	expect(requested.map((frame) => frame.type)).toContain(
		FrameType.CONFIG_REQUEST,
	);
	await respondWithConfig("online", CONFIG_A);
	checkpoint = checkpoints.get(created.id);
	expect(checkpoint.status).toBe("partial");
	expect(
		checkpoint.items.find((item) => item.deviceId === "online")
			?.backupAvailable,
	).toBe(true);
	expect(
		checkpoint.items.find((item) => item.deviceId === "offline")?.status,
	).toBe("failed");
});

test("空のDevice選択は拒否しViewerはcheckpointを作成できない", async () => {
	const empty = await createRequest(adminCookie, { deviceIds: [] });
	expect(empty.status).toBe(400);
	const denied = await createRequest(viewerCookie, { deviceIds: ["d1"] });
	expect(denied.status).toBe(403);
	const listed = await app().request("/api/config-checkpoints", {
		headers: { cookie: viewerCookie },
	});
	expect(listed.status).toBe(200);
	expect((await listed.json()).checkpoints).toEqual([]);
});

test("同じDeviceではcheckpoint取得を重ねず、前の待機がtimeoutしたら失敗にする", async () => {
	seedDevice("d1");
	seedDevice("d2");
	await returnedFrames("d1");
	await returnedFrames("d2");
	const first = checkpoints.create({
		name: "first",
		deviceIds: ["d1"],
		userId: adminId,
	});
	const second = checkpoints.create({
		name: "second",
		deviceIds: ["d1", "d2"],
		userId: adminId,
	});
	expect(first.items[0]?.status).toBe("pending");
	expect(second.items.find((item) => item.deviceId === "d1")?.failureCode).toBe(
		"checkpoint_in_progress",
	);
	expect(second.items.find((item) => item.deviceId === "d2")?.status).toBe(
		"pending",
	);

	now += CHECKPOINT_REQUEST_TIMEOUT_MS + 1;
	expect(checkpoints.expirePending()).toBe(2);
	expect(checkpoints.get(first.id).items[0]?.failureCode).toBe(
		"response_timeout",
	);
	expect(
		checkpoints.get(second.id).items.find((item) => item.deviceId === "d2")
			?.failureCode,
	).toBe("response_timeout");
});

test("dedupeは既存世代を参照し、retention後もcheckpoint履歴を残す", async () => {
	seedDevice("d1");
	const original = await snapshots.ingest(
		"d1",
		encodeSnapshotPayload({
			reason: "manual",
			config: new TextEncoder().encode(CONFIG_A),
		}),
	);
	await returnedFrames("d1");
	const checkpoint = checkpoints.create({
		name: "dedupe",
		deviceIds: ["d1"],
		userId: adminId,
	});
	await returnedFrames("d1");
	const reused = await respondWithConfig("d1", CONFIG_A);
	expect(reused.backupId).toBe(original.backupId);
	expect(checkpoints.get(checkpoint.id).items[0]?.backupId).toBe(
		original.backupId,
	);
	const capturedAt = checkpoints.get(checkpoint.id).items[0]?.capturedAt;

	await snapshots.ingest(
		"d1",
		encodeSnapshotPayload({
			reason: "manual",
			config: new TextEncoder().encode(CONFIG_B),
		}),
	);
	const afterPrune = checkpoints.get(checkpoint.id).items[0];
	expect(afterPrune?.status).toBe("captured");
	expect(afterPrune?.backupId).toBeNull();
	expect(afterPrune?.backupAvailable).toBe(false);
	expect(afterPrune?.capturedAt).toBe(capturedAt);

	checkpoints.delete(checkpoint.id, adminId);
	expect(checkpoints.list()).toHaveLength(0);
	expect(storage.configBackups.list("d1")).toHaveLength(1);
	expect(
		audit
			.list()
			.some((event) => event.type === AuditEventType.CONFIG_CHECKPOINT_CREATED),
	).toBe(true);
	expect(
		audit
			.list()
			.some((event) => event.type === AuditEventType.CONFIG_CHECKPOINT_DELETED),
	).toBe(true);
});

test("checkpointは50台まで、削除は取得中に拒否する", async () => {
	for (let index = 0; index < 51; index += 1) seedDevice(`d${index}`);
	const tooMany = await createRequest(adminCookie, {
		deviceIds: Array.from({ length: 51 }, (_, index) => `d${index}`),
	});
	expect(tooMany.status).toBe(400);

	await returnedFrames("d0");
	const pending = checkpoints.create({
		name: "pending",
		deviceIds: ["d0"],
		userId: adminId,
	});
	const appInstance = app();
	const deletedWhilePending = await appInstance.request(
		`/api/config-checkpoints/${pending.id}`,
		{ method: "DELETE", headers: { cookie: adminCookie } },
	);
	expect(deletedWhilePending.status).toBe(409);
	now += CHECKPOINT_REQUEST_TIMEOUT_MS + 1;
	checkpoints.expirePending();
	const deleted = await appInstance.request(
		`/api/config-checkpoints/${pending.id}`,
		{ method: "DELETE", headers: { cookie: adminCookie } },
	);
	expect(deleted.status).toBe(200);
});
