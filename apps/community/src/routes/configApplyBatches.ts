/** CONFIG Apply Batch API。変更系・参照系ともにAdmin専用 (#119). */
import { DeviceNotConnectedError } from "@routemon/gateway";
import { type Context, Hono } from "hono";
import { type AuthEnv, requireAdmin, requireUser } from "../auth/authorize.ts";
import type { LocalAuth } from "../auth/localAuth.ts";
import {
	ConfigApplyBatchConflictError,
	type ConfigApplyBatchCreateInput,
	type ConfigApplyBatches,
	ConfigApplyBatchNotFoundError,
	ConfigApplyBatchValidationError,
} from "../config/configApplyBatches.ts";
import { DeviceNotFoundError } from "../config/configSnapshots.ts";

export function createConfigApplyBatchRoutes(
	auth: LocalAuth,
	batches: ConfigApplyBatches,
) {
	const app = new Hono<AuthEnv>();
	const authenticated = requireUser(auth);
	const admin = requireAdmin;

	app.get("/config-apply-batches", authenticated, admin, (c) =>
		c.json({ batches: batches.list() }, 200, { "cache-control": "no-store" }),
	);

	app.post("/config-apply-batches", authenticated, admin, async (c) => {
		const body = await c.req.json().catch(() => null);
		if (!isObject(body))
			return c.json({ error: "request body must be an object" }, 400);
		const input = parseCreateInput(body);
		if (!input) {
			return c.json(
				{ error: "source must be a checkpoint or an ordered Device list" },
				400,
			);
		}
		try {
			const batch = batches.create({ ...input, userId: c.get("user").id });
			return c.json({ batch }, 202, { "cache-control": "no-store" });
		} catch (error) {
			return errorResponse(c, error);
		}
	});

	app.get("/config-apply-batches/:id", authenticated, admin, (c) => {
		try {
			return c.json({ batch: batches.get(c.req.param("id")) }, 200, {
				"cache-control": "no-store",
			});
		} catch (error) {
			return errorResponse(c, error);
		}
	});

	app.patch(
		"/config-apply-batches/:id/plan",
		authenticated,
		admin,
		async (c) => {
			const body = await c.req.json().catch(() => null);
			if (!isObject(body) || !Array.isArray(body.items)) {
				return c.json({ error: "items must be an ordered array" }, 400);
			}
			try {
				const batch = batches.updatePlan(
					c.req.param("id"),
					body.items,
					c.get("user").id,
				);
				return c.json({ batch }, 200, { "cache-control": "no-store" });
			} catch (error) {
				return errorResponse(c, error);
			}
		},
	);

	app.post(
		"/config-apply-batches/:id/confirm",
		authenticated,
		admin,
		async (c) => {
			const body = await c.req.json().catch(() => null);
			if (!isObject(body) || body.acknowledged !== true) {
				return c.json({ error: "acknowledged=true is required" }, 400);
			}
			try {
				const batch = await batches.confirmPlan(
					c.req.param("id"),
					c.get("user").id,
					body.acknowledged,
				);
				return c.json({ batch }, 202, { "cache-control": "no-store" });
			} catch (error) {
				return errorResponse(c, error);
			}
		},
	);

	app.post(
		"/config-apply-batches/:id/items/:itemId/confirm",
		authenticated,
		admin,
		async (c) => {
			const body = await c.req.json().catch(() => null);
			if (!isObject(body) || body.acknowledged !== true) {
				return c.json({ error: "acknowledged=true is required" }, 400);
			}
			try {
				const batch = await batches.confirmItem(
					c.req.param("id"),
					c.req.param("itemId"),
					c.get("user").id,
					body.acknowledged,
				);
				return c.json({ batch }, 202, { "cache-control": "no-store" });
			} catch (error) {
				return errorResponse(c, error);
			}
		},
	);

	app.post(
		"/config-apply-batches/:id/stop",
		authenticated,
		admin,
		async (c) => {
			try {
				const batch = await batches.stop(c.req.param("id"), c.get("user").id);
				return c.json({ batch }, 202, { "cache-control": "no-store" });
			} catch (error) {
				return errorResponse(c, error);
			}
		},
	);

	return app;
}

function parseCreateInput(
	body: Record<string, unknown>,
): Omit<ConfigApplyBatchCreateInput, "userId"> | null {
	const source = body.source;
	if (!isObject(source)) return null;
	let normalizedSource: ConfigApplyBatchCreateInput["source"];
	if (source.type === "checkpoint" && typeof source.checkpointId === "string") {
		normalizedSource = {
			type: "checkpoint",
			checkpointId: source.checkpointId,
		};
	} else if (source.type === "devices" && Array.isArray(source.items)) {
		if (
			source.items.some(
				(item) =>
					!isObject(item) ||
					typeof item.deviceId !== "string" ||
					typeof item.backupId !== "string",
			)
		) {
			return null;
		}
		normalizedSource = {
			type: "devices",
			items: source.items.map((item) => ({
				deviceId: (item as Record<string, string>).deviceId,
				backupId: (item as Record<string, string>).backupId,
			})),
		};
	} else {
		return null;
	}
	return {
		source: normalizedSource,
		...(body.confirmationMode !== undefined
			? {
					confirmationMode:
						body.confirmationMode as ConfigApplyBatchCreateInput["confirmationMode"],
				}
			: {}),
		...(body.saveAfterApply !== undefined
			? { saveAfterApply: body.saveAfterApply as boolean }
			: {}),
	};
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorResponse(c: Context<AuthEnv>, error: unknown) {
	if (
		error instanceof ConfigApplyBatchNotFoundError ||
		error instanceof DeviceNotFoundError
	) {
		return c.json({ error: error.message || "not found" }, 404);
	}
	if (error instanceof ConfigApplyBatchValidationError) {
		return c.json({ error: error.message, code: error.code }, 400);
	}
	if (
		error instanceof ConfigApplyBatchConflictError ||
		error instanceof DeviceNotConnectedError
	) {
		return c.json({ error: error.message }, 409);
	}
	throw error;
}
