/**
 * WebGUI relay(docs/core/webgui-relay-design.md、#27)。
 *
 * Browserの接続をそのままAgent GatewayのStreamへ流す。HTMLやJavaScriptは
 * 書き換えず、必要なL7補正(`/define.js`)だけをServer側で行う。
 *
 * Browserからの到達方式:
 * - WebGUI転送専用のorigin(Routemon本体とは別port)で待ち受ける
 * - `/session/<id>`でsession cookieを発行し、以後はそのcookieでDeviceを決める
 * - origin全体が転送先のGUIになるため、root-relativeなURLがそのまま動く
 * - 同時に開けるNative WebGUIは1つ(新しいsessionが前のsessionを置き換える)
 */
import { createServer, type Server } from "node:net";
import type { AgentGateway, StreamHandle } from "@routemon/gateway";
import type { NativeGuiSessions } from "./sessions.ts";

export const GUI_SESSION_COOKIE = "routemon_gui_session";
const MAX_HEAD_BYTES = 16 * 1024;
const DEFAULT_IDLE_TIMEOUT_MS = 30_000;

const REWRITE_FROM = 'HTTPD_ACCESS: "GFW"';
const REWRITE_TO = 'HTTPD_ACCESS: "DIRECT"';

export type RelayOptions = {
	gateway: AgentGateway;
	sessions: NativeGuiSessions;
	idleTimeoutMs?: number;
	logger?: { warn(msg: string): void };
};

export type RequestHead = {
	method: string;
	path: string;
	headers: [string, string][];
	headEnd: number;
};

/** requestのheader部分を解析する。headerが揃っていなければnull。 */
export function parseRequestHead(data: Buffer): RequestHead | null {
	const headEnd = data.indexOf("\r\n\r\n");
	if (headEnd < 0) return null;
	const lines = data.subarray(0, headEnd).toString("latin1").split("\r\n");
	const [method = "", path = ""] = (lines[0] ?? "").split(" ");
	const headers: [string, string][] = [];
	for (const line of lines.slice(1)) {
		const index = line.indexOf(":");
		if (index > 0)
			headers.push([line.slice(0, index), line.slice(index + 1).trim()]);
	}
	return { method, path, headers, headEnd: headEnd + 4 };
}

export function getHeader(head: RequestHead, name: string): string | undefined {
	const lower = name.toLowerCase();
	return head.headers.find(([key]) => key.toLowerCase() === lower)?.[1];
}

export function readCookie(
	cookieHeader: string | undefined,
	name: string,
): string | undefined {
	if (!cookieHeader) return undefined;
	for (const part of cookieHeader.split(";")) {
		const [key, ...rest] = part.trim().split("=");
		if (key === name) return rest.join("=");
	}
	return undefined;
}

/** Routemonのsession cookieをRouterへ転送しない。 */
export function stripCookie(cookieHeader: string, name: string): string {
	return cookieHeader
		.split(";")
		.map((part) => part.trim())
		.filter((part) => part.split("=")[0] !== name)
		.join("; ");
}

/** headerを組み立て直す(Cookieからはsession cookieを除く)。 */
export function rebuildHead(head: RequestHead, cookieName: string): Buffer {
	const lines = [`${head.method} ${head.path} HTTP/1.1`];
	for (const [key, value] of head.headers) {
		if (key.toLowerCase() === "cookie") {
			const remaining = stripCookie(value, cookieName);
			if (remaining) lines.push(`${key}: ${remaining}`);
			continue;
		}
		lines.push(`${key}: ${value}`);
	}
	return Buffer.from(`${lines.join("\r\n")}\r\n\r\n`, "latin1");
}

export function isDefineJs(path: string): boolean {
	return (path.split("?")[0] ?? "") === "/define.js";
}

/**
 * Router自身がGFW(YNOのGUI Forwarder)経由と判定すると、WebGUI側のpath組み立てが
 * 壊れるため、`/define.js`のレスポンスだけを書き換える(#1の実機調査)。
 */
export function rewriteDefineJs(body: Buffer): Buffer {
	return Buffer.from(
		body.toString("latin1").split(REWRITE_FROM).join(REWRITE_TO),
		"latin1",
	);
}

function httpResponse(
	status: string,
	body: string,
	extraHeaders: string[] = [],
): Buffer {
	const payload = Buffer.from(body, "utf8");
	const head = [
		`HTTP/1.1 ${status}`,
		"Content-Type: text/plain; charset=utf-8",
		`Content-Length: ${payload.length}`,
		"Connection: close",
		...extraHeaders,
		"",
		"",
	].join("\r\n");
	return Buffer.concat([Buffer.from(head, "latin1"), payload]);
}

export function createWebGuiRelay(options: RelayOptions): Server {
	const idleTimeout = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;

	return createServer((socket) => {
		let buffer = Buffer.alloc(0);
		let stream: StreamHandle | null = null;
		let rewriteBuffer: Buffer[] | null = null;

		socket.setTimeout(idleTimeout, () => socket.destroy());
		socket.on("error", () => socket.destroy());

		const onHead = (head: RequestHead) => {
			// session cookieの発行(Routemon本体から開かれる入口)
			const sessionPath = head.path.match(/^\/session\/([\w-]+)/);
			if (sessionPath) {
				const session = options.sessions.get(sessionPath[1] as string);
				if (!session) {
					socket.end(httpResponse("404 Not Found", "session not found"));
					return;
				}
				socket.end(
					httpResponse("302 Found", "", [
						"Location: /",
						`Set-Cookie: ${GUI_SESSION_COOKIE}=${session.id}; HttpOnly; SameSite=Lax; Path=/`,
					]),
				);
				return;
			}

			const sessionId = readCookie(
				getHeader(head, "cookie"),
				GUI_SESSION_COOKIE,
			);
			const session = sessionId ? options.sessions.get(sessionId) : undefined;
			if (!session) {
				socket.end(
					httpResponse("401 Unauthorized", "no active native webgui session"),
				);
				return;
			}

			const initial = Buffer.concat([
				rebuildHead(head, GUI_SESSION_COOKIE),
				buffer.subarray(head.headEnd),
			]);
			buffer = Buffer.alloc(0);
			if (isDefineJs(head.path)) rewriteBuffer = [];

			try {
				stream = options.gateway.openStream(
					session.deviceId,
					new Uint8Array(initial),
					{
						onData: (data) => {
							const chunk = Buffer.from(data);
							if (rewriteBuffer) {
								rewriteBuffer.push(chunk);
							} else {
								socket.write(chunk);
							}
						},
						onClose: () => {
							if (rewriteBuffer) {
								socket.write(rewriteDefineJs(Buffer.concat(rewriteBuffer)));
								rewriteBuffer = null;
							}
							stream = null;
							socket.end();
						},
					},
				);
			} catch (error) {
				options.logger?.warn(`webgui relay: ${(error as Error).message}`);
				socket.end(httpResponse("502 Bad Gateway", "device not connected"));
			}
		};

		socket.on("data", (chunk) => {
			if (stream) {
				stream.send(new Uint8Array(chunk));
				return;
			}
			buffer = Buffer.concat([buffer, chunk]);
			if (buffer.length > MAX_HEAD_BYTES) {
				socket.end(
					httpResponse(
						"431 Request Header Fields Too Large",
						"request header too large",
					),
				);
				return;
			}
			const head = parseRequestHead(buffer);
			if (head) onHead(head);
		});

		socket.on("close", () => {
			stream?.close();
			stream = null;
		});
	});
}
