/**
 * Gatewayの負荷試験用server(#7、docs/community/loadtest.md)。
 *
 * Community Serverと同じ`AgentGateway`とAgent endpointを、認証に`MemoryDeviceStore`を使って
 * 起動する。実際のSYSLOG経路(`SyslogService`、Raw SYSLOGのfile保存、Event抽出)とWebGUI relayも
 * 載せられる。数秒ごとに、CPU・memory・FD・接続数を1行のJSONで出力する。
 *
 *   node scripts/loadtest/server.ts --devices 1000 --port 18081
 *
 * 認証: Device `dev-N`のcredentialは`tok-N`(N = 1..--devices)。
 */
import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
} from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { FrameType } from "@routemon/core";
import {
	AgentGateway,
	createAgentEndpoint,
	MemoryDeviceStore,
} from "@routemon/gateway";
import { EventRecorder } from "../../apps/community/src/events/recorder.ts";
import {
	ensureDefaultTenant,
	openStorage,
} from "../../apps/community/src/storage/index.ts";
import { SyslogEventExtractor } from "../../apps/community/src/syslog/events.ts";
import { SyslogService } from "../../apps/community/src/syslog/service.ts";
import { createWebGuiRelay } from "../../apps/community/src/webgui/relay.ts";

const { values } = parseArgs({
	options: {
		port: { type: "string", default: "18081" },
		"gui-port": { type: "string", default: "18082" },
		devices: { type: "string", default: "1000" },
		"tls-cert": { type: "string" },
		"tls-key": { type: "string" },
		"stats-interval": { type: "string", default: "5" },
		"no-storage": { type: "boolean", default: false },
		"data-dir": { type: "string" },
		help: { type: "boolean", default: false },
	},
});

if (values.help) {
	console.log(
		"usage: node scripts/loadtest/server.ts [--port 18081] [--gui-port 18082 (0で無効)] [--devices 1000]\n" +
			"       [--tls-cert cert.pem --tls-key key.pem] [--stats-interval 5] [--no-storage] [--data-dir DIR]",
	);
	process.exit(0);
}

const port = Number(values.port);
const guiPort = Number(values["gui-port"]);
const deviceCount = Number(values.devices);
const statsIntervalMs = Number(values["stats-interval"]) * 1000;

const store = new MemoryDeviceStore();
for (let i = 1; i <= deviceCount; i++) store.add(`dev-${i}`, `tok-${i}`);

const counters = {
	syslogFrames: 0,
	syslogBytes: 0,
	syslogLines: 0,
	warnings: 0,
	otherFrames: 0,
	guiStreams: 0,
};

// SYSLOGの実経路(保存とEvent抽出)を載せる。--no-storageなら、受け取って数えるだけ
let cleanup: () => void = () => {};
let syslogService: SyslogService | undefined;
const dataDir =
	values["data-dir"] ?? mkdtempSync(join(tmpdir(), "routemon-loadtest-"));
if (!values["no-storage"]) {
	mkdirSync(dataDir, { recursive: true });
}

const gateway: AgentGateway = new AgentGateway({
	store,
	logger: {
		info() {},
		warn() {
			counters.warnings++;
		},
	},
	onFrame: (deviceId, frame) => {
		if (frame.type === FrameType.SYSLOG) {
			counters.syslogFrames++;
			counters.syslogBytes += frame.payload.length;
			if (syslogService) {
				void syslogService.handleBatch(deviceId, frame.payload).then(
					(lines) => {
						counters.syslogLines += lines.length;
					},
					() => {
						counters.warnings++;
					},
				);
			}
			return;
		}
		counters.otherFrames++;
	},
});

if (!values["no-storage"]) {
	const storage = await openStorage({ root: dataDir });
	const tenantId = ensureDefaultTenant(storage.db);
	// Eventの記録先(device_events)は、Deviceが存在する必要がある(外部キー)
	const at = new Date().toISOString();
	const insert = storage.db.prepare(
		"INSERT INTO devices (id, tenant_id, name, lifecycle_status, created_at, updated_at) VALUES (?, ?, ?, 'active', ?, ?)",
	);
	storage.db.exec("BEGIN");
	for (let i = 1; i <= deviceCount; i++) {
		insert.run(`dev-${i}`, tenantId, `dev-${i}`, at, at);
	}
	storage.db.exec("COMMIT");
	const recorder = new EventRecorder({ db: storage.db, tenantId });
	syslogService = new SyslogService(gateway, storage.syslog, Date.now, {
		events: new SyslogEventExtractor({ recorder }),
	});
	cleanup = () => {
		storage.close();
		if (!values["data-dir"]) rmSync(dataDir, { recursive: true, force: true });
	};
}

const tls =
	values["tls-cert"] && values["tls-key"]
		? {
				cert: readFileSync(values["tls-cert"]),
				key: readFileSync(values["tls-key"]),
			}
		: undefined;
const agentServer: Server = createAgentEndpoint({ gateway, tls });
agentServer.listen(port, () => {
	console.error(
		`loadtest server: agent endpoint on :${port} (${tls ? "https" : "http"}), ${deviceCount} devices` +
			`, syslog ${syslogService ? "stored to " + dataDir : "counted only"}`,
	);
});

// WebGUI relay。sessionのcookieの値(`routemon_gui_session`)をそのままDevice idとして扱う
let guiServer: ReturnType<typeof createWebGuiRelay> | undefined;
if (guiPort > 0) {
	guiServer = createWebGuiRelay({
		gateway,
		sessions: {
			get: (id: string) => {
				counters.guiStreams++;
				return { id, deviceId: id };
			},
		} as never,
		logger: { warn: () => counters.warnings++ },
	});
	guiServer.listen(guiPort, () => {
		console.error(`loadtest server: webgui relay on :${guiPort}`);
	});
}

function fdCount(): number | null {
	for (const dir of ["/proc/self/fd", "/dev/fd"]) {
		try {
			return readdirSync(dir).length;
		} catch {
			// 次の候補
		}
	}
	return null;
}

function connections(
	server:
		| {
				getConnections(
					cb: (error: Error | null, count: number) => void,
				): unknown;
		  }
		| undefined,
): Promise<number> {
	return new Promise((resolve) => {
		if (!server) return resolve(0);
		server.getConnections((error, count) => resolve(error ? -1 : count));
	});
}

let lastCpu = process.cpuUsage();
let lastAt = Date.now();
const timer = setInterval(async () => {
	// FDが尽きているとき、統計の取得自体が`EMFILE`で失敗する(memoryUsageもFDを使う)。
	// 試験用serverを、統計の失敗で落とさない
	try {
		const nowAt = Date.now();
		const cpu = process.cpuUsage();
		const cpuMs =
			(cpu.user - lastCpu.user + cpu.system - lastCpu.system) / 1000;
		const cpuPct = (cpuMs / (nowAt - lastAt)) * 100;
		lastCpu = cpu;
		lastAt = nowAt;
		const mem = process.memoryUsage();
		console.log(
			JSON.stringify({
				t: new Date(nowAt).toISOString(),
				cpuPct: Number(cpuPct.toFixed(1)),
				rssMb: Math.round(mem.rss / 1048576),
				heapMb: Math.round(mem.heapUsed / 1048576),
				fds: fdCount(),
				agentConns: await connections(agentServer),
				guiConns: await connections(guiServer),
				devicesSeen: gateway.observedDevices().length,
				...counters,
			}),
		);
	} catch (error) {
		console.log(
			JSON.stringify({
				t: new Date().toISOString(),
				statsError:
					(error as NodeJS.ErrnoException).code ?? (error as Error).message,
				...counters,
			}),
		);
	}
}, statsIntervalMs);
timer.unref();

function shutdown() {
	clearInterval(timer);
	agentServer.close();
	guiServer?.close();
	void gateway.shutdown();
	setTimeout(() => {
		cleanup();
		process.exit(0);
	}, 500).unref();
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
