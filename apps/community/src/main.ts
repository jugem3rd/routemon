import { existsSync, readFileSync } from "node:fs";
import type { Server } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getRequestListener, serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { FrameType } from "@routemon/core";
import { AgentGateway, createAgentEndpoint } from "@routemon/gateway";
import { Hono } from "hono";
import { AgentUpdates } from "./agent/agentUpdates.ts";
import { installBundledAgent } from "./agent/bundledAgent.ts";
import {
	GatewayEndpointsNotifier,
	parseGatewayEndpoints,
} from "./agent/gatewayEndpoints.ts";
import { createApp } from "./app.ts";
import { AuditLog } from "./auth/audit.ts";
import { LocalAuth } from "./auth/localAuth.ts";
import { ConfigApplies } from "./config/configApplies.ts";
import { ConfigApplyBatches } from "./config/configApplyBatches.ts";
import {
	CHECKPOINT_SWEEP_INTERVAL_MS,
	ConfigCheckpoints,
} from "./config/configCheckpoints.ts";
import { ConfigSnapshots } from "./config/configSnapshots.ts";
import {
	CONFIG_RECONCILE_CHECK_MS,
	ConfigReconciler,
} from "./config/reconcile.ts";
import { DeviceRuntime, RUNTIME_REFRESH_MS } from "./devices/runtime.ts";
import { createDeviceStore, Enrollment } from "./enrollment/enrollment.ts";
import { PresenceEvents } from "./events/presence.ts";
import { EventRecorder } from "./events/recorder.ts";
import { Jobs } from "./jobs/jobs.ts";
import { createEnrollmentDeviceRoutes } from "./routes/enrollment.ts";
import {
	ROUTE_TABLE_RECONCILE_CHECK_MS,
	RouteTableCollector,
} from "./routeTables/collector.ts";
import { RouteTableRepository } from "./routeTables/repository.ts";
import { writeCaddyfile } from "./setup/caddy.ts";
import { Setup } from "./setup/setup.ts";
import {
	createShutdown,
	installShutdownSignals,
	trackNetServer,
} from "./shutdown.ts";
import {
	DEFAULT_SYSLOG_POLICY,
	ensureDefaultTenant,
	openStorage,
} from "./storage/index.ts";
import { SyslogEventExtractor } from "./syslog/events.ts";
import { SyslogService } from "./syslog/service.ts";
import { createWebGuiRelay } from "./webgui/relay.ts";
import { NativeGuiSessions } from "./webgui/sessions.ts";

const port = Number(process.env.PORT ?? 8080);
// Agent APIは別のlistenerで受ける(Agent API以外を同じlistenerへ出さない、
// docs/core/agent-gateway-design.md §3)。CommunityではCaddyがTLSを終端する。
const agentPort = Number(process.env.AGENT_PORT ?? 8081);
const presenceSweepMs = Number(process.env.PRESENCE_SWEEP_MS ?? 10_000);
const configApplyVerifySweepMs = 10_000;
// Native WebGUIはRoutemon本体とは別のoriginで受ける(docs/core/webgui-relay-design.md)
const guiPort = Number(process.env.GUI_PORT ?? 8082);
const guiBaseUrl = process.env.GUI_BASE_URL ?? "";
const syslogCleanupMs = Number(process.env.SYSLOG_CLEANUP_MS ?? 3_600_000);

// SQLiteを開き、migrationを適用する。失敗した場合は通常起動しない
// (docs/community/storage-backup-design.md)。
const storage = await openStorage();
console.log(`storage ready: ${storage.paths.root}`);
const tenantId = ensureDefaultTenant(storage.db);
const auth = new LocalAuth(storage.db, tenantId);
const audit = new AuditLog(storage.db, tenantId);
const webguiSessions = new NativeGuiSessions(storage.db, tenantId, audit);
setInterval(() => auth.purgeExpiredSessions(), 3_600_000).unref();

// credentialはEnrollment(#23)が発行し、SQLiteのdevice_credentialsで検証する
const store = createDeviceStore(storage.db);

let syslogService: SyslogService | undefined;
let configSnapshots: ConfigSnapshots | undefined;
let configApplies: ConfigApplies | undefined;
let configApplyBatches: ConfigApplyBatches | undefined;
let configCheckpoints: ConfigCheckpoints | undefined;
let deviceRuntime: DeviceRuntime | undefined;
let agentUpdates: AgentUpdates | undefined;
let gatewayEndpoints: GatewayEndpointsNotifier | undefined;
let presenceEvents: PresenceEvents | undefined;
const gateway = new AgentGateway({
	store,
	logger: console,
	onFrame: (deviceId, frame) => {
		if (frame.type === FrameType.AGENT_STATUS) {
			try {
				const status = agentUpdates?.handleStatus(deviceId, frame.payload);
				// 対応済みのAgentへ、接続先の一覧を通知する(#147)
				if (status) gatewayEndpoints?.notify(deviceId, status.version);
			} catch (error) {
				console.warn(
					`agent status failed for ${deviceId}: ${(error as Error).message}`,
				);
			}
			return;
		}
		if (frame.type === FrameType.CONFIG_BACKUP) {
			// CONFIG本文はlogへ出さない(docs/core/config-backup-design.md §7)
			void configSnapshots
				?.ingest(deviceId, frame.payload)
				.then((result) => {
					configCheckpoints?.handleSnapshot(deviceId, result);
					return configApplyBatches
						?.handleSnapshot(deviceId, result)
						.then(() => configApplies?.handleSnapshot(deviceId, result));
				})
				.catch((error) => {
					console.warn(
						`config snapshot ingest failed for ${deviceId}: ${(error as Error).message}`,
					);
				});
			return;
		}
		if (frame.type === FrameType.SYSLOG) {
			void syslogService
				?.handleBatch(deviceId, frame.payload)
				.catch((error) => {
					console.warn(`syslog batch failed: ${(error as Error).message}`);
				});
			return;
		}
		console.warn(
			`unhandled frame type 0x${frame.type.toString(16)} from ${deviceId}`,
		);
	},
	onPresenceChange: (presence) => {
		console.log(`presence ${presence.deviceId}: ${presence.status}`);
		try {
			presenceEvents?.handle(presence);
		} catch (error) {
			console.warn(
				`presence event failed for ${presence.deviceId}: ${(error as Error).message}`,
			);
		}
		// 接続し直したら起動時刻を測り直す(再起動していれば変わる、#54)
		if (presence.status === "online") {
			// Gatewayの再起動後など、AGENT_STATUSを待たずに接続先の一覧を通知する(#147)
			gatewayEndpoints?.notify(
				presence.deviceId,
				agentUpdates?.state(presence.deviceId).agentVersion,
			);
			void deviceRuntime?.probe(presence.deviceId).catch(() => null);
		}
		// 再接続時はAgent側のLive modeがoffに戻っているため、購読者が居れば再通知する
		if (presence.status === "online")
			syslogService?.resyncLive(presence.deviceId);
	},
});
configSnapshots = new ConfigSnapshots({
	db: storage.db,
	tenantId,
	backups: storage.configBackups,
	gateway,
	audit,
});
const configReconciler = new ConfigReconciler({
	db: storage.db,
	tenantId,
	gateway,
	configSnapshots,
});
void configReconciler.sweep().catch((error) => {
	console.warn(`config reconcile failed: ${(error as Error).message}`);
});
setInterval(() => {
	void configReconciler.sweep().catch((error) => {
		console.warn(`config reconcile failed: ${(error as Error).message}`);
	});
}, CONFIG_RECONCILE_CHECK_MS).unref();
const routeTableRepository = new RouteTableRepository(storage.db);
const routeTableCollector = new RouteTableCollector({
	db: storage.db,
	tenantId,
	gateway,
	repository: routeTableRepository,
});
void routeTableCollector.sweep().catch((error) => {
	console.warn(`route table sweep failed: ${(error as Error).message}`);
});
setInterval(() => {
	void routeTableCollector.sweep().catch((error) => {
		console.warn(`route table sweep failed: ${(error as Error).message}`);
	});
}, ROUTE_TABLE_RECONCILE_CHECK_MS).unref();
setInterval(() => gateway.sweepPresence(), presenceSweepMs).unref();

// Agent artifactの配布(Bootstrap / Supervisorが取得する)とversion管理(#35)
const agentReleaseDir = storage.paths.agentReleases;
// imageへ同梱したAgentを配置する。新規installでEnrollmentが通るために必要で、
// version宣言が読めない壊れたimageは、ここで起動を失敗させる(#2)。
{
	const bundled = installBundledAgent({
		sourcePath:
			process.env.AGENT_BUNDLE_PATH ??
			join(
				dirname(fileURLToPath(import.meta.url)),
				"../../../agent/https_tunnel_agent.lua",
			),
		releaseDir: agentReleaseDir,
	});
	console.log(
		`bundled agent ${bundled.version}: stable ${bundled.stableWritten ? `updated (was ${bundled.previousStable ?? "none"})` : "kept"}, release ${bundled.releaseWritten ? "written" : "kept"}`,
	);
}
// Structured Eventの記録(フラッピングのまとめ、1日の上限、保持期間。#158)
const eventRecorder = new EventRecorder({
	db: storage.db,
	tenantId,
	flapWindowMs: Number(process.env.EVENT_FLAP_WINDOW_MS) || undefined,
	flapThreshold: Number(process.env.EVENT_FLAP_THRESHOLD) || undefined,
	dailyCap: Number(process.env.EVENT_DAILY_CAP) || undefined,
	retentionDays: Number(process.env.EVENT_RETENTION_DAYS) || undefined,
});
presenceEvents = new PresenceEvents({ recorder: eventRecorder });
setInterval(
	() => {
		try {
			const deleted = eventRecorder.cleanup();
			if (deleted > 0) console.log(`events cleanup: deleted ${deleted}`);
		} catch (error) {
			console.warn(`events cleanup failed: ${(error as Error).message}`);
		}
	},
	Number(process.env.EVENT_CLEANUP_MS ?? 86_400_000),
).unref();
agentUpdates = new AgentUpdates({
	db: storage.db,
	tenantId,
	gateway,
	audit,
	releaseDir: agentReleaseDir,
	events: eventRecorder,
});

deviceRuntime = new DeviceRuntime({
	db: storage.db,
	tenantId,
	gateway,
	events: eventRecorder,
});
setInterval(() => {
	void deviceRuntime?.sweep().catch((error) => {
		console.warn(`runtime sweep failed: ${(error as Error).message}`);
	});
}, RUNTIME_REFRESH_MS).unref();

const jobs = new Jobs(storage.db, tenantId, gateway, audit);
configApplies = new ConfigApplies({
	db: storage.db,
	tenantId,
	gateway,
	snapshots: configSnapshots,
	jobs,
	audit,
});
configApplyBatches = new ConfigApplyBatches({
	db: storage.db,
	tenantId,
	gateway,
	snapshots: configSnapshots,
	applies: configApplies,
	audit,
});
configApplyBatches.recoverAfterRestart();
configApplies.recoverAfterRestart();
setInterval(() => {
	void configApplyBatches?.sweep().catch((error) => {
		console.warn(
			`CONFIG Apply Batch sweep failed: ${(error as Error).message}`,
		);
	});
}, 1_000).unref();
setInterval(() => {
	try {
		configApplies?.expireVerificationOperations();
	} catch (error) {
		console.warn(
			`CONFIG Apply verification expiry failed: ${(error as Error).message}`,
		);
	}
}, configApplyVerifySweepMs).unref();
configCheckpoints = new ConfigCheckpoints({
	db: storage.db,
	tenantId,
	snapshots: configSnapshots,
	audit,
});
configCheckpoints.recoverAfterRestart();
setInterval(() => {
	configCheckpoints?.expirePending();
}, CHECKPOINT_SWEEP_INTERVAL_MS).unref();
syslogService = new SyslogService(gateway, storage.syslog, Date.now, {
	configSnapshots,
	onConfigSaved: (deviceId) => configApplies?.handleConfigSaved(deviceId),
	// PPPoE・IP Tunnelの状態変化、WANのIPアドレスの変更をEventにする(#6)
	events: new SyslogEventExtractor({ recorder: eventRecorder }),
});
// 予約した再起動(#54)。Server再起動後もDBに残った予約を拾う
const scheduleTickMs = Number(process.env.SCHEDULE_TICK_MS ?? 30_000);
setInterval(() => {
	void jobs.runDue().catch((error) => {
		console.warn(`scheduled job failed: ${(error as Error).message}`);
	});
}, scheduleTickMs).unref();
// Routerから見たRoutemonのbase URLとAgent Gateway endpoint(#12のSetupで設定する)。
// Public URLはSetup Wizardで起動後に決まるため、起動時の値を固定せず、使うたびに読む。
const setup = new Setup(storage.db, auth);
const agentBaseUrl = (): string =>
	process.env.AGENT_BASE_URL ??
	process.env.PUBLIC_BASE_URL ??
	setup.status().publicBaseUrl ??
	`http://localhost:${port}`;
// Agentへ通知する接続先の一覧(カンマ区切り、先頭が優先)。既定はAGENT_BASE_URL(#147)。
// 接続先を変更するときは、古い接続先がまだ使えるうちに、この値を新しい接続先へ変える。
if (
	process.env.AGENT_ENDPOINTS &&
	!parseGatewayEndpoints(process.env.AGENT_ENDPOINTS)
) {
	console.warn(
		"AGENT_ENDPOINTS is not a valid gateway endpoint list; endpoint updates are disabled",
	);
}
gatewayEndpoints = new GatewayEndpointsNotifier({
	gateway,
	endpoints: () =>
		parseGatewayEndpoints(process.env.AGENT_ENDPOINTS ?? agentBaseUrl()),
	log: (message) => console.log(message),
});
const enrollment = new Enrollment(storage.db, tenantId, audit, {
	gatewayUrl: agentBaseUrl,
	agentVersion: process.env.AGENT_VERSION ?? "stable",
});
if (!setup.status().initialized) {
	console.log("setup is not completed: open the GUI and follow /setup");
}

// Public URLからCaddy設定を生成する(利用者にCaddyfileを編集させない、#12)。
// CADDY_CONFIG_PATHが無い環境(開発や外部Reverse Proxy)では何もしない。
const caddyConfigPath = process.env.CADDY_CONFIG_PATH;
function syncCaddy(): void {
	const url = setup.status().publicBaseUrl;
	if (!caddyConfigPath || !url) return;
	try {
		if (
			writeCaddyfile(caddyConfigPath, url, {
				app: `routemon:${port}`,
				agent: `routemon:${agentPort}`,
				webgui: `routemon:${guiPort}`,
				webguiPort: Number(process.env.GUI_PUBLIC_PORT ?? 8443),
			})
		) {
			console.log(`caddy config updated: ${caddyConfigPath}`);
		}
	} catch (error) {
		console.warn(`caddy config update failed: ${(error as Error).message}`);
	}
}
syncCaddy();
setInterval(syncCaddy, 30_000).unref();

const app = createApp({
	auth,
	audit,
	setup,
	jobs,
	configApplies,
	configApplyBatches,
	configCheckpoints,
	backups: { db: storage.db, paths: storage.paths },
	devices: {
		db: storage.db,
		tenantId,
		gateway,
		config: configSnapshots,
		updates: agentUpdates,
		cleanupDeviceData: storage.deleteDeviceData,
	},
	routeTables: {
		db: storage.db,
		tenantId,
		collector: routeTableCollector,
	},
	// Enrollment /v1 endpoints are hosted by the Agent API listener. In a
	// split-port deployment the Router must reach AGENT_BASE_URL directly.
	enrollment: { service: enrollment, baseUrl: agentBaseUrl },
	syslog: { service: syslogService, db: storage.db, tenantId },
	webguiSessions,
	secureCookie: process.env.INSECURE_COOKIE !== "1",
	guiBaseUrl,
});
setInterval(() => {
	void storage.syslog.cleanup(DEFAULT_SYSLOG_POLICY).catch((error) => {
		console.warn(`syslog cleanup failed: ${(error as Error).message}`);
	});
}, syslogCleanupMs).unref();

// 通常はCaddyがTLSを終端する(#12)。開発・実機検証用に直接TLSも張れるようにする。
const certFile = process.env.CERT_FILE;
const keyFile = process.env.KEY_FILE;
const tls =
	certFile && keyFile
		? { cert: readFileSync(certFile), key: readFileSync(keyFile) }
		: undefined;

// Router向けのEnrollment endpointはAgent向けlistenerに載せる
// (docs/core/device-enrollment-design.md §5)
const routerApp = new Hono();
routerApp.route(
	"/",
	createEnrollmentDeviceRoutes(enrollment, { baseUrl: agentBaseUrl }),
);

const agentServer = createAgentEndpoint({
	gateway,
	tls,
	fallback: getRequestListener(routerApp.fetch),
	releases: {
		dir: agentReleaseDir,
		resolveCredential: (credential) => store.resolveCredential(credential),
	},
}).listen(agentPort, () => {
	console.log(`Routemon agent endpoint listening on port ${agentPort}`);
});

const guiServer = createWebGuiRelay({
	gateway,
	sessions: webguiSessions,
	logger: console,
}).listen(guiPort, () => {
	console.log(`Routemon webgui relay listening on port ${guiPort}`);
});

// GUI(#28)のbuild成果物。無ければAPIだけを提供する(devはViteのproxyを使う)。
const webDir =
	process.env.WEB_DIR ??
	join(dirname(fileURLToPath(import.meta.url)), "../../../packages/web/dist");
if (existsSync(join(webDir, "index.html"))) {
	app.use("/*", serveStatic({ root: webDir }));
	// hash routingなので、未知のpathはindex.htmlへ寄せるだけでよい
	app.notFound((c) => c.html(readFileSync(join(webDir, "index.html"), "utf8")));
	console.log(`Routemon GUI served from ${webDir}`);
}

const apiServer = serve({ fetch: app.fetch, port }, (info) => {
	console.log(`Routemon Community listening on port ${info.port}`);
}) as Server;

// 停止シグナルを受けたら、待機中のlong-pollを返し、進行中のリクエストを待ってから終了する(#151)
installShutdownSignals(
	createShutdown({
		servers: [agentServer, trackNetServer(guiServer), apiServer],
		beforeClose: () => gateway.shutdown(),
		afterClose: () => storage.close(),
		graceMs: Number(process.env.SHUTDOWN_GRACE_MS ?? 5_000),
		log: (message) => console.log(message),
	}),
);
