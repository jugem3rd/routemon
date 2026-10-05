import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseConfig } from "@routemon/core";
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

const PASSWORD = "correct horse battery";
const CONFIG = `ip lan1 address 192.0.2.1/24
ip wan1 address 203.0.113.10/24
ip route default gateway 203.0.113.1
`;

const PPPOE_CONFIG = `ip lan1 address 192.0.2.2/24
ip route default gateway pp 1
pp select 1
 pppoe use lan2
 ip pp address dhcp
`;

let root: string;
let storage: Storage;
let tenantId: string;
let auth: LocalAuth;
let app: ReturnType<typeof createApp>;

function addDevice(id: string, name: string, deviceTenantId = tenantId): void {
	const at = nowIso();
	storage.db
		.prepare(
			`INSERT INTO devices (id, tenant_id, name, lifecycle_status, model, hostname, created_at, updated_at)
			 VALUES (?, ?, ?, 'active', 'RTX830', ?, ?, ?)`,
		)
		.run(id, deviceTenantId, name, `${id}.example`, at, at);
}

function addProfile(
	deviceId: string,
	deviceTenantId = tenantId,
	profile: unknown = parseConfig(CONFIG),
): void {
	const at = nowIso();
	storage.db
		.prepare(
			`INSERT INTO device_profiles (device_id, tenant_id, profile, config_hash, captured_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?)
			 ON CONFLICT(device_id) DO UPDATE SET
				profile = excluded.profile, config_hash = excluded.config_hash,
				captured_at = excluded.captured_at, updated_at = excluded.updated_at`,
		)
		.run(
			deviceId,
			deviceTenantId,
			JSON.stringify(profile),
			`sha256:${deviceId}`,
			at,
			at,
		);
}

async function login(identifier: string): Promise<string> {
	const response = await app.request("/api/auth/login", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ identifier, password: PASSWORD }),
	});
	return response.headers.get("set-cookie")?.split(";")[0] ?? "";
}

beforeEach(async () => {
	root = mkdtempSync(join(tmpdir(), "routemon-topology-api-"));
	storage = await openStorage({ root });
	tenantId = ensureDefaultTenant(storage.db);
	addDevice("hq", "HQ");
	addDevice("without-profile", "Without Profile");

	const otherTenant = "other-tenant";
	const at = nowIso();
	storage.db
		.prepare(
			"INSERT INTO tenants (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)",
		)
		.run(otherTenant, "Other", at, at);
	addDevice("other-device", "Other Device", otherTenant);
	addProfile("hq");
	addProfile("other-device", otherTenant);

	auth = new LocalAuth(storage.db, tenantId);
	await auth.createFirstAdmin({ loginId: "admin", password: PASSWORD });
	await auth.createUser({
		loginId: "viewer",
		password: PASSWORD,
		role: "viewer",
	});
	app = createApp({
		auth,
		audit: new AuditLog(storage.db, tenantId),
		devices: {
			db: storage.db,
			tenantId,
			gateway: new AgentGateway({
				store: new MemoryDeviceStore(),
				coalesceWaitMs: 1,
			}),
		},
		secureCookie: false,
	});
});

afterEach(() => {
	storage.close();
	rmSync(root, { recursive: true, force: true });
});

test("同一TenantのDeviceだけをProfile有無を問わず返す", async () => {
	const cookie = await login("viewer");
	const response = await app.request("/api/topology?tenantId=other-tenant", {
		headers: { cookie },
	});

	expect(response.status).toBe(200);
	expect(response.headers.get("cache-control")).toBe("no-store");
	const body = await response.json();
	expect(
		body.topology.devices.map((device: { id: string }) => device.id),
	).toEqual(["hq", "without-profile"]);
	expect(body.topology.warnings).toContainEqual({
		code: "profile_missing",
		deviceId: "without-profile",
		message: "Device profile is not available",
	});
	expect(
		body.topology.devices.find((device: { id: string }) => device.id === "hq")
			.interfaceIds,
	).toContain("hq:lan1");
	expect(
		body.topology.devices.find((device: { id: string }) => device.id === "hq")
			.wan,
	).toMatchObject({ ipv4: { method: "static", interface: "wan1" } });
});

test("壊れたProfileがあっても他DeviceのTopologyを200で返す", async () => {
	const at = nowIso();
	addDevice("broken", "Broken");
	storage.db
		.prepare(
			`INSERT INTO device_profiles (device_id, tenant_id, profile, config_hash, captured_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?)`,
		)
		.run("broken", tenantId, "{not-json", "sha256:broken", at, at);

	const cookie = await login("admin");
	const response = await app.request("/api/topology", {
		headers: { cookie },
	});

	expect(response.status).toBe(200);
	const body = await response.json();
	expect(
		body.topology.devices.map((device: { id: string }) => device.id),
	).toEqual(["broken", "hq", "without-profile"]);
	expect(
		body.topology.devices.find((device: { id: string }) => device.id === "hq")
			.interfaceIds,
	).toContain("hq:lan1");
	expect(body.topology.warnings).toContainEqual({
		code: "partial_profile",
		deviceId: "broken",
		message: "Device profile does not contain all canonical facts",
	});
});

test("動的WANの方式もTopology Deviceへ返す", async () => {
	addDevice("pppoe", "PPPoE");
	addProfile("pppoe", tenantId, parseConfig(PPPOE_CONFIG));

	const cookie = await login("viewer");
	const response = await app.request("/api/topology", {
		headers: { cookie },
	});
	const body = await response.json();
	const pppoe = body.topology.devices.find(
		(device: { id: string }) => device.id === "pppoe",
	);

	expect(response.status).toBe(200);
	expect(pppoe.wan).toMatchObject({
		ipv4: { method: "pppoe", interface: "lan2", pp: 1 },
	});
});

test("L2TP/IPsec remote access受けをsanitizer経由で返しVPN linkを作らない", async () => {
	addDevice("remote-access", "Remote Access");
	addProfile(
		"remote-access",
		tenantId,
		parseConfig(`ip lan1 address 192.0.2.10/24
ip wan1 address 203.0.113.10/24
tunnel select 7
 tunnel encapsulation l2tp
 ipsec tunnel 7
 ipsec ike local address 7 203.0.113.10
 ipsec ike remote address 7 any
`),
	);

	const cookie = await login("viewer");
	const response = await app.request("/api/topology", {
		headers: { cookie },
	});
	const body = await response.json();
	const topology = body.topology as {
		vpnTunnels: Array<Record<string, unknown>>;
		links: Array<{ kind: string; vpnTunnelId?: string }>;
	};

	expect(response.status).toBe(200);
	expect(topology.vpnTunnels).toContainEqual(
		expect.objectContaining({
			id: "remote-access:tunnel:7",
			tunnelNumber: 7,
			type: "l2tp-ipsec",
			remoteAccess: true,
			localEndpoint: { kind: "ipv4", value: "203.0.113.10" },
			remoteEndpoint: { kind: "dynamic", value: "any" },
		}),
	);
	expect(
		topology.links.some(
			(link) => link.vpnTunnelId === "remote-access:tunnel:7",
		),
	).toBe(false);
});

test("旧ipsecTunnels保存形式もTopologyへ読み込む", async () => {
	const legacyProfile = JSON.parse(
		JSON.stringify(parseConfig(CONFIG)),
	) as Record<string, unknown>;
	delete legacyProfile.vpnTunnels;
	legacyProfile.ipsecTunnels = [
		{
			id: 1,
			encapsulation: "ipsec",
			ipsecTunnelIds: [1],
			remoteEndpoint: { kind: "ipv4", value: "198.51.100.20" },
		},
	];
	addProfile("hq", tenantId, legacyProfile);
	addDevice("branch", "Branch");
	addProfile(
		"branch",
		tenantId,
		parseConfig(`ip lan1 address 198.51.100.1/24
ip wan1 address 198.51.100.20/24
`),
	);

	const cookie = await login("viewer");
	const response = await app.request("/api/topology", {
		headers: { cookie },
	});
	const body = await response.json();

	expect(response.status).toBe(200);
	expect(body.topology.vpnTunnels).toContainEqual(
		expect.objectContaining({
			id: "hq:tunnel:1",
			type: "ipsec",
			remoteEndpoint: { kind: "ipv4", value: "198.51.100.20" },
		}),
	);
	expect(body.topology.links).toContainEqual(
		expect.objectContaining({
			id: "hq:vpn:1",
			match: { status: "matched", confidence: "high" },
		}),
	);
	expect(body.topology.warnings).not.toContainEqual(
		expect.objectContaining({ code: "partial_profile", deviceId: "hq" }),
	);
});

test("Profile JSONの余分なsecret相当フィールドをレスポンスへ返さない", async () => {
	const profile = {
		...parseConfig(CONFIG),
		pppoePassword: "topology-pppoe-secret",
		preSharedKey: "topology-ipsec-secret",
		rawConfig: "pp auth myname secret-user topology-password",
	};
	addProfile("hq", tenantId, profile);

	const cookie = await login("viewer");
	const response = await app.request("/api/topology", {
		headers: { cookie },
	});
	const text = await response.text();

	expect(response.status).toBe(200);
	expect(text).not.toContain("topology-pppoe-secret");
	expect(text).not.toContain("topology-ipsec-secret");
	expect(text).not.toContain("pp auth myname secret-user topology-password");
});

test("未認証は401、TopologyはViewerにも公開し、Admin専用操作は403にする", async () => {
	expect((await app.request("/api/topology")).status).toBe(401);
	const viewer = await login("viewer");
	expect(
		(
			await app.request("/api/topology", {
				headers: { cookie: viewer },
			})
		).status,
	).toBe(200);
	const forbidden = await app.request("/api/devices/hq", {
		method: "PATCH",
		headers: { cookie: viewer, "content-type": "application/json" },
		body: JSON.stringify({ name: "forbidden" }),
	});
	expect(forbidden.status).toBe(403);
});
