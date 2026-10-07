/**
 * DeviceのStructured Event一覧(#6、docs/core/data-model.md §4.11)。
 *
 * 新しい順に返す。続きは、返した最後のEventの`occurredAt`と`id`を`before` / `beforeId`へ渡して取る
 * (同じ時刻のEventを取りこぼさないため、`occurred_at`と`rowid`の組で並べる)。
 */
import { Hono } from "hono";
import { type AuthEnv, requireUser } from "../auth/authorize.ts";
import type { LocalAuth } from "../auth/localAuth.ts";
import type { Db } from "../storage/db.ts";

export const DEFAULT_EVENT_LIMIT = 50;
export const MAX_EVENT_LIMIT = 200;

type EventRow = {
	id: string;
	type: string;
	severity: string;
	detail_json: string | null;
	occurred_at: string;
	seq: number;
};

export function createDeviceEventRoutes(
	auth: LocalAuth,
	db: Db,
	tenantId: string,
) {
	const app = new Hono<AuthEnv>();
	const authenticated = requireUser(auth);

	app.get("/devices/:deviceId/events", authenticated, (c) => {
		const deviceId = c.req.param("deviceId");
		const exists = db
			.prepare("SELECT 1 FROM devices WHERE id = ? AND tenant_id = ?")
			.get(deviceId, tenantId);
		if (!exists) return c.json({ error: "device not found" }, 404);

		const requested = Number(c.req.query("limit") ?? DEFAULT_EVENT_LIMIT);
		const limit = Number.isFinite(requested)
			? Math.min(Math.max(Math.trunc(requested), 1), MAX_EVENT_LIMIT)
			: DEFAULT_EVENT_LIMIT;

		const where = ["tenant_id = ?", "device_id = ?"];
		const params: (string | number)[] = [tenantId, deviceId];
		const type = c.req.query("type");
		if (type) {
			where.push("type = ?");
			params.push(type);
		}
		const before = c.req.query("before");
		const beforeSeq = Number(c.req.query("beforeSeq"));
		if (before) {
			if (Number.isFinite(beforeSeq) && c.req.query("beforeSeq")) {
				where.push("(occurred_at < ? OR (occurred_at = ? AND rowid < ?))");
				params.push(before, before, beforeSeq);
			} else {
				where.push("occurred_at < ?");
				params.push(before);
			}
		}

		// 1件多く取って、続きがあるかを判定する
		const rows = db
			.prepare(
				`SELECT id, type, severity, detail_json, occurred_at, rowid AS seq
				 FROM device_events WHERE ${where.join(" AND ")}
				 ORDER BY occurred_at DESC, rowid DESC LIMIT ?`,
			)
			.all(...params, limit + 1) as EventRow[];
		const page = rows.slice(0, limit);
		return c.json(
			{
				events: page.map((row) => ({
					id: row.id,
					type: row.type,
					severity: row.severity,
					detail: parseDetail(row.detail_json),
					occurredAt: row.occurred_at,
					seq: row.seq,
				})),
				hasMore: rows.length > limit,
			},
			200,
			{ "cache-control": "no-store" },
		);
	});

	return app;
}

function parseDetail(json: string | null): Record<string, unknown> | null {
	if (!json) return null;
	try {
		const value = JSON.parse(json);
		return value && typeof value === "object" ? value : null;
	} catch {
		return null;
	}
}
