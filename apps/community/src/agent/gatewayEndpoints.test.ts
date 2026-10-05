import { decodeGatewayEndpoints, FrameType } from "@routemon/core";
import type { AgentGateway } from "@routemon/gateway";
import { expect, test } from "vitest";
import {
	GatewayEndpointsNotifier,
	parseGatewayEndpoints,
} from "./gatewayEndpoints.ts";

function fakeGateway(connected = true) {
	const sent: { deviceId: string; type: number; payload?: Uint8Array }[] = [];
	const gateway = {
		sendFrame: (
			deviceId: string,
			type: number,
			_s: number,
			payload?: Uint8Array,
		) => {
			if (!connected) throw new Error("not connected");
			sent.push({ deviceId, type, payload });
		},
	} as unknown as AgentGateway;
	return { gateway, sent };
}

test("対応済みのAgentには、接続先の一覧を送る", () => {
	const { gateway, sent } = fakeGateway();
	const notifier = new GatewayEndpointsNotifier({
		gateway,
		endpoints: ["https://gw.example.com"],
	});
	expect(notifier.notify("dev-1", "0.2.0")).toBe(true);
	expect(sent).toHaveLength(1);
	expect(sent[0]?.type).toBe(FrameType.GATEWAY_ENDPOINTS);
	expect(decodeGatewayEndpoints(sent[0]?.payload as Uint8Array)).toEqual([
		"https://gw.example.com",
	]);
});

test("古いAgentと、versionが不明なAgentには送らない", () => {
	const { gateway, sent } = fakeGateway();
	const notifier = new GatewayEndpointsNotifier({
		gateway,
		endpoints: ["https://gw.example.com"],
	});
	expect(notifier.notify("dev-1", "0.1.0")).toBe(false);
	expect(notifier.notify("dev-1", null)).toBe(false);
	expect(notifier.notify("dev-1", undefined)).toBe(false);
	expect(sent).toHaveLength(0);
});

test("接続していないDeviceへは送らずに、falseを返す", () => {
	const { gateway } = fakeGateway(false);
	const notifier = new GatewayEndpointsNotifier({
		gateway,
		endpoints: ["https://gw.example.com"],
	});
	expect(notifier.notify("dev-1", "0.2.0")).toBe(false);
});

test("AGENT_ENDPOINTSの解釈", () => {
	expect(parseGatewayEndpoints("https://a.example.com")).toEqual([
		"https://a.example.com",
	]);
	expect(
		parseGatewayEndpoints("https://a.example.com, http://192.168.0.2:8081"),
	).toEqual(["https://a.example.com", "http://192.168.0.2:8081"]);
	expect(parseGatewayEndpoints("")).toBeUndefined();
	expect(parseGatewayEndpoints("https://a.example.com/")).toBeUndefined();
	expect(parseGatewayEndpoints("ftp://a")).toBeUndefined();
});
