/**
 * 開発・実機検証用のentry(Issue #22)。
 *
 * Agent endpoint(TLS)と、動作確認用のraw TCP relayを起動する。relayはBrowserの
 * 接続をそのままstreamへ流すだけで、GUI sessionの認可・L7補正は#27で実装する。
 *
 *   CERT_FILE=... KEY_FILE=... DEVICE_ID=... DEVICE_TOKEN=... \
 *   node packages/gateway/scripts/dev-agent-endpoint.ts
 */
import { readFileSync } from "node:fs";
import { createServer } from "node:net";
import {
	AgentGateway,
	createAgentEndpoint,
	MemoryDeviceStore,
} from "../src/index.ts";

const agentPort = Number(process.env.AGENT_PORT ?? 9445);
const browserPort = Number(process.env.BROWSER_PORT ?? 8092);
const deviceId = process.env.DEVICE_ID ?? "dev-device";
const deviceToken = process.env.DEVICE_TOKEN ?? "dev-token";
const certFile = process.env.CERT_FILE;
const keyFile = process.env.KEY_FILE;

const store = new MemoryDeviceStore();
store.add(deviceId, deviceToken);

const gateway = new AgentGateway({
	store,
	logger: console,
	onPresenceChange: (presence) =>
		console.log(`presence ${presence.deviceId}: ${presence.status}`),
});
setInterval(() => gateway.sweepPresence(), 10_000).unref();

const tls =
	certFile && keyFile
		? { cert: readFileSync(certFile), key: readFileSync(keyFile) }
		: undefined;
createAgentEndpoint({ gateway, tls }).listen(agentPort, () => {
	console.log(`agent endpoint listening on ${agentPort} (tls=${Boolean(tls)})`);
});

createServer((socket) => {
	socket.once("data", (initial) => {
		let stream: { send(data: Uint8Array): void; close(): void };
		try {
			stream = gateway.openStream(deviceId, new Uint8Array(initial), {
				onData: (data) => socket.write(data),
				onClose: () => socket.end(),
			});
		} catch (error) {
			console.warn(`stream open failed: ${(error as Error).message}`);
			socket.destroy();
			return;
		}
		socket.on("data", (chunk) => stream.send(new Uint8Array(chunk)));
		socket.on("close", () => stream.close());
		socket.on("error", () => stream.close());
	});
}).listen(browserPort, () => {
	console.log(`dev browser relay listening on ${browserPort}`);
});
