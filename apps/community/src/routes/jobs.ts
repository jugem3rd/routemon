/**
 * 任意コマンド実行とJob履歴のHTTP API(#25)。
 *
 * 実行はAdminのみ、履歴はViewerも閲覧できる(docs/core/access-control-design.md §3)。
 */

import { DeviceNotConnectedError } from "@routemon/gateway";
import { Hono } from "hono";
import { type AuthEnv, requireAdmin, requireUser } from "../auth/authorize.ts";
import type { LocalAuth } from "../auth/localAuth.ts";
import {
	CommandNotAllowedError,
	DeviceNotFoundError,
	DeviceOperationBusyError,
	InvalidScheduleError,
	JobNotFoundError,
	type Jobs,
} from "../jobs/jobs.ts";

export function createJobRoutes(auth: LocalAuth, jobs: Jobs) {
	const app = new Hono<AuthEnv>();
	const authenticated = requireUser(auth);

	app.post(
		"/devices/:deviceId/commands",
		authenticated,
		requireAdmin,
		async (c) => {
			const body = await c.req.json().catch(() => null);
			if (typeof body?.command !== "string")
				return c.json({ error: "command is required" }, 400);
			try {
				const job = await jobs.runCommand({
					deviceId: c.req.param("deviceId"),
					command: body.command,
					userId: c.get("user").id,
				});
				return c.json({ job }, 201);
			} catch (error) {
				if (error instanceof CommandNotAllowedError)
					return c.json({ error: error.message }, 400);
				if (error instanceof DeviceNotFoundError)
					return c.json({ error: error.message }, 404);
				throw error;
			}
		},
	);

	/**
	 * Deviceの再起動(#54)。応答は返らない前提で、送れたらJobをsuccessにする。
	 * `save`をtrueにすると、未保存の設定を保存してから再起動する。
	 */
	app.post(
		"/devices/:deviceId/reboot",
		authenticated,
		requireAdmin,
		async (c) => {
			const body = (await c.req.json().catch(() => ({}))) as {
				save?: unknown;
				at?: unknown;
			};
			try {
				// atを指定すると予約になる(#54)。実行はrunDue()が行う
				if (typeof body.at === "string") {
					const at = new Date(body.at);
					if (Number.isNaN(at.getTime()))
						return c.json({ error: "atの形式が不正です" }, 400);
					const job = jobs.scheduleReboot({
						deviceId: c.req.param("deviceId"),
						userId: c.get("user").id,
						save: body.save === true,
						at,
					});
					return c.json({ job }, 202);
				}
				const job = await jobs.reboot({
					deviceId: c.req.param("deviceId"),
					userId: c.get("user").id,
					save: body.save === true,
				});
				return c.json({ job }, 202);
			} catch (error) {
				if (error instanceof InvalidScheduleError)
					return c.json({ error: error.message }, 400);
				if (error instanceof DeviceNotFoundError)
					return c.json({ error: error.message }, 404);
				if (error instanceof DeviceNotConnectedError)
					return c.json({ error: "device is not connected" }, 409);
				if (error instanceof DeviceOperationBusyError)
					return c.json({ error: error.message }, 409);
				throw error;
			}
		},
	);

	/** 予約中のJob(未実行)。 */
	app.get("/scheduled-jobs", authenticated, (c) =>
		c.json({ jobs: jobs.pending(c.req.query("deviceId")) }),
	);

	/** 予約の取り消し(Adminのみ)。 */
	app.post("/jobs/:id/cancel", authenticated, requireAdmin, (c) => {
		try {
			return c.json({
				job: jobs.cancelScheduled(c.req.param("id"), c.get("user").id),
			});
		} catch (error) {
			if (error instanceof JobNotFoundError)
				return c.json({ error: "job not found" }, 404);
			if (error instanceof InvalidScheduleError)
				return c.json({ error: error.message }, 409);
			throw error;
		}
	});

	app.get("/jobs", authenticated, (c) => {
		const deviceId = c.req.query("deviceId");
		const limit = Number(c.req.query("limit") ?? 50) || 50;
		return c.json({ jobs: jobs.list({ deviceId, limit }) });
	});

	app.get("/jobs/:id", authenticated, (c) => {
		const job = jobs.get(c.req.param("id"));
		if (!job) return c.json({ error: "job not found" }, 404);
		return c.json({ job });
	});

	return app;
}
