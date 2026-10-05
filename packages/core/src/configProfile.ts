/**
 * YAMAHA CONFIGからDevice Profileを作るParser(#6、docs/core/device-profile-discovery-design.md)。
 *
 * 完全なCONFIG interpreterではない。判定に必要なcommandだけを読み、知らないcommandは無視する。
 * Agent側にparserを置かないため、判定はすべてここで行う。
 *
 * Profileには構造だけを入れる。CONFIGにはsecret(`pp auth myname`のpassword、
 * `ipsec ike pre-shared-key`等)が含まれるため、値を取り込むcommandを増やすときは
 * secretを含まないことを確認する(docs/core/config-backup-design.md §7)。
 */

export type Ipv4Method = "pppoe" | "dhcp" | "static";
export type Ipv6Method = "dhcpv6-pd" | "dhcpv6" | "ra" | "static";
export type Ipv4OverIpv6Method = "map-e" | "ds-lite";

export type ProfileInterfaceRole = "lan" | "wan" | "tunnel" | "unknown";
export type ProfileAddressFamily = "ipv4" | "ipv6";
export type ProfileAddressAssignment = "static" | "dhcp" | "pppoe" | "unknown";

export type ProfileAddress = {
	family: ProfileAddressFamily;
	/** static addressはCIDR。DHCP / PPPoE等で未確定の場合は省略する。 */
	address?: string;
	assignment: ProfileAddressAssignment;
};

export type ProfileInterface = {
	/** `lan1`、`wan1`、`pp1`、`tunnel1`等のRouter上の名前。 */
	name: string;
	role: ProfileInterfaceRole;
	addresses: ProfileAddress[];
};

export type ProfileNetworkKind = "lan" | "wan" | "tunnel" | "unknown";

export type ProfileNetwork = {
	/** Device IDをまだ持たないParser内ではinterface名で関連付ける。 */
	interface: string;
	family: ProfileAddressFamily;
	cidr: string;
	kind: ProfileNetworkKind;
};

export type ProfileRouteGatewayKind =
	| "ip"
	| "dhcp"
	| "pp"
	| "tunnel"
	| "interface"
	| "unknown";

export type ProfileRoute = {
	destination: string;
	gateway: {
		kind: ProfileRouteGatewayKind;
		value: string;
	};
	interface?: string;
	tunnel?: number;
};

export type ProfileEndpointKind =
	| "ipv4"
	| "ipv6"
	| "fqdn"
	| "dynamic"
	| "unknown";

export type ProfileEndpoint = {
	kind: ProfileEndpointKind;
	value: string;
};

export type ProfileVpnTunnelType =
	| "ipsec"
	| "l2tp-ipsec"
	| "l2tpv3"
	| "gre"
	| "ipip"
	| "unknown";

export type ProfileTunnelSummary = {
	id: number;
	encapsulation: string;
};

export type ProfileTunnel = {
	id: number;
	encapsulation: string;
	/** Topologyで表示・分類するVPN方式。古い保存Profileでは未定義の場合がある。 */
	type?: ProfileVpnTunnelType;
	/** `ipsec tunnel`の番号。通常は1個だが、CONFIGの値を失わないよう配列にする。 */
	ipsecTunnelIds?: number[];
	localEndpoint?: ProfileEndpoint;
	remoteEndpoint?: ProfileEndpoint;
	/** 相手が`any`で指定されるL2TP/IPsecのリモートアクセス受け。 */
	remoteAccess?: boolean;
};

export type DeviceProfile = {
	internet: {
		ipv4?: { method: Ipv4Method; interface?: string; pp?: number };
		ipv6?: { method: Ipv6Method; interface?: string };
		ipv4_over_ipv6?: { method: Ipv4OverIpv6Method; tunnel?: number };
	};
	/** default routeの出口(`pp 1`、`tunnel 1`、`dhcp lan2`、IP address等) */
	defaultRoute?: string;
	/** 既存API互換のprojection。canonicalなinterfacesから生成する。 */
	lan: { interface: string; address: string }[];
	/** 既存API互換のprojection。既存のid / encapsulationだけを保持する。 */
	tunnels: ProfileTunnelSummary[];
	/** CONFIGから抽出したcanonical facts。 */
	interfaces: ProfileInterface[];
	networks: ProfileNetwork[];
	routes: ProfileRoute[];
	/** Topologyに表示するVPN tunnel facts。 */
	vpnTunnels: ProfileTunnel[];
	/** 古い保存Profileとの互換読み取り専用。新規Parserでは出力しない。 */
	ipsecTunnels?: ProfileTunnel[];
	parserVersion: 1;
	/** parse対象のCONFIGが由来する機種・firmware(判定の前提として保持する) */
	model?: string;
	firmwareRevision?: string;
};

export type ParseOptions = {
	model?: string;
	firmwareRevision?: string;
};

type MutableTunnel = {
	id: number;
	encapsulation?: string;
	ipsecTunnelIds?: number[];
	localEndpoint?: ProfileEndpoint;
	remoteEndpoint?: ProfileEndpoint;
	endpointLocal?: ProfileEndpoint;
	endpointRemote?: ProfileEndpoint;
};

type AddressInfo = {
	family: ProfileAddressFamily;
	network?: string;
};

type ParsedGateway = {
	gateway: ProfileRoute["gateway"];
	interface?: string;
	tunnel?: number;
};

/** Router出力はShift_JIS(docs/core/lua-api-notes.md)。コメントに日本語が入る。 */
export function decodeConfig(config: Uint8Array): string {
	return new TextDecoder("shift_jis").decode(config);
}

const LAN_ADDRESS = /^ip (lan\d+|wan\d+) address (\S+)/;
const IPV6_LAN = /^ipv6 (lan\d+|wan\d+) (\S+)(?: (\S+))?/;

export function parseConfig(
	config: Uint8Array | string,
	options: ParseOptions = {},
): DeviceProfile {
	const text = typeof config === "string" ? config : decodeConfig(config);
	const interfaceFacts = new Map<string, ProfileInterface>();
	const networkFacts = new Map<string, ProfileNetwork>();
	const routeFacts: ProfileRoute[] = [];
	const tunnelFacts = new Map<number, MutableTunnel>();
	const pppoeUses = new Map<number, string>();
	const dhcpInterfaces = new Set<string>();

	let ipv6Internet: DeviceProfile["internet"]["ipv6"];
	// `pp select` / `tunnel select`で以降の行の対象が変わる
	let pp: number | undefined;
	let tunnel: number | undefined;

	for (const raw of text.split(/\r?\n/)) {
		const line = raw.trim();
		if (!line || line.startsWith("#")) continue;

		const ppSelect = /^pp select (\d+)/.exec(line);
		if (ppSelect) {
			pp = Number(ppSelect[1]);
			tunnel = undefined;
			continue;
		}
		const tunnelSelect = /^tunnel select (\d+)/.exec(line);
		if (tunnelSelect) {
			tunnel = Number(tunnelSelect[1]);
			pp = undefined;
			continue;
		}

		const pppoe = /^pppoe use (\S+)/.exec(line);
		if (pppoe && pp !== undefined) {
			const physicalInterface = pppoe[1] ?? "";
			pppoeUses.set(pp, physicalInterface);
			ensureInterface(interfaceFacts, physicalInterface);
			ensureInterface(interfaceFacts, `pp${pp}`, "wan");
			continue;
		}

		const ppAddress = /^ip pp address (\S+)/.exec(line);
		if (ppAddress && pp !== undefined) {
			const value = ppAddress[1] ?? "";
			const ppInterface = ensureInterface(interfaceFacts, `pp${pp}`, "wan");
			if (value === "dhcp") {
				addAddress(ppInterface, {
					family: "ipv4",
					assignment: "dhcp",
				});
				dhcpInterfaces.add(ppInterface.name);
			} else {
				addStaticAddress(interfaceFacts, networkFacts, ppInterface.name, value);
			}
			continue;
		}

		// IPv4 WAN: PPPoE / DHCP client / static
		const lanAddress = LAN_ADDRESS.exec(line);
		if (lanAddress) {
			const iface = lanAddress[1] ?? "";
			const value = lanAddress[2] ?? "";
			const interfaceFact = ensureInterface(interfaceFacts, iface);
			if (value === "dhcp") {
				addAddress(interfaceFact, {
					family: "ipv4",
					assignment: "dhcp",
				});
				dhcpInterfaces.add(iface);
			} else {
				addStaticAddress(interfaceFacts, networkFacts, iface, value);
			}
			continue;
		}

		// IPv6 WAN / LAN
		const ipv6 = IPV6_LAN.exec(line);
		if (ipv6) {
			const iface = ipv6[1] ?? "";
			const keyword = ipv6[2] ?? "";
			const arg = ipv6[3];
			const interfaceFact = ensureInterface(interfaceFacts, iface);
			if (keyword === "dhcp" && arg === "service") {
				// `ipv6 lan2 dhcp service client`。PDかどうかはprefix定義で上書きする
				ipv6Internet ??= { method: "dhcpv6", interface: iface };
				addAddress(interfaceFact, {
					family: "ipv6",
					assignment: "dhcp",
				});
			} else if (
				keyword === "address" &&
				(arg === "ra-prefix" || arg?.startsWith("ra-prefix@"))
			) {
				ipv6Internet ??= { method: "ra", interface: iface };
			} else if (keyword === "address") {
				ipv6Internet ??= { method: "static", interface: iface };
				if (arg) {
					addStaticAddress(interfaceFacts, networkFacts, iface, arg);
				}
			}
			continue;
		}
		// `ipv6 prefix 1 ra-prefix@lan2::/64`があればDHCPv6-PDとみなす
		const pd = /^ipv6 prefix \d+ ra-prefix@(lan\d+|wan\d+)/.exec(line);
		if (pd) {
			ipv6Internet = { method: "dhcpv6-pd", interface: pd[1] };
			continue;
		}

		const route = parseRoute(line);
		if (route) {
			if (!routeFacts.some((current) => sameRoute(current, route))) {
				routeFacts.push(route);
			}
			continue;
		}

		// Tunnel(MAP-E / DS-Lite / IPsec等)
		const encapsulation = /^tunnel encapsulation (\S+)/.exec(line);
		if (encapsulation && tunnel !== undefined) {
			const tunnelFact = ensureTunnel(tunnelFacts, tunnel);
			tunnelFact.encapsulation = (encapsulation[1] ?? "").toLowerCase();
			continue;
		}

		const ipsecTunnel = /^ipsec tunnel (\d+(?:\s+\d+)*)$/.exec(line);
		if (ipsecTunnel && tunnel !== undefined) {
			const tunnelFact = ensureTunnel(tunnelFacts, tunnel);
			const ids = (ipsecTunnel[1] ?? "")
				.split(/\s+/)
				.filter(Boolean)
				.map(Number);
			tunnelFact.ipsecTunnelIds = uniqueNumbers([
				...(tunnelFact.ipsecTunnelIds ?? []),
				...ids,
			]);
			continue;
		}

		const localEndpoint = /^ipsec ike local address \d+ (\S+)$/.exec(line);
		if (localEndpoint && tunnel !== undefined) {
			const value = localEndpoint[1] ?? "";
			ensureTunnel(tunnelFacts, tunnel).localEndpoint = parseEndpoint(value);
			continue;
		}
		const remoteEndpoint = /^ipsec ike remote address \d+ (\S+)$/.exec(line);
		if (remoteEndpoint && tunnel !== undefined) {
			const value = remoteEndpoint[1] ?? "";
			ensureTunnel(tunnelFacts, tunnel).remoteEndpoint = parseEndpoint(value);
			continue;
		}

		const tunnelEndpointAddress = /^tunnel endpoint address (.+)$/.exec(line);
		if (tunnelEndpointAddress && tunnel !== undefined) {
			const endpointParts = (tunnelEndpointAddress[1] ?? "")
				.trim()
				.split(/\s+/);
			const tunnelFact = ensureTunnel(tunnelFacts, tunnel);
			if (endpointParts.length > 1) {
				tunnelFact.endpointLocal = parseEndpoint(endpointParts[0] ?? "");
				tunnelFact.endpointRemote = parseEndpoint(endpointParts[1] ?? "");
			} else if (endpointParts[0]) {
				tunnelFact.endpointRemote = parseEndpoint(endpointParts[0]);
			}
			continue;
		}

		const localTunnelEndpoint = /^tunnel endpoint local address (\S+)$/.exec(
			line,
		);
		if (localTunnelEndpoint && tunnel !== undefined) {
			ensureTunnel(tunnelFacts, tunnel).endpointLocal = parseEndpoint(
				localTunnelEndpoint[1] ?? "",
			);
			continue;
		}
		const remoteTunnelEndpoint = /^tunnel endpoint remote address (\S+)$/.exec(
			line,
		);
		if (remoteTunnelEndpoint && tunnel !== undefined) {
			ensureTunnel(tunnelFacts, tunnel).endpointRemote = parseEndpoint(
				remoteTunnelEndpoint[1] ?? "",
			);
			continue;
		}
		const legacyRemoteTunnelEndpoint = /^ip tunnel remote address (\S+)$/.exec(
			line,
		);
		if (legacyRemoteTunnelEndpoint && tunnel !== undefined) {
			ensureTunnel(tunnelFacts, tunnel).endpointRemote = parseEndpoint(
				legacyRemoteTunnelEndpoint[1] ?? "",
			);
			continue;
		}

		const tunnelAddress = /^ip tunnel address (\S+)/.exec(line);
		if (tunnelAddress && tunnel !== undefined) {
			const iface = `tunnel${tunnel}`;
			ensureInterface(interfaceFacts, iface, "tunnel");
			addStaticAddress(
				interfaceFacts,
				networkFacts,
				iface,
				tunnelAddress[1] ?? "",
			);
		}
	}

	const interfaceList = [...interfaceFacts.values()];
	classifyInterfaces(interfaceList, networkFacts, routeFacts, pppoeUses);

	// `ip pp address dhcp`は、pppoe useと組み合わさった場合だけPPPoEのdynamic addressと表示する。
	for (const [ppNumber] of pppoeUses) {
		const ppInterface = interfaceFacts.get(`pp${ppNumber}`);
		for (const address of ppInterface?.addresses ?? []) {
			if (address.assignment === "dhcp") address.assignment = "pppoe";
		}
	}

	const tunnels: ProfileTunnelSummary[] = [];
	const vpnTunnels: ProfileTunnel[] = [];
	for (const tunnelFact of tunnelFacts.values()) {
		if (tunnelFact.encapsulation !== undefined) {
			tunnels.push({
				id: tunnelFact.id,
				encapsulation: tunnelFact.encapsulation,
			});
			const type = profileVpnTunnelType(tunnelFact);
			if (type) {
				const vpnTunnel: ProfileTunnel = {
					id: tunnelFact.id,
					encapsulation: tunnelFact.encapsulation,
					type,
				};
				if (tunnelFact.ipsecTunnelIds) {
					vpnTunnel.ipsecTunnelIds = tunnelFact.ipsecTunnelIds;
				}
				const localEndpoint =
					tunnelFact.localEndpoint ?? tunnelFact.endpointLocal;
				const remoteEndpoint =
					tunnelFact.remoteEndpoint ?? tunnelFact.endpointRemote;
				if (localEndpoint) vpnTunnel.localEndpoint = localEndpoint;
				if (remoteEndpoint) vpnTunnel.remoteEndpoint = remoteEndpoint;
				if (
					type === "l2tp-ipsec" &&
					remoteEndpoint?.kind === "dynamic" &&
					remoteEndpoint.value.toLowerCase() === "any"
				) {
					vpnTunnel.remoteAccess = true;
				}
				vpnTunnels.push(vpnTunnel);
			}
		}
	}

	const internet: DeviceProfile["internet"] = {};
	const ipv4 = projectIpv4(interfaceList, pppoeUses, dhcpInterfaces);
	if (ipv4) internet.ipv4 = ipv4;
	if (ipv6Internet) internet.ipv6 = ipv6Internet;
	const ipv4OverIpv6 = projectIpv4OverIpv6(tunnels);
	if (ipv4OverIpv6) internet.ipv4_over_ipv6 = ipv4OverIpv6;

	const profile: DeviceProfile = {
		internet,
		defaultRoute: projectDefaultRoute(routeFacts),
		lan: projectLegacyLan(interfaceList),
		tunnels,
		interfaces: interfaceList,
		networks: [...networkFacts.values()],
		routes: routeFacts,
		vpnTunnels,
		parserVersion: 1,
		model: options.model,
		firmwareRevision: options.firmwareRevision,
	};

	return profile;
}

function ensureInterface(
	interfaces: Map<string, ProfileInterface>,
	name: string,
	role?: ProfileInterfaceRole,
): ProfileInterface {
	const current = interfaces.get(name);
	if (current) {
		if (role && current.role === "unknown") current.role = role;
		return current;
	}
	const created: ProfileInterface = {
		name,
		role: role ?? interfaceRoleHint(name),
		addresses: [],
	};
	interfaces.set(name, created);
	return created;
}

function interfaceRoleHint(name: string): ProfileInterfaceRole {
	if (/^(wan|pp)\d+$/.test(name)) return "wan";
	if (/^tunnel\d+$/.test(name)) return "tunnel";
	return "unknown";
}

function addAddress(
	interfaceFact: ProfileInterface,
	address: ProfileAddress,
): void {
	if (
		interfaceFact.addresses.some(
			(current) =>
				current.family === address.family &&
				current.address === address.address &&
				current.assignment === address.assignment,
		)
	) {
		return;
	}
	interfaceFact.addresses.push(address);
}

function addStaticAddress(
	interfaces: Map<string, ProfileInterface>,
	networks: Map<string, ProfileNetwork>,
	interfaceName: string,
	value: string,
): void {
	const info = addressInfo(value);
	if (!info) return;
	addAddress(ensureInterface(interfaces, interfaceName), {
		family: info.family,
		address: value,
		assignment: "static",
	});
	if (!info.network) return;
	const key = `${interfaceName}|${info.family}|${info.network}`;
	if (!networks.has(key)) {
		networks.set(key, {
			interface: interfaceName,
			family: info.family,
			cidr: info.network,
			kind: "unknown",
		});
	}
}

function ensureTunnel(
	tunnels: Map<number, MutableTunnel>,
	id: number,
): MutableTunnel {
	const current = tunnels.get(id);
	if (current) return current;
	const created: MutableTunnel = { id };
	tunnels.set(id, created);
	return created;
}

function parseRoute(line: string): ProfileRoute | undefined {
	const match = /^ip route (\S+) gateway (.+)$/.exec(line);
	if (!match) return undefined;
	const destination = match[1] ?? "";
	const value = (match[2] ?? "").trim();
	const parsed = parseGateway(value);
	const route: ProfileRoute = {
		destination,
		gateway: parsed.gateway,
	};
	if (parsed.interface) route.interface = parsed.interface;
	if (parsed.tunnel !== undefined) route.tunnel = parsed.tunnel;
	return route;
}

function parseGateway(value: string): ParsedGateway {
	const tunnel = /^tunnel (\d+)$/.exec(value);
	if (tunnel) {
		return {
			gateway: { kind: "tunnel", value },
			tunnel: Number(tunnel[1]),
		};
	}
	if (/^pp \d+$/.test(value)) {
		return { gateway: { kind: "pp", value } };
	}
	const dhcp = /^dhcp (lan\d+|wan\d+)$/.exec(value);
	if (dhcp) {
		return {
			gateway: { kind: "dhcp", value },
			interface: dhcp[1],
		};
	}
	if (/^(lan|wan)\d+$/.test(value)) {
		return {
			gateway: { kind: "interface", value },
			interface: value,
		};
	}
	if (isIpv4Literal(value) || value.includes(":")) {
		return { gateway: { kind: "ip", value } };
	}
	return { gateway: { kind: "unknown", value } };
}

function parseEndpoint(value: string): ProfileEndpoint {
	if (isIpv4Literal(value)) return { kind: "ipv4", value };
	if (value.includes(":")) return { kind: "ipv6", value };
	if (/^(any|auto|dhcp|dynamic)$/i.test(value)) {
		return { kind: "dynamic", value };
	}
	if (/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)) {
		return { kind: "fqdn", value };
	}
	return { kind: "unknown", value };
}

function profileVpnTunnelType(
	tunnel: MutableTunnel,
): ProfileVpnTunnelType | undefined {
	switch (tunnel.encapsulation) {
		case "ipsec":
			return "ipsec";
		case "l2tp":
			return tunnel.ipsecTunnelIds?.length ? "l2tp-ipsec" : undefined;
		case "l2tpv3":
		case "l2tpv3-raw":
			return "l2tpv3";
		case "gre":
			return "gre";
		case "ipip":
			return "ipip";
		default:
			return undefined;
	}
}

function sameRoute(left: ProfileRoute, right: ProfileRoute): boolean {
	return (
		left.destination === right.destination &&
		left.gateway.kind === right.gateway.kind &&
		left.gateway.value === right.gateway.value &&
		left.interface === right.interface &&
		left.tunnel === right.tunnel
	);
}

function classifyInterfaces(
	interfaces: ProfileInterface[],
	networks: Map<string, ProfileNetwork>,
	routes: ProfileRoute[],
	pppoeUses: Map<number, string>,
): void {
	const wanPhysical = new Set<string>();
	for (const name of interfaces.map((item) => item.name)) {
		if (/^(wan|pp)\d+$/.test(name)) wanPhysical.add(name);
	}
	for (const physicalInterface of pppoeUses.values()) {
		wanPhysical.add(physicalInterface);
	}
	for (const route of routes) {
		if (
			route.destination === "default" &&
			(route.gateway.kind === "dhcp" || route.gateway.kind === "interface") &&
			route.interface
		) {
			wanPhysical.add(route.interface);
		}
		if (route.destination === "default" && route.gateway.kind === "ip") {
			const candidates = interfaces.filter((interfaceFact) =>
				interfaceFact.addresses.some(
					(address) =>
						address.family === "ipv4" &&
						address.assignment === "static" &&
						address.address !== undefined &&
						containsIpv4(address.address, route.gateway.value),
				),
			);
			if (candidates.length === 1) {
				wanPhysical.add(candidates[0]?.name ?? "");
			}
		}
	}

	for (const interfaceFact of interfaces) {
		if (/^tunnel\d+$/.test(interfaceFact.name)) {
			interfaceFact.role = "tunnel";
		} else if (
			/^(wan|pp)\d+$/.test(interfaceFact.name) ||
			wanPhysical.has(interfaceFact.name)
		) {
			interfaceFact.role = "wan";
		} else if (/^lan\d+$/.test(interfaceFact.name) && wanPhysical.size > 0) {
			// uplinkが別に明示されている場合だけ、残りのlanNをLANと分類する。
			interfaceFact.role = "lan";
		}
	}

	for (const network of networks.values()) {
		network.kind =
			interfaces.find((item) => item.name === network.interface)?.role ??
			"unknown";
	}
}

function projectIpv4(
	interfaces: ProfileInterface[],
	pppoeUses: Map<number, string>,
	dhcpInterfaces: Set<string>,
): DeviceProfile["internet"]["ipv4"] {
	for (const [ppNumber, physicalInterface] of pppoeUses) {
		return { method: "pppoe", interface: physicalInterface, pp: ppNumber };
	}
	for (const interfaceName of dhcpInterfaces) {
		const pp = /^pp(\d+)$/.exec(interfaceName);
		return {
			method: "dhcp",
			interface: interfaceName,
			...(pp ? { pp: Number(pp[1]) } : {}),
		};
	}
	for (const interfaceFact of interfaces) {
		if (interfaceFact.role !== "wan") continue;
		if (
			interfaceFact.addresses.some(
				(address) =>
					address.family === "ipv4" && address.assignment === "static",
			)
		) {
			return { method: "static", interface: interfaceFact.name };
		}
	}
	return undefined;
}

function projectDefaultRoute(routes: ProfileRoute[]): string | undefined {
	let value: string | undefined;
	for (const route of routes) {
		if (route.destination === "default") value = route.gateway.value;
	}
	return value;
}

function projectLegacyLan(
	interfaces: ProfileInterface[],
): { interface: string; address: string }[] {
	const legacy: { interface: string; address: string }[] = [];
	for (const interfaceFact of interfaces) {
		if (!/^(lan|wan)\d+$/.test(interfaceFact.name)) continue;
		for (const address of interfaceFact.addresses) {
			if (
				address.family === "ipv4" &&
				address.assignment === "static" &&
				address.address
			) {
				legacy.push({
					interface: interfaceFact.name,
					address: address.address,
				});
			}
		}
	}
	return legacy;
}

function projectIpv4OverIpv6(
	tunnels: ProfileTunnelSummary[],
): DeviceProfile["internet"]["ipv4_over_ipv6"] {
	for (const tunnel of tunnels) {
		if (
			tunnel.encapsulation === "map-e" ||
			tunnel.encapsulation === "ds-lite"
		) {
			return { method: tunnel.encapsulation, tunnel: tunnel.id };
		}
	}
	return undefined;
}

function addressInfo(value: string): AddressInfo | undefined {
	if (isIpv4Literal(value)) {
		return { family: "ipv4", network: networkFromCidr(value) };
	}
	if (value.includes(":")) return { family: "ipv6" };
	return undefined;
}

function isIpv4Literal(value: string): boolean {
	const [address, prefix] = value.split("/");
	if (address === undefined || ipv4Number(address) === undefined) return false;
	if (prefix === undefined) return true;
	const length = Number(prefix);
	return /^\d+$/.test(prefix) && length >= 0 && length <= 32;
}

function networkFromCidr(value: string): string | undefined {
	const [address, prefixText] = value.split("/");
	if (prefixText === undefined) return undefined;
	const prefix = Number(prefixText);
	const ip = ipv4Number(address ?? "");
	if (
		ip === undefined ||
		!/^\d+$/.test(prefixText) ||
		prefix < 0 ||
		prefix > 32
	) {
		return undefined;
	}
	const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
	return `${ipv4Text((ip & mask) >>> 0)}/${prefix}`;
}

function containsIpv4(cidr: string, address: string): boolean {
	const network = networkFromCidr(cidr);
	const [networkAddress, prefixText] = network?.split("/") ?? [];
	const networkNumber = ipv4Number(networkAddress ?? "");
	const addressNumber = ipv4Number(address);
	const prefix = Number(prefixText);
	if (
		networkNumber === undefined ||
		addressNumber === undefined ||
		!Number.isInteger(prefix)
	) {
		return false;
	}
	const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
	return (addressNumber & mask) >>> 0 === networkNumber;
}

function ipv4Number(value: string): number | undefined {
	const parts = value.split(".");
	if (parts.length !== 4) return undefined;
	let result = 0;
	for (const part of parts) {
		if (!/^\d+$/.test(part)) return undefined;
		const octet = Number(part);
		if (octet < 0 || octet > 255) return undefined;
		result = (result * 256 + octet) >>> 0;
	}
	return result;
}

function ipv4Text(value: number): string {
	return [
		(value >>> 24) & 255,
		(value >>> 16) & 255,
		(value >>> 8) & 255,
		value & 255,
	].join(".");
}

function uniqueNumbers(values: number[]): number[] {
	return [...new Set(values)];
}
