/**
 * Enrollment API(docs/core/device-enrollment-design.md §5)。
 *
 * - GUI向け(Adminのみ): Pending Device作成、Code再発行、進捗、credential revoke
 * - Router向け(認証はEnrollment CodeのBearer): Bootstrap取得、Enrollment完了
 *
 * Router向けの2つはCodeで認証するためloginを要求しない。Codeは短命・one-timeで、
 * 平文を保存しない。
 */
import { Hono } from "hono";
import { type AuthEnv, requireAdmin, requireUser } from "../auth/authorize.ts";
import type { LocalAuth } from "../auth/localAuth.ts";
import { renderBootstrap, renderCliBlock } from "../enrollment/bootstrap.ts";
import {
	DeviceNotFoundError,
	type Enrollment,
	InvalidCodeError,
	type RouterIdentity,
} from "../enrollment/enrollment.ts";

export type EnrollmentRouteOptions = {
	/** Routerから見たRoutemonのbase URL(#12のSetupで設定する) */
	baseUrl: string;
};

function bearer(header: string | undefined): string | null {
	if (!header) return null;
	const [scheme, ...rest] = header.trim().split(/\s+/);
	if (scheme?.toLowerCase() !== "bearer" || rest.length !== 1) return null;
	return rest[0] ?? null;
}

/** GUI向け(Adminのみ)。Routemon本体のlistenerに載せる。 */
export function createEnrollmentRoutes(
	auth: LocalAuth,
	enrollment: Enrollment,
	options: EnrollmentRouteOptions,
) {
	const app = new Hono<AuthEnv>();
	const authenticated = requireUser(auth);

	app.post("/api/devices", authenticated, requireAdmin, async (c) => {
		const body = await c.req.json().catch(() => null);
		if (typeof body?.name !== "string" || !body.name.trim()) {
			return c.json({ error: "name is required" }, 400);
		}
		const pending = enrollment.createPendingDevice({
			name: body.name.trim(),
			siteId: typeof body.siteId === "string" ? body.siteId : null,
			userId: c.get("user").id,
		});
		return c.json(
			{
				device: { id: pending.deviceId },
				enrollment: {
					code: pending.code,
					expiresAt: pending.expiresAt,
					cliBlock: renderCliBlock({
						baseUrl: options.baseUrl,
						code: pending.code,
					}),
				},
			},
			201,
		);
	});

	app.post(
		"/api/devices/:deviceId/enrollment-codes",
		authenticated,
		requireAdmin,
		(c) => {
			try {
				const pending = enrollment.issueCode(
					c.req.param("deviceId"),
					c.get("user").id,
				);
				return c.json({
					enrollment: {
						code: pending.code,
						expiresAt: pending.expiresAt,
						cliBlock: renderCliBlock({
							baseUrl: options.baseUrl,
							code: pending.code,
						}),
					},
				});
			} catch (error) {
				if (error instanceof DeviceNotFoundError)
					return c.json({ error: error.message }, 404);
				throw error;
			}
		},
	);

	app.get("/api/devices/:deviceId/enrollment", authenticated, (c) => {
		try {
			return c.json(enrollment.status(c.req.param("deviceId")));
		} catch (error) {
			if (error instanceof DeviceNotFoundError)
				return c.json({ error: error.message }, 404);
			throw error;
		}
	});

	app.post(
		"/api/devices/:deviceId/credentials/revoke",
		authenticated,
		requireAdmin,
		(c) => {
			const revoked = enrollment.revokeCredentials(
				c.req.param("deviceId"),
				c.get("user").id,
			);
			return c.json({ revoked });
		},
	);

	return app;
}

/**
 * Router向け(Enrollment CodeのBearerで認証)。Agent向けのpublic endpointに載せる
 * (docs/core/device-enrollment-design.md §5)。loginは要求しない。
 */
export function createEnrollmentDeviceRoutes(
	enrollment: Enrollment,
	options: EnrollmentRouteOptions,
) {
	const app = new Hono();

	app.get("/v1/enrollment/bootstrap", (c) => {
		const code = bearer(c.req.header("authorization"));
		if (!code) return c.json({ error: "enrollment code required" }, 401);
		try {
			enrollment.verifyCode(code);
		} catch (error) {
			if (error instanceof InvalidCodeError)
				return c.json({ error: "invalid enrollment code" }, 401);
			throw error;
		}
		return c.body(renderBootstrap({ baseUrl: options.baseUrl, code }), 200, {
			"content-type": "text/plain; charset=utf-8",
		});
	});

	app.post("/v1/enrollment/complete", async (c) => {
		const code = bearer(c.req.header("authorization"));
		if (!code) return c.json({ error: "enrollment code required" }, 401);
		const body = (await c.req.json().catch(() => ({}))) as Record<
			string,
			unknown
		>;
		const identity: RouterIdentity = {
			model:
				typeof body.model === "string" && body.model !== "nil"
					? body.model
					: undefined,
			serialNumber:
				typeof body.serialNumber === "string" && body.serialNumber !== "nil"
					? body.serialNumber
					: undefined,
			firmwareRevision:
				typeof body.firmwareRevision === "string" &&
				body.firmwareRevision !== "nil"
					? body.firmwareRevision
					: undefined,
			hostname:
				typeof body.hostname === "string" && body.hostname !== "nil"
					? body.hostname
					: undefined,
			bootstrapVersion:
				typeof body.bootstrapVersion === "string" &&
				body.bootstrapVersion !== "nil"
					? body.bootstrapVersion
					: undefined,
		};
		try {
			return c.json(enrollment.complete(code, identity));
		} catch (error) {
			if (error instanceof InvalidCodeError)
				return c.json({ error: "invalid enrollment code" }, 401);
			throw error;
		}
	});

	return app;
}
