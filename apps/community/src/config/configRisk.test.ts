import { describe, expect, test } from "vitest";
import { type ConfigRisk, classifyConfigRisks } from "./configRisk.ts";

// Issue #126 §2の「検出する」表をそのままテストデータにする。表の1行=1ケース。
// 複数例のある行はその全行を入力し、期待する分類の和集合になること。
const DETECT_CASES: Array<{ lines: string[]; expected: ConfigRisk[] }> = [
	{ lines: [" ip pp secure filter in 200030"], expected: ["filter"] },
	{
		lines: [" ip pp secure filter out 200031 dynamic 200080"],
		expected: ["filter"],
	},
	{ lines: [" ipv6 pp secure filter in 101000"], expected: ["filter"] },
	{ lines: ["ip lan2 secure filter in 200030"], expected: ["wan", "filter"] },
	{ lines: ["ip filter 200030 reject * * * * *"], expected: ["filter"] },
	{ lines: ["ipv6 filter 101000 pass * * icmp6"], expected: ["filter"] },
	{ lines: ["ip filter dynamic 200080 * * ftp"], expected: ["filter"] },
	{ lines: ["ip route default gateway pp 1"], expected: ["wan"] },
	{ lines: ["ipv6 route default gateway dhcp lan2"], expected: ["wan"] },
	{ lines: ["ip lan2 address dhcp"], expected: ["wan"] },
	{ lines: [" ip pp address 203.0.113.10/32"], expected: ["wan"] },
	{ lines: ["pp select 1"], expected: ["wan", "pppoe"] },
	{ lines: [" pppoe use lan2"], expected: ["wan", "pppoe"] },
	{
		lines: [" pp auth accept chap", " pp bind lan2", " pp always-on on"],
		expected: ["pppoe"],
	},
	{ lines: ["pp enable 1", "pp disable 1"], expected: ["pppoe"] },
	{
		lines: [
			"nat descriptor type 1000 masquerade",
			" ip pp nat descriptor 1000",
		],
		expected: ["wan"],
	},
	{ lines: ["dns server 192.0.2.53"], expected: ["wan"] },
	{
		lines: [
			"tunnel select 1",
			" tunnel encapsulation map-e",
			" tunnel encapsulation ipip",
		],
		expected: ["wan"],
	},
	{
		lines: ["schedule at 3 +15 * lua /routemon_bootstrap.lua"],
		expected: ["supervisor_autostart"],
	},
	{ lines: ["ethernet lan1 filter in 1"], expected: ["filter"] },
	{
		lines: ["ethernet filter 1 pass 00:00:00:00:00:00"],
		expected: ["filter"],
	},
	{ lines: [" ipsec tunnel 101"], expected: ["wan"] },
	{ lines: ["ipv6 lan2 address dhcp"], expected: ["wan"] },
	{
		lines: ["ipv6 lan1 address ra-prefix@lan2::1/64"],
		expected: ["wan"],
	},
	{
		lines: ["ipv6 prefix 1 ra-prefix@lan2::/64"],
		expected: ["wan"],
	},
	{
		lines: ["ipv6 lan2 dhcp service client ir=on"],
		expected: ["wan"],
	},
	{ lines: ["ngn type lan2 ntt"], expected: ["wan"] },
	{ lines: [" ip pp mtu 1454"], expected: ["wan"] },
];

// Issue #126 §2の「検出しない」表をそのままテストデータにする。表の1行=1ケース。
const IGNORE_CASES: string[] = [
	"description lan2 wan-link",
	"dhcp scope 1 192.168.100.2-192.168.100.191/24",
	"syslog notice on",
	"schedule at 1 */* 03:00:00 * save",
	"ip lan1 proxyarp on",
	" ipsec sa policy 101 1 esp aes-cbc sha-hmac",
	" ipsec ike remote address 1 198.51.100.1",
	"description 1 tunnel-to-osaka",
];

describe("classifyConfigRisks", () => {
	for (const { lines, expected } of DETECT_CASES) {
		test(`検出する: ${lines.join(" / ")}`, () => {
			expect(classifyConfigRisks(lines)).toEqual(expected);
		});
	}
	for (const line of IGNORE_CASES) {
		test(`検出しない: ${line}`, () => {
			expect(classifyConfigRisks([line])).toEqual([]);
		});
	}
	test("分類の順序は wan / pppoe / filter / supervisor_autostart で固定", () => {
		expect(
			classifyConfigRisks([
				"schedule at 3 +15 * lua /routemon_bootstrap.lua",
				"ip lan2 secure filter in 200030",
				"pp select 1",
			]),
		).toEqual(["wan", "pppoe", "filter", "supervisor_autostart"]);
	});
});
