import { describe, expect, test } from "vitest";
import type {
	TopologyEvidence,
	TopologyLink,
	TopologyModel,
	TopologyNodeRef,
} from "../api.ts";
import { buildTopologyLayout } from "./Topology.tsx";

const siteNames = new Map([
	["hq", "本社"],
	["osaka", "大阪"],
	["nagoya", "名古屋"],
	["fukuoka", "福岡"],
	["sendai", "仙台"],
	["kyoto", "京都"],
	["sapporo", "札幌"],
	["okinawa", "沖縄"],
]);

function evidence(source: TopologyEvidence["source"]): TopologyEvidence {
	return { source, summary: "fixture" };
}

function device(
	id: string,
	withProfile = true,
	wan: TopologyModel["devices"][number]["wan"] = null,
): TopologyModel["devices"][number] {
	return {
		id,
		name: id.toUpperCase(),
		vendor: "yamaha",
		model: "RTX830",
		hostname: `${id}-router`,
		lifecycle: "active",
		interfaceIds: withProfile ? [`${id}:lan1`, `${id}:wan1`] : [],
		routeIds: [],
		vpnTunnelIds: [],
		wan,
		profile: withProfile
			? { capturedAt: "2026-09-22T00:00:00.000Z", configHash: `${id}-hash` }
			: null,
	};
}

function deviceRef(id: string): TopologyNodeRef {
	return { type: "device", id };
}

function vpnLink(
	id: string,
	source: TopologyNodeRef,
	target: TopologyNodeRef,
	status: "matched" | "unmatched" = "matched",
): TopologyLink {
	return {
		id,
		kind: "vpn",
		source,
		target,
		vpnTunnelId: `${id}:tunnel`,
		vpnTunnelIds: [`${id}:tunnel`],
		vpnDirection: "single",
		match: status === "matched" ? { status, confidence: "high" } : { status },
		evidence: [evidence(status === "matched" ? "inferred" : "configured")],
	};
}

function network(
	deviceId: string,
	kind: "lan" | "wan",
	cidr: string,
): TopologyModel["networks"][number] {
	const interfaceName = kind === "lan" ? "lan1" : "wan1";
	const interfaceId = `${deviceId}:${interfaceName}`;
	return {
		id: `${deviceId}:${kind}`,
		deviceId,
		family: "ipv4",
		cidr,
		kind,
		interfaceIds: [interfaceId],
		evidence: [evidence("configured")],
	};
}

function topologyModel(
	devices: TopologyModel["devices"],
	links: TopologyLink[],
): TopologyModel {
	const interfaces = devices.flatMap((item) =>
		item.profile
			? [
					{
						id: `${item.id}:lan1`,
						deviceId: item.id,
						name: "lan1",
						role: "lan" as const,
						addresses: [],
						networkIds: [`${item.id}:lan`],
						evidence: [evidence("configured")],
					},
					{
						id: `${item.id}:wan1`,
						deviceId: item.id,
						name: "wan1",
						role: "wan" as const,
						addresses: [],
						networkIds: [`${item.id}:wan`],
						evidence: [evidence("configured")],
					},
				]
			: [],
	);
	return {
		schemaVersion: 1,
		generatedAt: "2026-09-22T00:00:00.000Z",
		devices,
		interfaces,
		networks: devices.flatMap((item) =>
			item.profile
				? [
						network(
							item.id,
							"lan",
							item.id === "hq" ? "192.0.2.0/24" : "198.51.100.0/24",
						),
						network(item.id, "wan", "203.0.113.0/24"),
					]
				: [],
		),
		routes: [],
		vpnTunnels: [],
		neighbors: [],
		links: [
			...links,
			{
				id: "network-attachment",
				kind: "network-attachment",
				source: deviceRef("hq"),
				target: { type: "network", id: "hq:lan" },
				evidence: [evidence("configured")],
			},
			{
				id: "wan-connection",
				kind: "wan",
				source: deviceRef("hq"),
				target: { type: "external", id: "internet", label: "Internet" },
				evidence: [evidence("configured")],
			},
		],
		warnings: [],
	};
}

function rectanglesOverlap(
	left: { x: number; y: number; width: number; height: number },
	right: { x: number; y: number; width: number; height: number },
): boolean {
	return (
		left.x < right.x + right.width &&
		left.x + left.width > right.x &&
		left.y < right.y + right.height &&
		left.y + left.height > right.y
	);
}

describe("Topology graph layout", () => {
	test("VPNだけを描き、hub・peer・CONFIGなしを決定論的に配置する", () => {
		const external = {
			type: "external" as const,
			id: "vpn-mobile.example.test",
			label: "vpn-mobile.example.test",
		};
		const model = topologyModel(
			[
				device("hq"),
				device("osaka"),
				device("nagoya"),
				device("fukuoka", false),
			],
			[
				vpnLink("vpn-1", deviceRef("hq"), deviceRef("osaka")),
				vpnLink("vpn-2", deviceRef("hq"), deviceRef("nagoya")),
				vpnLink("vpn-3", deviceRef("osaka"), deviceRef("nagoya")),
				vpnLink("vpn-4", deviceRef("hq"), external, "unmatched"),
			],
		);

		const layout = buildTopologyLayout(model, siteNames);
		const hub = layout.nodes.find((node) => node.key === "device:hq");
		const fukuoka = layout.nodes.find((node) => node.key === "device:fukuoka");
		const peerY = layout.nodes
			.filter((node) => ["device:osaka", "device:nagoya"].includes(node.key))
			.map((node) => node.y);

		expect(layout.nodes.filter((node) => node.type === "network")).toHaveLength(
			0,
		);
		expect(layout.links).toHaveLength(4);
		expect(layout.links.every((link) => link.link.kind === "vpn")).toBe(true);
		expect(
			layout.links.find((link) => link.link.id === "vpn-4")?.badgeLabel,
		).toBe("相手不明");
		expect(layout.links.find((link) => link.link.id === "vpn-1")).toMatchObject(
			{ badgeLabel: "推定・片側のみ", direction: "single" },
		);
		expect(hub?.y).toBeLessThan(Math.min(...peerY));
		expect(fukuoka?.missingProfile).toBe(true);
		expect(fukuoka?.y).toBeGreaterThan(Math.max(...peerY));
		for (const [index, left] of layout.nodes.entries()) {
			for (const right of layout.nodes.slice(index + 1)) {
				expect(rectanglesOverlap(left, right)).toBe(false);
			}
		}

		const reversed = buildTopologyLayout(
			topologyModel([...model.devices].reverse(), [...model.links].reverse()),
			siteNames,
		);
		expect(reversed).toEqual(layout);
	});

	test("Deviceが8台でも行内のnodeが重ならず横幅を拡張する", () => {
		const devices = [
			device("hq"),
			device("osaka"),
			device("nagoya"),
			device("fukuoka", false),
			device("sendai"),
			device("kyoto"),
			device("sapporo"),
			device("okinawa"),
		];
		const links = devices
			.slice(1, 7)
			.map((item, index) =>
				vpnLink(`vpn-${index}`, deviceRef("hq"), deviceRef(item.id)),
			);
		const layout = buildTopologyLayout(
			topologyModel(devices, links),
			siteNames,
		);

		expect(layout.nodes.filter((node) => node.type === "device")).toHaveLength(
			8,
		);
		expect(layout.width).toBeGreaterThan(800);
		for (const [index, left] of layout.nodes.entries()) {
			for (const right of layout.nodes.slice(index + 1)) {
				expect(rectanglesOverlap(left, right)).toBe(false);
			}
		}
	});

	test("PPPoE・IPoE・静的WANの方式をDeviceカードへ出す", () => {
		const model = topologyModel(
			[
				device("pppoe", true, {
					ipv4: { method: "pppoe", interface: "lan2", pp: 1, evidence: [] },
				}),
				device("ipoe", true, {
					ipv4: { method: "dhcp", interface: "wan1", evidence: [] },
					ipv4OverIpv6: { method: "ds-lite", tunnel: 1, evidence: [] },
				}),
				device("static", true, {
					ipv4: { method: "static", interface: "wan1", evidence: [] },
				}),
			],
			[],
		);
		const layout = buildTopologyLayout(model, siteNames);

		expect(
			layout.nodes.find((node) => node.key === "device:pppoe")?.detailLines,
		).toContain("WAN PPPoE");
		expect(
			layout.nodes.find((node) => node.key === "device:ipoe")?.detailLines,
		).toEqual(expect.arrayContaining(["WAN DHCP", "WAN IPoE (DS-Lite)"]));
		expect(
			layout.nodes.find((node) => node.key === "device:static")?.detailLines,
		).toContain("WAN 203.0.113.0/24 (静的)");
	});

	test("リモートアクセス受けをDeviceカードに表示し、VPN線は作らない", () => {
		const model = topologyModel([device("hq")], []);
		model.vpnTunnels = [
			{
				id: "hq:tunnel:1",
				deviceId: "hq",
				tunnelNumber: 1,
				type: "l2tp-ipsec",
				remoteAccess: true,
				localEndpoint: { kind: "ipv4", value: "203.0.113.10" },
				localNetworkIds: [],
				remoteNetworkIds: [],
				evidence: [evidence("configured")],
			},
		];

		const layout = buildTopologyLayout(model, siteNames);
		const node = layout.nodes.find((item) => item.key === "device:hq");

		expect(node?.detailLines).toContain(
			"リモートアクセス受け: 有効 (L2TP/IPsec)",
		);
		expect(node?.ariaLabel).toContain("L2TP/IPsec");
		expect(layout.links).toEqual([]);
	});
});
