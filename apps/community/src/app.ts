import type { AgentGateway } from "@routemon/gateway";
import { Hono } from "hono";
import type { AgentUpdates } from "./agent/agentUpdates.ts";
import type { AuditLog } from "./auth/audit.ts";
import type { LocalAuth } from "./auth/localAuth.ts";
import type { ConfigApplies } from "./config/configApplies.ts";
import type { ConfigApplyBatches } from "./config/configApplyBatches.ts";
import type { ConfigCheckpoints } from "./config/configCheckpoints.ts";
import type { ConfigSnapshots } from "./config/configSnapshots.ts";
import type { Enrollment } from "./enrollment/enrollment.ts";
import type { UrlSource } from "./enrollment/urlSource.ts";
import type { Jobs } from "./jobs/jobs.ts";
import { createAuthRoutes } from "./routes/auth.ts";
import { createBackupRoutes } from "./routes/backups.ts";
import { createConfigApplyRoutes } from "./routes/configApplies.ts";
import { createConfigApplyBatchRoutes } from "./routes/configApplyBatches.ts";
import { createConfigCheckpointRoutes } from "./routes/configCheckpoints.ts";
import {
	createDeviceRoutes,
	type DeviceDataCleanup,
} from "./routes/devices.ts";
import { createEnrollmentRoutes } from "./routes/enrollment.ts";
import { createJobRoutes } from "./routes/jobs.ts";
import { createRouteTableRoutes } from "./routes/routeTables.ts";
import { createSetupRoutes } from "./routes/setup.ts";
import { createSiteTagRoutes } from "./routes/siteTags.ts";
import { createSyslogRoutes } from "./routes/syslog.ts";
import { createTopologyRoutes } from "./routes/topology.ts";
import { createWebGuiRoutes } from "./routes/webgui.ts";
import type { RouteTableCollector } from "./routeTables/collector.ts";
import type { Setup } from "./setup/setup.ts";
import type { Db } from "./storage/db.ts";
import type { DataPaths } from "./storage/paths.ts";
import type { SyslogService } from "./syslog/service.ts";
import type { NativeGuiSessions } from "./webgui/sessions.ts";

export type AppOptions = {
	auth?: LocalAuth;
	audit?: AuditLog;
	webguiSessions?: NativeGuiSessions;
	jobs?: Jobs;
	configApplies?: ConfigApplies;
	configApplyBatches?: ConfigApplyBatches;
	configCheckpoints?: ConfigCheckpoints;
	/** Device一覧・Dashboard(#28)。PresenceはGatewayから読む */
	devices?: {
		db: Db;
		tenantId: string;
		gateway: AgentGateway;
		config?: ConfigSnapshots;
		updates?: AgentUpdates;
		cleanupDeviceData?: DeviceDataCleanup;
	};
	enrollment?: { service: Enrollment; baseUrl: UrlSource };
	syslog?: { service: SyslogService; db: Db; tenantId: string };
	backups?: { db: Db; paths: DataPaths };
	/** 初期Setup(#12)。未初期化なら/setupだけを許す */
	setup?: Setup;
	routeTables?: { db: Db; tenantId: string; collector: RouteTableCollector };
	secureCookie?: boolean;
	/** Native WebGUIを開くorigin(#12のSetupで設定する) */
	guiBaseUrl?: string;
};

export function createApp(options: AppOptions = {}) {
	const app = new Hono();
	app.get("/healthz", (c) => c.json({ status: "ok" }));
	if (options.setup && options.auth) {
		app.route("/api", createSetupRoutes(options.setup, options.auth));
	}
	if (options.auth && options.audit) {
		app.route(
			"/api",
			createAuthRoutes(options.auth, options.audit, {
				secureCookie: options.secureCookie,
			}),
		);
		if (options.enrollment) {
			app.route(
				"/",
				createEnrollmentRoutes(options.auth, options.enrollment.service, {
					baseUrl: options.enrollment.baseUrl,
				}),
			);
		}
		if (options.devices) {
			app.route("/api", createTopologyRoutes(options.auth, options.devices.db));
			app.route(
				"/api",
				createDeviceRoutes(
					options.auth,
					options.devices.db,
					options.devices.tenantId,
					options.devices.gateway,
					options.audit,
					options.jobs,
					options.devices.config,
					options.devices.updates,
					options.devices.cleanupDeviceData,
				),
			);
			app.route(
				"/api",
				createSiteTagRoutes(
					options.auth,
					options.devices.db,
					options.devices.tenantId,
					options.audit,
				),
			);
		}
		if (options.routeTables) {
			app.route(
				"/api",
				createRouteTableRoutes(
					options.auth,
					options.routeTables.db,
					options.routeTables.tenantId,
					options.routeTables.collector,
					options.audit,
				),
			);
		}
		if (options.jobs) {
			app.route("/api", createJobRoutes(options.auth, options.jobs));
		}
		if (options.configApplies) {
			app.route(
				"/api",
				createConfigApplyRoutes(options.auth, options.configApplies),
			);
		}
		if (options.configApplyBatches) {
			app.route(
				"/api",
				createConfigApplyBatchRoutes(options.auth, options.configApplyBatches),
			);
		}
		if (options.configCheckpoints) {
			app.route(
				"/api",
				createConfigCheckpointRoutes(options.auth, options.configCheckpoints),
			);
		}
		if (options.backups) {
			app.route(
				"/api",
				createBackupRoutes(
					options.auth,
					options.backups.paths,
					options.backups.db,
					options.audit,
				),
			);
		}
		if (options.syslog) {
			app.route(
				"/api",
				createSyslogRoutes(
					options.auth,
					options.syslog.service,
					options.syslog.db,
					options.syslog.tenantId,
				),
			);
		}
		if (options.webguiSessions) {
			app.route(
				"/api",
				createWebGuiRoutes(options.auth, options.webguiSessions, {
					guiBaseUrl: options.guiBaseUrl,
				}),
			);
		}
	}
	return app;
}

/** 依存なしの最小構成(healthzのみ)。 */
export const app = createApp();
