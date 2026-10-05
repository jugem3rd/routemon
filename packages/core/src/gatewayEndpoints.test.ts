import { expect, test } from "vitest";
import {
	decodeGatewayEndpoints,
	encodeGatewayEndpoints,
	isValidGatewayEndpoint,
	supportsGatewayEndpoints,
} from "./gatewayEndpoints.ts";

test("endpoint一覧を、LF区切りで往復できる", () => {
	const urls = ["https://gw.example.com", "http://192.168.100.2:18185"];
	expect(decodeGatewayEndpoints(encodeGatewayEndpoints(urls))).toEqual(urls);
});

test("不正なURLを含む一覧は、全体を不正として空にする", () => {
	const payload = new TextEncoder().encode("https://ok.example.com\nftp://bad");
	expect(decodeGatewayEndpoints(payload)).toEqual([]);
	expect(decodeGatewayEndpoints(new Uint8Array())).toEqual([]);
});

test("encodeは、不正なURLと件数の範囲外を拒否する", () => {
	expect(() => encodeGatewayEndpoints([])).toThrow(RangeError);
	expect(() => encodeGatewayEndpoints(["not a url"])).toThrow(RangeError);
	expect(() =>
		encodeGatewayEndpoints(Array(5).fill("https://a.example")),
	).toThrow(RangeError);
});

test("URLの検証", () => {
	expect(isValidGatewayEndpoint("https://gw.example.com")).toBe(true);
	expect(isValidGatewayEndpoint("http://192.168.100.2:18185")).toBe(true);
	expect(isValidGatewayEndpoint("https://gw.example.com/")).toBe(false);
	expect(isValidGatewayEndpoint("https://gw.example.com/a b")).toBe(false);
	expect(isValidGatewayEndpoint(`https://${"a".repeat(250)}.com`)).toBe(false);
});

test("0.2.0以上のAgentだけがendpoint更新に対応する", () => {
	expect(supportsGatewayEndpoints("0.1.0")).toBe(false);
	expect(supportsGatewayEndpoints("0.1.9")).toBe(false);
	expect(supportsGatewayEndpoints("0.2.0")).toBe(true);
	expect(supportsGatewayEndpoints("0.10.0")).toBe(true);
	expect(supportsGatewayEndpoints("1.0.0")).toBe(true);
	expect(supportsGatewayEndpoints("garbage")).toBe(false);
	expect(supportsGatewayEndpoints("")).toBe(false);
});
