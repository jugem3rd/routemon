/**
 * Server-side Authorization(docs/core/access-control-design.md §4、§5)。
 *
 * - RoleはAdmin / Viewerだけ。Adminは全操作、Viewerは読み取りのみ
 * - Frontendの表示制御に依存せず、API側で必ずRoleを検証する
 * - Native WebGUIはAdminのみ。session作成の前に拒否する
 */
import type { MiddlewareHandler } from "hono";
import { getCookie } from "hono/cookie";
import type { LocalAuth, Role, User } from "./localAuth.ts";

export const SESSION_COOKIE = "routemon_session";

export type AuthEnv = {
	Variables: { user: User; tenantId: string };
};

export function requireUser(auth: LocalAuth): MiddlewareHandler<AuthEnv> {
	return async (c, next) => {
		const token = getCookie(c, SESSION_COOKIE);
		const user = token ? auth.authenticate(token) : null;
		if (!user) return c.json({ error: "unauthorized" }, 401);
		c.set("user", user);
		// LocalAuthがsessionのmembershipを確認したTenantをAPI scopeへ渡す。
		c.set("tenantId", auth.sessionTenantId());
		await next();
	};
}

export function requireRole(role: Role): MiddlewareHandler<AuthEnv> {
	return async (c, next) => {
		if (c.get("user").role !== role) return c.json({ error: "forbidden" }, 403);
		await next();
	};
}

export const requireAdmin = requireRole("admin");

/** Native WebGUIを開けるか(docs/core/access-control-design.md §5)。 */
export function canUseNativeWebGui(user: User): boolean {
	return user.role === "admin";
}

/** Viewerが実行できない操作かどうか。読み取り以外はAdminのみ。 */
export function isWriteOperation(method: string): boolean {
	return !["GET", "HEAD", "OPTIONS"].includes(method.toUpperCase());
}
