import { describe, expect, test } from "vitest";
import { parseConfig } from "./configProfile.ts";
import { parseRouteTable } from "./routeTable.ts";
import { TopologyBuilder, type TopologyDeviceInput } from "./topology.ts";

const CAPTURED_AT = "2026-09-22T00:00:00.000Z";

const HQ_CONFIG = `ip lan1 address 192.0.2.1/24
ip wan1 address 203.0.113.10/24
ip route default gateway 203.0.113.1
tunnel select 1
 tunnel encapsulation ipsec
 ipsec tunnel 1
 ipsec ike local address 1 203.0.113.10
 ipsec ike remote address 1 198.51.100.20
 ip tunnel address 203.0.113.30/30
ip route 198.51.100.0/24 gateway tunnel 1
`;

const BRANCH_CONFIG = `ip lan1 address 198.51.100.1/24
ip wan1 address 198.51.100.20/24
ip route default gateway 198.51.100.254
`;

const PPPOE_CONFIG = `ip lan1 address 192.0.2.1/24
ip route default gateway pp 1
pp select 1
 pppoe use lan2
 ip pp address dhcp
`;

const DS_LITE_CONFIG = `ip lan1 address 198.51.100.1/24
ipv6 lan2 dhcp service client
tunnel select 1
 tunnel encapsulation ds-lite
`;

const REVERSE_BRANCH_CONFIG = `ip lan1 address 198.51.100.1/24
ip wan1 address 198.51.100.20/24
ip route default gateway 198.51.100.254
tunnel select 1
 tunnel encapsulation ipsec
 ipsec tunnel 1
 ipsec ike local address 1 198.51.100.20
 ipsec ike remote address 1 203.0.113.10
ip route 192.0.2.0/24 gateway tunnel 1
`;

const AMBIGUOUS_SOURCE_CONFIG = `ip lan1 address 192.0.2.2/24
ip wan1 address 192.0.2.3/24
ip route default gateway 192.0.2.254
tunnel select 1
 tunnel encapsulation ipsec
 ipsec tunnel 1
 ipsec ike remote address 1 203.0.113.20
`;

const AMBIGUOUS_CANDIDATE_CONFIG = `ip lan1 address 198.51.100.2/24
ip wan1 address 203.0.113.20/24
ip route default gateway 203.0.113.1
`;

const EXTERNAL_PEER_CONFIG = `ip lan1 address 192.0.2.4/24
ip wan1 address 198.51.100.4/24
ip route default gateway 198.51.100.1
tunnel select 1
 tunnel encapsulation ipsec
 ipsec tunnel 1
 ipsec ike remote address 1 remote.example
tunnel select 2
 tunnel encapsulation ipsec
 ipsec tunnel 2
 ipsec ike remote address 1 dynamic
`;

function input(
	id: string,
	name: string,
	config: string,
	configHash = `${id}-config-hash`,
): TopologyDeviceInput {
	return {
		device: {
			id,
			name,
			model: "RTX-test",
			hostname: `${id}-router`,
			lifecycle: "active",
		},
		profile: parseConfig(config),
		profileMetadata: { capturedAt: CAPTURED_AT, configHash },
	};
}

describe("TopologyBuilder", () => {
	test("ProfileのWAN方式をDeviceへ運び、動的方式も要約する", () => {
		const model = new TopologyBuilder().build(
			[
				input("pppoe", "PPPoE", PPPOE_CONFIG),
				input("ds-lite", "DS-Lite", DS_LITE_CONFIG),
				input("static", "Static", BRANCH_CONFIG),
			],
			{ generatedAt: CAPTURED_AT },
		);

		expect(
			model.devices.find((device) => device.id === "pppoe")?.wan,
		).toMatchObject({
			ipv4: { method: "pppoe", interface: "lan2", pp: 1 },
		});
		expect(
			model.devices.find((device) => device.id === "ds-lite")?.wan,
		).toMatchObject({
			ipv6: { method: "dhcpv6", interface: "lan2" },
			ipv4OverIpv6: { method: "ds-lite", tunnel: 1 },
		});
		expect(
			model.devices.find((device) => device.id === "static")?.wan,
		).toMatchObject({
			ipv4: { method: "static", interface: "wan1" },
		});
		for (const device of model.devices) {
			for (const fact of [
				device.wan?.ipv4,
				device.wan?.ipv6,
				device.wan?.ipv4OverIpv6,
			]) {
				if (fact) expect(fact.evidence[0]?.source).toBe("configured");
			}
		}
	});

	test("canonical factsからModelを作り、静的WAN IPv4でpeerを突合する", () => {
		const builder = new TopologyBuilder();
		const hq = input("hq", "HQ", HQ_CONFIG);
		const branch = input("branch", "Branch", BRANCH_CONFIG);
		const options = { generatedAt: CAPTURED_AT };

		const model = builder.build([hq, branch], options);
		const reversed = builder.build([branch, hq], options);

		expect(reversed).toEqual(model);
		expect(model.schemaVersion).toBe(1);
		expect(model.generatedAt).toBe(CAPTURED_AT);
		expect(model.neighbors).toEqual([]);
		expect(model.warnings).toEqual([]);

		const hqDevice = model.devices.find((device) => device.id === "hq");
		expect(hqDevice).toMatchObject({
			id: "hq",
			name: "HQ",
			vendor: "yamaha",
			model: "RTX-test",
			interfaceIds: ["hq:lan1", "hq:tunnel1", "hq:wan1"],
			routeIds: [
				"hq:route:198.51.100.0/24:tunnel:tunnel 1",
				"hq:route:default:ip:203.0.113.1",
			],
			vpnTunnelIds: ["hq:tunnel:1"],
			profile: { capturedAt: CAPTURED_AT, configHash: "hq-config-hash" },
		});

		const hqInterface = model.interfaces.find(
			(interfaceFact) => interfaceFact.id === "hq:lan1",
		);
		expect(hqInterface?.networkIds).toEqual(["hq:network:lan1:192.0.2.0/24"]);
		expect(hqInterface?.evidence).toContainEqual({
			source: "configured",
			at: CAPTURED_AT,
			configHash: "hq-config-hash",
			summary: "configured interface fact",
		});

		const hqTunnel = model.vpnTunnels.find(
			(tunnel) => tunnel.id === "hq:tunnel:1",
		);
		expect(hqTunnel).toMatchObject({
			deviceId: "hq",
			tunnelNumber: 1,
			type: "ipsec",
			interfaceId: "hq:tunnel1",
			localEndpoint: { kind: "ipv4", value: "203.0.113.10" },
			remoteEndpoint: { kind: "ipv4", value: "198.51.100.20" },
			localNetworkIds: ["hq:network:lan1:192.0.2.0/24"],
			remoteNetworkIds: ["hq:network:remote:198.51.100.0/24"],
		});
		expect(hqTunnel?.evidence).toContainEqual({
			source: "configured",
			at: CAPTURED_AT,
			configHash: "hq-config-hash",
			summary: "configured VPN tunnel",
		});

		const matched = model.links.find((link) => link.id === "hq:vpn:1");
		expect(matched).toMatchObject({
			kind: "vpn",
			source: { type: "device", id: "hq" },
			target: { type: "device", id: "branch" },
			vpnTunnelId: "hq:tunnel:1",
			match: { status: "matched", confidence: "high" },
		});
		expect(matched?.evidence).toContainEqual({
			source: "inferred",
			rule: "vpn-remote-address-equals-wan-address",
			inputs: ["hq:tunnel:1", "branch:wan:wan1:address:198.51.100.20"],
			summary: "VPN remote endpoint matches exactly one Device WAN address",
		});
	});

	test("種別の異なるVPNを保持し、L2TP/IPsecのany受けには線を作らない", () => {
		const mixedConfig = `ip lan1 address 192.0.2.1/24
ip wan1 address 203.0.113.10/24
tunnel select 1
 tunnel encapsulation l2tp
 ipsec tunnel 1
 ipsec ike local address 1 203.0.113.10
 ipsec ike remote address 1 any
tunnel select 2
 tunnel encapsulation l2tpv3-raw
 tunnel endpoint address 203.0.113.10 198.51.100.20
tunnel select 3
 tunnel encapsulation gre
 tunnel endpoint address 203.0.113.10 198.51.100.30
tunnel select 4
 tunnel encapsulation ipip
 tunnel endpoint address 203.0.113.10 198.51.100.40
tunnel select 5
 tunnel encapsulation ipsec
 ipsec tunnel 5
 ipsec ike local address 5 203.0.113.10
 ipsec ike remote address 5 198.51.100.20
`;
		const model = new TopologyBuilder().build(
			[
				input("mixed", "Mixed", mixedConfig),
				input("peer", "Peer", BRANCH_CONFIG),
			],
			{ generatedAt: CAPTURED_AT },
		);

		expect(model.vpnTunnels.map(({ type }) => type)).toEqual([
			"l2tp-ipsec",
			"l2tpv3",
			"gre",
			"ipip",
			"ipsec",
		]);
		expect(model.vpnTunnels[0]).toMatchObject({
			id: "mixed:tunnel:1",
			type: "l2tp-ipsec",
			remoteAccess: true,
			localEndpoint: { kind: "ipv4", value: "203.0.113.10" },
			remoteEndpoint: { kind: "dynamic", value: "any" },
		});
		expect(model.links.filter((link) => link.kind === "vpn")).toHaveLength(4);
		expect(
			model.links.some((link) => link.vpnTunnelId === "mixed:tunnel:1"),
		).toBe(false);
		expect(
			model.links.find((link) => link.vpnTunnelId === "mixed:tunnel:2")?.match,
		).toEqual({ status: "matched", confidence: "high" });
		expect(
			model.links.find((link) => link.vpnTunnelId === "mixed:tunnel:3")?.match,
		).toEqual({ status: "unmatched" });
		expect(
			model.links.find((link) => link.vpnTunnelId === "mixed:tunnel:5")?.match,
		).toEqual({ status: "matched", confidence: "high" });
	});

	test("両端のmatched VPN linkを1本へ集約し、両方のtunnelを参照する", () => {
		const model = new TopologyBuilder().build(
			[
				input("hq", "HQ", HQ_CONFIG),
				input("branch", "Branch", REVERSE_BRANCH_CONFIG),
			],
			{ generatedAt: CAPTURED_AT },
		);
		const links = model.links.filter((link) => link.kind === "vpn");

		expect(model.vpnTunnels.map((tunnel) => tunnel.id)).toEqual([
			"branch:tunnel:1",
			"hq:tunnel:1",
		]);
		expect(links).toHaveLength(1);
		expect(links[0]).toMatchObject({
			id: "branch:vpn:hq",
			source: { type: "device", id: "branch" },
			target: { type: "device", id: "hq" },
			vpnTunnelIds: ["branch:tunnel:1", "hq:tunnel:1"],
			vpnDirection: "bidirectional",
			match: { status: "matched", confidence: "high" },
		});
		expect(links[0]).not.toHaveProperty("vpnTunnelId");
	});

	test("片側だけのmatched VPN linkはsingleとして残す", () => {
		const model = new TopologyBuilder().build(
			[input("hq", "HQ", HQ_CONFIG), input("branch", "Branch", BRANCH_CONFIG)],
			{ generatedAt: CAPTURED_AT },
		);
		const link = model.links.find((item) => item.kind === "vpn");

		expect(link).toMatchObject({
			vpnTunnelId: "hq:tunnel:1",
			vpnTunnelIds: ["hq:tunnel:1"],
			vpnDirection: "single",
			match: { status: "matched" },
		});
	});

	test("複数一致ではDeviceを選ばずcandidateDeviceIdsをwarningへ残す", () => {
		const model = new TopologyBuilder().build(
			[
				input("source", "Source", AMBIGUOUS_SOURCE_CONFIG),
				input("candidate-a", "Candidate A", AMBIGUOUS_CANDIDATE_CONFIG),
				input("candidate-b", "Candidate B", AMBIGUOUS_CANDIDATE_CONFIG),
			],
			{ generatedAt: CAPTURED_AT },
		);
		const link = model.links.find((item) => item.id === "source:vpn:1");

		expect(link).toMatchObject({
			target: { type: "external" },
			match: {
				status: "ambiguous",
				candidateDeviceIds: ["candidate-a", "candidate-b"],
			},
		});
		expect(link?.evidence).toContainEqual({
			source: "configured",
			at: CAPTURED_AT,
			configHash: "source-config-hash",
			summary: "configured VPN tunnel has multiple WAN peer candidates",
		});
		expect(model.warnings).toContainEqual({
			code: "ambiguous_vpn_peer",
			deviceId: "source",
			factId: "source:tunnel:1",
			candidateDeviceIds: ["candidate-a", "candidate-b"],
			message: "VPN remote endpoint matches multiple Device WAN addresses",
		});
	});

	test("FQDN・dynamic・自Deviceだけの一致はexternalのunmatchedにする", () => {
		const selfConfig = EXTERNAL_PEER_CONFIG.replace(
			"remote.example",
			"198.51.100.4",
		);
		const model = new TopologyBuilder().build(
			[input("external", "External", selfConfig)],
			{ generatedAt: CAPTURED_AT },
		);
		const links = model.links.filter((link) => link.kind === "vpn");

		expect(links).toHaveLength(2);
		for (const link of links) {
			expect(link.target.type).toBe("external");
			expect(link.match).toEqual({ status: "unmatched" });
		}
		expect(links.map((link) => link.target.label)).toEqual([
			"198.51.100.4",
			"dynamic",
		]);
	});

	test("Observed routeをConfigured routeと別IDで保持しobserved evidenceを付ける", () => {
		const router = input(
			"router",
			"Router",
			"ip lan1 address 192.168.100.1/24\nip route 198.51.100.0/24 gateway 203.0.113.1\n",
		);
		router.observedRouteTables = [
			{
				capturedAt: "2026-09-23T12:00:00.000Z",
				result: parseRouteTable(
					"Destination Gateway Interface Type\n" +
						"198.51.100.0/24 203.0.113.1 TUNNEL[1] static\n" +
						"192.168.100.0/24 - LAN1 implicit\n",
					"ipv4",
				),
			},
		];
		const model = new TopologyBuilder().build([router], {
			generatedAt: CAPTURED_AT,
		});
		const duplicatePrefixRoutes = model.routes.filter(
			(route) => route.destination === "198.51.100.0/24",
		);
		const configured = duplicatePrefixRoutes.find(
			(route) => route.evidence[0]?.source === "configured",
		);
		const observed = duplicatePrefixRoutes.find(
			(route) => route.evidence[0]?.source === "observed",
		);

		expect(duplicatePrefixRoutes).toHaveLength(2);
		expect(configured?.id).toBe("router:route:198.51.100.0/24:ip:203.0.113.1");
		expect(observed).toMatchObject({
			id: "router:route:observed:ipv4:198.51.100.0/24:203.0.113.1:TUNNEL[1]:static",
			family: "ipv4",
			rawType: "static",
			category: "static",
			evidence: [
				{
					source: "observed",
					at: "2026-09-23T12:00:00.000Z",
					summary: "show ip route",
				},
			],
		});
		expect(observed?.id).not.toBe(configured?.id);
		expect(model.devices[0]?.routeIds).toContain(observed?.id);

		const interfaceRoute = model.routes.find(
			(route) => route.destination === "192.168.100.0/24",
		);
		expect(interfaceRoute).toMatchObject({
			gateway: { kind: "interface", value: "LAN1" },
			interfaceId: "router:lan1",
		});
	});

	test("ProfileがなくてもObserved routeとpartial warningを返す", () => {
		const result = parseRouteTable(
			"Destination Gateway Interface Type\n" +
				"203.0.113.0/24 - LAN1 implicit\n" +
				"malformed route row\n",
			"ipv4",
		);
		const model = new TopologyBuilder().build(
			[
				{
					device: { id: "without-profile", name: "Without profile" },
					profile: null,
					observedRouteTables: [{ capturedAt: CAPTURED_AT, result }],
				},
			],
			{ generatedAt: CAPTURED_AT },
		);

		expect(model.routes).toHaveLength(1);
		expect(model.routes[0]?.evidence[0]?.source).toBe("observed");
		expect(model.devices[0]?.routeIds).toEqual([model.routes[0]?.id]);
		expect(model.warnings).toContainEqual({
			code: "partial_observed_routes",
			deviceId: "without-profile",
			factId: "without-profile:route-table:ipv4",
			message: "ipv4 observed route table contains unparsed rows",
		});
		expect(model.warnings).not.toContainEqual(
			expect.objectContaining({
				message: expect.stringContaining("malformed"),
			}),
		);
	});

	test("ProfileなしのDeviceもModelに残し、legacy tunnelsは参照しない", () => {
		const profile = parseConfig(HQ_CONFIG);
		profile.vpnTunnels = [];
		profile.tunnels = [{ id: 1, encapsulation: "ipsec" }];
		const model = new TopologyBuilder().build(
			[
				input("with-profile", "With profile", BRANCH_CONFIG),
				{
					device: { id: "without-profile", name: "Without profile" },
					profile: null,
				},
				{
					device: { id: "legacy-profile", name: "Legacy profile" },
					profile,
				},
			],
			{ generatedAt: CAPTURED_AT },
		);

		expect(model.devices.map((device) => device.id)).toEqual([
			"legacy-profile",
			"with-profile",
			"without-profile",
		]);
		expect(model.vpnTunnels).toEqual([]);
		expect(model.warnings).toContainEqual({
			code: "profile_missing",
			deviceId: "without-profile",
			message: "Device profile is not available",
		});
	});
});
