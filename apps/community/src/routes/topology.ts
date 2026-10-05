/**
 * Tenant内の最新Device ProfileからTopologyを都度生成するAPI(#99)。
 *
 * ProfileはDevice rowと同じTenant scopeで読む。Topologyは永続化せず、
 * raw CONFIGやProfile JSONをレスポンスへ渡さない。
 */
import {
	type DeviceProfile,
	type ProfileAddress,
	type ProfileEndpoint,
	type ProfileInterface,
	type ProfileNetwork,
	type ProfileRoute,
	type ProfileTunnel,
	type ProfileVpnTunnelType,
	TopologyBuilder,
	type TopologyModel,
} from "@routemon/core";
import { Hono } from "hono";
import { type AuthEnv, requireUser } from "../auth/authorize.ts";
import type { LocalAuth } from "../auth/localAuth.ts";
import type { Db } from "../storage/db.ts";

type TopologyDeviceRow = {
	id: string;
	name: string;
	model: string | null;
	hostname: string | null;
	lifecycle_status: string;
	profile_json: string | null;
	config_hash: string | null;
	captured_at: string | null;
};

type ProfileRead = {
	profile: DeviceProfile | null;
	metadata: { capturedAt: string; configHash: string } | null;
};

const PROFILE_ROLES = new Set<ProfileInterface["role"]>([
	"lan",
	"wan",
	"tunnel",
	"unknown",
]);
const ADDRESS_FAMILIES = new Set<ProfileAddress["family"]>(["ipv4", "ipv6"]);
const ADDRESS_ASSIGNMENTS = new Set<ProfileAddress["assignment"]>([
	"static",
	"dhcp",
	"pppoe",
	"unknown",
]);
const NETWORK_KINDS = new Set<ProfileNetwork["kind"]>([
	"lan",
	"wan",
	"tunnel",
	"unknown",
]);
const ROUTE_GATEWAY_KINDS = new Set<ProfileRoute["gateway"]["kind"]>([
	"ip",
	"dhcp",
	"pp",
	"tunnel",
	"interface",
	"unknown",
]);
const ENDPOINT_KINDS = new Set<ProfileEndpoint["kind"]>([
	"ipv4",
	"ipv6",
	"fqdn",
	"dynamic",
	"unknown",
]);
const VPN_TUNNEL_TYPES = new Set<ProfileVpnTunnelType>([
	"ipsec",
	"l2tp-ipsec",
	"l2tpv3",
	"gre",
	"ipip",
	"unknown",
]);
const IPV4_METHODS = new Set<"pppoe" | "dhcp" | "static">([
	"pppoe",
	"dhcp",
	"static",
]);
const IPV6_METHODS = new Set<"dhcpv6-pd" | "dhcpv6" | "ra" | "static">([
	"dhcpv6-pd",
	"dhcpv6",
	"ra",
	"static",
]);
const IPV4_OVER_IPV6_METHODS = new Set<"map-e" | "ds-lite">([
	"map-e",
	"ds-lite",
]);

export function createTopologyRoutes(auth: LocalAuth, db: Db) {
	const app = new Hono<AuthEnv>();
	const authenticated = requireUser(auth);
	const service = new TopologyService(db);

	app.get("/topology", authenticated, (c) => {
		const topology = service.build(c.get("tenantId"));
		return c.json({ topology }, 200, { "cache-control": "no-store" });
	});

	return app;
}

/** Profileの読み取りとTopology生成をTenant scopeの内側に閉じ込める。 */
export class TopologyService {
	private readonly db: Db;

	constructor(db: Db) {
		this.db = db;
	}

	build(tenantId: string): TopologyModel {
		const rows = this.db
			.prepare(
				`SELECT d.id, d.name, d.model, d.hostname, d.lifecycle_status,
						p.profile AS profile_json, p.config_hash, p.captured_at
					 FROM devices d
					 LEFT JOIN device_profiles p
					   ON p.device_id = d.id
					  AND p.tenant_id = d.tenant_id
					  AND p.tenant_id = ?
					 WHERE d.tenant_id = ?
					 ORDER BY d.id`,
			)
			.all(tenantId, tenantId) as TopologyDeviceRow[];

		const inputs = rows.map((row) => {
			const profile = readProfile(row);
			return {
				device: {
					id: row.id,
					name: row.name,
					vendor: "yamaha",
					model: row.model,
					hostname: row.hostname,
					lifecycle: row.lifecycle_status,
				},
				profile: profile.profile,
				profileMetadata: profile.metadata,
			};
		});

		return new TopologyBuilder().build(inputs);
	}
}

function readProfile(row: TopologyDeviceRow): ProfileRead {
	if (row.profile_json === null) {
		return { profile: null, metadata: null };
	}

	const metadata =
		row.config_hash !== null && row.captured_at !== null
			? { capturedAt: row.captured_at, configHash: row.config_hash }
			: null;

	try {
		const value: unknown = JSON.parse(row.profile_json);
		return {
			profile: sanitizeProfile(value),
			metadata,
		};
	} catch {
		// JSONが壊れていても、このDeviceだけをpartialとして扱い他Deviceを返す。
		return { profile: partialProfile(), metadata };
	}
}

/**
 * DB内のProfileをTopologyBuilderが読むcanonical factsだけへ絞る。
 * 余分なフィールドをコピーしないため、古いProfileや不正JSONにsecretが
 * 混ざっていてもAPIレスポンスへ流出しない。
 */
function sanitizeProfile(value: unknown): DeviceProfile {
	if (!isRecord(value)) return partialProfile();

	const interfaces = readArray(value.interfaces, isProfileInterface);
	const networks = readArray(value.networks, isProfileNetwork);
	const routes = readArray(value.routes, isProfileRoute);
	const tunnelSource = Array.isArray(value.vpnTunnels)
		? value.vpnTunnels
		: value.ipsecTunnels;
	const vpnTunnels = readArray(tunnelSource, isProfileTunnel).map(
		sanitizeProfileTunnel,
	);
	const complete =
		value.parserVersion === 1 &&
		Array.isArray(value.interfaces) &&
		interfaces.length === value.interfaces.length &&
		Array.isArray(value.networks) &&
		networks.length === value.networks.length &&
		Array.isArray(value.routes) &&
		routes.length === value.routes.length &&
		Array.isArray(tunnelSource) &&
		vpnTunnels.length === tunnelSource.length;

	return {
		internet: sanitizeInternet(value.internet),
		interfaces,
		networks,
		routes,
		vpnTunnels,
		...(complete ? { parserVersion: 1 } : {}),
		...(typeof value.model === "string" ? { model: value.model } : {}),
	} as unknown as DeviceProfile;
}

function partialProfile(): DeviceProfile {
	return {
		internet: {},
		interfaces: [],
		networks: [],
		routes: [],
		vpnTunnels: [],
	} as unknown as DeviceProfile;
}

function sanitizeInternet(value: unknown): DeviceProfile["internet"] {
	if (!isRecord(value)) return {};
	const internet: DeviceProfile["internet"] = {};
	const ipv4 = value.ipv4;
	if (isRecord(ipv4) && isSetValue(IPV4_METHODS, ipv4.method)) {
		internet.ipv4 = {
			method: ipv4.method,
			...(typeof ipv4.interface === "string"
				? { interface: ipv4.interface }
				: {}),
			...(typeof ipv4.pp === "number" && Number.isInteger(ipv4.pp)
				? { pp: ipv4.pp }
				: {}),
		};
	}
	const ipv6 = value.ipv6;
	if (isRecord(ipv6) && isSetValue(IPV6_METHODS, ipv6.method)) {
		internet.ipv6 = {
			method: ipv6.method,
			...(typeof ipv6.interface === "string"
				? { interface: ipv6.interface }
				: {}),
		};
	}
	const ipv4OverIpv6 = value.ipv4_over_ipv6;
	if (
		isRecord(ipv4OverIpv6) &&
		isSetValue(IPV4_OVER_IPV6_METHODS, ipv4OverIpv6.method)
	) {
		internet.ipv4_over_ipv6 = {
			method: ipv4OverIpv6.method,
			...(typeof ipv4OverIpv6.tunnel === "number" &&
			Number.isInteger(ipv4OverIpv6.tunnel)
				? { tunnel: ipv4OverIpv6.tunnel }
				: {}),
		};
	}
	return internet;
}

function readArray<T>(
	value: unknown,
	predicate: (value: unknown) => value is T,
): T[] {
	return Array.isArray(value) ? value.filter(predicate) : [];
}

function isProfileInterface(value: unknown): value is ProfileInterface {
	if (!isRecord(value)) return false;
	return (
		typeof value.name === "string" &&
		isSetValue(PROFILE_ROLES, value.role) &&
		Array.isArray(value.addresses) &&
		value.addresses.every(isProfileAddress)
	);
}

function isProfileAddress(value: unknown): value is ProfileAddress {
	if (!isRecord(value)) return false;
	return (
		isSetValue(ADDRESS_FAMILIES, value.family) &&
		isSetValue(ADDRESS_ASSIGNMENTS, value.assignment) &&
		(value.address === undefined || typeof value.address === "string")
	);
}

function isProfileNetwork(value: unknown): value is ProfileNetwork {
	if (!isRecord(value)) return false;
	return (
		typeof value.interface === "string" &&
		isSetValue(ADDRESS_FAMILIES, value.family) &&
		typeof value.cidr === "string" &&
		isSetValue(NETWORK_KINDS, value.kind)
	);
}

function isProfileRoute(value: unknown): value is ProfileRoute {
	if (!isRecord(value) || !isRecord(value.gateway)) return false;
	return (
		typeof value.destination === "string" &&
		isSetValue(ROUTE_GATEWAY_KINDS, value.gateway.kind) &&
		typeof value.gateway.value === "string" &&
		(value.interface === undefined || typeof value.interface === "string") &&
		(value.tunnel === undefined ||
			(typeof value.tunnel === "number" && Number.isInteger(value.tunnel)))
	);
}

function isProfileTunnel(value: unknown): value is ProfileTunnel {
	if (!isRecord(value)) return false;
	return (
		typeof value.id === "number" &&
		Number.isInteger(value.id) &&
		typeof value.encapsulation === "string" &&
		(value.type === undefined || isSetValue(VPN_TUNNEL_TYPES, value.type)) &&
		(value.ipsecTunnelIds === undefined ||
			(Array.isArray(value.ipsecTunnelIds) &&
				value.ipsecTunnelIds.every(
					(id) => typeof id === "number" && Number.isInteger(id),
				))) &&
		(value.localEndpoint === undefined ||
			isProfileEndpoint(value.localEndpoint)) &&
		(value.remoteEndpoint === undefined ||
			isProfileEndpoint(value.remoteEndpoint)) &&
		(value.remoteAccess === undefined ||
			typeof value.remoteAccess === "boolean")
	);
}

function sanitizeProfileTunnel(tunnel: ProfileTunnel): ProfileTunnel {
	const result: ProfileTunnel = {
		id: tunnel.id,
		encapsulation: tunnel.encapsulation,
	};
	if (tunnel.type) result.type = tunnel.type;
	if (tunnel.ipsecTunnelIds) result.ipsecTunnelIds = [...tunnel.ipsecTunnelIds];
	if (tunnel.localEndpoint) {
		result.localEndpoint = { ...tunnel.localEndpoint };
	}
	if (tunnel.remoteEndpoint) {
		result.remoteEndpoint = { ...tunnel.remoteEndpoint };
	}
	if (tunnel.remoteAccess === true) result.remoteAccess = true;
	return result;
}

function isProfileEndpoint(value: unknown): value is ProfileEndpoint {
	return (
		isRecord(value) &&
		isSetValue(ENDPOINT_KINDS, value.kind) &&
		typeof value.value === "string"
	);
}

function isSetValue<T>(set: Set<T>, value: unknown): value is T {
	return set.has(value as T);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
