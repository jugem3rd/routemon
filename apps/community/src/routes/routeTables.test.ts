import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentGateway } from "@routemon/gateway";
import { afterEach, beforeEach, expect, test } from "vitest";
import { createApp } from "../app.ts";
import { AuditEventType, AuditLog } from "../auth/audit.ts";
import { LocalAuth } from "../auth/localAuth.ts";
import { RouteTableCollector } from "../routeTables/collector.ts";
import { RouteTableRepository } from "../routeTables/repository.ts";
import { nowIso } from "../storage/db.ts";
import {
	ensureDefaultTenant,
	openStorage,
	type Storage,
} from "../storage/index.ts";

const PASSWORD = "correct horse battery";
const IPV4_OUTPUT = [
	"Destination Gateway Interface Type",
	"198.51.100.0/24 198.51.100.1 LAN1 static",
].join("\r\n");
const IPV6_OUTPUT = [
	"Destination Gateway Interface Type",
	"2001:db8:1::/64 2001:db8::1 LAN1 OSPF cost=10",
].join("\r\n");

let root: string;
let storage: Storage;
let tenantId: string;
let now: number;
let online: Set<string>;
let commandCount: number;
let auth: LocalAuth;
let audit: AuditLog;
let collector: RouteTableCollector;
let app: ReturnType<typeof createApp>;

function addDevice(
	id: string,
	targetTenantId = tenantId,
	lifecycleStatus: "active" | "disabled" = "active",
): void {
	const at = nowIso(new Date(now));
	storage.db
		.prepare(
			"INSERT INTO devices (id, tenant_id, name, lifecycle_status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
		)
		.run(id, targetTenantId, id, lifecycleStatus, at, at);
}

async function login(loginId: string): Promise<string> {
	const response = await app.request("/api/auth/login", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ identifier: loginId, password: PASSWORD }),
	});
	return response.headers.get("set-cookie")?.split(";")[0] ?? "";
}

beforeEach(async () => {
	root = mkdtempSync(join(tmpdir(), "routemon-route-api-"));
	storage = await openStorage({ root });
	tenantId = ensureDefaultTenant(storage.db);
	now = Date.UTC(2026, 0, 1);
	online = new Set(["d-online"]);
	commandCount = 0;
	addDevice("d-online");
	addDevice("d-offline");
	const secondTenant = "other-tenant";
	const at = nowIso(new Date(now));
	storage.db
		.prepare(
			"INSERT INTO tenants (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)",
		)
		.run(secondTenant, "Other", at, at);
	addDevice("d-other-tenant", secondTenant);

	const gateway = {
		presence: (deviceId: string) =>
			({
				deviceId,
				status: online.has(deviceId) ? "online" : "offline",
				lastSeenAt: online.has(deviceId) ? new Date(now) : null,
				observedSourceIp: undefined,
			}) as ReturnType<AgentGateway["presence"]>,
		sendCommand: async (_deviceId: string, commandBytes: Uint8Array) => {
			commandCount += 1;
			const command = new TextDecoder().decode(commandBytes);
			return {
				success: true,
				output: new TextEncoder().encode(
					command === "show ip route" ? IPV4_OUTPUT : IPV6_OUTPUT,
				),
			};
		},
	} as unknown as AgentGateway;
	const repository = new RouteTableRepository(storage.db);
	collector = new RouteTableCollector({
		db: storage.db,
		tenantId,
		gateway,
		repository,
		now: () => now,
	});
	auth = new LocalAuth(storage.db, tenantId);
	await auth.createFirstAdmin({ loginId: "admin", password: PASSWORD });
	await auth.createUser({
		loginId: "viewer",
		password: PASSWORD,
		role: "viewer",
	});
	audit = new AuditLog(storage.db, tenantId, () => now);
	app = createApp({
		auth,
		audit,
		routeTables: { db: storage.db, tenantId, collector },
		secureCookie: false,
	});
});

afterEach(() => {
	storage.close();
	rmSync(root, { recursive: true, force: true });
});

test("ViewerはObservedだけを読めるがrefreshは403、別TenantのDeviceは読めない", async () => {
	const viewer = await login("viewer");
	const own = await app.request("/api/devices/d-online/routes", {
		headers: { cookie: viewer },
	});
	expect(own.status).toBe(200);
	expect(await own.json()).toEqual({ ipv4: null, ipv6: null });

	const denied = await app.request("/api/devices/d-online/routes/refresh", {
		method: "POST",
		headers: { cookie: viewer },
	});
	expect(denied.status).toBe(403);
	expect(commandCount).toBe(0);

	const otherTenant = await app.request("/api/devices/d-other-tenant/routes", {
		headers: { cookie: viewer },
	});
	expect(otherTenant.status).toBe(404);
});

test("Admin refreshはonline Deviceを収集し、route dataなしで監査する", async () => {
	const admin = await login("admin");
	const response = await app.request("/api/devices/d-online/routes/refresh", {
		method: "POST",
		headers: { cookie: admin },
	});
	expect(response.status).toBe(200);
	const body = await response.json();
	expect(body.ipv4).toMatchObject({ lastAttemptStatus: "complete" });
	expect(body.ipv4.routes).toHaveLength(1);
	expect(body.ipv6).toMatchObject({ lastAttemptStatus: "complete" });
	expect(commandCount).toBe(2);

	const viewer = await login("viewer");
	const observed = await app.request("/api/devices/d-online/routes", {
		headers: { cookie: viewer },
	});
	expect(observed.status).toBe(200);
	expect((await observed.json()).ipv4.routes).toHaveLength(1);

	const event = audit.list({
		type: AuditEventType.DEVICE_ROUTE_TABLE_REFRESHED,
	})[0];
	expect(event?.target_id).toBe("d-online");
	expect(event?.detail_json).toBe('{"result":"complete"}');
	expect(event?.detail_json).not.toContain("198.51.100");
});

test("offline Deviceのrefreshは409で、定期取得でもcommandを送らない", async () => {
	const admin = await login("admin");
	const response = await app.request("/api/devices/d-offline/routes/refresh", {
		method: "POST",
		headers: { cookie: admin },
	});
	expect(response.status).toBe(409);
	expect(commandCount).toBe(0);

	await collector.sweep();
	expect(commandCount).toBe(0);
});
