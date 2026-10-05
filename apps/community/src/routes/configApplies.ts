/** CONFIG Apply / standalone save / discard API(#96)。 */
import {
	ConfigApplyBusyError,
	DeviceNotConnectedError,
} from "@routemon/gateway";
import { type Context, Hono } from "hono";
import { type AuthEnv, requireAdmin, requireUser } from "../auth/authorize.ts";
import type { LocalAuth } from "../auth/localAuth.ts";
import {
	type ConfigApplies,
	ConfigApplyBatchActiveError,
	ConfigApplyNotFoundError,
	ConfigApplyStateError,
	ConfigApplyValidationError,
} from "../config/configApplies.ts";
import { ConfigBackupNotFoundError } from "../config/configSnapshots.ts";
import { DeviceNotFoundError, DeviceOperationBusyError } from "../jobs/jobs.ts";

export function createConfigApplyRoutes(
	auth: LocalAuth,
	configApplies: ConfigApplies,
) {
	const app = new Hono<AuthEnv>();
	const authenticated = requireUser(auth);
	app.post(
		"/devices/:deviceId/config-applies/prepare",
		authenticated,
		requireAdmin,
		async (c) => {
			const body = await c.req.json().catch(() => null);
			if (typeof body?.backupId !== "string" || !body.backupId.trim()) {
				return c.json({ error: "backupId is required" }, 400);
			}
			try {
				const apply = await configApplies.prepare({
					deviceId: c.req.param("deviceId"),
					targetBackupId: body.backupId.trim(),
					userId: c.get("user").id,
				});
				return c.json({ apply }, 202);
			} catch (error) {
				return errorResponse(c, error);
			}
		},
	);

	app.get(
		"/devices/:deviceId/config-applies",
		authenticated,
		requireAdmin,
		(c) => {
			try {
				return c.json({ applies: configApplies.list(c.req.param("deviceId")) });
			} catch (error) {
				return errorResponse(c, error);
			}
		},
	);

	app.get(
		"/devices/:deviceId/config-applies/:applyId",
		authenticated,
		requireAdmin,
		async (c) => {
			try {
				return c.json(
					await configApplies.getDetails(
						c.req.param("deviceId"),
						c.req.param("applyId"),
						c.get("user").id,
					),
					200,
					{ "cache-control": "no-store" },
				);
			} catch (error) {
				return errorResponse(c, error);
			}
		},
	);

	app.post(
		"/devices/:deviceId/config-applies/:applyId/confirm",
		authenticated,
		requireAdmin,
		async (c) => {
			const body = await c.req.json().catch(() => null);
			if (
				typeof body?.saveAfterApply !== "boolean" ||
				body.acknowledged !== true
			) {
				return c.json(
					{ error: "saveAfterApply and acknowledged=true are required" },
					400,
				);
			}
			try {
				const apply = await configApplies.confirm({
					deviceId: c.req.param("deviceId"),
					applyId: c.req.param("applyId"),
					userId: c.get("user").id,
					saveAfterApply: body.saveAfterApply,
					acknowledged: body.acknowledged,
				});
				return c.json({ apply }, 202);
			} catch (error) {
				return errorResponse(c, error);
			}
		},
	);

	app.post(
		"/devices/:deviceId/config-save",
		authenticated,
		requireAdmin,
		async (c) => {
			try {
				const job = await configApplies.save({
					deviceId: c.req.param("deviceId"),
					userId: c.get("user").id,
				});
				return c.json({ job }, 202);
			} catch (error) {
				return errorResponse(c, error);
			}
		},
	);

	app.post(
		"/devices/:deviceId/config-applies/:applyId/discard",
		authenticated,
		requireAdmin,
		async (c) => {
			try {
				const result = await configApplies.discard({
					deviceId: c.req.param("deviceId"),
					applyId: c.req.param("applyId"),
					userId: c.get("user").id,
				});
				return c.json(result, 202);
			} catch (error) {
				return errorResponse(c, error);
			}
		},
	);

	return app;
}

function errorResponse(c: Context<AuthEnv>, error: unknown) {
	if (error instanceof ConfigApplyBatchActiveError) {
		return c.json(
			{
				error: `一括適用が実行中です (Batch ${error.batchId})`,
				code: "config_apply_batch_active",
				batch_id: error.batchId,
				batch_status: error.batchStatus,
				batch_source: error.batchSource,
			},
			409,
		);
	}
	if (
		error instanceof DeviceNotFoundError ||
		error instanceof ConfigApplyNotFoundError ||
		error instanceof ConfigBackupNotFoundError
	)
		return c.json({ error: "not found" }, 404);
	if (error instanceof ConfigApplyValidationError)
		return c.json({ error: error.message, code: error.code }, 400);
	if (
		error instanceof ConfigApplyStateError ||
		error instanceof DeviceOperationBusyError ||
		error instanceof ConfigApplyBusyError
	)
		return c.json({ error: error.message }, 409);
	if (error instanceof DeviceNotConnectedError)
		return c.json({ error: "device is not connected" }, 409);
	throw error;
}
