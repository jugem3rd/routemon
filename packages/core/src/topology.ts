import type {
	DeviceProfile,
	ProfileAddress,
	ProfileEndpoint,
	ProfileInterface,
	ProfileNetwork,
	ProfileRoute,
	ProfileTunnel,
	ProfileVpnTunnelType,
} from "./configProfile.ts";
import type {
	ObservedRouteCategory,
	RouteTableParseResult,
} from "./routeTable.ts";

export type FactSource = "configured" | "observed" | "inferred";

export type Evidence = {
	source: FactSource;
	at?: string;
	configHash?: string;
	rule?: string;
	inputs?: string[];
	summary?: string;
};

export type TopologyDeviceMetadata = {
	id: string;
	name: string;
	vendor?: string | null;
	model?: string | null;
	hostname?: string | null;
	lifecycle?: string | null;
};

export type TopologyWanSummary = {
	ipv4?: {
		method: "pppoe" | "dhcp" | "static";
		interface?: string;
		pp?: number;
		evidence: Evidence[];
	};
	ipv6?: {
		method: "dhcpv6-pd" | "dhcpv6" | "ra" | "static";
		interface?: string;
		evidence: Evidence[];
	};
	ipv4OverIpv6?: {
		method: "map-e" | "ds-lite";
		tunnel?: number;
		evidence: Evidence[];
	};
};

export type TopologyProfileMetadata = {
	capturedAt: string;
	configHash: string;
};

export type TopologyDeviceInput = {
	device: TopologyDeviceMetadata;
	profile?: DeviceProfile | null;
	profileMetadata?: TopologyProfileMetadata | null;
	observedRouteTables?: readonly TopologyObservedRouteSnapshot[];
};

export type TopologyObservedRouteSnapshot = {
	capturedAt: string;
	result: RouteTableParseResult;
};

export type TopologyBuildOptions = {
	generatedAt?: string;
};

export type TopologyDevice = {
	id: string;
	name: string;
	vendor: string;
	model: string | null;
	hostname: string | null;
	lifecycle: string;
	interfaceIds: string[];
	routeIds: string[];
	vpnTunnelIds: string[];
	/** ParserがCONFIGから抽出したWAN方式。addressとは別に動的方式も表現する。 */
	wan: TopologyWanSummary | null;
	profile: TopologyProfileMetadata | null;
};

export type TopologyAddress = {
	family: "ipv4" | "ipv6";
	address?: string;
	assignment: "static" | "dhcp" | "pppoe" | "unknown";
	evidence: Evidence[];
};

export type TopologyInterface = {
	id: string;
	deviceId: string;
	name: string;
	role: "lan" | "wan" | "tunnel" | "unknown";
	addresses: TopologyAddress[];
	networkIds: string[];
	evidence: Evidence[];
};

export type TopologyNetwork = {
	id: string;
	deviceId: string;
	family: "ipv4" | "ipv6";
	cidr: string;
	kind: "lan" | "wan" | "tunnel" | "unknown";
	interfaceIds: string[];
	evidence: Evidence[];
};

export type TopologyRoute = {
	id: string;
	deviceId: string;
	destination: string;
	gateway: {
		kind: "ip" | "dhcp" | "pp" | "tunnel" | "interface" | "unknown";
		value: string;
	};
	interfaceId?: string;
	family?: "ipv4" | "ipv6";
	rawType?: string;
	category?: ObservedRouteCategory;
	protocol?: string;
	metric?: number;
	cost?: number;
	evidence: Evidence[];
};

export type TopologyEndpoint = {
	kind: "ipv4" | "ipv6" | "fqdn" | "dynamic" | "unknown";
	value: string;
};

export type TopologyVpnTunnel = {
	id: string;
	deviceId: string;
	tunnelNumber: number;
	type: ProfileVpnTunnelType;
	remoteAccess?: true;
	interfaceId?: string;
	localEndpoint?: TopologyEndpoint;
	remoteEndpoint?: TopologyEndpoint;
	localNetworkIds: string[];
	remoteNetworkIds: string[];
	evidence: Evidence[];
};

export type TopologyNodeRef = {
	type: "device" | "network" | "external";
	id: string;
	label?: string;
};

export type TopologyLinkMatch = {
	status: "matched" | "unmatched" | "ambiguous";
	confidence?: "high" | "medium" | "low";
	candidateDeviceIds?: string[];
};

export type TopologyLink = {
	id: string;
	kind: "network-attachment" | "wan" | "vpn";
	source: TopologyNodeRef;
	target: TopologyNodeRef;
	interfaceId?: string;
	vpnTunnelId?: string;
	/** 双方向の設定を1本へ集約したlinkが参照する全tunnelのstable id。 */
	vpnTunnelIds?: string[];
	/** matchedな相手がいても片端のCONFIGだけならsingleとして向きを表示する。 */
	vpnDirection?: "single" | "bidirectional";
	match?: TopologyLinkMatch;
	evidence: Evidence[];
};

export type TopologyNeighbor = {
	id: string;
	sourceDeviceId: string;
	targetDeviceId?: string;
	targetAddress?: string;
	protocol: "lldp" | "arp" | "route" | "unknown";
	evidence: Evidence[];
};

export type TopologyWarning = {
	code:
		| "profile_missing"
		| "partial_profile"
		| "partial_observed_routes"
		| "unsupported_feature"
		| "ambiguous_vpn_peer";
	deviceId?: string;
	factId?: string;
	candidateDeviceIds?: string[];
	message: string;
};

export type TopologyModel = {
	schemaVersion: 1;
	generatedAt: string;
	devices: TopologyDevice[];
	interfaces: TopologyInterface[];
	networks: TopologyNetwork[];
	routes: TopologyRoute[];
	vpnTunnels: TopologyVpnTunnel[];
	neighbors: TopologyNeighbor[];
	links: TopologyLink[];
	warnings: TopologyWarning[];
};

export type PeerMatchResult = {
	links: TopologyLink[];
	warnings: TopologyWarning[];
};

type CanonicalProfile = {
	interfaces: ProfileInterface[];
	networks: ProfileNetwork[];
	routes: ProfileRoute[];
	vpnTunnels: ProfileTunnel[];
	complete: boolean;
};

type WanAddressCandidate = {
	deviceId: string;
	factId: string;
};

/**
 * Profile factsから、API/UIへ渡す一時的なTopology Modelを組み立てる。
 * 入力は呼び出し側で同一Tenantに絞る。Tenant authorizationはAPI層の責務とする。
 */
export class TopologyBuilder {
	build(
		inputs: readonly TopologyDeviceInput[],
		options: TopologyBuildOptions = {},
	): TopologyModel {
		const devices: TopologyDevice[] = [];
		const interfaces: TopologyInterface[] = [];
		const networks: TopologyNetwork[] = [];
		const routes: TopologyRoute[] = [];
		const vpnTunnels: TopologyVpnTunnel[] = [];
		const links: TopologyLink[] = [];
		const warnings: TopologyWarning[] = [];

		const sortedInputs = [...inputs].sort((left, right) =>
			left.device.id.localeCompare(right.device.id),
		);

		for (const input of sortedInputs) {
			const deviceId = input.device.id;
			const profile = input.profile ?? null;
			const canonical = profile ? readCanonicalProfile(profile) : undefined;
			const device: TopologyDevice = {
				id: deviceId,
				name: input.device.name,
				vendor: input.device.vendor ?? "yamaha",
				model: input.device.model ?? profile?.model ?? null,
				hostname: input.device.hostname ?? null,
				lifecycle: input.device.lifecycle ?? "unknown",
				interfaceIds: [],
				routeIds: [],
				vpnTunnelIds: [],
				wan: profile ? buildWanSummary(profile, input.profileMetadata) : null,
				profile: profile ? (input.profileMetadata ?? null) : null,
			};
			devices.push(device);

			if (!profile) {
				device.routeIds = appendObservedRoutes(
					deviceId,
					input.observedRouteTables ?? [],
					new Map<string, string>(),
					routes,
					warnings,
				);
				warnings.push({
					code: "profile_missing",
					deviceId,
					message: "Device profile is not available",
				});
				continue;
			}
			if (!canonical?.complete) {
				warnings.push({
					code: "partial_profile",
					deviceId,
					message: "Device profile does not contain all canonical facts",
				});
			}
			if (!canonical) continue;

			const evidence = (summary: string): Evidence[] => [
				configuredEvidence(input.profileMetadata, summary),
			];
			const interfaceIds = new Map<string, string>();
			const networkIdsByInterface = new Map<string, string[]>();
			const topologyNetworks = new Map<string, TopologyNetwork>();

			for (const network of canonical.networks) {
				const networkId = networkFactId(deviceId, network);
				const interfaceId = interfaceFactId(deviceId, network.interface);
				const topologyNetwork: TopologyNetwork = {
					id: networkId,
					deviceId,
					family: network.family,
					cidr: network.cidr,
					kind: network.kind,
					interfaceIds: [interfaceId],
					evidence: evidence("configured network fact"),
				};
				topologyNetworks.set(networkId, topologyNetwork);
				networks.push(topologyNetwork);
				const networkIds = networkIdsByInterface.get(network.interface) ?? [];
				networkIds.push(networkId);
				networkIdsByInterface.set(network.interface, networkIds);
			}

			for (const interfaceFact of canonical.interfaces) {
				const interfaceId = interfaceFactId(deviceId, interfaceFact.name);
				interfaceIds.set(interfaceFact.name, interfaceId);
				const topologyInterface = toTopologyInterface(
					deviceId,
					interfaceFact,
					networkIdsByInterface.get(interfaceFact.name) ?? [],
					evidence,
				);
				interfaces.push(topologyInterface);
				if (interfaceFact.role === "wan") {
					links.push({
						id: `${deviceId}:wan:${interfaceFact.name}`,
						kind: "wan",
						source: { type: "device", id: deviceId },
						target: {
							type: "external",
							id: "external:internet",
							label: "Internet",
						},
						interfaceId,
						evidence: evidence("configured WAN interface"),
					});
				}
			}

			for (const topologyNetwork of topologyNetworks.values()) {
				for (const interfaceId of topologyNetwork.interfaceIds) {
					links.push({
						id: `${topologyNetwork.id}:attachment`,
						kind: "network-attachment",
						source: { type: "device", id: deviceId },
						target: { type: "network", id: topologyNetwork.id },
						interfaceId,
						evidence: evidence("configured network attachment"),
					});
				}
			}

			for (const route of canonical.routes) {
				const routeId = routeFactId(deviceId, route);
				const interfaceId = routeInterfaceId(route, interfaceIds);
				const topologyRoute: TopologyRoute = {
					id: routeId,
					deviceId,
					destination: route.destination,
					gateway: { ...route.gateway },
					evidence: evidence("configured route fact"),
				};
				if (interfaceId) topologyRoute.interfaceId = interfaceId;
				routes.push(topologyRoute);
			}
			const observedRouteIds = appendObservedRoutes(
				deviceId,
				input.observedRouteTables ?? [],
				interfaceIds,
				routes,
				warnings,
			);

			const remoteNetworkIdsByTunnel = new Map<number, string[]>();
			for (const route of canonical.routes) {
				if (route.tunnel === undefined || route.destination === "default") {
					continue;
				}
				const networkId = remoteNetworkFactId(deviceId, route.destination);
				if (!networks.some((network) => network.id === networkId)) {
					const remoteNetwork: TopologyNetwork = {
						id: networkId,
						deviceId,
						family: route.destination.includes(":") ? "ipv6" : "ipv4",
						cidr: route.destination,
						kind: "unknown",
						interfaceIds: [],
						evidence: evidence("configured VPN remote network route"),
					};
					networks.push(remoteNetwork);
				}
				const networkIds = remoteNetworkIdsByTunnel.get(route.tunnel) ?? [];
				if (!networkIds.includes(networkId)) networkIds.push(networkId);
				remoteNetworkIdsByTunnel.set(route.tunnel, networkIds);
			}

			for (const tunnel of canonical.vpnTunnels) {
				const tunnelId = tunnelFactId(deviceId, tunnel.id);
				const tunnelInterfaceId = interfaceIds.get(`tunnel${tunnel.id}`);
				const localNetworkIds = canonical.networks
					.filter((network) => network.kind === "lan")
					.map((network) => networkFactId(deviceId, network));
				const topologyTunnel: TopologyVpnTunnel = {
					id: tunnelId,
					deviceId,
					tunnelNumber: tunnel.id,
					type: topologyVpnTunnelType(tunnel),
					localNetworkIds: uniqueSorted(localNetworkIds),
					remoteNetworkIds: uniqueSorted(
						remoteNetworkIdsByTunnel.get(tunnel.id) ?? [],
					),
					evidence: evidence("configured VPN tunnel"),
				};
				if (tunnelInterfaceId) topologyTunnel.interfaceId = tunnelInterfaceId;
				if (tunnel.localEndpoint) {
					topologyTunnel.localEndpoint = toTopologyEndpoint(
						tunnel.localEndpoint,
					);
				}
				if (tunnel.remoteEndpoint) {
					topologyTunnel.remoteEndpoint = toTopologyEndpoint(
						tunnel.remoteEndpoint,
					);
				}
				if (
					tunnel.remoteAccess ||
					(topologyTunnel.type === "l2tp-ipsec" &&
						tunnel.remoteEndpoint?.kind === "dynamic" &&
						tunnel.remoteEndpoint.value.toLowerCase() === "any")
				) {
					topologyTunnel.remoteAccess = true;
				}
				vpnTunnels.push(topologyTunnel);
				device.vpnTunnelIds.push(tunnelId);
			}

			device.interfaceIds = [...interfaceIds.values()].sort();
			device.routeIds = [
				...canonical.routes.map((route) => routeFactId(deviceId, route)),
				...observedRouteIds,
			].sort();
			device.vpnTunnelIds.sort();
		}

		const peerMatches = matchTopologyPeers(vpnTunnels, interfaces);
		links.push(...peerMatches.links);
		warnings.push(...peerMatches.warnings);

		return {
			schemaVersion: 1,
			generatedAt: options.generatedAt ?? new Date().toISOString(),
			devices: devices.sort((left, right) => left.id.localeCompare(right.id)),
			interfaces: interfaces.sort((left, right) =>
				left.id.localeCompare(right.id),
			),
			networks: networks.sort((left, right) => left.id.localeCompare(right.id)),
			routes: routes.sort((left, right) => left.id.localeCompare(right.id)),
			vpnTunnels: vpnTunnels.sort((left, right) =>
				left.id.localeCompare(right.id),
			),
			neighbors: [],
			links: links.sort((left, right) => left.id.localeCompare(right.id)),
			warnings: warnings.sort((left, right) =>
				warningSortKey(left).localeCompare(warningSortKey(right)),
			),
		};
	}
}

function appendObservedRoutes(
	deviceId: string,
	snapshots: readonly TopologyObservedRouteSnapshot[],
	interfaceIds: Map<string, string>,
	routes: TopologyRoute[],
	warnings: TopologyWarning[],
): string[] {
	const routeIds: string[] = [];
	const sortedSnapshots = [...snapshots].sort((left, right) =>
		left.result.family.localeCompare(right.result.family),
	);
	for (const snapshot of sortedSnapshots) {
		const { result } = snapshot;
		if (result.status === "unrecognized_output") continue;
		if (result.status === "partial" || result.unparsedLines.length > 0) {
			warnings.push({
				code: "partial_observed_routes",
				deviceId,
				factId: `${deviceId}:route-table:${result.family}`,
				message: `${result.family} observed route table contains unparsed rows`,
			});
		}

		for (const route of result.routes) {
			const routeId = observedRouteFactId(deviceId, route);
			const topologyRoute: TopologyRoute = {
				id: routeId,
				deviceId,
				destination: route.destination,
				gateway:
					route.gateway !== null
						? { kind: "ip", value: route.gateway }
						: route.interface !== null
							? { kind: "interface", value: route.interface }
							: { kind: "unknown", value: "-" },
				family: route.family,
				rawType: route.rawType,
				category: route.category,
				evidence: [
					{
						source: "observed",
						at: snapshot.capturedAt,
						summary:
							result.family === "ipv4" ? "show ip route" : "show ipv6 route",
					},
				],
			};
			if (route.interface !== null) {
				const interfaceId = observedInterfaceId(route.interface, interfaceIds);
				if (interfaceId) topologyRoute.interfaceId = interfaceId;
			}
			if (route.protocol !== undefined) topologyRoute.protocol = route.protocol;
			if (route.metric !== undefined) topologyRoute.metric = route.metric;
			if (route.cost !== undefined) topologyRoute.cost = route.cost;
			routes.push(topologyRoute);
			routeIds.push(routeId);
		}
	}
	return routeIds.sort();
}

function observedRouteFactId(
	deviceId: string,
	route: {
		family: string;
		destination: string;
		gateway: string | null;
		interface: string | null;
		rawType: string;
	},
): string {
	return `${deviceId}:route:observed:${route.family}:${route.destination}:${route.gateway ?? "-"}:${route.interface ?? "-"}:${route.rawType}`;
}

function observedInterfaceId(
	name: string,
	interfaceIds: Map<string, string>,
): string | undefined {
	const exact = interfaceIds.get(name) ?? interfaceIds.get(name.toLowerCase());
	if (exact) return exact;
	const pp = /^pp\[(\d+)\]$/i.exec(name);
	if (pp?.[1]) return interfaceIds.get(`pp${Number(pp[1])}`);
	const tunnel = /^tunnel\[(\d+)\]$/i.exec(name);
	if (tunnel?.[1]) return interfaceIds.get(`tunnel${Number(tunnel[1])}`);
	return undefined;
}

/** Static WAN addressとVPN remote endpointの一意な完全一致だけを推定する。 */
export function matchTopologyPeers(
	vpnTunnels: readonly TopologyVpnTunnel[],
	interfaces: readonly TopologyInterface[],
): PeerMatchResult {
	const candidatesByAddress = new Map<string, WanAddressCandidate[]>();
	for (const interfaceFact of interfaces) {
		if (interfaceFact.role !== "wan") continue;
		for (const address of interfaceFact.addresses) {
			if (
				address.family !== "ipv4" ||
				address.assignment !== "static" ||
				address.address === undefined
			) {
				continue;
			}
			const normalized = normalizeIpv4(address.address);
			if (!normalized) continue;
			const factId = `${interfaceFact.deviceId}:wan:${interfaceFact.name}:address:${normalized}`;
			const candidates = candidatesByAddress.get(normalized) ?? [];
			candidates.push({ deviceId: interfaceFact.deviceId, factId });
			candidatesByAddress.set(normalized, candidates);
		}
	}

	const links: TopologyLink[] = [];
	const warnings: TopologyWarning[] = [];
	for (const tunnel of [...vpnTunnels].sort((left, right) =>
		left.id.localeCompare(right.id),
	)) {
		if (tunnel.remoteAccess) continue;
		const remote = tunnel.remoteEndpoint;
		const normalizedRemote =
			remote?.kind === "ipv4" ? normalizeIpv4(remote.value) : undefined;
		const candidates = normalizedRemote
			? (candidatesByAddress.get(normalizedRemote) ?? [])
					.filter((candidate) => candidate.deviceId !== tunnel.deviceId)
					.sort((left, right) => left.factId.localeCompare(right.factId))
			: [];
		const candidateDeviceIds = uniqueSorted(
			candidates.map((candidate) => candidate.deviceId),
		);
		const external = externalPeerRef(tunnel);
		const link: TopologyLink = {
			id: `${tunnel.deviceId}:vpn:${tunnel.tunnelNumber}`,
			kind: "vpn",
			source: { type: "device", id: tunnel.deviceId },
			target:
				candidateDeviceIds.length === 1
					? { type: "device", id: candidateDeviceIds[0] ?? "" }
					: external,
			vpnTunnelId: tunnel.id,
			vpnTunnelIds: [tunnel.id],
			vpnDirection: "single",
			evidence: [],
		};

		if (candidateDeviceIds.length === 1) {
			link.match = { status: "matched", confidence: "high" };
			link.evidence = [
				{
					source: "inferred",
					rule: "vpn-remote-address-equals-wan-address",
					inputs: [
						tunnel.id,
						...candidates
							.filter(
								(candidate) => candidate.deviceId === candidateDeviceIds[0],
							)
							.map((candidate) => candidate.factId),
					],
					summary: "VPN remote endpoint matches exactly one Device WAN address",
				},
			];
		} else if (candidateDeviceIds.length > 1) {
			link.match = {
				status: "ambiguous",
				candidateDeviceIds,
			};
			link.evidence = [
				configuredTunnelEvidence(
					tunnel,
					"configured VPN tunnel has multiple WAN peer candidates",
				),
			];
			warnings.push({
				code: "ambiguous_vpn_peer",
				deviceId: tunnel.deviceId,
				factId: tunnel.id,
				candidateDeviceIds,
				message: "VPN remote endpoint matches multiple Device WAN addresses",
			});
		} else {
			link.match = { status: "unmatched" };
			link.evidence = [
				configuredTunnelEvidence(
					tunnel,
					"configured VPN tunnel has no unique WAN peer match",
				),
			];
		}
		links.push(link);
	}

	return { links: aggregateBidirectionalVpnLinks(links), warnings };
}

/**
 * 互いのCONFIGが同じDevice pairを指す場合だけ、graph上のlinkを1本へ集約する。
 * 各TopologyVpnTunnelは残し、linkから複数のstable idを参照できるようにする。
 */
function aggregateBidirectionalVpnLinks(
	links: readonly TopologyLink[],
): TopologyLink[] {
	const grouped = new Map<string, TopologyLink[]>();
	const passthrough: TopologyLink[] = [];
	for (const link of links) {
		if (
			link.source.type !== "device" ||
			link.target.type !== "device" ||
			link.match?.status !== "matched"
		) {
			passthrough.push(link);
			continue;
		}
		const pair = [link.source.id, link.target.id].sort().join("|");
		const current = grouped.get(pair) ?? [];
		current.push(link);
		grouped.set(pair, current);
	}

	const result = [...passthrough];
	for (const group of grouped.values()) {
		const directions = new Set(
			group.map((link) => `${link.source.id}->${link.target.id}`),
		);
		if (directions.size < 2) {
			result.push(...group);
			continue;
		}

		const sorted = [...group].sort((left, right) =>
			left.id.localeCompare(right.id),
		);
		const first = sorted[0];
		if (!first) continue;
		const deviceIds = [first.source.id, first.target.id].sort();
		const sourceId = deviceIds[0] ?? first.source.id;
		const targetId = deviceIds[1] ?? first.target.id;
		const tunnelIds = uniqueSorted(
			group.flatMap((link) => link.vpnTunnelIds ?? []),
		);
		const aggregated: TopologyLink = {
			...first,
			id: `${sourceId}:vpn:${targetId}`,
			source: { type: "device", id: sourceId },
			target: { type: "device", id: targetId },
			vpnTunnelIds: tunnelIds,
			vpnDirection: "bidirectional",
			match: { status: "matched", confidence: "high" },
			evidence: group.flatMap((link) => link.evidence),
		};
		delete aggregated.vpnTunnelId;
		result.push(aggregated);
	}

	return result.sort((left, right) => left.id.localeCompare(right.id));
}

function readCanonicalProfile(profile: DeviceProfile): CanonicalProfile {
	const interfaces = Array.isArray(profile.interfaces)
		? profile.interfaces
		: [];
	const networks = Array.isArray(profile.networks) ? profile.networks : [];
	const routes = Array.isArray(profile.routes) ? profile.routes : [];
	const hasVpnTunnels = Array.isArray(profile.vpnTunnels);
	const vpnTunnels = hasVpnTunnels
		? profile.vpnTunnels
		: Array.isArray(profile.ipsecTunnels)
			? profile.ipsecTunnels
			: [];
	return {
		interfaces,
		networks,
		routes,
		vpnTunnels,
		complete:
			profile.parserVersion === 1 &&
			Array.isArray(profile.interfaces) &&
			Array.isArray(profile.networks) &&
			Array.isArray(profile.routes) &&
			(hasVpnTunnels || Array.isArray(profile.ipsecTunnels)),
	};
}

function topologyVpnTunnelType(tunnel: ProfileTunnel): ProfileVpnTunnelType {
	if (tunnel.type) return tunnel.type;
	if (tunnel.encapsulation === "ipsec") return "ipsec";
	if (tunnel.encapsulation === "l2tp" && tunnel.ipsecTunnelIds?.length) {
		return "l2tp-ipsec";
	}
	if (
		tunnel.encapsulation === "l2tpv3" ||
		tunnel.encapsulation === "l2tpv3-raw"
	) {
		return "l2tpv3";
	}
	if (tunnel.encapsulation === "gre") return "gre";
	if (tunnel.encapsulation === "ipip") return "ipip";
	return "unknown";
}

function buildWanSummary(
	profile: DeviceProfile,
	metadata: TopologyProfileMetadata | null | undefined,
): TopologyWanSummary | null {
	const summary: TopologyWanSummary = {};
	const internet = profile.internet;
	if (internet?.ipv4) {
		summary.ipv4 = {
			...internet.ipv4,
			evidence: [configuredEvidence(metadata, "configured IPv4 WAN method")],
		};
	}
	if (internet?.ipv6) {
		summary.ipv6 = {
			...internet.ipv6,
			evidence: [configuredEvidence(metadata, "configured IPv6 WAN method")],
		};
	}
	if (internet?.ipv4_over_ipv6) {
		summary.ipv4OverIpv6 = {
			...internet.ipv4_over_ipv6,
			evidence: [
				configuredEvidence(metadata, "configured IPv4-over-IPv6 method"),
			],
		};
	}
	return Object.keys(summary).length > 0 ? summary : null;
}

function configuredEvidence(
	metadata: TopologyProfileMetadata | null | undefined,
	summary: string,
): Evidence {
	const evidence: Evidence = { source: "configured", summary };
	if (metadata?.capturedAt) evidence.at = metadata.capturedAt;
	if (metadata?.configHash) evidence.configHash = metadata.configHash;
	return evidence;
}

function configuredTunnelEvidence(
	tunnel: TopologyVpnTunnel,
	summary: string,
): Evidence {
	const configured = tunnel.evidence.find(
		(evidence) => evidence.source === "configured",
	);
	return {
		source: "configured",
		...(configured?.at ? { at: configured.at } : {}),
		...(configured?.configHash ? { configHash: configured.configHash } : {}),
		summary,
	};
}

function toTopologyInterface(
	deviceId: string,
	interfaceFact: ProfileInterface,
	networkIds: string[],
	evidence: (summary: string) => Evidence[],
): TopologyInterface {
	return {
		id: interfaceFactId(deviceId, interfaceFact.name),
		deviceId,
		name: interfaceFact.name,
		role: interfaceFact.role,
		addresses: interfaceFact.addresses.map((address) =>
			toTopologyAddress(address, evidence("configured interface address")),
		),
		networkIds: uniqueSorted(networkIds),
		evidence: evidence("configured interface fact"),
	};
}

function toTopologyAddress(
	address: ProfileAddress,
	evidence: Evidence[],
): TopologyAddress {
	return {
		family: address.family,
		...(address.address !== undefined ? { address: address.address } : {}),
		assignment: address.assignment,
		evidence,
	};
}

function toTopologyEndpoint(endpoint: ProfileEndpoint): TopologyEndpoint {
	return { kind: endpoint.kind, value: endpoint.value };
}

function routeInterfaceId(
	route: ProfileRoute,
	interfaceIds: Map<string, string>,
): string | undefined {
	if (route.interface) return interfaceIds.get(route.interface);
	const pp = /^pp (\d+)$/.exec(route.gateway.value);
	if (route.gateway.kind === "pp" && pp) {
		return interfaceIds.get(`pp${pp[1]}`);
	}
	if (route.tunnel !== undefined) {
		return interfaceIds.get(`tunnel${route.tunnel}`);
	}
	return undefined;
}

function externalPeerRef(tunnel: TopologyVpnTunnel): TopologyNodeRef {
	const endpoint = tunnel.remoteEndpoint;
	const kind = tunnel.type === "ipsec" ? "ipsec" : "vpn";
	if (!endpoint) {
		return {
			type: "external",
			id: `external:${kind}:${tunnel.deviceId}:tunnel:${tunnel.tunnelNumber}`,
			label: "Unknown peer",
		};
	}
	return {
		type: "external",
		id: `external:${kind}:${endpoint.kind}:${endpoint.value}`,
		label: endpoint.value,
	};
}

function interfaceFactId(deviceId: string, name: string): string {
	return `${deviceId}:${name}`;
}

function networkFactId(deviceId: string, network: ProfileNetwork): string {
	return `${deviceId}:network:${network.interface}:${network.cidr}`;
}

function remoteNetworkFactId(deviceId: string, destination: string): string {
	return `${deviceId}:network:remote:${destination}`;
}

function routeFactId(deviceId: string, route: ProfileRoute): string {
	return `${deviceId}:route:${route.destination}:${route.gateway.kind}:${route.gateway.value}`;
}

function tunnelFactId(deviceId: string, tunnelNumber: number): string {
	return `${deviceId}:tunnel:${tunnelNumber}`;
}

function normalizeIpv4(value: string): string | undefined {
	const address = value.split("/")[0] ?? "";
	const parts = address.split(".");
	if (parts.length !== 4) return undefined;
	const octets = parts.map((part) => Number(part));
	if (
		octets.some(
			(octet, index) =>
				!/^\d+$/.test(parts[index] ?? "") || octet < 0 || octet > 255,
		)
	) {
		return undefined;
	}
	return octets.join(".");
}

function uniqueSorted(values: string[]): string[] {
	return [...new Set(values)].sort();
}

function warningSortKey(warning: TopologyWarning): string {
	return `${warning.deviceId ?? ""}:${warning.factId ?? ""}:${warning.code}`;
}
