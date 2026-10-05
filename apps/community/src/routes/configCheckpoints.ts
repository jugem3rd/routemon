/** CONFIG checkpoint API(#93)。 */
import { Hono } from "hono";
import { type AuthEnv, requireAdmin, requireUser } from "../auth/authorize.ts";
import type { LocalAuth } from "../auth/localAuth.ts";
import {
	ConfigCheckpointBusyError,
	ConfigCheckpointNotFoundError,
	type ConfigCheckpoints,
	ConfigCheckpointValidationError,
} from "../config/configCheckpoints.ts";
import { DeviceNotFoundError } from "../config/configSnapshots.ts";

export function createConfigCheckpointRoutes(
	auth: LocalAuth,
	checkpoints: ConfigCheckpoints,
) {
	const app = new Hono<AuthEnv>();
	const authenticated = requireUser(auth);

	app.get("/config-checkpoints", authenticated, (c) =>
		c.json({ checkpoints: checkpoints.list() }, 200, {
			"cache-control": "no-store",
		}),
	);

	app.post("/config-checkpoints", authenticated, requireAdmin, async (c) => {
		const body = await c.req.json().catch(() => null);
		if (body === null || typeof body !== "object" || Array.isArray(body)) {
			return c.json({ error: "request body must be an object" }, 400);
		}
		if (typeof body.name !== "string") {
			return c.json({ error: "name is required" }, 400);
		}
		if (
			body.memo !== undefined &&
			body.memo !== null &&
			typeof body.memo !== "string"
		) {
			return c.json({ error: "memo must be a string" }, 400);
		}
		if (
			!Array.isArray(body.deviceIds) ||
			body.deviceIds.some((deviceId: unknown) => typeof deviceId !== "string")
		) {
			return c.json({ error: "deviceIds must be an array of ids" }, 400);
		}
		try {
			const checkpoint = checkpoints.create({
				name: body.name,
				memo: body.memo,
				deviceIds: body.deviceIds,
				userId: c.get("user").id,
			});
			return c.json({ checkpoint }, 201, { "cache-control": "no-store" });
		} catch (error) {
			if (error instanceof ConfigCheckpointValidationError) {
				return c.json({ error: error.message, code: error.code }, 400);
			}
			if (error instanceof DeviceNotFoundError) {
				return c.json({ error: "one or more devices were not found" }, 404);
			}
			throw error;
		}
	});

	app.delete("/config-checkpoints/:id", authenticated, requireAdmin, (c) => {
		try {
			checkpoints.delete(c.req.param("id"), c.get("user").id);
			return c.json({ ok: true });
		} catch (error) {
			if (error instanceof ConfigCheckpointNotFoundError) {
				return c.json({ error: "checkpoint not found" }, 404);
			}
			if (error instanceof ConfigCheckpointBusyError) {
				return c.json({ error: "checkpoint capture is still pending" }, 409);
			}
			throw error;
		}
	});

	return app;
}
