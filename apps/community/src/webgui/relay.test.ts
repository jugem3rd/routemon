import { mkdtempSync, rmSync } from "node:fs";
import {
	createServer as createHttpServer,
	type Server as HttpServer,
} from "node:http";
import { connect, type Server as NetServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	cobsDecode,
	concatFrames,
	decodeFrames,
	encodeFrame,
	FrameType,
	textEscape,
} from "@routemon/core";
import { AgentGateway, MemoryDeviceStore } from "@routemon/gateway";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { AuditLog } from "../auth/audit.ts";
import type { User } from "../auth/localAuth.ts";
import { nowIso } from "../storage/db.ts";
import {
	ensureDefaultTenant,
	openStorage,
	type Storage,
} from "../storage/index.ts";
import {
	createWebGuiRelay,
	GUI_SESSION_COOKIE,
	isDefineJs,
	parseRequestHead,
	readCookie,
	rebuildHead,
	rewriteDefineJs,
	stripCookie,
} from "./relay.ts";
import { NativeGuiSessions } from "./sessions.ts";

const TOKEN = "device-token";
const DEVICE_ID = "d1";
const ADMIN: User = {
	id: "u1",
	email: null,
	loginId: "admin",
	displayName: null,
	role: "admin",
};

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("helpers", () => {
	test("request headを解析する", () => {
		const raw = Buffer.from(
			"GET /define.js HTTP/1.1\r\nHost: x\r\nCookie: a=1; routemon_gui_session=s1\r\n\r\nbody",
		);
		const head = parseRequestHead(raw);
		expect(head?.method).toBe("GET");
		expect(head?.path).toBe("/define.js");
		expect(raw.subarray(head?.headEnd ?? 0).toString()).toBe("body");
		expect(readCookie("a=1; routemon_gui_session=s1", GUI_SESSION_COOKIE)).toBe(
			"s1",
		);
	});

	test("headerが揃うまではnullを返す", () => {
		expect(
			parseRequestHead(Buffer.from("GET / HTTP/1.1\r\nHost: x\r\n")),
		).toBeNull();
	});

	test("session cookieだけを除いて組み立て直す", () => {
		const head = parseRequestHead(
			Buffer.from(
				`GET / HTTP/1.1\r\nHost: x\r\nCookie: keep=1; ${GUI_SESSION_COOKIE}=s1; also=2\r\n\r\n`,
			),
		);
		const rebuilt = (
			head ? rebuildHead(head, GUI_SESSION_COOKIE) : Buffer.alloc(0)
		).toString();
		expect(rebuilt).toContain("Cookie: keep=1; also=2");
		expect(rebuilt).not.toContain(GUI_SESSION_COOKIE);
		expect(stripCookie(`${GUI_SESSION_COOKIE}=s1`, GUI_SESSION_COOKIE)).toBe(
			"",
		);
	});

	test("define.jsだけを書き換え対象にする", () => {
		expect(isDefineJs("/define.js")).toBe(true);
		expect(isDefineJs("/define.js?x=1")).toBe(true);
		expect(isDefineJs("/dashboard/define.js")).toBe(false);
		expect(
			rewriteDefineJs(
				Buffer.from('var a = { HTTPD_ACCESS: "GFW" };'),
			).toString(),
		).toBe('var a = { HTTPD_ACCESS: "DIRECT" };');
	});
});

describe("relay", () => {
	let root: string;
	let storage: Storage;
	let gateway: AgentGateway;
	let sessions: NativeGuiSessions;
	let webgui: HttpServer;
	let relay: NetServer;
	let relayPort: number;
	let agentRunning = true;
	let agentSockets: Socket[] = [];

	/** Routerのlocal WebGUIの代わり。 */
	async function startFakeWebGui(): Promise<number> {
		webgui = createHttpServer((req, res) => {
			let body = "";
			req.on("data", (chunk) => {
				body += chunk;
			});
			req.on("end", () => {
				res.setHeader("Connection", "close");
				if (req.url === "/define.js") {
					res.setHeader("Content-Type", "application/javascript");
					res.end('var conf = { HTTPD_ACCESS: "GFW" };');
					return;
				}
				res.setHeader("Content-Type", "text/plain");
				res.end(
					JSON.stringify({
						url: req.url,
						cookie: req.headers.cookie ?? null,
						body,
					}),
				);
			});
		});
		await new Promise<void>((resolve) =>
			webgui.listen(0, "127.0.0.1", resolve),
		);
		return (webgui.address() as { port: number }).port;
	}

	/** Agentの代わり: syncでframeを受け取り、local WebGUIへ中継する。 */
	function startFakeAgent(webguiPort: number) {
		const outgoing: Uint8Array[] = [];
		const streams = new Map<number, Socket>();
		agentRunning = true;
		void (async () => {
			while (agentRunning) {
				const body = outgoing.splice(0, outgoing.length);
				const response = await gateway.handleSync({
					authorization: `Bearer ${TOKEN}`,
					waitSeconds: 0,
					body: textEscape(
						body.length > 0
							? concatFrames(body)
							: encodeFrame(FrameType.HEARTBEAT, 0),
					),
					remoteAddress: "127.0.0.1",
				});
				for (const frame of decodeFrames(cobsDecode(response.body))) {
					if (frame.type === FrameType.STREAM_OPEN) {
						const id = frame.streamId;
						const socket = connect(webguiPort, "127.0.0.1", () =>
							socket.write(Buffer.from(frame.payload)),
						);
						agentSockets.push(socket);
						streams.set(id, socket);
						socket.on("data", (chunk) =>
							outgoing.push(
								encodeFrame(FrameType.STREAM_DATA, id, new Uint8Array(chunk)),
							),
						);
						socket.on("close", () => {
							streams.delete(id);
							outgoing.push(encodeFrame(FrameType.STREAM_CLOSE, id));
						});
						socket.on("error", () => socket.destroy());
					} else if (frame.type === FrameType.STREAM_DATA) {
						streams.get(frame.streamId)?.write(Buffer.from(frame.payload));
					} else if (frame.type === FrameType.STREAM_CLOSE) {
						streams.get(frame.streamId)?.end();
						streams.delete(frame.streamId);
					}
				}
				await delay(5);
			}
		})();
	}

	/** relayへHTTPを1往復投げ、生のレスポンスを返す。 */
	function request(raw: string): Promise<string> {
		return new Promise((resolve, reject) => {
			const chunks: Buffer[] = [];
			const socket = connect(relayPort, "127.0.0.1", () => socket.write(raw));
			socket.on("data", (chunk) => chunks.push(chunk));
			socket.on("close", () => resolve(Buffer.concat(chunks).toString()));
			socket.on("error", reject);
			socket.setTimeout(5000, () => socket.destroy());
		});
	}

	beforeEach(async () => {
		root = mkdtempSync(join(tmpdir(), "routemon-relay-"));
		storage = await openStorage({ root });
		const tenantId = ensureDefaultTenant(storage.db);
		const at = nowIso();
		storage.db
			.prepare(
				"INSERT INTO devices (id, tenant_id, name, lifecycle_status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
			)
			.run(DEVICE_ID, tenantId, "RTX830", "active", at, at);
		storage.db
			.prepare(
				"INSERT INTO users (id, login_id, created_at, updated_at) VALUES (?, ?, ?, ?)",
			)
			.run(ADMIN.id, ADMIN.loginId, at, at);
		storage.db
			.prepare(
				"INSERT INTO memberships (user_id, tenant_id, role, created_at) VALUES (?, ?, ?, ?)",
			)
			.run(ADMIN.id, tenantId, "admin", at);

		const store = new MemoryDeviceStore();
		store.add(DEVICE_ID, TOKEN);
		gateway = new AgentGateway({ store, coalesceWaitMs: 1 });
		sessions = new NativeGuiSessions(
			storage.db,
			tenantId,
			new AuditLog(storage.db, tenantId),
		);

		const webguiPort = await startFakeWebGui();
		startFakeAgent(webguiPort);
		await delay(30); // Agentを接続済みにする

		relay = createWebGuiRelay({ gateway, sessions, idleTimeoutMs: 5000 });
		await new Promise<void>((resolve) => relay.listen(0, "127.0.0.1", resolve));
		relayPort = (relay.address() as { port: number }).port;
	});

	afterEach(async () => {
		agentRunning = false;
		for (const socket of agentSockets) socket.destroy();
		agentSockets = [];
		relay.close();
		webgui.close();
		storage.close();
		rmSync(root, { recursive: true, force: true });
		await delay(20);
	});

	test("/session/<id>でcookieを発行してrootへ誘導する", async () => {
		const session = sessions.start(ADMIN, DEVICE_ID);
		const response = await request(
			`GET /session/${session.id} HTTP/1.1\r\nHost: gui\r\n\r\n`,
		);
		expect(response).toContain("302 Found");
		expect(response).toContain("Location: /");
		expect(response).toContain(`${GUI_SESSION_COOKIE}=${session.id}`);
		expect(response).toContain("HttpOnly");
	});

	test("存在しないsessionのcookieは発行しない", async () => {
		const response = await request(
			"GET /session/unknown HTTP/1.1\r\nHost: gui\r\n\r\n",
		);
		expect(response).toContain("404 Not Found");
	});

	test("session cookieが無ければ転送しない", async () => {
		const response = await request("GET / HTTP/1.1\r\nHost: gui\r\n\r\n");
		expect(response).toContain("401 Unauthorized");
	});

	test("cookieがあればRouterのWebGUIへ中継する", async () => {
		const session = sessions.start(ADMIN, DEVICE_ID);
		const response = await request(
			`GET /status HTTP/1.1\r\nHost: gui\r\nCookie: ${GUI_SESSION_COOKIE}=${session.id}; keep=1\r\n\r\n`,
		);
		expect(response).toContain("200 OK");
		const body = JSON.parse(response.slice(response.indexOf("\r\n\r\n") + 4));
		expect(body.url).toBe("/status");
		// Routemonのsession cookieはRouterへ渡さない
		expect(body.cookie).toBe("keep=1");
	});

	test("POST bodyを中継する", async () => {
		const session = sessions.start(ADMIN, DEVICE_ID);
		const payload = "name=test&value=1";
		const response = await request(
			`POST /submit HTTP/1.1\r\nHost: gui\r\nCookie: ${GUI_SESSION_COOKIE}=${session.id}\r\n` +
				`Content-Type: application/x-www-form-urlencoded\r\nContent-Length: ${payload.length}\r\n\r\n${payload}`,
		);
		const body = JSON.parse(response.slice(response.indexOf("\r\n\r\n") + 4));
		expect(body.body).toBe(payload);
	});

	test("/define.jsのGFW判定だけを書き換える", async () => {
		const session = sessions.start(ADMIN, DEVICE_ID);
		const response = await request(
			`GET /define.js HTTP/1.1\r\nHost: gui\r\nCookie: ${GUI_SESSION_COOKIE}=${session.id}\r\n\r\n`,
		);
		expect(response).toContain('HTTPD_ACCESS: "DIRECT"');
		expect(response).not.toContain('"GFW"');
	});

	test("Agentが繋がっていないDeviceは502", async () => {
		const at = nowIso();
		storage.db
			.prepare(
				"INSERT INTO devices (id, tenant_id, name, lifecycle_status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
			)
			.run("d2", ensureDefaultTenant(storage.db), "Other", "active", at, at);
		const session = sessions.start(ADMIN, "d2");
		const response = await request(
			`GET / HTTP/1.1\r\nHost: gui\r\nCookie: ${GUI_SESSION_COOKIE}=${session.id}\r\n\r\n`,
		);
		expect(response).toContain("502 Bad Gateway");
	});

	test("session終了後は転送しない", async () => {
		const session = sessions.start(ADMIN, DEVICE_ID);
		sessions.end(session.id);
		const response = await request(
			`GET / HTTP/1.1\r\nHost: gui\r\nCookie: ${GUI_SESSION_COOKIE}=${session.id}\r\n\r\n`,
		);
		expect(response).toContain("401 Unauthorized");
	});
});
