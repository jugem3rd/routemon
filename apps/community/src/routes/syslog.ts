/**
 * SYSLOGのHTTP API(docs/core/syslog-design.md §11)。
 *
 * 認可はAuthenticated User -> Membership -> Device(§10)。SYSLOGの閲覧は
 * ViewerにもできるReadである(docs/core/access-control-design.md §3)。
 */
import { type Context, Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { type AuthEnv, requireUser } from "../auth/authorize.ts";
import type { LocalAuth } from "../auth/localAuth.ts";
import type { Db } from "../storage/db.ts";
import { DEFAULT_SYSLOG_POLICY } from "../storage/syslogStorage.ts";
import {
	InvalidTimeRangeError,
	type SyslogHistoryOptions,
	type SyslogService,
	TimeRangeTooLargeError,
} from "../syslog/service.ts";

export function createSyslogRoutes(
	auth: LocalAuth,
	syslog: SyslogService,
	db: Db,
	tenantId: string,
) {
	const app = new Hono<AuthEnv>();
	const authenticated = requireUser(auth);

	const deviceExists = (deviceId: string) =>
		db
			.prepare("SELECT 1 FROM devices WHERE id = ? AND tenant_id = ?")
			.get(deviceId, tenantId) !== undefined;

	app.get("/devices/:deviceId/syslog", authenticated, async (c) => {
		const deviceId = c.req.param("deviceId");
		if (!deviceExists(deviceId))
			return c.json({ error: "device not found" }, 404);
		try {
			return c.json(await syslog.historyResult(deviceId, historyOptions(c)));
		} catch (error) {
			if (
				error instanceof TimeRangeTooLargeError ||
				error instanceof InvalidTimeRangeError
			)
				return c.json({ error: error.message }, 400);
			throw error;
		}
	});

	app.get("/devices/:deviceId/syslog/download", authenticated, async (c) => {
		const deviceId = c.req.param("deviceId");
		if (!deviceExists(deviceId))
			return c.json({ error: "device not found" }, 404);
		try {
			const result = await syslog.historyResult(deviceId, historyOptions(c));
			const output = result.lines
				.map((line) => `${line.ts} ${line.message}`)
				.join("\n");
			const text = result.truncated
				? `# truncated at ${result.lines.length} lines\n${output}`
				: output;
			const body = text.length > 0 ? `${text}\n` : "";
			return c.body(new TextEncoder().encode(body), 200, {
				"content-type": "text/plain; charset=utf-8",
				"content-disposition": `attachment; filename="syslog-${safeFilename(deviceId)}.log"`,
				"cache-control": "no-store",
				"x-content-type-options": "nosniff",
			});
		} catch (error) {
			if (
				error instanceof TimeRangeTooLargeError ||
				error instanceof InvalidTimeRangeError
			)
				return c.json({ error: error.message }, 400);
			throw error;
		}
	});

	app.get("/devices/:deviceId/syslog/storage", authenticated, async (c) => {
		const deviceId = c.req.param("deviceId");
		if (!deviceExists(deviceId))
			return c.json({ error: "device not found" }, 404);
		return c.json({
			...(await syslog.usage(deviceId)),
			maxBytes: DEFAULT_SYSLOG_POLICY.maxBytes,
			retentionDays: DEFAULT_SYSLOG_POLICY.retentionDays,
			lowWatermark: DEFAULT_SYSLOG_POLICY.lowWatermark,
		});
	});

	/** Live Logs(Server-Sent Events)。購読中だけAgentのflush周期が短くなる。 */
	app.get("/devices/:deviceId/syslog/live", authenticated, (c) => {
		const deviceId = c.req.param("deviceId");
		if (!deviceExists(deviceId))
			return c.json({ error: "device not found" }, 404);
		return streamSSE(c, async (stream) => {
			const queue: string[] = [];
			let notify: (() => void) | null = null;
			const unsubscribe = syslog.subscribe(deviceId, (line) => {
				queue.push(JSON.stringify(line));
				notify?.();
			});
			stream.onAbort(() => {
				unsubscribe();
				notify?.();
			});
			try {
				while (!stream.aborted && !stream.closed) {
					while (queue.length > 0) {
						await stream.writeSSE({
							event: "syslog",
							data: queue.shift() as string,
						});
					}
					await new Promise<void>((resolve) => {
						notify = resolve;
						setTimeout(resolve, 15_000); // keep-alive
					});
					notify = null;
					if (!stream.aborted && !stream.closed && queue.length === 0) {
						await stream.writeSSE({ event: "ping", data: "" });
					}
				}
			} finally {
				unsubscribe();
			}
		});
	});

	return app;
}

function historyOptions(c: Context<AuthEnv>): SyslogHistoryOptions {
	return {
		from: parseDate(c.req.query("from")),
		to: parseDate(c.req.query("to")),
		limit: parseLimit(c.req.query("limit")),
		keyword: c.req.query("keyword"),
		exclude: c.req.query("exclude"),
	};
}

function parseDate(value: string | undefined): Date | undefined {
	if (!value) return undefined;
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) {
		throw new InvalidTimeRangeError("time range must be valid");
	}
	return date;
}

function parseLimit(value: string | undefined): number | undefined {
	if (!value) return undefined;
	const limit = Number(value);
	return Number.isFinite(limit) ? limit : undefined;
}

function safeFilename(value: string): string {
	return value.replace(/[^A-Za-z0-9._-]/g, "_");
}
