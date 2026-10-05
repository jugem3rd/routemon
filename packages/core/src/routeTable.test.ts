import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { parseRouteTable } from "./routeTable.ts";

function fixture(name: string): string {
	return readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
}

describe("parseRouteTable", () => {
	test("日本語見出しのIPv4経路とdefault表記を解析する", () => {
		const result = parseRouteTable(
			fixture("route-table-ipv4-japanese.txt"),
			"ipv4",
		);

		expect(result.status).toBe("complete");
		expect(result.unparsedLines).toEqual([]);
		expect(result.routes).toEqual([
			{
				family: "ipv4",
				destination: "default",
				gateway: null,
				interface: "PP[01]",
				rawType: "static",
				category: "static",
				rawDetails: "filter:500000",
			},
			{
				family: "ipv4",
				destination: "198.51.100.2/32",
				gateway: null,
				interface: "PP[01]",
				rawType: "temporary",
				category: "temporary",
			},
			{
				family: "ipv4",
				destination: "192.168.100.0/24",
				gateway: "192.168.100.1",
				interface: "LAN1",
				rawType: "implicit",
				category: "implicit",
			},
		]);
	});

	test("英語見出し、種別、RIP / OSPF付加情報、未知の種別を解析する", () => {
		const result = parseRouteTable(
			fixture("route-table-ipv4-english.txt"),
			"ipv4",
		);

		expect(result.status).toBe("complete");
		expect(result.routes).toEqual([
			{
				family: "ipv4",
				destination: "default",
				gateway: null,
				interface: "PP[01]",
				rawType: "static",
				category: "static",
				rawDetails: "filter:500000",
			},
			{
				family: "ipv4",
				destination: "203.0.113.0/24",
				gateway: "203.0.113.1",
				interface: "TUNNEL[1]",
				rawType: "RIP",
				category: "dynamic",
				protocol: "RIP",
				metric: 1,
				rawDetails: "metric=1",
			},
			{
				family: "ipv4",
				destination: "198.51.100.0/24",
				gateway: "198.51.100.1",
				interface: "TUNNEL[2]",
				rawType: "OSPF",
				category: "dynamic",
				protocol: "OSPF",
				cost: 20,
				rawDetails: "cost=20",
			},
			{
				family: "ipv4",
				destination: "192.0.2.0/24",
				gateway: "192.0.2.1",
				interface: "TUNNEL[3]",
				rawType: "BGP",
				category: "dynamic",
				protocol: "BGP",
				rawDetails: "local-pref=100",
			},
			{
				family: "ipv4",
				destination: "192.0.2.128/25",
				gateway: null,
				interface: "LAN1",
				rawType: "vendor-route",
				category: "unknown",
				rawDetails: "note=kept",
			},
		]);
		// filter番号のような数値はmetricへ誤分類しない。
		expect(result.routes[0]).not.toHaveProperty("metric");
	});

	test("見出しだけの空IPv6 tableを完全な空snapshotとして返す", () => {
		expect(
			parseRouteTable(fixture("route-table-ipv6-empty.txt"), "ipv6"),
		).toEqual({
			family: "ipv6",
			status: "complete",
			routes: [],
			unparsedLines: [],
		});
	});

	test("「タイプ」見出しで付加情報列のないIPv6経路を解析する", () => {
		const result = parseRouteTable(
			fixture("route-table-ipv6-japanese.txt"),
			"ipv6",
		);

		expect(result.status).toBe("complete");
		expect(result.unparsedLines).toEqual([]);
		expect(result.routes).toEqual([
			{
				family: "ipv6",
				destination: "2001:db8:100::/48",
				gateway: "2001:db8::1",
				interface: "TUNNEL[1]",
				rawType: "static",
				category: "static",
			},
		]);
	});

	test("IPv6 default prefixを正規化し、IPv6 OSPF costを数値化する", () => {
		const result = parseRouteTable(
			fixture("route-table-ipv6-default.txt"),
			"ipv6",
		);

		expect(result.status).toBe("complete");
		expect(result.routes).toEqual([
			{
				family: "ipv6",
				destination: "default",
				gateway: null,
				interface: "TUNNEL[1]",
				rawType: "static",
				category: "static",
			},
			{
				family: "ipv6",
				destination: "2001:db8:1::/64",
				gateway: "fe80::1",
				interface: "TUNNEL[1]",
				rawType: "OSPF",
				category: "dynamic",
				protocol: "OSPF",
				cost: 10,
				rawDetails: "cost=10",
			},
		]);
	});

	test("見出し認識後に解析できない行があればpartialで原文を残す", () => {
		const result = parseRouteTable(fixture("route-table-partial.txt"), "ipv4");

		expect(result.status).toBe("partial");
		expect(result.routes).toHaveLength(1);
		expect(result.unparsedLines).toEqual(["malformed route row"]);
	});

	test("既知の見出しが無い出力をunrecognized_outputとする", () => {
		expect(
			parseRouteTable(fixture("route-table-unrecognized.txt"), "ipv4"),
		).toEqual({
			family: "ipv4",
			status: "unrecognized_output",
			routes: [],
			unparsedLines: [],
		});
	});
});
