/**
 * Community Local Auth(docs/community/local-auth-design.md)。
 *
 * - Local Authのみ。Public signup / OIDC / SAML / Social Loginは提供しない
 * - 最初のUserはAdmin固定で、Setup完了後は再作成できない(#12のSetup Wizardから呼ぶ)
 * - Password・Session tokenは平文で保存せず、logへも出さない
 * - 最低1名のAdminを維持する(docs/core/access-control-design.md §2)
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { type Db, nowIso } from "../storage/db.ts";
import { hashPassword, verifyPassword } from "./passwords.ts";

export type Role = "admin" | "viewer";

export type User = {
	id: string;
	email: string | null;
	loginId: string | null;
	displayName: string | null;
	role: Role;
};

/** User管理画面で表示する一覧用のUser情報。 */
export type UserListItem = User & {
	createdAt: string;
	lastLoginAt: string | null;
};

export type Session = {
	token: string;
	expiresAt: string;
};

export class AuthError extends Error {}
export class AccountLockedError extends AuthError {}
export class LastAdminError extends AuthError {}

const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const MAX_FAILED_ATTEMPTS = 10;
const LOCK_DURATION_MS = 15 * 60 * 1000;
const SESSION_TOKEN_BYTES = 32;

type UserRow = {
	id: string;
	email: string | null;
	login_id: string | null;
	display_name: string | null;
	role: Role;
};

type UserListRow = UserRow & {
	created_at: string;
	last_login_at: string | null;
};

export class LocalAuth {
	private readonly db: Db;
	private readonly tenantId: string;
	private readonly now: () => number;

	constructor(db: Db, tenantId: string, now: () => number = Date.now) {
		this.db = db;
		this.tenantId = tenantId;
		this.now = now;
	}

	/** 認証済みSessionが所属するTenant scopeをMiddlewareへ渡す。 */
	sessionTenantId(): string {
		return this.tenantId;
	}

	/** Setup Wizardから呼ぶ。Adminが既にいる場合は作成しない。 */
	async createFirstAdmin(input: {
		email?: string;
		loginId?: string;
		password: string;
		displayName?: string;
	}): Promise<User> {
		if (this.countAdmins() > 0) {
			throw new AuthError("an administrator already exists");
		}
		return this.createUser({ ...input, role: "admin" });
	}

	async createUser(input: {
		email?: string;
		loginId?: string;
		password: string;
		displayName?: string;
		role: Role;
	}): Promise<User> {
		if (!input.email && !input.loginId) {
			throw new AuthError("email or login id is required");
		}
		const passwordHash = await hashPassword(input.password);
		const id = randomUUID();
		const at = nowIso(new Date(this.now()));
		this.db.transaction(() => {
			this.db
				.prepare(
					"INSERT INTO users (id, email, login_id, display_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
				)
				.run(
					id,
					input.email ?? null,
					input.loginId ?? null,
					input.displayName ?? null,
					at,
					at,
				);
			this.db
				.prepare(
					"INSERT INTO memberships (user_id, tenant_id, role, created_at) VALUES (?, ?, ?, ?)",
				)
				.run(id, this.tenantId, input.role, at);
			this.db
				.prepare(
					`INSERT INTO local_auth_credentials (user_id, password_hash, password_updated_at, created_at, updated_at)
					 VALUES (?, ?, ?, ?, ?)`,
				)
				.run(id, passwordHash, at, at, at);
		})();
		return {
			id,
			email: input.email ?? null,
			loginId: input.loginId ?? null,
			displayName: input.displayName ?? null,
			role: input.role,
		};
	}

	listUsers(): UserListItem[] {
		const rows = this.db
			.prepare(
				`SELECT u.id, u.email, u.login_id, u.display_name, m.role,
						u.created_at, MAX(s.created_at) AS last_login_at
				 FROM users u JOIN memberships m ON m.user_id = u.id AND m.tenant_id = ?
				 LEFT JOIN sessions s ON s.user_id = u.id
				 GROUP BY u.id, u.email, u.login_id, u.display_name, m.role, u.created_at
				 ORDER BY u.created_at, u.rowid`,
			)
			.all(this.tenantId) as UserListRow[];
		return rows.map((row) => ({
			...toUser(row),
			createdAt: row.created_at,
			lastLoginAt: row.last_login_at,
		}));
	}

	deleteUser(userId: string): void {
		const user = this.findUser(userId);
		if (!user) throw new AuthError("user not found");
		if (user.role === "admin" && this.countAdmins() <= 1) {
			throw new LastAdminError("cannot delete the last administrator");
		}
		this.db.prepare("DELETE FROM users WHERE id = ?").run(userId);
	}

	/** Role変更。最後のAdminをViewerへ変更できない(docs/core/access-control-design.md §2)。 */
	changeRole(userId: string, role: Role): User {
		const user = this.findUser(userId);
		if (!user) throw new AuthError("user not found");
		if (user.role === role) return user;
		if (user.role === "admin" && this.countAdmins() <= 1) {
			throw new LastAdminError(
				"cannot change the role of the last administrator",
			);
		}
		this.db
			.prepare(
				"UPDATE memberships SET role = ? WHERE user_id = ? AND tenant_id = ?",
			)
			.run(role, userId, this.tenantId);
		return { ...user, role };
	}

	async setPassword(userId: string, password: string): Promise<void> {
		const hash = await hashPassword(password);
		const at = nowIso(new Date(this.now()));
		const result = this.db
			.prepare(
				`UPDATE local_auth_credentials
				 SET password_hash = ?, password_updated_at = ?, updated_at = ?, failed_attempts = 0, locked_until = NULL
				 WHERE user_id = ?`,
			)
			.run(hash, at, at, userId);
		if (result.changes === 0) throw new AuthError("user not found");
		// Password変更時は既存Sessionを無効化する
		this.db.prepare("DELETE FROM sessions WHERE user_id = ?").run(userId);
	}

	/** login。失敗理由をclientへ細かく返さない(user不在とpassword誤りを区別しない)。 */
	async login(
		identifier: string,
		password: string,
	): Promise<{ user: User; session: Session }> {
		const row = this.db
			.prepare(
				`SELECT u.id, u.email, u.login_id, u.display_name, m.role
				 FROM users u JOIN memberships m ON m.user_id = u.id AND m.tenant_id = ?
				 WHERE u.email = ? OR u.login_id = ?`,
			)
			.get(this.tenantId, identifier, identifier) as UserRow | undefined;
		if (!row) throw new AuthError("invalid credentials");

		const credential = this.db
			.prepare(
				"SELECT password_hash, failed_attempts, locked_until FROM local_auth_credentials WHERE user_id = ?",
			)
			.get(row.id) as
			| {
					password_hash: string;
					failed_attempts: number;
					locked_until: string | null;
			  }
			| undefined;
		if (!credential) throw new AuthError("invalid credentials");

		const now = this.now();
		if (credential.locked_until && Date.parse(credential.locked_until) > now) {
			throw new AccountLockedError("account temporarily locked");
		}

		if (!(await verifyPassword(password, credential.password_hash))) {
			this.recordFailure(row.id, credential.failed_attempts + 1);
			throw new AuthError("invalid credentials");
		}

		this.db
			.prepare(
				"UPDATE local_auth_credentials SET failed_attempts = 0, locked_until = NULL, updated_at = ? WHERE user_id = ?",
			)
			.run(nowIso(new Date(now)), row.id);
		return { user: toUser(row), session: this.createSession(row.id) };
	}

	private recordFailure(userId: string, attempts: number): void {
		const now = this.now();
		const lockedUntil =
			attempts >= MAX_FAILED_ATTEMPTS
				? nowIso(new Date(now + LOCK_DURATION_MS))
				: null;
		this.db
			.prepare(
				"UPDATE local_auth_credentials SET failed_attempts = ?, locked_until = ?, updated_at = ? WHERE user_id = ?",
			)
			.run(attempts, lockedUntil, nowIso(new Date(now)), userId);
	}

	private createSession(userId: string): Session {
		const token = randomBytes(SESSION_TOKEN_BYTES).toString("base64url");
		const now = this.now();
		const expiresAt = nowIso(new Date(now + SESSION_TTL_MS));
		this.db
			.prepare(
				"INSERT INTO sessions (token_hash, user_id, created_at, last_seen_at, expires_at) VALUES (?, ?, ?, ?, ?)",
			)
			.run(
				hashToken(token),
				userId,
				nowIso(new Date(now)),
				nowIso(new Date(now)),
				expiresAt,
			);
		return { token, expiresAt };
	}

	/** session tokenからUserを解決する。期限切れは無効。 */
	authenticate(token: string): User | null {
		const tokenHash = hashToken(token);
		const row = this.db
			.prepare(
				`SELECT u.id, u.email, u.login_id, u.display_name, m.role, s.expires_at
				 FROM sessions s
				 JOIN users u ON u.id = s.user_id
				 JOIN memberships m ON m.user_id = u.id AND m.tenant_id = ?
				 WHERE s.token_hash = ?`,
			)
			.get(this.tenantId, tokenHash) as
			| (UserRow & { expires_at: string })
			| undefined;
		if (!row) return null;
		if (Date.parse(row.expires_at) <= this.now()) {
			this.db
				.prepare("DELETE FROM sessions WHERE token_hash = ?")
				.run(tokenHash);
			return null;
		}
		this.db
			.prepare("UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?")
			.run(nowIso(new Date(this.now())), tokenHash);
		return toUser(row);
	}

	logout(token: string): void {
		this.db
			.prepare("DELETE FROM sessions WHERE token_hash = ?")
			.run(hashToken(token));
	}

	/** 期限切れSessionの掃除。 */
	purgeExpiredSessions(): number {
		return this.db
			.prepare("DELETE FROM sessions WHERE expires_at <= ?")
			.run(nowIso(new Date(this.now()))).changes;
	}

	countAdmins(): number {
		const row = this.db
			.prepare(
				"SELECT COUNT(*) AS count FROM memberships WHERE tenant_id = ? AND role = 'admin'",
			)
			.get(this.tenantId) as { count: number };
		return row.count;
	}

	findUser(userId: string): User | null {
		const row = this.db
			.prepare(
				`SELECT u.id, u.email, u.login_id, u.display_name, m.role
				 FROM users u JOIN memberships m ON m.user_id = u.id AND m.tenant_id = ?
				 WHERE u.id = ?`,
			)
			.get(this.tenantId, userId) as UserRow | undefined;
		return row ? toUser(row) : null;
	}
}

function toUser(row: UserRow): User {
	return {
		id: row.id,
		email: row.email,
		loginId: row.login_id,
		displayName: row.display_name,
		role: row.role,
	};
}

function hashToken(token: string): string {
	return createHash("sha256").update(token, "utf8").digest("hex");
}
