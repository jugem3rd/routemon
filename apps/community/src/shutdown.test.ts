import { createServer, type Server } from "node:http";
import {
	type AddressInfo,
	connect,
	createServer as createNetServer,
} from "node:net";
import { cobsDecode, decodeFrames } from "@routemon/core";
import {
	AgentGateway,
	createAgentEndpoint,
	MemoryDeviceStore,
} from "@routemon/gateway";
import { expect, test } from "vitest";
import { createShutdown, trackNetServer } from "./shutdown.ts";

const listen = (server: Server) =>
	new Promise<number>((resolve) =>
		server.listen(0, "127.0.0.1", () =>
			resolve((server.address() as AddressInfo).port),
		),
	);

test("停止すると、待機中のlong-pollを空の応答で返し、数秒以内に正常終了する", async () => {
	const store = new MemoryDeviceStore();
	store.add("device-1", "token-1");
	const gateway = new AgentGateway({ store });
	const server = createAgentEndpoint({ gateway });
	const port = await listen(server);

	// Agentの待機中のlong-poll(最大25秒)
	const pending = fetch(`http://127.0.0.1:${port}/v1/tunnel/sync/25`, {
		method: "POST",
		headers: { authorization: "Bearer token-1" },
		body: "",
	});
	await new Promise((resolve) => setTimeout(resolve, 50));

	const exits: number[] = [];
	const events: string[] = [];
	const shutdown = createShutdown({
		servers: [server],
		beforeClose: () => {
			events.push("beforeClose");
			gateway.shutdown();
		},
		afterClose: () => events.push("afterClose"),
		graceMs: 5_000,
		exit: (code) => exits.push(code),
	});

	const started = Date.now();
	await shutdown();
	const response = await pending;

	// エラーではなく、通常の(空の)応答として返る
	expect(response.status).toBe(200);
	const body = new Uint8Array(await response.arrayBuffer());
	expect(decodeFrames(cobsDecode(body))).toHaveLength(0);
	expect(Date.now() - started).toBeLessThan(2_000);
	expect(events).toEqual(["beforeClose", "afterClose"]);
	expect(exits).toEqual([0]);
	expect(server.listening).toBe(false);
});

test("停止は一度しか実行されない", async () => {
	const server = createServer();
	await listen(server);
	let closes = 0;
	const shutdown = createShutdown({
		servers: [server],
		afterClose: () => {
			closes++;
		},
		graceMs: 5_000,
		exit: () => {},
	});
	await Promise.all([shutdown(), shutdown()]);
	expect(closes).toBe(1);
});

test("閉じない接続が残っていても、猶予の途中で閉じて正常終了する", async () => {
	const net = createNetServer((socket) => {
		socket.on("error", () => {});
	});
	// 接続の記録は、起動時(接続を受ける前)に始める
	const tracked = trackNetServer(net);
	await new Promise<void>((resolve) => net.listen(0, "127.0.0.1", resolve));
	const port = (net.address() as AddressInfo).port;
	const client = await new Promise<ReturnType<typeof connect>>((resolve) => {
		const socket = connect(port, "127.0.0.1", () => resolve(socket));
		socket.on("error", () => {});
	});

	const exits: number[] = [];
	const shutdown = createShutdown({
		servers: [tracked],
		graceMs: 1_000,
		exit: (code) => exits.push(code),
	});
	await shutdown();
	client.destroy();

	expect(exits).toEqual([0]);
});

test("猶予を過ぎても終わらない場合は、終了コード1で強制終了する", async () => {
	// close()のcallbackを呼ばないserver(終わらない停止)
	const stuck = {
		close: () => {},
		closeIdleConnections: () => {},
		closeAllConnections: () => {},
	};
	const exits: number[] = [];
	const shutdown = createShutdown({
		servers: [stuck],
		graceMs: 100,
		exit: (code) => exits.push(code),
	});
	void shutdown();
	await new Promise((resolve) => setTimeout(resolve, 300));
	expect(exits).toEqual([1]);
});
