/**
 * Site / Tagの管理API(#59)。
 *
 * SiteとTagはTenant-scopedなので、一覧・更新・削除のすべてでtenant_idを条件にする。
 * Deviceへの割り当てはDevice APIで扱い、ここではSite / Tag自身だけを管理する。
 */
import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { AuditEventType, type AuditLog } from "../auth/audit.ts";
import { type AuthEnv, requireAdmin, requireUser } from "../auth/authorize.ts";
import type { LocalAuth } from "../auth/localAuth.ts";
import { type Db, nowIso } from "../storage/db.ts";

type SiteRow = {
	id: string;
	name: string;
	description: string | null;
	created_at: string;
	updated_at: string;
};

type TagRow = {
	id: string;
	name: string;
	created_at: string;
};

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isUniqueConstraint(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		typeof error.code === "string" &&
		error.code === "SQLITE_CONSTRAINT_UNIQUE"
	);
}

function toSite(row: SiteRow) {
	return {
		id: row.id,
		name: row.name,
		description: row.description,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

function toTag(row: TagRow) {
	return {
		id: row.id,
		name: row.name,
		createdAt: row.created_at,
	};
}

export function createSiteTagRoutes(
	auth: LocalAuth,
	db: Db,
	tenantId: string,
	audit: AuditLog,
) {
	const app = new Hono<AuthEnv>();
	const authenticated = requireUser(auth);

	app.get("/sites", authenticated, (c) => {
		const rows = db
			.prepare(
				"SELECT id, name, description, created_at, updated_at FROM sites WHERE tenant_id = ? ORDER BY name, id",
			)
			.all(tenantId) as SiteRow[];
		return c.json({ sites: rows.map(toSite) });
	});

	app.post("/sites", authenticated, requireAdmin, async (c) => {
		const body = await c.req.json().catch(() => null);
		if (!isObject(body) || typeof body.name !== "string" || !body.name.trim()) {
			return c.json({ error: "name must not be empty" }, 400);
		}
		const name = body.name.trim();
		if (
			"description" in body &&
			body.description !== null &&
			typeof body.description !== "string"
		) {
			return c.json({ error: "description must be a string or null" }, 400);
		}
		const description =
			typeof body.description === "string"
				? body.description.trim() || null
				: null;
		if (
			db
				.prepare("SELECT 1 FROM sites WHERE tenant_id = ? AND name = ?")
				.get(tenantId, name)
		) {
			return c.json({ error: "site name already exists" }, 409);
		}

		const id = randomUUID();
		const at = nowIso();
		try {
			db.prepare(
				"INSERT INTO sites (id, tenant_id, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
			).run(id, tenantId, name, description, at, at);
		} catch (error) {
			if (isUniqueConstraint(error))
				return c.json({ error: "site name already exists" }, 409);
			throw error;
		}

		const site = db
			.prepare(
				"SELECT id, name, description, created_at, updated_at FROM sites WHERE id = ? AND tenant_id = ?",
			)
			.get(id, tenantId) as SiteRow;
		audit.record({
			type: AuditEventType.SITE_CREATED,
			actorUserId: c.get("user").id,
			targetType: "site",
			targetId: id,
			detail: { name },
		});
		return c.json({ site: toSite(site) }, 201);
	});

	app.patch("/sites/:siteId", authenticated, requireAdmin, async (c) => {
		const siteId = c.req.param("siteId");
		const current = db
			.prepare("SELECT id FROM sites WHERE id = ? AND tenant_id = ?")
			.get(siteId, tenantId);
		if (!current) return c.json({ error: "site not found" }, 404);

		const body = await c.req.json().catch(() => null);
		if (!isObject(body)) {
			return c.json({ error: "request body must be an object" }, 400);
		}
		const assignments: string[] = [];
		const values: (string | null)[] = [];
		if ("name" in body) {
			if (typeof body.name !== "string" || !body.name.trim()) {
				return c.json({ error: "name must not be empty" }, 400);
			}
			const name = body.name.trim();
			if (
				db
					.prepare(
						"SELECT 1 FROM sites WHERE tenant_id = ? AND name = ? AND id <> ?",
					)
					.get(tenantId, name, siteId)
			) {
				return c.json({ error: "site name already exists" }, 409);
			}
			assignments.push("name = ?");
			values.push(name);
		}
		if ("description" in body) {
			if (body.description !== null && typeof body.description !== "string") {
				return c.json({ error: "description must be a string or null" }, 400);
			}
			assignments.push("description = ?");
			values.push(
				typeof body.description === "string"
					? body.description.trim() || null
					: null,
			);
		}
		if (assignments.length === 0) {
			return c.json({ error: "at least one editable field is required" }, 400);
		}
		assignments.push("updated_at = ?");
		values.push(nowIso());
		try {
			db.prepare(
				`UPDATE sites SET ${assignments.join(", ")} WHERE id = ? AND tenant_id = ?`,
			).run(...values, siteId, tenantId);
		} catch (error) {
			if (isUniqueConstraint(error))
				return c.json({ error: "site name already exists" }, 409);
			throw error;
		}

		const site = db
			.prepare(
				"SELECT id, name, description, created_at, updated_at FROM sites WHERE id = ? AND tenant_id = ?",
			)
			.get(siteId, tenantId) as SiteRow;
		audit.record({
			type: AuditEventType.SITE_UPDATED,
			actorUserId: c.get("user").id,
			targetType: "site",
			targetId: siteId,
			detail: {
				fields: assignments.slice(0, -1).map((field) => field.split(" ")[0]),
			},
		});
		return c.json({ site: toSite(site) });
	});

	app.delete("/sites/:siteId", authenticated, requireAdmin, (c) => {
		const siteId = c.req.param("siteId");
		const deleted = db
			.prepare("DELETE FROM sites WHERE id = ? AND tenant_id = ?")
			.run(siteId, tenantId);
		if (deleted.changes === 0) return c.json({ error: "site not found" }, 404);
		audit.record({
			type: AuditEventType.SITE_DELETED,
			actorUserId: c.get("user").id,
			targetType: "site",
			targetId: siteId,
		});
		return c.json({ ok: true });
	});

	app.get("/tags", authenticated, (c) => {
		const rows = db
			.prepare(
				"SELECT id, name, created_at FROM tags WHERE tenant_id = ? ORDER BY name, id",
			)
			.all(tenantId) as TagRow[];
		return c.json({ tags: rows.map(toTag) });
	});

	app.post("/tags", authenticated, requireAdmin, async (c) => {
		const body = await c.req.json().catch(() => null);
		if (!isObject(body) || typeof body.name !== "string" || !body.name.trim()) {
			return c.json({ error: "name must not be empty" }, 400);
		}
		const name = body.name.trim();
		if (
			db
				.prepare("SELECT 1 FROM tags WHERE tenant_id = ? AND name = ?")
				.get(tenantId, name)
		) {
			return c.json({ error: "tag name already exists" }, 409);
		}
		const id = randomUUID();
		const at = nowIso();
		try {
			db.prepare(
				"INSERT INTO tags (id, tenant_id, name, created_at) VALUES (?, ?, ?, ?)",
			).run(id, tenantId, name, at);
		} catch (error) {
			if (isUniqueConstraint(error))
				return c.json({ error: "tag name already exists" }, 409);
			throw error;
		}

		const tag = db
			.prepare(
				"SELECT id, name, created_at FROM tags WHERE id = ? AND tenant_id = ?",
			)
			.get(id, tenantId) as TagRow;
		audit.record({
			type: AuditEventType.TAG_CREATED,
			actorUserId: c.get("user").id,
			targetType: "tag",
			targetId: id,
			detail: { name },
		});
		return c.json({ tag: toTag(tag) }, 201);
	});

	app.delete("/tags/:tagId", authenticated, requireAdmin, (c) => {
		const tagId = c.req.param("tagId");
		const deleted = db
			.prepare("DELETE FROM tags WHERE id = ? AND tenant_id = ?")
			.run(tagId, tenantId);
		if (deleted.changes === 0) return c.json({ error: "tag not found" }, 404);
		audit.record({
			type: AuditEventType.TAG_DELETED,
			actorUserId: c.get("user").id,
			targetType: "tag",
			targetId: tagId,
		});
		return c.json({ ok: true });
	});

	return app;
}
