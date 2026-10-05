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
import { ConfigBackupInUseError } from "../storage/configBackups.ts";
import { nowIso } from "../storage/db.ts";
import {
	ensureDefaultTenant,
	openStorage,
	type Storage,
} from "../storage/index.ts";
import { ConfigApplies } from "./configApplies.ts";
import { ConfigApplyBatches } from "./configApplyBatches.ts";
import { ConfigSnapshots } from "./configSnapshots.ts";

const ADMIN_ID = "admin-test";
const DEVICE_A = "device-a";
const DEVICE_B = "device-b";
const PASSWORD = "batch-test-password";

function config(description: string): string {
	return `# RTX830 Rev.15.02.30
schedule at 3 +15 * lua /routemon_bootstrap.lua
description ${description}
`;
}

function snapshotPayload(
	content: string,
	reason: "pre_apply" | "apply_verify",
): Uint8Array {
	return encodeSnapshotPayload({
		reason,
		config: new TextEncoder().encode(content),
	});
}

let root: string;
let storage: Storage;
let tenantId: string;
let snapshots: ConfigSnapshots;
let applies: ConfigApplies;
let batches: ConfigApplyBatches;
let gateway: AgentGateway;
let handlers: Map<string, ConfigApplyHandlers>;
let startedDevices: string[];
let audit: AuditLog;

async function saveTarget(
	deviceId: string,
	content = config(`target-${deviceId}`),
) {
	return storage.configBackups.create({
		tenantId,
		deviceId,
		config: new TextEncoder().encode(content),
		firmwareRevision: "15.02.30",
	});
}

async function deliverSnapshot(
	deviceId: string,
	content: string,
	reason: "pre_apply" | "apply_verify",
): Promise<void> {
	const result = await snapshots.ingest(
		deviceId,
		snapshotPayload(content, reason),
	);
	await batches.handleSnapshot(deviceId, result);
	await applies.handleSnapshot(deviceId, result);
}

async function settle(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 0));
}

async function completeApply(deviceId: string, targetContent: string) {
	const active = handlers.get(deviceId);
	if (!active) throw new Error(`Apply did not start for ${deviceId}`);
	active.onResult?.({ status: "ready", errorCode: "none" });
	await settle();
	active.onResult?.({ status: "staged", errorCode: "none" });
	await settle();
	active.onResult?.({ status: "loaded", errorCode: "none" });
	await settle();
	const verify = await snapshots.ingest(
		deviceId,
		snapshotPayload(targetContent, "apply_verify"),
	);
	await applies.handleSnapshot(deviceId, verify);
}

beforeEach(async () => {
	root = mkdtempSync(join(tmpdir(), "routemon-config-batch-"));
	storage = await openStorage({ root });
	tenantId = ensureDefaultTenant(storage.db);
	const at = nowIso();
	for (const [id, name] of [
		[DEVICE_A, "Router A"],
		[DEVICE_B, "Router B"],
	]) {
		storage.db
			.prepare(
				`INSERT INTO devices
				 (id, tenant_id, name, lifecycle_status, model, firmware_revision, created_at, updated_at)
				 VALUES (?, ?, ?, 'active', 'RTX830', '15.02.30', ?, ?)`,
			)
			.run(id, tenantId, name, at, at);
	}
	storage.db
		.prepare(
			"INSERT INTO users (id, login_id, created_at, updated_at) VALUES (?, ?, ?, ?)",
		)
		.run(ADMIN_ID, "batch-admin", at, at);

	handlers = new Map();
	startedDevices = [];
	const gatewayShape = {
		presence: vi.fn((deviceId: string) => ({
			deviceId,
			status: "online" as const,
			lastSeenAt: new Date(),
		})),
		sendFrame: vi.fn(),
		sendCommand: vi.fn(async () => ({
			success: true,
			output: new Uint8Array(),
		})),
		startConfigApply: vi.fn(
			(
				deviceId: string,
				_config: unknown,
				_content: Uint8Array,
				callbacks: ConfigApplyHandlers,
			) => {
				startedDevices.push(deviceId);
				handlers.set(deviceId, callbacks);
				return {
					id: startedDevices.length,
					activate: () => undefined,
					abort: () => undefined,
				};
			},
		),
	};
	gateway = gatewayShape as unknown as AgentGateway;
	audit = new AuditLog(storage.db, tenantId);
	snapshots = new ConfigSnapshots({
		db: storage.db,
		tenantId,
		backups: storage.configBackups,
		gateway,
		audit,
	});
	const jobs = new Jobs(storage.db, tenantId, gateway, audit, {
		commandTimeoutMs: 100,
	});
	applies = new ConfigApplies({
		db: storage.db,
		tenantId,
		gateway,
		snapshots,
		jobs,
		audit,
	});
	batches = new ConfigApplyBatches({
		db: storage.db,
		tenantId,
		gateway,
		snapshots,
		applies,
		audit,
	});
});

afterEach(() => {
	storage.close();
	rmSync(root, { recursive: true, force: true });
});

test("BatchはApplyと選択されたsave確認を一台ずつ完了してから次へ進む", async () => {
	const targetA = await saveTarget(DEVICE_A);
	const targetB = await saveTarget(DEVICE_B);
	const batch = batches.create({
		userId: ADMIN_ID,
		saveAfterApply: true,
		source: {
			type: "devices",
			items: [
				{ deviceId: DEVICE_A, backupId: targetA.id },
				{ deviceId: DEVICE_B, backupId: targetB.id },
			],
		},
	});
	await deliverSnapshot(DEVICE_A, config("current-a"), "pre_apply");
	await deliverSnapshot(DEVICE_B, config("current-b"), "pre_apply");
	expect(batches.get(batch.id).status).toBe("awaiting_confirmation");

	await batches.confirmPlan(batch.id, ADMIN_ID, true);
	await deliverSnapshot(DEVICE_A, config("current-a"), "pre_apply");
	expect(startedDevices).toEqual([DEVICE_A]);
	expect(activeApplyCount()).toBe(1);
	expect(
		storage.db
			.prepare(
				"SELECT pre_apply_backup_id FROM config_applies WHERE device_id = ?",
			)
			.get(DEVICE_A),
	).toMatchObject({
		pre_apply_backup_id: batches.get(batch.id).items[0]?.executionCheckBackupId,
	});

	const firstTarget = config("target-device-a");
	const firstHandler = handlers.get(DEVICE_A);
	firstHandler?.onResult?.({ status: "ready", errorCode: "none" });
	await settle();
	firstHandler?.onResult?.({ status: "staged", errorCode: "none" });
	await settle();
	firstHandler?.onResult?.({ status: "loaded", errorCode: "none" });
	await settle();
	expect(startedDevices).toEqual([DEVICE_A]);
	expect(activeApplyCount()).toBe(1);
	const verifyA = await snapshots.ingest(
		DEVICE_A,
		snapshotPayload(firstTarget, "apply_verify"),
	);
	await applies.handleSnapshot(DEVICE_A, verifyA);
	expect(startedDevices).toEqual([DEVICE_A]);
	await batches.sweep();
	expect(startedDevices).toEqual([DEVICE_A]);
	expect(batches.get(batch.id).items[0]).toMatchObject({
		status: "applying",
		applyEffect: null,
		saveResult: "pending",
	});
	const child = storage.db
		.prepare("SELECT save_after_apply FROM config_applies WHERE device_id = ?")
		.get(DEVICE_A) as { save_after_apply: number };
	expect(child.save_after_apply).toBe(1);

	// save commandのsuccess応答だけでは次Deviceへ進まず、CONFIG_SAVEDを待つ。
	applies.handleConfigSaved(DEVICE_A);
	await batches.sweep();
	expect(batches.get(batch.id).items[0]).toMatchObject({
		status: "applied",
		applyEffect: "confirmed",
		saveResult: "confirmed",
	});
	expect(startedDevices).toEqual([DEVICE_A]);
	await deliverSnapshot(DEVICE_B, config("current-b"), "pre_apply");
	expect(startedDevices).toEqual([DEVICE_A, DEVICE_B]);
	expect(activeApplyCount()).toBe(1);

	await completeApply(DEVICE_B, config("target-device-b"));
	await batches.sweep();
	expect(startedDevices).toEqual([DEVICE_A, DEVICE_B]);
	applies.handleConfigSaved(DEVICE_B);
	await batches.sweep();
	expect(batches.get(batch.id).status).toBe("complete");
	expect(activeApplyCount()).toBe(0);
	const auditRows = storage.db
		.prepare("SELECT detail_json FROM audit_events WHERE tenant_id = ?")
		.all(tenantId) as Array<{ detail_json: string | null }>;
	const details = auditRows.map((row) => row.detail_json ?? "").join("\n");
	expect(details).toContain(batch.id);
	expect(details).toContain("batch_item_id");
	expect(details).not.toContain("target-device-a");
	expect(details).not.toContain("current-a");
});

test("guard snapshotのhashが準備時と違えばload前に停止する", async () => {
	const target = await saveTarget(DEVICE_A);
	const batch = batches.create({
		userId: ADMIN_ID,
		source: {
			type: "devices",
			items: [{ deviceId: DEVICE_A, backupId: target.id }],
		},
	});
	await deliverSnapshot(DEVICE_A, config("prepared-a"), "pre_apply");
	await batches.confirmPlan(batch.id, ADMIN_ID, true);
	await deliverSnapshot(DEVICE_A, config("changed-after-plan"), "pre_apply");

	const stopped = batches.get(batch.id);
	expect(stopped.status).toBe("stopped");
	expect(stopped.stopReason).toBe("prepared_config_changed");
	expect(stopped.items[0]).toMatchObject({
		status: "failed",
		failureCode: "prepared_config_changed",
		applyEffect: "not_applied",
	});
	expect(startedDevices).toEqual([]);
	expect(activeApplyCount()).toBe(0);
	expect(
		storage.db.prepare("SELECT COUNT(*) AS count FROM config_applies").get(),
	).toMatchObject({ count: 0 });
});

test("最初のApply失敗後は後続Deviceをskipし自動継続しない", async () => {
	const targetA = await saveTarget(DEVICE_A);
	const targetB = await saveTarget(DEVICE_B);
	const batch = batches.create({
		userId: ADMIN_ID,
		source: {
			type: "devices",
			items: [
				{ deviceId: DEVICE_A, backupId: targetA.id },
				{ deviceId: DEVICE_B, backupId: targetB.id },
			],
		},
	});
	await deliverSnapshot(DEVICE_A, config("current-a"), "pre_apply");
	await deliverSnapshot(DEVICE_B, config("current-b"), "pre_apply");
	await batches.confirmPlan(batch.id, ADMIN_ID, true);
	await deliverSnapshot(DEVICE_A, config("current-a"), "pre_apply");
	expect(startedDevices).toEqual([DEVICE_A]);

	const failedHandler = handlers.get(DEVICE_A);
	failedHandler?.onResult?.({ status: "ready", errorCode: "none" });
	await settle();
	failedHandler?.onResult?.({ status: "staged", errorCode: "none" });
	await settle();
	failedHandler?.onResult?.({
		status: "load_failed",
		errorCode: "load_failed",
	});
	await settle();
	await batches.sweep();
	const stopped = batches.get(batch.id);
	expect(stopped.status).toBe("stopped");
	expect(stopped.items[0]).toMatchObject({
		status: "failed",
		applyEffect: "unknown",
	});
	expect(stopped.items[1]).toMatchObject({
		status: "skipped",
		applyEffect: "not_applied",
	});
	expect(startedDevices).toEqual([DEVICE_A]);
	await batches.sweep();
	expect(startedDevices).toEqual([DEVICE_A]);
});

test("apply_verify mismatchは適用確認済みに分類しない", async () => {
	const target = await saveTarget(DEVICE_A);
	const batch = batches.create({
		userId: ADMIN_ID,
		saveAfterApply: true,
		source: {
			type: "devices",
			items: [{ deviceId: DEVICE_A, backupId: target.id }],
		},
	});
	await deliverSnapshot(DEVICE_A, config("current-a"), "pre_apply");
	await batches.confirmPlan(batch.id, ADMIN_ID, true);
	await deliverSnapshot(DEVICE_A, config("current-a"), "pre_apply");
	const handler = handlers.get(DEVICE_A);
	handler?.onResult?.({ status: "ready", errorCode: "none" });
	await settle();
	handler?.onResult?.({ status: "staged", errorCode: "none" });
	await settle();
	handler?.onResult?.({ status: "loaded", errorCode: "none" });
	await settle();
	const mismatch = await snapshots.ingest(
		DEVICE_A,
		snapshotPayload(config("different-running-config"), "apply_verify"),
	);
	await applies.handleSnapshot(DEVICE_A, mismatch);
	await batches.sweep();
	expect(batches.get(batch.id)).toMatchObject({
		status: "stopped",
		items: [
			{
				status: "failed",
				failureCode: "verify_mismatch",
				applyEffect: "unknown",
				saveResult: "not_requested",
			},
		],
	});
});

test("per_device modeでは各Deviceの確認後にだけ次のApplyを開始する", async () => {
	const targetA = await saveTarget(DEVICE_A);
	const targetB = await saveTarget(DEVICE_B);
	const batch = batches.create({
		userId: ADMIN_ID,
		confirmationMode: "per_device",
		source: {
			type: "devices",
			items: [
				{ deviceId: DEVICE_A, backupId: targetA.id },
				{ deviceId: DEVICE_B, backupId: targetB.id },
			],
		},
	});
	await deliverSnapshot(DEVICE_A, config("current-a"), "pre_apply");
	await deliverSnapshot(DEVICE_B, config("current-b"), "pre_apply");
	expect(batches.get(batch.id).items[0]?.status).toBe("awaiting_confirmation");
	expect(batches.get(batch.id).items[1]?.status).toBe("queued");

	await batches.confirmItem(batch.id, batch.items[0]?.id ?? "", ADMIN_ID, true);
	await deliverSnapshot(DEVICE_A, config("current-a"), "pre_apply");
	expect(startedDevices).toEqual([DEVICE_A]);
	await completeApply(DEVICE_A, config("target-device-a"));
	await batches.sweep();
	expect(batches.get(batch.id).items[0]).toMatchObject({
		status: "applied",
		applyEffect: "confirmed",
	});
	expect(batches.get(batch.id).items[1]?.status).toBe("awaiting_confirmation");
	expect(startedDevices).toEqual([DEVICE_A]);

	await batches.confirmItem(batch.id, batch.items[1]?.id ?? "", ADMIN_ID, true);
	await deliverSnapshot(DEVICE_B, config("current-b"), "pre_apply");
	await completeApply(DEVICE_B, config("target-device-b"));
	await batches.sweep();
	expect(batches.get(batch.id).status).toBe("complete");
	expect(startedDevices).toEqual([DEVICE_A, DEVICE_B]);
});

test("実行中の停止は現在のApplyだけを完了させ、残りを未適用として止める", async () => {
	const targetA = await saveTarget(DEVICE_A);
	const targetB = await saveTarget(DEVICE_B);
	const batch = batches.create({
		userId: ADMIN_ID,
		source: {
			type: "devices",
			items: [
				{ deviceId: DEVICE_A, backupId: targetA.id },
				{ deviceId: DEVICE_B, backupId: targetB.id },
			],
		},
	});
	await deliverSnapshot(DEVICE_A, config("current-a"), "pre_apply");
	await deliverSnapshot(DEVICE_B, config("current-b"), "pre_apply");
	await batches.confirmPlan(batch.id, ADMIN_ID, true);
	await deliverSnapshot(DEVICE_A, config("current-a"), "pre_apply");
	const handler = handlers.get(DEVICE_A);
	handler?.onResult?.({ status: "ready", errorCode: "none" });
	await settle();
	handler?.onResult?.({ status: "staged", errorCode: "none" });
	await settle();

	const stopping = await batches.stop(batch.id, ADMIN_ID);
	expect(stopping.status).toBe("stopping");
	const targetContent = config("target-device-a");
	handler?.onResult?.({ status: "loaded", errorCode: "none" });
	await settle();
	const verifyA = await snapshots.ingest(
		DEVICE_A,
		snapshotPayload(targetContent, "apply_verify"),
	);
	await applies.handleSnapshot(DEVICE_A, verifyA);
	await batches.sweep();
	const stopped = batches.get(batch.id);
	expect(stopped.status).toBe("stopped");
	expect(stopped.items[0]).toMatchObject({
		status: "applied",
		applyEffect: "confirmed",
	});
	expect(stopped.items[1]).toMatchObject({
		status: "skipped",
		applyEffect: "not_applied",
	});
	expect(startedDevices).toEqual([DEVICE_A]);
});

test("Server再起動時はCONFIG_SAVED待ちの単体Apply mutexを解放する", async () => {
	const target = await saveTarget(DEVICE_A);
	const apply = await applies.prepare({
		deviceId: DEVICE_A,
		targetBackupId: target.id,
		userId: ADMIN_ID,
	});
	await deliverSnapshot(DEVICE_A, config("current-a"), "pre_apply");
	await applies.confirm({
		deviceId: DEVICE_A,
		applyId: apply.id,
		userId: ADMIN_ID,
		saveAfterApply: true,
		acknowledged: true,
	});
	await completeApply(DEVICE_A, config("target-device-a"));
	expect(
		storage.db
			.prepare("SELECT owner_type FROM config_apply_locks WHERE tenant_id = ?")
			.get(tenantId),
	).toMatchObject({ owner_type: "single_apply" });

	applies.recoverAfterRestart();
	expect(
		storage.db
			.prepare("SELECT owner_type FROM config_apply_locks WHERE tenant_id = ?")
			.get(tenantId),
	).toBeUndefined();
	expect(applies.get(DEVICE_A, apply.id).phase).toBe("complete");
});

test("準備失敗が1件あれば成功済みitemだけへ範囲を縮めない", async () => {
	const targetA = await saveTarget(DEVICE_A);
	const invalidTarget = await saveTarget(
		DEVICE_B,
		"# RTX830 Rev.15.02.30\ndescription missing-supervisor\n",
	);
	const batch = batches.create({
		userId: ADMIN_ID,
		source: {
			type: "devices",
			items: [
				{ deviceId: DEVICE_A, backupId: targetA.id },
				{ deviceId: DEVICE_B, backupId: invalidTarget.id },
			],
		},
	});
	await deliverSnapshot(DEVICE_A, config("current-a"), "pre_apply");
	await deliverSnapshot(DEVICE_B, config("current-b"), "pre_apply");

	const stopped = batches.get(batch.id);
	expect(stopped.status).toBe("stopped");
	expect(stopped.items[0]?.status).toBe("skipped");
	expect(stopped.items[1]).toMatchObject({
		status: "failed",
		failureCode: "supervisor_schedule_missing",
		plan: {
			validation: { valid: false, supervisorAutostart: { valid: false } },
		},
	});
	expect(startedDevices).toEqual([]);
	expect(activeApplyCount()).toBe(0);
	const lock = storage.db
		.prepare("SELECT owner_id FROM config_apply_locks WHERE tenant_id = ?")
		.get(tenantId);
	expect(lock).toBeUndefined();
});

test("checkpoint指定は全件capturedを要求しbackup IDを固定する", async () => {
	const oldTarget = await saveTarget(DEVICE_A, config("checkpoint-target"));
	const checkpointId = "checkpoint-full";
	const at = nowIso();
	storage.db
		.prepare(
			"INSERT INTO config_checkpoints (id, tenant_id, name, created_by_user_id, created_at) VALUES (?, ?, ?, ?, ?)",
		)
		.run(checkpointId, tenantId, "full checkpoint", ADMIN_ID, at);
	storage.db
		.prepare(
			`INSERT INTO config_checkpoint_items
			 (id, checkpoint_id, device_id, device_name, backup_id, status, requested_at, captured_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, 'captured', ?, ?, ?)`,
		)
		.run(
			"checkpoint-item-a",
			checkpointId,
			DEVICE_A,
			"Router A",
			oldTarget.id,
			at,
			at,
			at,
		);
	const batch = batches.create({
		userId: ADMIN_ID,
		source: { type: "checkpoint", checkpointId },
	});
	await expect(
		storage.configBackups.deleteDevice(DEVICE_A),
	).rejects.toBeInstanceOf(ConfigBackupInUseError);
	const newTarget = await saveTarget(DEVICE_A, config("later-target"));
	expect(batch.items[0]?.targetBackupId).toBe(oldTarget.id);
	expect(batch.sourceCheckpointId).toBe(checkpointId);
	expect(batch.items[0]?.targetBackupId).not.toBe(newTarget.id);

	const partialId = "checkpoint-partial";
	storage.db
		.prepare(
			"INSERT INTO config_checkpoints (id, tenant_id, name, created_by_user_id, created_at) VALUES (?, ?, ?, ?, ?)",
		)
		.run(partialId, tenantId, "partial checkpoint", ADMIN_ID, at);
	storage.db
		.prepare(
			`INSERT INTO config_checkpoint_items
			 (id, checkpoint_id, device_id, device_name, status, failure_code, requested_at, updated_at)
			 VALUES (?, ?, ?, ?, 'failed', 'device_offline', ?, ?)`,
		)
		.run("partial-item-a", partialId, DEVICE_A, "Router A", at, at);
	expect(() =>
		batches.create({
			userId: ADMIN_ID,
			source: { type: "checkpoint", checkpointId: partialId },
		}),
	).toThrow("Checkpoint must have a captured");
});

test("Batch中の単体Apply Prepareは原因Batch IDを含む409、Viewerは403", async () => {
	const targetA = await saveTarget(DEVICE_A);
	expect(() =>
		batches.create({
			userId: ADMIN_ID,
			source: {
				type: "devices",
				items: [{ deviceId: DEVICE_B, backupId: targetA.id }],
			},
		}),
	).toThrow("Device or backup not found");
	const otherTenantId = ensureDefaultTenant(
		storage.db,
		"other-tenant",
		"Other tenant",
	);
	const otherDeviceId = "other-tenant-device";
	const at = nowIso();
	storage.db
		.prepare(
			`INSERT INTO devices
			 (id, tenant_id, name, lifecycle_status, model, firmware_revision, created_at, updated_at)
			 VALUES (?, ?, 'Other tenant router', 'active', 'RTX830', '15.02.30', ?, ?)`,
		)
		.run(otherDeviceId, otherTenantId, at, at);
	const otherBackup = await storage.configBackups.create({
		tenantId: otherTenantId,
		deviceId: otherDeviceId,
		config: new TextEncoder().encode(config("foreign-target")),
		firmwareRevision: "15.02.30",
	});
	expect(() =>
		batches.create({
			userId: ADMIN_ID,
			source: {
				type: "devices",
				items: [{ deviceId: DEVICE_A, backupId: otherBackup.id }],
			},
		}),
	).toThrow("Device or backup not found");
	expect(() =>
		batches.create({
			userId: ADMIN_ID,
			source: {
				type: "devices",
				items: [{ deviceId: otherDeviceId, backupId: otherBackup.id }],
			},
		}),
	).toThrow("Device or backup not found");
	const batch = batches.create({
		userId: ADMIN_ID,
		source: {
			type: "devices",
			items: [{ deviceId: DEVICE_A, backupId: targetA.id }],
		},
	});
	const auth = new LocalAuth(storage.db, tenantId);
	await auth.createUser({
		loginId: "route-admin",
		password: PASSWORD,
		role: "admin",
	});
	await auth.createUser({
		loginId: "route-viewer",
		password: PASSWORD,
		role: "viewer",
	});
	const app = createApp({
		auth,
		audit,
		configApplies: applies,
		configApplyBatches: batches,
	});
	const login = async (identifier: string) => {
		const response = await app.request("/api/auth/login", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ identifier, password: PASSWORD }),
		});
		return response.headers.get("set-cookie")?.split(";")[0] ?? "";
	};
	const adminCookie = await login("route-admin");
	const rejected = await app.request(
		`/api/devices/${DEVICE_B}/config-applies/prepare`,
		{
			method: "POST",
			headers: { cookie: adminCookie, "content-type": "application/json" },
			body: JSON.stringify({ backupId: targetA.id }),
		},
	);
	expect(rejected.status).toBe(409);
	expect(await rejected.json()).toMatchObject({
		code: "config_apply_batch_active",
		batch_id: batch.id,
	});

	const viewerCookie = await login("route-viewer");
	const denied = await app.request(`/api/config-apply-batches/${batch.id}`, {
		headers: { cookie: viewerCookie },
	});
	expect(denied.status).toBe(403);
});

test("一括適用の計画は ip pp secure filter に filter を付ける(#126)", async () => {
	const target = await saveTarget(
		DEVICE_A,
		`${config("target-device-a")}ip pp secure filter in 200030\n`,
	);
	const batch = batches.create({
		userId: ADMIN_ID,
		source: {
			type: "devices",
			items: [{ deviceId: DEVICE_A, backupId: target.id }],
		},
	});
	await deliverSnapshot(DEVICE_A, config("current-a"), "pre_apply");
	expect(batches.get(batch.id).status).toBe("awaiting_confirmation");
	const item = batches.get(batch.id).items[0];
	expect(item?.plan).toMatchObject({ changed: true });
	// 単体Applyの詳細APIと同じ分類が出ること。
	expect(item?.plan?.risks).toEqual(["filter"]);
});

function activeApplyCount(): number {
	const row = storage.db
		.prepare(
			`SELECT COUNT(*) AS count FROM config_applies
			 WHERE tenant_id = ? AND phase IN ('prepare', 'confirm', 'transfer', 'activate', 'verify')`,
		)
		.get(tenantId) as { count: number };
	return row.count;
}
