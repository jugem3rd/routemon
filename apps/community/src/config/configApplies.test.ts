import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeSnapshotPayload } from "@routemon/core";
import type { AgentGateway, ConfigApplyHandlers } from "@routemon/gateway";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createApp } from "../app.ts";
import { AuditLog } from "../auth/audit.ts";
import { LocalAuth } from "../auth/localAuth.ts";
import { Jobs } from "../jobs/jobs.ts";
import { nowIso } from "../storage/db.ts";
import {
	ensureDefaultTenant,
	openStorage,
	type Storage,
} from "../storage/index.ts";
import { ConfigApplies } from "./configApplies.ts";
import { ConfigSnapshots } from "./configSnapshots.ts";

const DEVICE_ID = "device-1";
const ADMIN_ID = "admin-1";
const TARGET_CONFIG = `# RTX830 Rev.15.02.30
schedule at 3 +15 * lua /routemon_bootstrap.lua
description target-config
`;
const PRE_APPLY_CONFIG = `# RTX830 Rev.15.02.30
schedule at 3 +15 * lua /routemon_bootstrap.lua
description current-config
`;

let root: string;
let storage: Storage;
let tenantId: string;
let snapshots: ConfigSnapshots;
let applies: ConfigApplies;
let fakeGateway: AgentGateway;
let activeHandlers: ConfigApplyHandlers | undefined;
let activateCount: number;
let saveCount: number;

function snapshotPayload(
	config: string,
	reason: "pre_apply" | "apply_verify",
): Uint8Array {
	return encodeSnapshotPayload({
		reason,
		config: new TextEncoder().encode(config),
	});
}

async function settle(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 0));
}

async function startApplyUntilVerify(saveAfterApply: boolean) {
	const target = await storage.configBackups.create({
		tenantId,
		deviceId: DEVICE_ID,
		config: new TextEncoder().encode(TARGET_CONFIG),
		firmwareRevision: "15.02.30",
	});
	const prepared = await applies.prepare({
		deviceId: DEVICE_ID,
		targetBackupId: target.id,
		userId: ADMIN_ID,
	});
	const preApply = await snapshots.ingest(
		DEVICE_ID,
		snapshotPayload(PRE_APPLY_CONFIG, "pre_apply"),
	);
	await applies.handleSnapshot(DEVICE_ID, preApply);
	await applies.confirm({
		deviceId: DEVICE_ID,
		applyId: prepared.id,
		userId: ADMIN_ID,
		saveAfterApply,
		acknowledged: true,
	});
	const handlers = activeHandlers;
	if (!handlers) throw new Error("Apply handlers were not registered");
	handlers.onResult?.({ status: "ready", errorCode: "none" });
	await settle();
	handlers.onResult?.({ status: "staged", errorCode: "none" });
	await settle();
	handlers.onResult?.({ status: "loaded", errorCode: "none" });
	await settle();
	return prepared;
}

beforeEach(async () => {
	root = mkdtempSync(join(tmpdir(), "routemon-config-apply-"));
	storage = await openStorage({ root });
	tenantId = ensureDefaultTenant(storage.db);
	const at = nowIso();
	storage.db
		.prepare(
			`INSERT INTO devices
			 (id, tenant_id, name, lifecycle_status, model, firmware_revision, created_at, updated_at)
			 VALUES (?, ?, ?, 'active', 'RTX830', '15.02.30', ?, ?)`,
		)
		.run(DEVICE_ID, tenantId, "test-router", at, at);
	storage.db
		.prepare(
			"INSERT INTO users (id, login_id, created_at, updated_at) VALUES (?, ?, ?, ?)",
		)
		.run(ADMIN_ID, "admin", at, at);

	activeHandlers = undefined;
	activateCount = 0;
	saveCount = 0;
	const gatewayShape = {
		presence: vi.fn(() => ({
			deviceId: DEVICE_ID,
			status: "online" as const,
			lastSeenAt: new Date(),
		})),
		sendFrame: vi.fn(),
		sendCommand: vi.fn(async () => {
			saveCount++;
			return { success: true, output: new Uint8Array() };
		}),
		startConfigApply: vi.fn(
			(
				_deviceId: string,
				_config: unknown,
				_content: Uint8Array,
				handlers: ConfigApplyHandlers,
			) => {
				activeHandlers = handlers;
				return {
					id: 101,
					activate: () => {
						activateCount++;
					},
					abort: () => undefined,
				};
			},
		),
	};
	fakeGateway = gatewayShape as unknown as AgentGateway;
	const audit = new AuditLog(storage.db, tenantId);
	snapshots = new ConfigSnapshots({
		db: storage.db,
		tenantId,
		backups: storage.configBackups,
		gateway: fakeGateway,
		audit,
	});
	const jobs = new Jobs(storage.db, tenantId, fakeGateway, audit, {
		commandTimeoutMs: 100,
	});
	applies = new ConfigApplies({
		db: storage.db,
		tenantId,
		gateway: fakeGateway,
		snapshots,
		jobs,
		audit,
	});
});

afterEach(() => {
	storage.close();
	rmSync(root, { recursive: true, force: true });
});

test("apply verify一致ではsaveせず、保存SYSLOGでsavedへ遷移する", async () => {
	const target = await storage.configBackups.create({
		tenantId,
		deviceId: DEVICE_ID,
		config: new TextEncoder().encode(TARGET_CONFIG),
		firmwareRevision: "15.02.30",
	});

	const prepared = await applies.prepare({
		deviceId: DEVICE_ID,
		targetBackupId: target.id,
		userId: ADMIN_ID,
	});
	expect(prepared.phase).toBe("prepare");
	expect(fakeGateway.sendFrame).toHaveBeenCalled();

	const preApply = await snapshots.ingest(
		DEVICE_ID,
		snapshotPayload(PRE_APPLY_CONFIG, "pre_apply"),
	);
	await applies.handleSnapshot(DEVICE_ID, preApply);
	expect(applies.get(DEVICE_ID, prepared.id).phase).toBe("confirm");

	const confirmed = await applies.confirm({
		deviceId: DEVICE_ID,
		applyId: prepared.id,
		userId: ADMIN_ID,
		saveAfterApply: false,
		acknowledged: true,
	});
	expect(confirmed.phase).toBe("transfer");
	activeHandlers?.onResult?.({ status: "ready", errorCode: "none" });
	await settle();
	activeHandlers?.onResult?.({ status: "staged", errorCode: "none" });
	await settle();
	expect(activateCount).toBe(1);
	activeHandlers?.onResult?.({ status: "loaded", errorCode: "none" });
	await settle();

	const verify = await snapshots.ingest(
		DEVICE_ID,
		snapshotPayload(TARGET_CONFIG, "apply_verify"),
	);
	await applies.handleSnapshot(DEVICE_ID, verify);
	const complete = applies.get(DEVICE_ID, prepared.id);
	expect(complete.phase).toBe("complete");
	expect(complete.result).toBe("matched");
	expect(saveCount).toBe(0);
	expect(
		(
			storage.db
				.prepare("SELECT config_state FROM devices WHERE id = ?")
				.get(DEVICE_ID) as { config_state: string }
		).config_state,
	).toBe("unsaved");

	const saveJob = await applies.save({ deviceId: DEVICE_ID, userId: ADMIN_ID });
	expect(saveJob.type).toBe("config_save");
	expect(saveCount).toBe(1);
	expect(
		(
			storage.db
				.prepare("SELECT config_state FROM devices WHERE id = ?")
				.get(DEVICE_ID) as { config_state: string }
		).config_state,
	).toBe("unsaved");
	applies.handleConfigSaved(DEVICE_ID);
	expect(
		(
			storage.db
				.prepare("SELECT config_state FROM devices WHERE id = ?")
				.get(DEVICE_ID) as { config_state: string }
		).config_state,
	).toBe("saved");
});

test("すぐ保存する場合もverify一致後だけsaveを1回送る", async () => {
	const target = await storage.configBackups.create({
		tenantId,
		deviceId: DEVICE_ID,
		config: new TextEncoder().encode(TARGET_CONFIG),
		firmwareRevision: "15.02.30",
	});
	const prepared = await applies.prepare({
		deviceId: DEVICE_ID,
		targetBackupId: target.id,
		userId: ADMIN_ID,
	});
	const preApply = await snapshots.ingest(
		DEVICE_ID,
		snapshotPayload(PRE_APPLY_CONFIG, "pre_apply"),
	);
	await applies.handleSnapshot(DEVICE_ID, preApply);
	await applies.confirm({
		deviceId: DEVICE_ID,
		applyId: prepared.id,
		userId: ADMIN_ID,
		saveAfterApply: true,
		acknowledged: true,
	});
	activeHandlers?.onResult?.({ status: "ready", errorCode: "none" });
	await settle();
	activeHandlers?.onResult?.({ status: "staged", errorCode: "none" });
	await settle();
	activeHandlers?.onResult?.({ status: "loaded", errorCode: "none" });
	await settle();
	const verify = await snapshots.ingest(
		DEVICE_ID,
		snapshotPayload(TARGET_CONFIG, "apply_verify"),
	);
	await applies.handleSnapshot(DEVICE_ID, verify);
	expect(saveCount).toBe(1);
	expect(applies.get(DEVICE_ID, prepared.id).saveJobId).not.toBeNull();
});

test("verify期限切れは遅着snapshotを成功扱いせずlockを解放する", async () => {
	const prepared = await startApplyUntilVerify(true);
	const verify = await snapshots.ingest(
		DEVICE_ID,
		snapshotPayload(TARGET_CONFIG, "apply_verify"),
	);

	let markReadStarted!: () => void;
	const readStarted = new Promise<void>((resolve) => {
		markReadStarted = resolve;
	});
	let releaseRead!: () => void;
	const readGate = new Promise<void>((resolve) => {
		releaseRead = resolve;
	});
	let pauseFirstRead = true;
	const readBackup = snapshots.read.bind(snapshots);
	vi.spyOn(snapshots, "read").mockImplementation(async (deviceId, backupId) => {
		if (pauseFirstRead) {
			pauseFirstRead = false;
			markReadStarted();
			await readGate;
		}
		return readBackup(deviceId, backupId);
	});
	const lateVerification = applies.handleSnapshot(DEVICE_ID, verify);
	await readStarted;
	storage.db
		.prepare("UPDATE config_applies SET updated_at = ? WHERE id = ?")
		.run("2000-01-01T00:00:00.000Z", prepared.id);
	expect(applies.expireVerificationOperations()).toBe(1);
	releaseRead();
	await lateVerification;

	const expired = applies.get(DEVICE_ID, prepared.id);
	expect(expired.phase).toBe("failed");
	expect(expired.result).toBe("unavailable");
	expect(expired.errorCode).toBe("verify_timeout");
	expect(saveCount).toBe(0);
	expect(
		(
			storage.db
				.prepare("SELECT config_state FROM devices WHERE id = ?")
				.get(DEVICE_ID) as { config_state: string }
		).config_state,
	).toBe("unsaved");
	expect(
		(
			storage.db
				.prepare(
					"SELECT COUNT(*) AS count FROM audit_events WHERE target_id = ? AND type = 'CONFIG_APPLIED'",
				)
				.get(DEVICE_ID) as { count: number }
		).count,
	).toBe(0);

	const nextTarget = await storage.configBackups.create({
		tenantId,
		deviceId: DEVICE_ID,
		config: new TextEncoder().encode(TARGET_CONFIG),
		firmwareRevision: "15.02.30",
	});
	await expect(
		applies.prepare({
			deviceId: DEVICE_ID,
			targetBackupId: nextTarget.id,
			userId: ADMIN_ID,
		}),
	).resolves.toMatchObject({ phase: "prepare" });
});

test("Server再起動時に残ったverifyも終端化しlockを解放する", async () => {
	const prepared = await startApplyUntilVerify(false);
	applies.recoverAfterRestart();
	const recovered = applies.get(DEVICE_ID, prepared.id);
	expect(recovered.phase).toBe("failed");
	expect(recovered.errorCode).toBe("server_restarted");

	const nextTarget = await storage.configBackups.create({
		tenantId,
		deviceId: DEVICE_ID,
		config: new TextEncoder().encode(TARGET_CONFIG),
		firmwareRevision: "15.02.30",
	});
	await expect(
		applies.prepare({
			deviceId: DEVICE_ID,
			targetBackupId: nextTarget.id,
			userId: ADMIN_ID,
		}),
	).resolves.toMatchObject({ phase: "prepare" });
});

test("verify不一致ではすぐ保存する選択でもsaveを送らない", async () => {
	const target = await storage.configBackups.create({
		tenantId,
		deviceId: DEVICE_ID,
		config: new TextEncoder().encode(TARGET_CONFIG),
		firmwareRevision: "15.02.30",
	});
	const prepared = await applies.prepare({
		deviceId: DEVICE_ID,
		targetBackupId: target.id,
		userId: ADMIN_ID,
	});
	const preApply = await snapshots.ingest(
		DEVICE_ID,
		snapshotPayload(PRE_APPLY_CONFIG, "pre_apply"),
	);
	await applies.handleSnapshot(DEVICE_ID, preApply);
	await applies.confirm({
		deviceId: DEVICE_ID,
		applyId: prepared.id,
		userId: ADMIN_ID,
		saveAfterApply: true,
		acknowledged: true,
	});
	activeHandlers?.onResult?.({ status: "ready", errorCode: "none" });
	await settle();
	activeHandlers?.onResult?.({ status: "staged", errorCode: "none" });
	await settle();
	activeHandlers?.onResult?.({ status: "loaded", errorCode: "none" });
	await settle();
	const mismatch = await snapshots.ingest(
		DEVICE_ID,
		snapshotPayload(
			`${PRE_APPLY_CONFIG.replace("current-config", "unexpected-config")}`,
			"apply_verify",
		),
	);
	await applies.handleSnapshot(DEVICE_ID, mismatch);
	const failed = applies.get(DEVICE_ID, prepared.id);
	expect(failed.phase).toBe("failed");
	expect(failed.result).toBe("mismatch");
	expect(saveCount).toBe(0);
});

test("Supervisor自動起動行のないtargetはPrepareで拒否する", async () => {
	const invalid = await storage.configBackups.create({
		tenantId,
		deviceId: DEVICE_ID,
		config: new TextEncoder().encode(
			"# RTX830 Rev.15.02.30\ndescription no-supervisor\n",
		),
	});
	await expect(
		applies.prepare({
			deviceId: DEVICE_ID,
			targetBackupId: invalid.id,
			userId: ADMIN_ID,
		}),
	).rejects.toMatchObject({ code: "supervisor_schedule_missing" });
	expect(
		(
			storage.db
				.prepare("SELECT COUNT(*) AS count FROM config_applies")
				.get() as { count: number }
		).count,
	).toBe(0);
});

test("ApplyとsaveのAPIはAdminだけが呼び出せる", async () => {
	const auth = new LocalAuth(storage.db, tenantId);
	const password = "correct horse battery";
	await auth.createFirstAdmin({ loginId: "api-admin", password });
	await auth.createUser({
		loginId: "api-viewer",
		password,
		role: "viewer",
	});
	const app = createApp({
		auth,
		audit: new AuditLog(storage.db, tenantId),
		configApplies: applies,
		secureCookie: false,
	});
	const login = async (identifier: string) => {
		const response = await app.request("/api/auth/login", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ identifier, password }),
		});
		return response.headers.get("set-cookie")?.split(";")[0] ?? "";
	};
	const viewer = await login("api-viewer");
	const denied = await app.request(`/api/devices/${DEVICE_ID}/config-applies`, {
		headers: { cookie: viewer },
	});
	expect(denied.status).toBe(403);

	const admin = await login("api-admin");
	const listed = await app.request(`/api/devices/${DEVICE_ID}/config-applies`, {
		headers: { cookie: admin },
	});
	expect(listed.status).toBe(200);
	expect((await listed.json()).applies).toEqual([]);
});

test("config_stateを制約し、backup削除後もApply履歴を残す", async () => {
	const target = await storage.configBackups.create({
		tenantId,
		deviceId: DEVICE_ID,
		config: new TextEncoder().encode(TARGET_CONFIG),
	});
	const prepared = await applies.prepare({
		deviceId: DEVICE_ID,
		targetBackupId: target.id,
		userId: ADMIN_ID,
	});
	const preApply = await snapshots.ingest(
		DEVICE_ID,
		snapshotPayload(PRE_APPLY_CONFIG, "pre_apply"),
	);
	await applies.handleSnapshot(DEVICE_ID, preApply);

	expect(() =>
		storage.db
			.prepare("UPDATE devices SET config_state = 'unknown' WHERE id = ?")
			.run(DEVICE_ID),
	).toThrow();
	storage.db
		.prepare("DELETE FROM device_config_backups WHERE id = ?")
		.run(target.id);
	const view = applies.get(DEVICE_ID, prepared.id);
	expect(view.targetBackupId).toBeNull();
	expect(view.preApplyBackupId).not.toBeNull();
	const history = storage.db
		.prepare("SELECT id FROM config_applies WHERE id = ?")
		.get(prepared.id) as { id: string } | undefined;
	expect(history?.id).toBe(prepared.id);
});

test("詳細APIは差分のリスク分類をrisksで返し、差分が無ければnullになる(#126)", async () => {
	const target = await storage.configBackups.create({
		tenantId,
		deviceId: DEVICE_ID,
		config: new TextEncoder().encode(
			`${TARGET_CONFIG}ip pp secure filter in 200030\n`,
		),
		firmwareRevision: "15.02.30",
	});
	const prepared = await applies.prepare({
		deviceId: DEVICE_ID,
		targetBackupId: target.id,
		userId: ADMIN_ID,
	});
	// pre_apply snapshotが届く前は差分を返せないためrisksはnull。
	const beforeSnapshot = await applies.getDetails(
		DEVICE_ID,
		prepared.id,
		ADMIN_ID,
	);
	expect(beforeSnapshot.diff).toBeNull();
	expect(beforeSnapshot.risks).toBeNull();

	const preApply = await snapshots.ingest(
		DEVICE_ID,
		snapshotPayload(PRE_APPLY_CONFIG, "pre_apply"),
	);
	await applies.handleSnapshot(DEVICE_ID, preApply);
	const details = await applies.getDetails(DEVICE_ID, prepared.id, ADMIN_ID);
	expect(details.diff).not.toBeNull();
	expect(details.diffUnavailable).toBe(false);
	// 一括適用の計画と同じ分類が出ること。
	expect(details.risks).toEqual(["filter"]);
});
