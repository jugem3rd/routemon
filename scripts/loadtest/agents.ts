/**
 * 擬似Agent(load generator、#7、docs/community/loadtest.md)。
 *
 * 実際のAgent(RouterのLua)と同じ形で、`POST /v1/tunnel/sync/<wait>`を繰り返す。
 * - syncごとに**新しいTCP / TLS接続**を張る(RouterのLuaはkeep-aliveせず、Gatewayは`connection: close`で応答する)
 * - 失敗したら、1秒から倍々のbackoff(最大30秒)
 * - 開始は、`--ramp`の秒数の中に散らす
 *
 * シナリオ(組み合わせられる):
 * - 既定(idle): 空bodyのsyncだけ
 * - `--syslog-lines N`: 各syncで、N行のSYSLOG batchを送る
 * - `--gui-clients K`: Device `dev-1`をNative WebGUIの転送先にし、K個の擬似Browserが
 *   WebGUI relayへ繰り返しrequestする(同時K stream)
 *
 *   node scripts/loadtest/agents.ts --url http://127.0.0.1:18081 --agents 300 --ramp 20 --duration 60
 */
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { connect } from "node:net";
import { parseArgs } from "node:util";
import {
	cobsDecode,
	concatFrames,
	decodeFrames,
	encodeFrame,
	FrameType,
	textEscape,
} from "@routemon/core";

const { values } = parseArgs({
	options: {
		url: { type: "string", default: "http://127.0.0.1:18081" },
		agents: { type: "string", default: "100" },
		ramp: { type: "string", default: "20" },
		duration: { type: "string", default: "60" },
		wait: { type: "string", default: "20" },
		"id-offset": { type: "string", default: "0" },
		insecure: { type: "boolean", default: false },
		"report-interval": { type: "string", default: "10" },
		"min-sync-interval-ms": { type: "string", default: "250" },
		"syslog-lines": { type: "string", default: "0" },
		"syslog-event-every": { type: "string", default: "0" },
		"gui-url": { type: "string", default: "127.0.0.1:18082" },
		"gui-clients": { type: "string", default: "0" },
		"gui-bytes": { type: "string", default: "65536" },
		help: { type: "boolean", default: false },
	},
});

if (values.help) {
	console.log(
		"usage: node scripts/loadtest/agents.ts [--url URL] [--agents 100] [--ramp 20] [--duration 60] [--wait 20]\n" +
			"       [--id-offset 0] [--insecure] [--report-interval 10] [--min-sync-interval-ms 250]\n" +
			"       [--syslog-lines N] [--syslog-event-every M]\n" +
			"       [--gui-url host:port] [--gui-clients K] [--gui-bytes 65536]",
	);
	process.exit(0);
}

const target = new URL(values.url);
const agentCount = Number(values.agents);
const rampMs = Number(values.ramp) * 1000;
const durationMs = Number(values.duration) * 1000;
const waitSeconds = Number(values.wait);
const idOffset = Number(values["id-offset"]);
const reportMs = Number(values["report-interval"]) * 1000;
/**
 * syncの最小の間隔。RouterのLuaは、syncごとにTLS handshakeから行うため、無制限には速く回れない
 * (想定値。RTX830の実測ではない)。これが無いと、WebGUIを中継している1台が毎秒数百回syncして、
 * 試験元のCPUを使い切る。
 */
const minSyncIntervalMs = Number(values["min-sync-interval-ms"]);
const syslogLines = Number(values["syslog-lines"]);
const syslogEventEvery = Number(values["syslog-event-every"]);
const guiClients = Number(values["gui-clients"]);
const guiBytes = Number(values["gui-bytes"]);
const [guiHost = "127.0.0.1", guiPortText = "18082"] = (
	values["gui-url"] ?? ""
).split(":");
const guiPort = Number(guiPortText);

type Window = {
	ok: number;
	early: number;
	failed: number;
	/** 待機時間(wait)を過ぎてからの遅れ(ms)。timeoutで返った応答だけ */
	late: number[];
	syslogLines: number;
	guiOk: number;
	guiFailed: number;
	guiMs: number[];
};
const newWindow = (): Window => ({
	ok: 0,
	early: 0,
	failed: 0,
	late: [],
	syslogLines: 0,
	guiOk: 0,
	guiFailed: 0,
	guiMs: [],
});
let window = newWindow();
const total = newWindow();
const errors = new Map<string, number>();
let stopping = false;
let started = 0;

function percentile(sorted: number[], p: number): number | null {
	if (sorted.length === 0) return null;
	return (
		sorted[
			Math.min(sorted.length - 1, Math.floor((sorted.length * p) / 100))
		] ?? null
	);
}

function summarize(w: Window, seconds: number) {
	const late = [...w.late].sort((a, b) => a - b);
	const gui = [...w.guiMs].sort((a, b) => a - b);
	return {
		syncOk: w.ok,
		syncEarly: w.early,
		syncFailed: w.failed,
		syncPerSec: Number(((w.ok + w.early) / seconds).toFixed(1)),
		lateMsP50: percentile(late, 50),
		lateMsP95: percentile(late, 95),
		lateMsP99: percentile(late, 99),
		...(syslogLines > 0 ? { syslogLinesSent: w.syslogLines } : {}),
		...(guiClients > 0
			? {
					guiOk: w.guiOk,
					guiFailed: w.guiFailed,
					guiMsP50: percentile(gui, 50),
					guiMsP95: percentile(gui, 95),
					guiMsMax: gui.at(-1) ?? null,
				}
			: {}),
	};
}

function count(map: Map<string, number>, key: string) {
	map.set(key, (map.get(key) ?? 0) + 1);
}

/**
 * 1回のsyncで送るframeの上限(byte)。RTX830の`rt.httprequest`の送信は640KBまでで、
 * 送り切れない分は、次のsyncで続ける。
 */
const MAX_SYNC_FRAME_BYTES = 256 * 1024;

function post(
	token: string,
	body: Uint8Array,
	wait: number,
): Promise<{ status: number; body: Buffer }> {
	return new Promise((resolve, reject) => {
		const doRequest = target.protocol === "https:" ? httpsRequest : httpRequest;
		const req = doRequest(
			{
				hostname: target.hostname,
				port: target.port || (target.protocol === "https:" ? 443 : 80),
				path: `/v1/tunnel/sync/${wait}`,
				method: "POST",
				agent: false, // syncごとに新しい接続
				rejectUnauthorized: !values.insecure,
				timeout: (wait + 30) * 1000,
				headers: {
					authorization: `Bearer ${token}`,
					"content-length": body.length,
					"content-type": "application/octet-stream",
					connection: "close",
				},
			},
			(res) => {
				const chunks: Buffer[] = [];
				res.on("data", (chunk: Buffer) => chunks.push(chunk));
				res.on("end", () =>
					resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks) }),
				);
				res.on("error", reject);
			},
		);
		req.on("timeout", () => req.destroy(new Error("timeout")));
		req.on("error", reject);
		req.end(Buffer.from(body));
	});
}

function syslogBatch(deviceNumber: number, sequence: number): Uint8Array {
	const lines: string[] = [];
	for (let i = 0; i < syslogLines; i++) {
		const n = sequence * syslogLines + i;
		lines.push(
			syslogEventEvery > 0 && n % syslogEventEvery === 0
				? `2026/10/06 12:00:00: IP Tunnel[1] ${n % (syslogEventEvery * 2) === 0 ? "Up" : "Down"}`
				: `2026/10/06 12:00:00: PP[01] Rejected at IN(default) filter: UDP 198.51.100.${deviceNumber % 250}:${10000 + (n % 5000)} > 203.0.113.1:500`,
		);
	}
	return encodeFrame(
		FrameType.SYSLOG,
		0,
		new TextEncoder().encode(`${lines.join("\n")}\n`),
	);
}

/** 転送先のRouterのGUIの代わり: STREAM_OPENに、HTTP応答をSTREAM_DATAで返す。 */
function guiResponse(streamId: number): Uint8Array[] {
	const head = `HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: ${guiBytes}\r\nConnection: close\r\n\r\n`;
	const payload = Buffer.concat([
		Buffer.from(head),
		Buffer.alloc(guiBytes, 0x61),
	]);
	const frames: Uint8Array[] = [];
	for (let offset = 0; offset < payload.length; offset += 8192) {
		frames.push(
			encodeFrame(
				FrameType.STREAM_DATA,
				streamId,
				payload.subarray(offset, offset + 8192),
			),
		);
	}
	frames.push(encodeFrame(FrameType.STREAM_CLOSE, streamId));
	return frames;
}

const sleep = (ms: number) =>
	new Promise<void>((resolve) => setTimeout(resolve, ms));

async function runAgent(number: number, startDelayMs: number) {
	const token = `tok-${number}`;
	const isGuiTarget = guiClients > 0 && number === 1;
	const pending: Uint8Array[] = [];
	let backoff = 1000;
	let sequence = 0;
	await sleep(startDelayMs);
	started++;
	while (!stopping) {
		const frames: Uint8Array[] = [];
		let frameBytes = 0;
		while (
			pending.length > 0 &&
			(frames.length === 0 || frameBytes < MAX_SYNC_FRAME_BYTES)
		) {
			const next = pending.shift() as Uint8Array;
			frames.push(next);
			frameBytes += next.length;
		}
		// 送り切れていない分があるときは、待たずに続きを送る
		const wait = pending.length > 0 ? 0 : waitSeconds;
		if (frames.length === 0) frames.push(encodeFrame(FrameType.HEARTBEAT, 0));
		if (syslogLines > 0) {
			frames.push(syslogBatch(number, sequence++));
			window.syslogLines += syslogLines;
		}
		const body = textEscape(concatFrames(frames));
		const began = performance.now();
		try {
			const response = await post(token, body, wait);
			if (response.status !== 200) throw new Error(`http ${response.status}`);
			const elapsed = performance.now() - began;
			const received = decodeFrames(cobsDecode(new Uint8Array(response.body)));
			for (const frame of received) {
				if (isGuiTarget && frame.type === FrameType.STREAM_OPEN) {
					pending.push(...guiResponse(frame.streamId));
				}
			}
			if (wait > 0 && elapsed >= wait * 1000 * 0.9) {
				window.ok++;
				window.late.push(Math.max(0, elapsed - wait * 1000));
			} else {
				window.early++;
			}
			backoff = 1000;
			const spent = performance.now() - began;
			if (spent < minSyncIntervalMs) await sleep(minSyncIntervalMs - spent);
		} catch (error) {
			window.failed++;
			count(
				errors,
				(error as NodeJS.ErrnoException).code ?? (error as Error).message,
			);
			if (stopping) break;
			await sleep(backoff);
			backoff = Math.min(backoff * 2, 30_000);
		}
	}
}

/** 擬似Browser: WebGUI relayへ、cookieつきのrequestを繰り返す。 */
async function runGuiClient() {
	while (!stopping) {
		const began = performance.now();
		try {
			const bytes = await new Promise<number>((resolve, reject) => {
				let received = 0;
				const socket = connect(guiPort, guiHost, () => {
					socket.write(
						`GET /index.html HTTP/1.1\r\nHost: router\r\nCookie: routemon_gui_session=dev-${idOffset + 1}\r\nConnection: close\r\n\r\n`,
					);
				});
				socket.setTimeout(30_000, () =>
					socket.destroy(new Error("gui timeout")),
				);
				socket.on("data", (chunk) => {
					received += chunk.length;
				});
				socket.on("end", () => resolve(received));
				socket.on("error", reject);
			});
			if (bytes < guiBytes) throw new Error(`short response ${bytes}`);
			window.guiOk++;
			window.guiMs.push(performance.now() - began);
		} catch (error) {
			window.guiFailed++;
			count(
				errors,
				`gui:${(error as NodeJS.ErrnoException).code ?? (error as Error).message}`,
			);
			await sleep(1000);
		}
		await sleep(100);
	}
}

function merge(into: Window, from: Window) {
	into.ok += from.ok;
	into.early += from.early;
	into.failed += from.failed;
	into.late.push(...from.late);
	into.syslogLines += from.syslogLines;
	into.guiOk += from.guiOk;
	into.guiFailed += from.guiFailed;
	into.guiMs.push(...from.guiMs);
}

console.error(
	`loadtest agents: ${agentCount} agents (ramp ${rampMs / 1000}s, wait ${waitSeconds}s, duration ${durationMs / 1000}s) -> ${values.url}` +
		(syslogLines > 0 ? `, syslog ${syslogLines} lines/sync` : "") +
		(guiClients > 0 ? `, gui ${guiClients} clients x ${guiBytes}B` : ""),
);

const beganAt = Date.now();
for (let i = 1; i <= agentCount; i++) {
	void runAgent(idOffset + i, Math.random() * rampMs);
}
for (let i = 0; i < guiClients; i++) {
	// WebGUIのrequestは、転送先のAgentが接続してから始める
	void sleep(rampMs + 2000 + i * 200).then(runGuiClient);
}

const reporter = setInterval(() => {
	const seconds = reportMs / 1000;
	console.log(
		JSON.stringify({
			t: new Date().toISOString(),
			elapsedSec: Math.round((Date.now() - beganAt) / 1000),
			agentsStarted: started,
			...summarize(window, seconds),
		}),
	);
	merge(total, window);
	window = newWindow();
}, reportMs);

setTimeout(() => {
	stopping = true;
	clearInterval(reporter);
	merge(total, window);
	const seconds = (Date.now() - beganAt) / 1000;
	console.log(
		JSON.stringify({
			summary: true,
			seconds: Math.round(seconds),
			agents: agentCount,
			...summarize(total, seconds),
			errors: Object.fromEntries(errors),
		}),
	);
	// 進行中のlong-pollを待たずに終える
	setTimeout(() => process.exit(0), 200);
}, durationMs);
