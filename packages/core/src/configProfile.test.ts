import { describe, expect, test } from "vitest";
import { parseConfig } from "./configProfile.ts";
import {
	decodeSnapshotPayload,
	encodeSnapshotPayload,
} from "./configSnapshot.ts";

/** PPPoE + DHCPv6-PD + MAP-Eという、よくある構成(値はダミー)。 */
const PPPOE_CONFIG = `# RTX830 Rev.15.02.30
ip route default gateway pp 1
ip lan1 address 192.0.2.1/24
pp select 1
 pppoe use lan2
 ip pp address dhcp
pp enable 1
ipv6 lan2 dhcp service client
ipv6 prefix 1 ra-prefix@lan2::/64
tunnel select 1
 tunnel encapsulation map-e
 ip tunnel mtu 1460
tunnel enable 1
`;

const DHCP_CONFIG = `ip lan2 address dhcp
ip lan1 address 198.51.100.1/24
ip route default gateway dhcp lan2
`;

const STATIC_CONFIG = `ip lan2 address 203.0.113.2/24
ip lan1 address 192.0.2.1/24
ip route default gateway 203.0.113.1
tunnel select 2
 tunnel encapsulation ipip
`;

const IPSEC_CONFIG = `ip route default gateway pp 1
ip lan1 address 192.0.2.1/24
pp select 1
 pppoe use lan2
 ip pp address dhcp
tunnel select 1
 tunnel encapsulation ipsec
 ipsec tunnel 1
 ipsec ike local address 1 203.0.113.10
 ipsec ike remote address 1 203.0.113.20
 ip tunnel address 203.0.113.30/30
ip route 198.51.100.0/24 gateway tunnel 1
`;

describe("parseConfig", () => {
	test("PPPoE / DHCPv6-PD / MAP-Eを判定する", () => {
		const profile = parseConfig(PPPOE_CONFIG, {
			model: "RTX830",
			firmwareRevision: "15.02.30",
		});
		expect(profile.internet.ipv4).toEqual({
			method: "pppoe",
			interface: "lan2",
			pp: 1,
		});
		expect(profile.internet.ipv6).toEqual({
			method: "dhcpv6-pd",
			interface: "lan2",
		});
		expect(profile.internet.ipv4_over_ipv6).toEqual({
			method: "map-e",
			tunnel: 1,
		});
		expect(profile.defaultRoute).toBe("pp 1");
		expect(profile.lan).toEqual([
			{ interface: "lan1", address: "192.0.2.1/24" },
		]);
		expect(profile.tunnels).toEqual([{ id: 1, encapsulation: "map-e" }]);
		expect(profile.model).toBe("RTX830");
	});

	test("認証情報用のcommandをProfileに取り込まない", () => {
		const profile = parseConfig(
			`${PPPOE_CONFIG}pp auth\nipsec ike pre-shared-key 1\n`,
		);
		const serialized = JSON.stringify(profile);
		expect(serialized).not.toContain("pp auth");
		expect(serialized).not.toContain("pre-shared-key");
		expect(profile).not.toHaveProperty("credentials");
	});

	test("DHCP client / staticを判定する", () => {
		const dhcp = parseConfig(DHCP_CONFIG);
		expect(dhcp.internet.ipv4).toEqual({ method: "dhcp", interface: "lan2" });
		expect(dhcp.defaultRoute).toBe("dhcp lan2");
		expect(dhcp.lan).toEqual([
			{ interface: "lan1", address: "198.51.100.1/24" },
		]);

		const fixed = parseConfig(STATIC_CONFIG);
		expect(fixed.internet.ipv4).toEqual({
			method: "static",
			interface: "lan2",
		});
		expect(fixed.lan).toContainEqual({
			interface: "lan2",
			address: "203.0.113.2/24",
		});
		expect(fixed.networks).toContainEqual({
			interface: "lan2",
			family: "ipv4",
			cidr: "203.0.113.0/24",
			kind: "wan",
		});
		expect(fixed.defaultRoute).toBe("203.0.113.1");
		expect(fixed.tunnels).toEqual([{ id: 2, encapsulation: "ipip" }]);
		expect(fixed.internet.ipv4_over_ipv6).toBeUndefined();
	});

	test("IPv6のra-prefix表記をRAとして判定する", () => {
		const expanded = parseConfig("ipv6 lan1 address ra-prefix@lan2::1/64\n");
		const bare = parseConfig("ipv6 lan1 address ra-prefix\n");

		expect(expanded.internet.ipv6).toEqual({
			method: "ra",
			interface: "lan1",
		});
		expect(bare.internet.ipv6).toEqual({
			method: "ra",
			interface: "lan1",
		});
	});

	test("canonical factsからLAN/WAN、VPN、routeと互換projectionを作る", () => {
		const profile = parseConfig(IPSEC_CONFIG, {
			model: "RTX830",
			firmwareRevision: "15.02.30",
		});

		expect(profile.parserVersion).toBe(1);
		expect(profile.internet.ipv4).toEqual({
			method: "pppoe",
			interface: "lan2",
			pp: 1,
		});
		expect(profile.lan).toEqual([
			{ interface: "lan1", address: "192.0.2.1/24" },
		]);
		expect(profile.defaultRoute).toBe("pp 1");

		expect(profile.interfaces).toContainEqual({
			name: "lan1",
			role: "lan",
			addresses: [
				{
					family: "ipv4",
					address: "192.0.2.1/24",
					assignment: "static",
				},
			],
		});
		expect(profile.interfaces).toContainEqual({
			name: "pp1",
			role: "wan",
			addresses: [{ family: "ipv4", assignment: "pppoe" }],
		});
		expect(profile.networks).toContainEqual({
			interface: "lan1",
			family: "ipv4",
			cidr: "192.0.2.0/24",
			kind: "lan",
		});
		expect(profile.networks).toContainEqual({
			interface: "tunnel1",
			family: "ipv4",
			cidr: "203.0.113.28/30",
			kind: "tunnel",
		});

		expect(profile.tunnels).toEqual([{ id: 1, encapsulation: "ipsec" }]);
		expect(profile.vpnTunnels).toContainEqual({
			id: 1,
			encapsulation: "ipsec",
			type: "ipsec",
			ipsecTunnelIds: [1],
			localEndpoint: { kind: "ipv4", value: "203.0.113.10" },
			remoteEndpoint: { kind: "ipv4", value: "203.0.113.20" },
		});
		expect(profile.routes).toContainEqual({
			destination: "198.51.100.0/24",
			gateway: { kind: "tunnel", value: "tunnel 1" },
			tunnel: 1,
		});
	});

	test("L2TP/IPsecの匿名受けとL2TPv3・GRE・IPIPを種別付きで抽出する", () => {
		const profile = parseConfig(`tunnel select 1
 tunnel encapsulation l2tp
 ipsec tunnel 1
 ipsec ike local address 1 203.0.113.10
 ipsec ike remote address 1 any
tunnel select 2
 tunnel encapsulation l2tpv3-raw
 tunnel endpoint address 203.0.113.10 198.51.100.20
tunnel select 3
 tunnel encapsulation gre
 tunnel endpoint local address 203.0.113.10
 tunnel endpoint remote address 198.51.100.30
tunnel select 4
 tunnel encapsulation ipip
 ip tunnel remote address 198.51.100.40
tunnel select 5
 tunnel encapsulation l2tp
`);

		expect(profile.vpnTunnels).toEqual([
			{
				id: 1,
				encapsulation: "l2tp",
				type: "l2tp-ipsec",
				ipsecTunnelIds: [1],
				localEndpoint: { kind: "ipv4", value: "203.0.113.10" },
				remoteEndpoint: { kind: "dynamic", value: "any" },
				remoteAccess: true,
			},
			{
				id: 2,
				encapsulation: "l2tpv3-raw",
				type: "l2tpv3",
				localEndpoint: { kind: "ipv4", value: "203.0.113.10" },
				remoteEndpoint: { kind: "ipv4", value: "198.51.100.20" },
			},
			{
				id: 3,
				encapsulation: "gre",
				type: "gre",
				localEndpoint: { kind: "ipv4", value: "203.0.113.10" },
				remoteEndpoint: { kind: "ipv4", value: "198.51.100.30" },
			},
			{
				id: 4,
				encapsulation: "ipip",
				type: "ipip",
				remoteEndpoint: { kind: "ipv4", value: "198.51.100.40" },
			},
		]);
	});

	test("未知のcommandは無視し、Shift_JISのコメントを読める", () => {
		// 「説明」をShift_JISで書いたコメント行
		const comment = Uint8Array.from([0x23, 0x20, 0x90, 0xe0, 0x96, 0xbe, 0x0a]);
		const body = new TextEncoder().encode(
			"unknown command here\nip lan1 address 192.0.2.1/24\n",
		);
		const config = new Uint8Array(comment.length + body.length);
		config.set(comment, 0);
		config.set(body, comment.length);

		const profile = parseConfig(config);
		expect(profile.lan).toEqual([
			{ interface: "lan1", address: "192.0.2.1/24" },
		]);
		expect(profile.internet.ipv4).toBeUndefined();
	});
});

describe("snapshot payload", () => {
	test.each(["pre_apply", "apply_verify"] as const)(
		"CONFIG Apply用reason %sを往復できる",
		(reason) => {
			const config = Uint8Array.from([0x90, 0xe0, 0x0a, 0x41]);
			const decoded = decodeSnapshotPayload(
				encodeSnapshotPayload({ reason, config }),
			);
			expect(decoded.reason).toBe(reason);
			expect(Array.from(decoded.config)).toEqual(Array.from(config));
		},
	);

	test("reasonとCONFIG本文を往復できる", () => {
		const config = Uint8Array.from([0x90, 0xe0, 0x0a, 0x41]);
		const decoded = decodeSnapshotPayload(
			encodeSnapshotPayload({ reason: "agent_start", config }),
		);
		expect(decoded.reason).toBe("agent_start");
		expect(Array.from(decoded.config)).toEqual(Array.from(config));
	});

	test("知らないreasonはmanualとして扱う", () => {
		const payload = new TextEncoder().encode("weird\nip lan1 address\n");
		expect(decodeSnapshotPayload(payload).reason).toBe("manual");
	});

	test("reason行が無いpayloadは拒否する", () => {
		expect(() =>
			decodeSnapshotPayload(new TextEncoder().encode("x")),
		).toThrow();
	});
});
