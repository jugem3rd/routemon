/**
 * Setup Wizard API(#12、docs/community/installation-setup-design.md §4)。
 *
 * 未初期化のときだけ匿名で実行できる。完了後は再実行できず、変更はAdmin login後に行う。
 */

import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import {
	type AuthEnv,
	requireAdmin,
	requireUser,
	SESSION_COOKIE,
} from "../auth/authorize.ts";
import type { LocalAuth } from "../auth/localAuth.ts";
import {
	checkConnectivity,
	type Setup,
	SetupAlreadyDoneError,
} from "../setup/setup.ts";

export function createSetupRoutes(setup: Setup, auth: LocalAuth) {
	const app = new Hono<AuthEnv>();
	const authenticated = requireUser(auth);

	app.get("/setup/status", (c) => c.json(setup.status()));

	app.post("/setup", async (c) => {
		const body = await c.req.json().catch(() => null);
		const admin = body?.admin;
		if (
			typeof body?.instanceName !== "string" ||
			typeof body?.publicBaseUrl !== "string" ||
			typeof admin?.loginId !== "string" ||
			typeof admin?.password !== "string"
		) {
			return c.json(
				{ error: "instanceName, publicBaseUrl, adminが必要です" },
				400,
			);
		}
		try {
			await setup.complete({
				instanceName: body.instanceName.trim(),
				timezone:
					typeof body.timezone === "string" && body.timezone
						? body.timezone
						: "UTC",
				publicBaseUrl: body.publicBaseUrl.trim().replace(/\/$/, ""),
				admin: { loginId: admin.loginId.trim(), password: admin.password },
			});
		} catch (error) {
			if (error instanceof SetupAlreadyDoneError)
				return c.json({ error: "setupは完了済みです" }, 409);
			return c.json({ error: (error as Error).message }, 400);
		}
		return c.json(setup.status(), 201);
	});

	/**
	 * 到達性の確認。未初期化ならSetup Wizardから、初期化後はAdminだけが実行できる。
	 */
	app.post("/setup/connectivity", async (c) => {
		// 初期化後はAdminだけが実行できる(未初期化のときはWizardから呼ぶ)
		if (setup.status().initialized) {
			const token = getCookie(c, SESSION_COOKIE);
			const user = token ? auth.authenticate(token) : null;
			if (user?.role !== "admin") return c.json({ error: "unauthorized" }, 401);
		}
		const body = await c.req.json().catch(() => null);
		const target =
			typeof body?.publicBaseUrl === "string" && body.publicBaseUrl
				? body.publicBaseUrl
				: setup.status().publicBaseUrl;
		if (!target) return c.json({ error: "publicBaseUrlが必要です" }, 400);
		return c.json({ checks: await checkConnectivity(target) });
	});

	/** Public URLの変更(Adminのみ)。Caddyの設定もこの値から生成する。 */
	app.post("/settings/public-url", authenticated, requireAdmin, async (c) => {
		const body = await c.req.json().catch(() => null);
		if (typeof body?.publicBaseUrl !== "string" || !body.publicBaseUrl.trim())
			return c.json({ error: "publicBaseUrlが必要です" }, 400);
		setup.setPublicBaseUrl(body.publicBaseUrl.trim().replace(/\/$/, ""));
		return c.json(setup.status());
	});

	/** Instance名の変更(Adminのみ)。 */
	app.post(
		"/settings/instance-name",
		authenticated,
		requireAdmin,
		async (c) => {
			const body = await c.req.json().catch(() => null);
			if (typeof body?.instanceName !== "string" || !body.instanceName.trim())
				return c.json({ error: "instanceNameが必要です" }, 400);
			setup.setInstanceName(body.instanceName.trim());
			return c.json(setup.status());
		},
	);

	/** Timezoneの変更(Adminのみ)。 */
	app.post("/settings/timezone", authenticated, requireAdmin, async (c) => {
		const body = await c.req.json().catch(() => null);
		if (typeof body?.timezone !== "string" || !body.timezone.trim())
			return c.json({ error: "timezoneが必要です" }, 400);
		setup.setTimezone(body.timezone.trim());
		return c.json(setup.status());
	});

	return app;
}
