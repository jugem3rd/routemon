/**
 * Device一覧・詳細とDashboard summaryの読み取りAPI(#28)。
 *
 * Presenceは永続化していないため、Gatewayの現在値を都度参照する
 * (docs/core/data-model.md §5、packages/gateway)。
 */
import type { AgentGateway, Presence } from "@routemon/gateway";
import { Hono } from "hono";
import {
	type AgentUpdates,
	ReleaseNotFoundError,
} from "../agent/agentUpdates.ts";
import { AuditEventType, type AuditLog } from "../auth/audit.ts";
import { type AuthEnv, requireAdmin, requireUser } from "../auth/authorize.ts";
import type { LocalAuth } from "../auth/localAuth.ts";
import {
	ConfigBackupNotFoundError,
	type ConfigSnapshots,
	DeviceNotFoundError,
	InvalidConfigDiffError,
} from "../config/configSnapshots.ts";
import type { Jobs } from "../jobs/jobs.ts";
import { ConfigBackupInUseError } from "../storage/configBackups.ts";
import { type Db, nowIso } from "../storage/db.ts";

export type DeviceDataCleanup = (deviceId: string) => Promise<void>;

type DeviceRow = {
	id: string;
	name: string;
	site_id: string | null;
	site_name: string | null;
	description: string | null;
	notes: string | null;
	model: string | null;
	firmware_revision: string | null;
	agent_version: string | null;
	lifecycle_status: string;
	config_state: "saved" | "unsaved";
	serial_number: string | null;
	hostname: string | null;
	registered_at: string | null;
	booted_at: string | null;
};

type DeviceTag = {
	id: string;
	name: string;
};

const LIST_COLUMNS = `d.id, d.name, d.site_id, s.name AS site_name, d.description,
	 d.notes, d.model, d.firmware_revision, d.agent_version, d.lifecycle_status,
	 d.config_state`;
const DETAIL_COLUMNS = `${LIST_COLUMNS}, d.serial_number, d.hostname,
	 d.registered_at, d.booted_at`;

function toDevice(row: DeviceRow, presence: Presence, tags: DeviceTag[]) {
	return {
		id: row.id,
		name: row.name,
		siteId: row.site_id,
		siteName: row.site_name,
		tags,
		description: row.description,
		notes: row.notes,
		model: row.model,
		firmwareRevision: row.firmware_revision,
		agentVersion: row.agent_version,
		lifecycle: row.lifecycle_status,
		configState: row.config_state,
		presence: {
			status: presence.status,
			lastSeenAt: presence.lastSeenAt?.toISOString() ?? null,
			observedSourceIp: presence.observedSourceIp ?? null,
		},
	};
}

function toDeviceDetail(row: DeviceRow, presence: Presence, tags: DeviceTag[]) {
	return {
		...toDevice(row, presence, tags),
		serialNumber: row.serial_number,
		hostname: row.hostname,
		registeredAt: row.registered_at,
		bootedAt: row.booted_at,
	};
}

function findDeviceTags(
	db: Db,
	tenantId: string,
	deviceId: string,
): DeviceTag[] {
	return db
		.prepare(
			`SELECT t.id, t.name
			 FROM device_tags dt JOIN tags t ON t.id = dt.tag_id
			 WHERE dt.device_id = ? AND t.tenant_id = ?
			 ORDER BY t.name, t.id`,
		)
		.all(deviceId, tenantId) as DeviceTag[];
}

function findDevice(
	db: Db,
	tenantId: string,
	deviceId: string,
): DeviceRow | undefined {
	return db
		.prepare(
			`SELECT ${DETAIL_COLUMNS}
				 FROM devices d LEFT JOIN sites s ON s.id = d.site_id AND s.tenant_id = d.tenant_id
			 WHERE d.id = ? AND d.tenant_id = ?`,
		)
		.get(deviceId, tenantId) as DeviceRow | undefined;
}

export function createDeviceRoutes(
	auth: LocalAuth,
	db: Db,
	tenantId: string,
	gateway: AgentGateway,
	audit: AuditLog,
	jobs?: Jobs,
	config?: ConfigSnapshots,
	updates?: AgentUpdates,
	cleanupDeviceData?: DeviceDataCleanup,
) {
	const app = new Hono<AuthEnv>();
	const authenticated = requireUser(auth);

	app.get("/devices", authenticated, (c) => {
		const siteId = c.req.query("siteId");
		const tagId = c.req.query("tagId");
		const where = ["d.tenant_id = ?"];
		const params: string[] = [tenantId];
		if (siteId) {
			where.push("d.site_id = ?");
			params.push(siteId);
		}
		if (tagId) {
			where.push(
				`EXISTS (
					SELECT 1 FROM device_tags dt_filter JOIN tags t_filter ON t_filter.id = dt_filter.tag_id
					WHERE dt_filter.device_id = d.id AND t_filter.tenant_id = ? AND t_filter.id = ?
				)`,
			);
			params.push(tenantId, tagId);
		}
		const rows = db
			.prepare(
				`SELECT ${LIST_COLUMNS} FROM devices d LEFT JOIN sites s ON s.id = d.site_id AND s.tenant_id = d.tenant_id
				 WHERE ${where.join(" AND ")}
				 ORDER BY d.name`,
			)
			.all(...params) as DeviceRow[];
		return c.json({
			devices: rows.map((row) =>
				toDevice(
					row,
					gateway.presence(row.id),
					findDeviceTags(db, tenantId, row.id),
				),
			),
		});
	});

	app.get("/devices/:deviceId", authenticated, (c) => {
		const deviceId = c.req.param("deviceId");
		const row = findDevice(db, tenantId, deviceId);
		if (!row) return c.json({ error: "device not found" }, 404);
		return c.json({
			device: toDeviceDetail(
				row,
				gateway.presence(deviceId),
				findDeviceTags(db, tenantId, deviceId),
			),
		});
	});

	app.patch("/devices/:deviceId", authenticated, requireAdmin, async (c) => {
		const deviceId = c.req.param("deviceId");
		const current = findDevice(db, tenantId, deviceId);
		if (!current) return c.json({ error: "device not found" }, 404);
		const body = (await c.req.json().catch(() => null)) as Record<
			string,
			unknown
		> | null;
		if (!body || typeof body !== "object" || Array.isArray(body)) {
			return c.json({ error: "request body must be an object" }, 400);
		}

		const assignments: string[] = [];
		const values: (string | null)[] = [];
		const changedFields: string[] = [];
		let tagIds: string[] | undefined;
		if ("name" in body) {
			if (typeof body.name !== "string" || !body.name.trim()) {
				return c.json({ error: "name must not be empty" }, 400);
			}
			assignments.push("name = ?");
			values.push(body.name.trim());
			changedFields.push("name");
		}
		if ("siteId" in body) {
			if (body.siteId !== null && typeof body.siteId !== "string") {
				return c.json({ error: "siteId must be a string or null" }, 400);
			}
			const siteId =
				typeof body.siteId === "string" ? body.siteId.trim() || null : null;
			if (
				siteId !== null &&
				!db
					.prepare("SELECT 1 FROM sites WHERE id = ? AND tenant_id = ?")
					.get(siteId, tenantId)
			) {
				return c.json({ error: "site not found" }, 400);
			}
			assignments.push("site_id = ?");
			values.push(siteId);
			changedFields.push("siteId");
		}
		for (const field of ["description", "notes"] as const) {
			if (!(field in body)) continue;
			const value = body[field];
			if (value !== null && typeof value !== "string") {
				return c.json({ error: `${field} must be a string or null` }, 400);
			}
			assignments.push(`${field} = ?`);
			values.push(typeof value === "string" ? value.trim() || null : null);
			changedFields.push(field);
		}
		if ("tagIds" in body) {
			if (
				!Array.isArray(body.tagIds) ||
				body.tagIds.some((tagId) => typeof tagId !== "string" || !tagId.trim())
			) {
				return c.json({ error: "tagIds must be an array of strings" }, 400);
			}
			tagIds = [
				...new Set(body.tagIds.map((tagId) => (tagId as string).trim())),
			];
			if (tagIds.length > 0) {
				const placeholders = tagIds.map(() => "?").join(", ");
				const found = db
					.prepare(
						`SELECT id FROM tags WHERE tenant_id = ? AND id IN (${placeholders})`,
					)
					.all(tenantId, ...tagIds) as { id: string }[];
				if (found.length !== tagIds.length) {
					return c.json({ error: "tag not found" }, 400);
				}
			}
			changedFields.push("tagIds");
		}
		if (assignments.length === 0 && tagIds === undefined) {
			return c.json({ error: "at least one editable field is required" }, 400);
		}

		assignments.push("updated_at = ?");
		values.push(nowIso());
		db.transaction(() => {
			db.prepare(
				`UPDATE devices SET ${assignments.join(", ")} WHERE id = ? AND tenant_id = ?`,
			).run(...values, deviceId, tenantId);
			if (tagIds === undefined) return;
			db.prepare("DELETE FROM device_tags WHERE device_id = ?").run(deviceId);
			const insert = db.prepare(
				"INSERT INTO device_tags (device_id, tag_id) VALUES (?, ?)",
			);
			for (const tagId of tagIds) insert.run(deviceId, tagId);
		})();
		const updated = findDevice(db, tenantId, deviceId);
		if (!updated) return c.json({ error: "device not found" }, 404);
		audit.record({
			type: AuditEventType.DEVICE_UPDATED,
			actorUserId: c.get("user").id,
			targetType: "device",
			targetId: deviceId,
			detail: { fields: changedFields },
		});
		return c.json({
			device: toDeviceDetail(
				updated,
				gateway.presence(deviceId),
				findDeviceTags(db, tenantId, deviceId),
			),
		});
	});

	const setLifecycle = (
		deviceId: string,
		lifecycle: "active" | "disabled",
		actorUserId: string,
	): DeviceRow | undefined => {
		const current = findDevice(db, tenantId, deviceId);
		if (!current) return undefined;
		if (current.lifecycle_status !== lifecycle) {
			db.prepare(
				"UPDATE devices SET lifecycle_status = ?, updated_at = ? WHERE id = ? AND tenant_id = ?",
			).run(lifecycle, nowIso(), deviceId, tenantId);
			audit.record({
				type: AuditEventType.DEVICE_LIFECYCLE_CHANGED,
				actorUserId,
				targetType: "device",
				targetId: deviceId,
				detail: { from: current.lifecycle_status, to: lifecycle },
			});
		}
		return findDevice(db, tenantId, deviceId);
	};

	for (const [path, lifecycle] of [
		["disable", "disabled"],
		["enable", "active"],
	] as const) {
		app.post(`/devices/:deviceId/${path}`, authenticated, requireAdmin, (c) => {
			const device = setLifecycle(
				c.req.param("deviceId"),
				lifecycle,
				c.get("user").id,
			);
			if (!device) return c.json({ error: "device not found" }, 404);
			return c.json({
				device: toDeviceDetail(
					device,
					gateway.presence(device.id),
					findDeviceTags(db, tenantId, device.id),
				),
			});
		});
	}

	app.delete("/devices/:deviceId", authenticated, requireAdmin, async (c) => {
		const deviceId = c.req.param("deviceId");
		const current = findDevice(db, tenantId, deviceId);
		if (!current) return c.json({ error: "device not found" }, 404);
		if (!cleanupDeviceData) {
			return c.json({ error: "device data cleanup is not configured" }, 500);
		}

		// 先に無効化・revokeして、削除処理中の新しいsyncを受け付けない。
		const at = nowIso();
		const removal = db.transaction(() => {
			const activeBatch = db
				.prepare(
					`SELECT b.id FROM config_apply_batch_items i
					 JOIN config_apply_batches b ON b.id = i.batch_id
					 WHERE i.device_id = ? AND b.tenant_id = ?
					   AND b.status IN ('preparing', 'awaiting_confirmation', 'running', 'stopping')
					 LIMIT 1`,
				)
				.get(deviceId, tenantId) as { id: string } | undefined;
			if (activeBatch) return { batchId: activeBatch.id, revoked: 0 };
			db.prepare(
				"UPDATE devices SET lifecycle_status = 'disabled', updated_at = ? WHERE id = ? AND tenant_id = ?",
			).run(at, deviceId, tenantId);
			const revoked = db
				.prepare(
					"UPDATE device_credentials SET status = 'revoked', revoked_at = ? WHERE device_id = ? AND status = 'active'",
				)
				.run(at, deviceId).changes;
			return { batchId: null, revoked };
		})();
		if (removal.batchId) {
			return c.json(
				{
					error: `Device is used by active CONFIG Apply Batch ${removal.batchId}`,
					code: "config_apply_batch_active",
					batch_id: removal.batchId,
				},
				409,
			);
		}
		const revoked = removal.revoked;
		if (revoked > 0) {
			audit.record({
				type: AuditEventType.DEVICE_CREDENTIAL_REVOKED,
				actorUserId: c.get("user").id,
				targetType: "device",
				targetId: deviceId,
				detail: { reason: "device_deleted", count: revoked },
			});
		}

		try {
			await cleanupDeviceData(deviceId);
		} catch (error) {
			if (error instanceof ConfigBackupInUseError) {
				return c.json(
					{
						error: `Device is used by active CONFIG Apply Batch ${error.batchId}`,
						code: "config_apply_batch_active",
						batch_id: error.batchId,
					},
					409,
				);
			}
			return c.json({ error: "failed to delete device data" }, 500);
		}
		const deleted = db.transaction(() => {
			// Device削除後はcheckpoint waiterへ応答が届かないため、失敗で確定してから外す。
			db.prepare(
				`UPDATE config_checkpoint_items
				 SET status = 'failed', failure_code = 'device_not_found', updated_at = ?
				 WHERE device_id = ? AND status = 'pending'`,
			).run(nowIso(), deviceId);
			return db
				.prepare("DELETE FROM devices WHERE id = ? AND tenant_id = ?")
				.run(deviceId, tenantId);
		})();
		if (deleted.changes === 0)
			return c.json({ error: "device not found" }, 404);
		// 削除直前に開始していたingestが作ったfileも最後に掃除する。
		try {
			await cleanupDeviceData(deviceId);
		} catch {
			return c.json({ error: "failed to delete device data" }, 500);
		}
		audit.record({
			type: AuditEventType.DEVICE_DELETED,
			actorUserId: c.get("user").id,
			targetType: "device",
			targetId: deviceId,
			detail: { revokedCredentials: revoked },
		});
		return c.json({ ok: true });
	});

	// Device Profile / CONFIG世代(#6)。CONFIG本文はAPIから返さない。
	if (config) {
		app.get("/devices/:deviceId/profile", authenticated, (c) => {
			const deviceId = c.req.param("deviceId");
			return c.json({ profile: config.profile(deviceId) });
		});

		app.get(
			"/devices/:deviceId/config-backups",
			authenticated,
			requireAdmin,
			(c) => {
				try {
					return c.json({ backups: config.list(c.req.param("deviceId")) });
				} catch (error) {
					if (error instanceof DeviceNotFoundError)
						return c.json({ error: "device not found" }, 404);
					throw error;
				}
			},
		);

		/** CONFIG本文のdownloadはAdminのみ。本文はauditへ記録しない。 */
		app.get(
			"/devices/:deviceId/config-backups/:id/download",
			authenticated,
			requireAdmin,
			async (c) => {
				const deviceId = c.req.param("deviceId");
				const backupId = c.req.param("id");
				try {
					const { backup, content } = await config.read(deviceId, backupId);
					const body = new Uint8Array(content.length);
					body.set(content);
					audit.record({
						type: AuditEventType.DEVICE_CONFIG_DOWNLOADED,
						actorUserId: c.get("user").id,
						targetType: "device",
						targetId: deviceId,
						detail: { backup_id: backup.id },
					});
					return c.body(body, 200, {
						"content-type": "text/plain; charset=Shift_JIS",
						"content-disposition": `attachment; filename="config-${backup.id}.txt"`,
						"cache-control": "no-store",
						"x-content-type-options": "nosniff",
					});
				} catch (error) {
					if (error instanceof DeviceNotFoundError)
						return c.json({ error: "device not found" }, 404);
					if (error instanceof ConfigBackupNotFoundError)
						return c.json({ error: "config backup not found" }, 404);
					throw error;
				}
			},
		);

		/** CONFIG diffはAdminのみ。本文を含むためauditへ本文を記録しない。 */
		app.get(
			"/devices/:deviceId/config-backups/:id/diff",
			authenticated,
			requireAdmin,
			async (c) => {
				const deviceId = c.req.param("deviceId");
				const backupId = c.req.param("id");
				const against = c.req.query("against");
				if (against === "")
					return c.json({ error: "against must not be empty" }, 400);
				try {
					const result = await config.diff(deviceId, backupId, against);
					audit.record({
						type: AuditEventType.DEVICE_CONFIG_DIFF_VIEWED,
						actorUserId: c.get("user").id,
						targetType: "device",
						targetId: deviceId,
						detail: {
							backup_id: result.backup.id,
							against_id: result.against?.id ?? null,
						},
					});
					return c.json(result, 200, { "cache-control": "no-store" });
				} catch (error) {
					if (error instanceof DeviceNotFoundError)
						return c.json({ error: "device not found" }, 404);
					if (error instanceof ConfigBackupNotFoundError)
						return c.json({ error: "config backup not found" }, 404);
					if (error instanceof InvalidConfigDiffError)
						return c.json({ error: "against must be a different backup" }, 400);
					throw error;
				}
			},
		);

		/** CONFIGの再取得要求。応答は次のsyncで取り込まれる。 */
		app.post(
			"/devices/:deviceId/config-snapshots",
			authenticated,
			requireAdmin,
			(c) => {
				try {
					config.request(c.req.param("deviceId"), "manual", c.get("user").id);
					return c.json({ requested: true }, 202);
				} catch (error) {
					return c.json({ error: (error as Error).message }, 404);
				}
			},
		);
	}

	// Agent A/B Update(#35)
	if (updates) {
		app.get("/devices/:deviceId/agent", authenticated, (c) => {
			try {
				return c.json({
					agent: updates.state(c.req.param("deviceId")),
					releases: updates.releases(),
				});
			} catch {
				return c.json({ error: "device not found" }, 404);
			}
		});

		app.post(
			"/devices/:deviceId/agent-version",
			authenticated,
			requireAdmin,
			async (c) => {
				const body = await c.req.json().catch(() => null);
				if (typeof body?.version !== "string")
					return c.json({ error: "version is required" }, 400);
				try {
					updates.setDesiredVersion(
						c.req.param("deviceId"),
						body.version,
						c.get("user").id,
					);
					return c.json({ desiredVersion: body.version }, 202);
				} catch (error) {
					if (error instanceof ReleaseNotFoundError)
						return c.json({ error: error.message }, 400);
					return c.json({ error: "device not found" }, 404);
				}
			},
		);
		// Supervisor自身の更新(#159)。望ましいversionを保存し、接続中ならすぐに通知する
		app.post(
			"/devices/:deviceId/supervisor-version",
			authenticated,
			requireAdmin,
			async (c) => {
				const body = await c.req.json().catch(() => null);
				if (typeof body?.version !== "string")
					return c.json({ error: "version is required" }, 400);
				try {
					updates.setDesiredSupervisorVersion(
						c.req.param("deviceId"),
						body.version,
						c.get("user").id,
					);
					return c.json({ desiredVersion: body.version }, 202);
				} catch (error) {
					if (error instanceof ReleaseNotFoundError)
						return c.json({ error: error.message }, 400);
					return c.json({ error: "device not found" }, 404);
				}
			},
		);
	}

	/** Dashboard(#28): Device数、Presenceの内訳、最近のJob。 */
	app.get("/dashboard", authenticated, (c) => {
		const rows = db
			.prepare("SELECT id, name FROM devices WHERE tenant_id = ?")
			.all(tenantId) as { id: string; name: string }[];
		const presence = { online: 0, unstable: 0, offline: 0, unknown: 0 };
		for (const { id } of rows) presence[gateway.presence(id).status] += 1;
		const names = new Map(rows.map((row) => [row.id, row.name]));
		return c.json({
			deviceCount: rows.length,
			presence,
			recentJobs: (jobs?.list({ limit: 10 }) ?? []).map((job) => ({
				...job,
				deviceName: names.get(job.device_id) ?? job.device_id,
			})),
		});
	});

	return app;
}
