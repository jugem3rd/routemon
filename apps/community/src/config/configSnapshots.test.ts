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
import { AuditLog } from "../auth/audit.ts";
import { LocalAuth } from "../auth/localAuth.ts";
import { nowIso } from "../storage/db.ts";
import {
	ensureDefaultTenant,
	openStorage,
	type Storage,
} from "../storage/index.ts";
import { ConfigSnapshots } from "./configSnapshots.ts";

const DEVICE_ID = "d1";
const TOKEN = "device-token";
const PASSWORD = "correct horse battery";

const CONFIG = `ip route default gateway pp 1
ip lan1 address 192.168.0.1/24
pp select 1
 pppoe use lan2
 pp auth myname example-user example-password
`;

let root: string;
let storage: Storage;
let tenantId: string;
let gateway: AgentGateway;
let snapshots: ConfigSnapshots;
let auth: LocalAuth;
let audit: AuditLog;

function payload(config: string, reason: "agent_start" | "manual" = "manual") {
	return encodeSnapshotPayload({
		reason,
		config: new TextEncoder().encode(config),
	});
}

/** Agentの代わりに1回syncし、Gatewayから届いたframeを返す。 */
async function sync() {
	const response = await gateway.handleSync({
		authorization: `Bearer ${TOKEN}`,
		waitSeconds: 0,
		body: textEscape(concatFrames([encodeFrame(FrameType.HEARTBEAT, 0)])),
	});
	return decodeFrames(cobsDecode(response.body));
}

beforeEach(async () => {
	root = mkdtempSync(join(tmpdir(), "routemon-config-"));
	storage = await openStorage({ root });
	tenantId = ensureDefaultTenant(storage.db);
	const at = nowIso();
	storage.db
		.prepare(
			`INSERT INTO devices (id, tenant_id, name, lifecycle_status, model, firmware_revision, created_at, updated_at)
			 VALUES (?, ?, ?, 'active', 'RTX830', '15.02.30', ?, ?)`,
		)
		.run(DEVICE_ID, tenantId, "RTX830", at, at);
	const store = new MemoryDeviceStore();
	store.add(DEVICE_ID, TOKEN);
	gateway = new AgentGateway({ store, coalesceWaitMs: 1 });
	auth = new LocalAuth(storage.db, tenantId);
	audit = new AuditLog(storage.db, tenantId);
	snapshots = new ConfigSnapshots({
		db: storage.db,
		tenantId,
		backups: storage.configBackups,
		gateway,
		audit,
	});
});

afterEach(() => {
	storage.close();
	rmSync(root, { recursive: true, force: true });
});

test("snapshotを保存してProfileを作る", async () => {
	const result = await snapshots.ingest(
		DEVICE_ID,
		payload(CONFIG, "agent_start"),
	);
	expect(result.created).toBe(true);
	expect(result.reason).toBe("agent_start");

	const profile = snapshots.profile(DEVICE_ID);
	expect(profile?.internet.ipv4).toEqual({
		method: "pppoe",
		interface: "lan2",
		pp: 1,
	});
	expect(profile?.model).toBe("RTX830");
	// Profileにsecretを入れない
	expect(JSON.stringify(profile)).not.toContain("example-password");

	// CONFIG本文は暗号化して保存され、metadataだけがDBに載る
	const backups = snapshots.list(DEVICE_ID);
	expect(backups).toHaveLength(1);
	expect(backups[0]?.sizeBytes).toBe(CONFIG.length);
});

test("同じCONFIGでは世代を増やさない", async () => {
	await snapshots.ingest(DEVICE_ID, payload(CONFIG));
	const again = await snapshots.ingest(DEVICE_ID, payload(CONFIG));
	expect(again.created).toBe(false);
	expect(snapshots.list(DEVICE_ID)).toHaveLength(1);

	const changed = await snapshots.ingest(
		DEVICE_ID,
		payload(`${CONFIG}ip lan2 address dhcp\n`),
	);
	expect(changed.created).toBe(true);
	expect(snapshots.list(DEVICE_ID)).toHaveLength(2);
});

test("Reporting Dateだけが違うCONFIGは同じ世代とみなす", async () => {
	// `show config`は取得のたびにこの行が変わる(RTX830実機で確認、#6)
	const withDate = (date: string) =>
		`# RTX830 Rev.15.02.30\n# Reporting Date: ${date}\n${CONFIG}`;
	await snapshots.ingest(DEVICE_ID, payload(withDate("Sep 17 22:34:23 2026")));
	const again = await snapshots.ingest(
		DEVICE_ID,
		payload(withDate("Sep 17 22:35:03 2026")),
	);
	expect(again.created).toBe(false);
	expect(snapshots.list(DEVICE_ID)).toHaveLength(1);
});

test("大きすぎる / 空のsnapshotは拒否する", async () => {
	await expect(snapshots.ingest(DEVICE_ID, payload(""))).rejects.toThrow(
		/size out of range/,
	);
	expect(snapshots.list(DEVICE_ID)).toHaveLength(0);
});

test("再取得要求はCONFIG_REQUEST frameとして届く", async () => {
	await sync(); // Deviceを接続済みにする
	snapshots.request(DEVICE_ID, "manual");
	const frames = await sync();
	expect(frames.map((f) => f.type)).toEqual([FrameType.CONFIG_REQUEST]);
	expect(new TextDecoder().decode(frames[0]?.payload)).toBe("manual");
});

test("APIはProfileと世代を返し、本文は返さない", async () => {
	const admin = await auth.createFirstAdmin({
		loginId: "admin",
		password: PASSWORD,
	});
	await auth.createUser({
		loginId: "viewer",
		password: PASSWORD,
		role: "viewer",
	});
	await snapshots.ingest(DEVICE_ID, payload(CONFIG));
	await snapshots.ingest(DEVICE_ID, payload(`${CONFIG}ip lan2 address dhcp\n`));

	const app = createApp({
		auth,
		audit,
		devices: {
			db: storage.db,
			tenantId,
			gateway,
			config: snapshots,
		},
		secureCookie: false,
	});
	const login = await app.request("/api/auth/login", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ identifier: "viewer", password: PASSWORD }),
	});
	const cookie = login.headers.get("set-cookie")?.split(";")[0] ?? "";
	const adminLogin = await app.request("/api/auth/login", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ identifier: "admin", password: PASSWORD }),
	});
	const adminCookie = adminLogin.headers.get("set-cookie")?.split(";")[0] ?? "";

	const profile = await app.request(`/api/devices/${DEVICE_ID}/profile`, {
		headers: { cookie },
	});
	expect((await profile.json()).profile.internet.ipv4.method).toBe("pppoe");

	const backups = await app.request(
		`/api/devices/${DEVICE_ID}/config-backups`,
		{ headers: { cookie } },
	);
	expect(backups.status).toBe(403);

	const adminBackups = await app.request(
		`/api/devices/${DEVICE_ID}/config-backups`,
		{ headers: { cookie: adminCookie } },
	);
	const body = await adminBackups.text();
	expect(body).not.toContain("pppoe use lan2");
	const listed = JSON.parse(body).backups as { id: string }[];
	expect(listed).toHaveLength(2);

	const latest = listed[0] as { id: string };
	const previous = listed[1] as { id: string };

	const viewerDownload = await app.request(
		`/api/devices/${DEVICE_ID}/config-backups/${latest.id}/download`,
		{ headers: { cookie } },
	);
	expect(viewerDownload.status).toBe(403);

	const download = await app.request(
		`/api/devices/${DEVICE_ID}/config-backups/${latest.id}/download`,
		{ headers: { cookie: adminCookie } },
	);
	expect(download.status).toBe(200);
	expect(download.headers.get("content-type")).toContain("Shift_JIS");
	expect(download.headers.get("content-disposition")).toContain(
		`config-${latest.id}.txt`,
	);
	expect(Array.from(new Uint8Array(await download.arrayBuffer()))).toEqual(
		Array.from(new TextEncoder().encode(`${CONFIG}ip lan2 address dhcp\n`)),
	);

	const viewerDiff = await app.request(
		`/api/devices/${DEVICE_ID}/config-backups/${latest.id}/diff`,
		{ headers: { cookie } },
	);
	expect(viewerDiff.status).toBe(403);

	const diff = await app.request(
		`/api/devices/${DEVICE_ID}/config-backups/${latest.id}/diff`,
		{ headers: { cookie: adminCookie } },
	);
	expect(diff.status).toBe(200);
	expect(diff.headers.get("cache-control")).toBe("no-store");
	const diffBody = await diff.json();
	expect(diffBody.against.id).toBe(previous.id);
	expect(diffBody.changed).toBe(true);
	expect(diffBody.diff).toContain("+ip lan2 address dhcp");
	expect(diffBody.lines).toContainEqual({
		type: "added",
		text: "ip lan2 address dhcp",
	});

	const explicitDiff = await app.request(
		`/api/devices/${DEVICE_ID}/config-backups/${latest.id}/diff?against=${previous.id}`,
		{ headers: { cookie: adminCookie } },
	);
	expect((await explicitDiff.json()).against.id).toBe(previous.id);

	const auditEvents = audit.list();
	const downloadEvents = auditEvents.filter(
		(event) => event.type === "DEVICE_CONFIG_DOWNLOADED",
	);
	expect(downloadEvents).toHaveLength(1);
	expect(downloadEvents[0]?.actor_user_id).toBe(admin.id);
	expect(
		auditEvents.filter((event) => event.type === "DEVICE_CONFIG_DIFF_VIEWED"),
	).toHaveLength(2);
	expect(JSON.stringify(auditEvents)).not.toContain("example-password");

	// 再取得はAdminのみ
	const denied = await app.request(
		`/api/devices/${DEVICE_ID}/config-snapshots`,
		{ method: "POST", headers: { cookie } },
	);
	expect(denied.status).toBe(403);
});
