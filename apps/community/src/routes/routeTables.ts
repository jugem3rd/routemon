import { DeviceNotConnectedError } from "@routemon/gateway";
import { Hono } from "hono";
import { AuditEventType, type AuditLog } from "../auth/audit.ts";
import { type AuthEnv, requireAdmin, requireUser } from "../auth/authorize.ts";
import type { LocalAuth } from "../auth/localAuth.ts";
import {
	type RouteTableCollector,
	RouteTableDeviceInactiveError,
	RouteTableRefreshBusyError,
} from "../routeTables/collector.ts";
import type { Db } from "../storage/db.ts";

export function createRouteTableRoutes(
	auth: LocalAuth,
	db: Db,
	tenantId: string,
	collector: RouteTableCollector,
	audit: AuditLog,
) {
	const app = new Hono<AuthEnv>();
	const authenticated = requireUser(auth);

	app.get("/devices/:deviceId/routes", authenticated, (c) => {
		const device = findDevice(db, tenantId, c.req.param("deviceId"));
		if (!device) return c.json({ error: "device not found" }, 404);
		return c.json(collector.get(device.id), 200, {
			"cache-control": "no-store",
		});
	});

	app.post(
		"/devices/:deviceId/routes/refresh",
		authenticated,
		requireAdmin,
		async (c) => {
			const device = findDevice(db, tenantId, c.req.param("deviceId"));
			if (!device) return c.json({ error: "device not found" }, 404);
			if (
				device.lifecycle_status !== "active" ||
				!collector.isOnline(device.id)
			) {
				recordRefreshAudit(audit, c.get("user").id, device.id, "failed");
				return c.json({ error: "device is not online" }, 409);
			}
			if (collector.isRefreshing(device.id)) {
				recordRefreshAudit(audit, c.get("user").id, device.id, "failed");
				return c.json({ error: "route table refresh is already running" }, 409);
			}

			try {
				const snapshots = await collector.refresh(device.id);
				recordRefreshAudit(
					audit,
					c.get("user").id,
					device.id,
					collectionResult(snapshots),
				);
				return c.json(snapshots, 200, { "cache-control": "no-store" });
			} catch (error) {
				if (
					error instanceof DeviceNotConnectedError ||
					error instanceof RouteTableDeviceInactiveError ||
					error instanceof RouteTableRefreshBusyError
				) {
					recordRefreshAudit(audit, c.get("user").id, device.id, "failed");
					return c.json({ error: "device is not available for refresh" }, 409);
				}
				throw error;
			}
		},
	);

	return app;
}

type RouteTableDevice = { id: string; lifecycle_status: string };

function findDevice(
	db: Db,
	tenantId: string,
	deviceId: string,
): RouteTableDevice | undefined {
	return db
		.prepare(
			"SELECT id, lifecycle_status FROM devices WHERE id = ? AND tenant_id = ?",
		)
		.get(deviceId, tenantId) as RouteTableDevice | undefined;
}

function collectionResult(
	snapshots: Awaited<ReturnType<RouteTableCollector["refresh"]>>,
): "complete" | "partial" | "failed" {
	const statuses = [
		snapshots.ipv4?.lastAttemptStatus,
		snapshots.ipv6?.lastAttemptStatus,
	];
	const successful = statuses.filter(
		(status) => status === "complete" || status === "partial",
	);
	if (successful.length === 0) return "failed";
	if (statuses.every((status) => status === "complete")) return "complete";
	return "partial";
}

function recordRefreshAudit(
	audit: AuditLog,
	actorUserId: string,
	deviceId: string,
	result: "complete" | "partial" | "failed",
): void {
	audit.record({
		type: AuditEventType.DEVICE_ROUTE_TABLE_REFRESHED,
		actorUserId,
		targetType: "device",
		targetId: deviceId,
		detail: { result },
	});
}
