/**
 * Local AuthとUser管理のHTTP API(docs/community/local-auth-design.md、
 * docs/core/access-control-design.md §4)。
 *
 * Session tokenはhttpOnly cookieで渡す。Roleの検証はFrontendに依存せずここで行い、
 * 強い操作は監査Eventへ記録する。
 */
import { type Context, Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import {
	AUDIT_EXPORT_LIMIT,
	AuditEventType,
	type AuditListOptions,
	type AuditLog,
	filterAuditDetail,
} from "../auth/audit.ts";
import {
	AUDIT_EXPORT_COUNT_HEADER,
	AUDIT_EXPORT_LIMIT_HEADER,
	AUDIT_EXPORT_TRUNCATED_HEADER,
	buildAuditCsv,
} from "../auth/auditCsv.ts";
import {
	type AuthEnv,
	requireAdmin,
	requireUser,
	SESSION_COOKIE,
} from "../auth/authorize.ts";
import {
	AccountLockedError,
	AuthError,
	LastAdminError,
	type LocalAuth,
} from "../auth/localAuth.ts";
import { WeakPasswordError } from "../auth/passwords.ts";

export { SESSION_COOKIE };

export function createAuthRoutes(
	auth: LocalAuth,
	audit: AuditLog,
	options: { secureCookie?: boolean } = {},
) {
	const app = new Hono<AuthEnv>();
	const authenticated = requireUser(auth);

	app.post("/auth/login", async (c) => {
		const body = await c.req.json().catch(() => null);
		const identifier =
			typeof body?.identifier === "string" ? body.identifier : "";
		const password = typeof body?.password === "string" ? body.password : "";
		if (!identifier || !password) {
			return c.json({ error: "identifier and password are required" }, 400);
		}
		try {
			const { user, session } = await auth.login(identifier, password);
			setCookie(c, SESSION_COOKIE, session.token, {
				httpOnly: true,
				sameSite: "Lax",
				secure: options.secureCookie ?? true,
				path: "/",
				expires: new Date(session.expiresAt),
			});
			return c.json({ user });
		} catch (error) {
			if (error instanceof AccountLockedError)
				return c.json({ error: "account locked" }, 429);
			if (error instanceof AuthError)
				return c.json({ error: "invalid credentials" }, 401);
			throw error;
		}
	});

	app.post("/auth/logout", (c) => {
		const token = getCookie(c, SESSION_COOKIE);
		if (token) auth.logout(token);
		deleteCookie(c, SESSION_COOKIE, { path: "/" });
		return c.json({ ok: true });
	});

	app.get("/auth/me", authenticated, (c) => c.json({ user: c.get("user") }));

	app.get("/users", authenticated, requireAdmin, (c) =>
		c.json({ users: auth.listUsers() }),
	);

	app.post("/users", authenticated, requireAdmin, async (c) => {
		const body = await c.req.json().catch(() => null);
		const role =
			body?.role === "admin" || body?.role === "viewer" ? body.role : null;
		if (!role || typeof body?.password !== "string") {
			return c.json({ error: "role and password are required" }, 400);
		}
		try {
			const user = await auth.createUser({
				email: typeof body.email === "string" ? body.email : undefined,
				loginId: typeof body.loginId === "string" ? body.loginId : undefined,
				displayName:
					typeof body.displayName === "string" ? body.displayName : undefined,
				password: body.password,
				role,
			});
			audit.record({
				type: AuditEventType.USER_CREATED,
				actorUserId: c.get("user").id,
				targetType: "user",
				targetId: user.id,
				detail: { role: user.role },
			});
			return c.json({ user }, 201);
		} catch (error) {
			if (error instanceof WeakPasswordError || error instanceof AuthError) {
				return c.json({ error: error.message }, 400);
			}
			throw error;
		}
	});

	app.patch("/users/:id", authenticated, requireAdmin, async (c) => {
		const body = await c.req.json().catch(() => null);
		const role =
			body?.role === "admin" || body?.role === "viewer" ? body.role : null;
		if (!role) return c.json({ error: "role must be admin or viewer" }, 400);
		const target = c.req.param("id");
		try {
			const before = auth.findUser(target);
			const user = auth.changeRole(target, role);
			if (before && before.role !== user.role) {
				audit.record({
					type: AuditEventType.USER_ROLE_CHANGED,
					actorUserId: c.get("user").id,
					targetType: "user",
					targetId: user.id,
					detail: { from: before.role, to: user.role },
				});
			}
			return c.json({ user });
		} catch (error) {
			if (error instanceof LastAdminError)
				return c.json({ error: error.message }, 409);
			if (error instanceof AuthError)
				return c.json({ error: error.message }, 404);
			throw error;
		}
	});

	app.delete("/users/:id", authenticated, requireAdmin, (c) => {
		const target = c.req.param("id");
		const actor = c.get("user");
		if (actor.id === target) {
			return c.json(
				{
					error:
						"自分自身のアカウントは削除できません。別のAdminに依頼してください。",
				},
				409,
			);
		}
		try {
			audit.recordAndApply(
				{
					type: AuditEventType.USER_DELETED,
					actorUserId: actor.id,
					targetType: "user",
					targetId: target,
				},
				() => auth.deleteUser(target),
			);
			return c.json({ ok: true });
		} catch (error) {
			if (error instanceof LastAdminError)
				return c.json({ error: error.message }, 409);
			if (error instanceof AuthError)
				return c.json({ error: error.message }, 404);
			throw error;
		}
	});

	/** Adminは任意のUser、Userは自分のpasswordを変更できる。 */
	app.post("/users/:id/password", authenticated, async (c) => {
		const target = c.req.param("id");
		const actor = c.get("user");
		if (actor.role !== "admin" && actor.id !== target)
			return c.json({ error: "forbidden" }, 403);
		const body = await c.req.json().catch(() => null);
		if (typeof body?.password !== "string")
			return c.json({ error: "password is required" }, 400);
		try {
			await auth.setPassword(target, body.password);
			audit.record({
				type: AuditEventType.USER_PASSWORD_CHANGED,
				actorUserId: actor.id,
				targetType: "user",
				targetId: target,
				detail: { self: actor.id === target },
			});
			return c.json({ ok: true });
		} catch (error) {
			if (error instanceof WeakPasswordError)
				return c.json({ error: error.message }, 400);
			if (error instanceof AuthError)
				return c.json({ error: error.message }, 404);
			throw error;
		}
	});

	app.get("/audit-events", authenticated, requireAdmin, (c) => {
		const limit = Math.min(Number(c.req.query("limit") ?? 100) || 100, 500);
		const parsed = auditFilterQuery(c);
		if (parsed.error) return c.json({ error: parsed.error }, 400);

		const rows = audit.list({ ...parsed.options, limit });

		const actorNames = actorNameMap(auth);
		// 保存済みdetail_jsonはそのまま返さず、Event種別ごとのallowlistを通した結果だけ返す。
		return c.json({
			events: rows.map((row) => {
				const detail = filterAuditDetail(row.type, row.detail_json);
				return {
					id: row.id,
					actor_user_id: row.actor_user_id,
					actor_name: row.actor_user_id
						? (actorNames.get(row.actor_user_id) ?? null)
						: null,
					type: row.type,
					target_type: row.target_type,
					target_id: row.target_id,
					created_at: row.created_at,
					...(detail ? { detail } : {}),
				};
			}),
		});
	});

	/**
	 * 監査ログのCSVエクスポート(#118)。Adminのみ。
	 * 一覧と同じ絞り込み条件・同じ並び順で、上限(AUDIT_EXPORT_LIMIT)まで返す。
	 */
	app.get("/audit-events/export", authenticated, requireAdmin, (c) => {
		const parsed = auditFilterQuery(c);
		if (parsed.error) return c.json({ error: parsed.error }, 400);

		// 上限超過の検出用に1件多く取り、出力は上限までにする。
		const fetched = audit.list({
			...parsed.options,
			limit: AUDIT_EXPORT_LIMIT + 1,
		});
		const truncated = fetched.length > AUDIT_EXPORT_LIMIT;
		const rows = truncated ? fetched.slice(0, AUDIT_EXPORT_LIMIT) : fetched;

		const actorNames = actorNameMap(auth);
		const csv = buildAuditCsv(rows, (actorUserId) =>
			actorUserId ? (actorNames.get(actorUserId) ?? null) : null,
		);
		// エクスポート自体を監査へ残す。取得の後に記録するので、今回のCSVには含まれない。
		audit.record({
			type: AuditEventType.AUDIT_LOG_EXPORTED,
			actorUserId: c.get("user").id,
			detail: { count: rows.length, truncated },
		});
		const stamp = new Date().toISOString().slice(0, 10).replaceAll("-", "");
		return c.body(new TextEncoder().encode(csv), 200, {
			"content-type": "text/csv; charset=utf-8",
			"content-disposition": `attachment; filename="audit-events-${stamp}.csv"`,
			"cache-control": "no-store",
			"x-content-type-options": "nosniff",
			[AUDIT_EXPORT_TRUNCATED_HEADER]: truncated ? "true" : "false",
			[AUDIT_EXPORT_COUNT_HEADER]: String(rows.length),
			[AUDIT_EXPORT_LIMIT_HEADER]: String(AUDIT_EXPORT_LIMIT),
		});
	});

	return app;
}

/**
 * 一覧とエクスポートで同じ絞り込み条件を使うためのquery読み取り。
 * 日時の形式が不正ならerrorを返す。
 */
function auditFilterQuery(c: Context<AuthEnv>): {
	options: AuditListOptions;
	error?: string;
} {
	const from = c.req.query("from");
	const to = c.req.query("to");
	for (const [name, value] of [
		["from", from],
		["to", to],
	] as const) {
		if (value && Number.isNaN(Date.parse(value)))
			return { options: {}, error: `${name}の形式が不正です` };
	}
	return {
		options: {
			from: from || undefined,
			to: to || undefined,
			actorUserId:
				c.req.query("actorUserId") ?? c.req.query("actor") ?? undefined,
			type: c.req.query("type") || undefined,
			target: c.req.query("target") || undefined,
			targetType:
				c.req.query("targetType") ?? c.req.query("target_type") ?? undefined,
			targetId:
				c.req.query("targetId") ?? c.req.query("target_id") ?? undefined,
		},
	};
}

/** 一覧とエクスポートで同じ実行者表示にするための名前解決。 */
function actorNameMap(auth: LocalAuth): Map<string, string> {
	return new Map(
		auth
			.listUsers()
			.map((user) => [
				user.id,
				user.displayName ?? user.loginId ?? user.email ?? user.id,
			]),
	);
}
