/**
 * Native WebGUI sessionのHTTP API(docs/core/access-control-design.md §5)。
 *
 * ここではsessionの作成・終了と認可・監査だけを扱う。Agent Gatewayへの
 * stream接続とL7補正は#27。
 */
import { Hono } from "hono";
import { type AuthEnv, requireAdmin, requireUser } from "../auth/authorize.ts";
import type { LocalAuth } from "../auth/localAuth.ts";
import {
	DeviceNotFoundError,
	ForbiddenError,
	type NativeGuiSessions,
} from "../webgui/sessions.ts";

export type WebGuiRouteOptions = {
	/** Native WebGUIを開くorigin(例: https://routemon.example.com:8443)。#12で設定する */
	guiBaseUrl?: string;
};

export function createWebGuiRoutes(
	auth: LocalAuth,
	sessions: NativeGuiSessions,
	options: WebGuiRouteOptions = {},
) {
	const app = new Hono<AuthEnv>();
	const authenticated = requireUser(auth);

	app.post(
		"/devices/:deviceId/webgui-sessions",
		authenticated,
		requireAdmin,
		(c) => {
			try {
				const session = sessions.start(c.get("user"), c.req.param("deviceId"));
				const base = options.guiBaseUrl ?? "";
				return c.json(
					{
						session: {
							id: session.id,
							deviceId: session.deviceId,
							url: `${base}/session/${session.id}`,
						},
					},
					201,
				);
			} catch (error) {
				if (error instanceof ForbiddenError)
					return c.json({ error: error.message }, 403);
				if (error instanceof DeviceNotFoundError)
					return c.json({ error: error.message }, 404);
				throw error;
			}
		},
	);

	app.delete("/webgui-sessions/:id", authenticated, requireAdmin, (c) => {
		sessions.end(c.req.param("id"));
		return c.json({ ok: true });
	});

	return app;
}
