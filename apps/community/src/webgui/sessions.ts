/**
 * Native WebGUI sessionの認可と監査(docs/core/access-control-design.md §5、§6)。
 *
 * Agent GatewayへStreamを開く前に権限を確認する。relay本体とL7補正は#27。
 */
import { randomUUID } from "node:crypto";
import { AuditEventType, type AuditLog } from "../auth/audit.ts";
import { canUseNativeWebGui } from "../auth/authorize.ts";
import type { User } from "../auth/localAuth.ts";
import type { Db } from "../storage/db.ts";

export class ForbiddenError extends Error {}
export class DeviceNotFoundError extends Error {}

export type NativeGuiSession = {
	id: string;
	userId: string;
	deviceId: string;
	startedAt: number;
};

export class NativeGuiSessions {
	private readonly db: Db;
	private readonly tenantId: string;
	private readonly audit: AuditLog;
	private readonly now: () => number;
	private readonly sessions = new Map<string, NativeGuiSession>();

	constructor(
		db: Db,
		tenantId: string,
		audit: AuditLog,
		now: () => number = Date.now,
	) {
		this.db = db;
		this.tenantId = tenantId;
		this.audit = audit;
		this.now = now;
	}

	/** Adminだけがsessionを開始できる。Streamを開く前に判定する。 */
	start(user: User, deviceId: string): NativeGuiSession {
		if (!canUseNativeWebGui(user)) {
			throw new ForbiddenError(
				"native webgui is available to administrators only",
			);
		}
		const device = this.db
			.prepare("SELECT id FROM devices WHERE id = ? AND tenant_id = ?")
			.get(deviceId, this.tenantId) as { id: string } | undefined;
		if (!device) throw new DeviceNotFoundError(`device not found: ${deviceId}`);

		const session: NativeGuiSession = {
			id: randomUUID(),
			userId: user.id,
			deviceId,
			startedAt: this.now(),
		};
		this.sessions.set(session.id, session);
		this.audit.record({
			type: AuditEventType.NATIVE_GUI_SESSION_STARTED,
			actorUserId: user.id,
			targetType: "device",
			targetId: deviceId,
			detail: { session_id: session.id },
		});
		return session;
	}

	end(sessionId: string): void {
		const session = this.sessions.get(sessionId);
		if (!session) return;
		this.sessions.delete(sessionId);
		this.audit.record({
			type: AuditEventType.NATIVE_GUI_SESSION_ENDED,
			actorUserId: session.userId,
			targetType: "device",
			targetId: session.deviceId,
			detail: {
				session_id: sessionId,
				duration_ms: this.now() - session.startedAt,
			},
		});
	}

	get(sessionId: string): NativeGuiSession | undefined {
		return this.sessions.get(sessionId);
	}

	active(): NativeGuiSession[] {
		return [...this.sessions.values()];
	}
}
