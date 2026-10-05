/**
 * 監査Event(docs/core/access-control-design.md §6)。
 *
 * 強い操作を記録する。転送したHTTP body、CONFIG本文、password、token等は記録しない。
 */
import { randomUUID } from "node:crypto";
import { type Db, nowIso } from "../storage/db.ts";

export const AuditEventType = {
	USER_CREATED: "USER_CREATED",
	USER_DELETED: "USER_DELETED",
	USER_ROLE_CHANGED: "USER_ROLE_CHANGED",
	USER_PASSWORD_CHANGED: "USER_PASSWORD_CHANGED",
	DEVICE_PENDING_CREATED: "DEVICE_PENDING_CREATED",
	DEVICE_ENROLLED: "DEVICE_ENROLLED",
	DEVICE_UPDATED: "DEVICE_UPDATED",
	DEVICE_LIFECYCLE_CHANGED: "DEVICE_LIFECYCLE_CHANGED",
	DEVICE_CREDENTIAL_REVOKED: "DEVICE_CREDENTIAL_REVOKED",
	DEVICE_DELETED: "DEVICE_DELETED",
	DEVICE_CONFIG_SNAPSHOT: "DEVICE_CONFIG_SNAPSHOT",
	DEVICE_ROUTE_TABLE_REFRESHED: "DEVICE_ROUTE_TABLE_REFRESHED",
	DEVICE_CONFIG_REQUESTED: "DEVICE_CONFIG_REQUESTED",
	DEVICE_CONFIG_DOWNLOADED: "DEVICE_CONFIG_DOWNLOADED",
	DEVICE_CONFIG_DIFF_VIEWED: "DEVICE_CONFIG_DIFF_VIEWED",
	CONFIG_CHECKPOINT_CREATED: "CONFIG_CHECKPOINT_CREATED",
	CONFIG_CHECKPOINT_DELETED: "CONFIG_CHECKPOINT_DELETED",
	CONFIG_APPLY_BATCH_CREATED: "CONFIG_APPLY_BATCH_CREATED",
	CONFIG_APPLY_BATCH_PREPARED: "CONFIG_APPLY_BATCH_PREPARED",
	CONFIG_APPLY_BATCH_CONFIRMED: "CONFIG_APPLY_BATCH_CONFIRMED",
	CONFIG_APPLY_BATCH_COMPLETED: "CONFIG_APPLY_BATCH_COMPLETED",
	CONFIG_APPLY_BATCH_STOPPED: "CONFIG_APPLY_BATCH_STOPPED",
	DEVICE_AGENT_VERSION_SET: "DEVICE_AGENT_VERSION_SET",
	DEVICE_SUPERVISOR_UPDATE_REQUESTED: "DEVICE_SUPERVISOR_UPDATE_REQUESTED",
	NATIVE_GUI_SESSION_STARTED: "NATIVE_GUI_SESSION_STARTED",
	NATIVE_GUI_SESSION_ENDED: "NATIVE_GUI_SESSION_ENDED",
	COMMAND_EXECUTED: "COMMAND_EXECUTED",
	CONFIG_APPLIED: "CONFIG_APPLIED",
	CONFIG_APPLY_REQUESTED: "CONFIG_APPLY_REQUESTED",
	CONFIG_APPLY_FAILED: "CONFIG_APPLY_FAILED",
	CONFIG_SAVE_REQUESTED: "CONFIG_SAVE_REQUESTED",
	CONFIG_SAVE_FAILED: "CONFIG_SAVE_FAILED",
	CONFIG_SAVED: "CONFIG_SAVED",
	CONFIG_SAVED_DETECTED: "CONFIG_SAVED_DETECTED",
	CONFIG_APPLY_DISCARD_REQUESTED: "CONFIG_APPLY_DISCARD_REQUESTED",
	CONFIG_APPLY_DISCARDED: "CONFIG_APPLY_DISCARDED",
	DEVICE_REBOOT_REQUESTED: "DEVICE_REBOOT_REQUESTED",
	DEVICE_REBOOT_SCHEDULED: "DEVICE_REBOOT_SCHEDULED",
	DEVICE_REBOOT_CANCELLED: "DEVICE_REBOOT_CANCELLED",
	SITE_CREATED: "SITE_CREATED",
	SITE_UPDATED: "SITE_UPDATED",
	SITE_DELETED: "SITE_DELETED",
	TAG_CREATED: "TAG_CREATED",
	TAG_DELETED: "TAG_DELETED",
	BACKUP_CREATED: "BACKUP_CREATED",
	BACKUP_DOWNLOADED: "BACKUP_DOWNLOADED",
	BACKUP_DELETED: "BACKUP_DELETED",
	AUDIT_LOG_EXPORTED: "AUDIT_LOG_EXPORTED",
} as const;

type AuditEventTypeValue = (typeof AuditEventType)[keyof typeof AuditEventType];

/**
 * GUIへ返してよいdetail fieldだけをEvent種別ごとに定義する。
 * AuditEventTypeへ種別を追加しただけでは、ここに追加しない限りdetailは返さない。
 * CONFIG本文、password、token、secret、Native WebGUIのsession IDは公開しない。
 */
export const AUDIT_DETAIL_ALLOWLIST = {
	[AuditEventType.USER_CREATED]: ["role"],
	[AuditEventType.USER_DELETED]: [],
	[AuditEventType.USER_ROLE_CHANGED]: ["from", "to"],
	[AuditEventType.USER_PASSWORD_CHANGED]: ["self"],
	[AuditEventType.DEVICE_PENDING_CREATED]: ["name"],
	[AuditEventType.DEVICE_ENROLLED]: ["model", "firmware_revision"],
	[AuditEventType.DEVICE_UPDATED]: ["fields"],
	[AuditEventType.DEVICE_LIFECYCLE_CHANGED]: ["from", "to"],
	[AuditEventType.DEVICE_CREDENTIAL_REVOKED]: ["reason", "count"],
	[AuditEventType.DEVICE_DELETED]: ["revokedCredentials"],
	[AuditEventType.DEVICE_CONFIG_SNAPSHOT]: ["reason", "backup_id"],
	[AuditEventType.DEVICE_ROUTE_TABLE_REFRESHED]: ["result"],
	[AuditEventType.DEVICE_CONFIG_REQUESTED]: ["reason"],
	[AuditEventType.DEVICE_CONFIG_DOWNLOADED]: ["backup_id"],
	[AuditEventType.DEVICE_CONFIG_DIFF_VIEWED]: ["backup_id", "against_id"],
	[AuditEventType.CONFIG_CHECKPOINT_CREATED]: ["device_count"],
	[AuditEventType.CONFIG_CHECKPOINT_DELETED]: [],
	[AuditEventType.CONFIG_APPLY_BATCH_CREATED]: [
		"batch_id",
		"source",
		"checkpoint_id",
		"device_count",
		"confirmation_mode",
		"save_after_apply",
	],
	[AuditEventType.CONFIG_APPLY_BATCH_PREPARED]: [
		"batch_id",
		"device_count",
		"result",
	],
	[AuditEventType.CONFIG_APPLY_BATCH_CONFIRMED]: [
		"batch_id",
		"confirmation_mode",
		"device_count",
	],
	[AuditEventType.CONFIG_APPLY_BATCH_COMPLETED]: [
		"batch_id",
		"result",
		"device_count",
	],
	[AuditEventType.CONFIG_APPLY_BATCH_STOPPED]: [
		"batch_id",
		"result",
		"stop_reason",
		"device_count",
	],
	[AuditEventType.DEVICE_AGENT_VERSION_SET]: ["version", "from"],
	[AuditEventType.DEVICE_SUPERVISOR_UPDATE_REQUESTED]: ["version", "from"],
	[AuditEventType.NATIVE_GUI_SESSION_STARTED]: [],
	[AuditEventType.NATIVE_GUI_SESSION_ENDED]: ["duration_ms"],
	[AuditEventType.COMMAND_EXECUTED]: ["job_id", "command"],
	[AuditEventType.CONFIG_APPLIED]: [
		"apply_id",
		"batch_id",
		"batch_item_id",
		"target_backup_id",
		"pre_apply_backup_id",
		"apply_result",
	],
	[AuditEventType.CONFIG_APPLY_REQUESTED]: [
		"apply_id",
		"batch_id",
		"batch_item_id",
		"target_backup_id",
		"save_after_apply",
	],
	[AuditEventType.CONFIG_APPLY_FAILED]: [
		"apply_id",
		"batch_id",
		"batch_item_id",
		"phase",
		"error_code",
	],
	[AuditEventType.CONFIG_SAVE_REQUESTED]: [
		"job_id",
		"apply_id",
		"batch_id",
		"batch_item_id",
	],
	[AuditEventType.CONFIG_SAVE_FAILED]: [
		"job_id",
		"apply_id",
		"batch_id",
		"batch_item_id",
		"reason",
	],
	[AuditEventType.CONFIG_SAVED]: [
		"apply_id",
		"batch_id",
		"batch_item_id",
		"job_id",
	],
	[AuditEventType.CONFIG_SAVED_DETECTED]: ["job_id"],
	[AuditEventType.CONFIG_APPLY_DISCARD_REQUESTED]: ["apply_id", "job_id"],
	[AuditEventType.CONFIG_APPLY_DISCARDED]: ["apply_id", "job_id"],
	[AuditEventType.DEVICE_REBOOT_REQUESTED]: ["job_id", "save", "scheduled_at"],
	[AuditEventType.DEVICE_REBOOT_SCHEDULED]: ["job_id", "save", "scheduled_at"],
	[AuditEventType.DEVICE_REBOOT_CANCELLED]: ["job_id", "scheduled_at"],
	[AuditEventType.SITE_CREATED]: ["name"],
	[AuditEventType.SITE_UPDATED]: ["fields"],
	[AuditEventType.SITE_DELETED]: [],
	[AuditEventType.TAG_CREATED]: ["name"],
	[AuditEventType.TAG_DELETED]: [],
	[AuditEventType.BACKUP_CREATED]: ["includes_syslog", "size_bytes"],
	[AuditEventType.BACKUP_DOWNLOADED]: ["size_bytes"],
	[AuditEventType.BACKUP_DELETED]: ["size_bytes"],
	[AuditEventType.AUDIT_LOG_EXPORTED]: ["count", "truncated"],
	// AuditEventTypeに今後追加する種別は、ここへ明示的に追加するまで公開しない。
} as const satisfies Partial<Record<AuditEventTypeValue, readonly string[]>>;

function isJsonObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 保存済みdetail_jsonから、GUIへ返してよいfieldだけを取り出す。 */
export function filterAuditDetail(
	type: string,
	detailJson: string | null,
): Record<string, unknown> | undefined {
	const allowed =
		AUDIT_DETAIL_ALLOWLIST[type as AuditEventTypeValue] ?? undefined;
	if (!allowed || !detailJson) return undefined;

	let parsed: unknown;
	try {
		parsed = JSON.parse(detailJson);
	} catch {
		return undefined;
	}
	if (!isJsonObject(parsed)) return undefined;

	const filtered: Record<string, unknown> = {};
	for (const field of allowed) {
		if (Object.hasOwn(parsed, field)) {
			filtered[field] = parsed[field];
		}
	}
	return Object.keys(filtered).length > 0 ? filtered : undefined;
}

export type AuditEvent = {
	type: string;
	actorUserId?: string | null;
	targetType?: string | null;
	targetId?: string | null;
	detail?: Record<string, unknown>;
};

export type AuditEventRow = {
	id: string;
	tenant_id: string;
	actor_user_id: string | null;
	type: string;
	target_type: string | null;
	target_id: string | null;
	detail_json: string | null;
	created_at: string;
};

/**
 * CSVエクスポートの件数上限(#118)。一覧 API の最大 500 より多く出す。
 * 10,000 件を選んだ理由: 1 行 200B としても 2MB 程度で単一レスポンスとして
 * 安全に返せ、Excel の行上限(約 100 万行)にも遠く及ばず、月次まとめ等の
 * 長期保管用途にも足りる実用的な水準のため。上限なしにはしない。
 */
export const AUDIT_EXPORT_LIMIT = 10_000;

export type AuditListOptions = {
	limit?: number;
	from?: string;
	to?: string;
	actorUserId?: string;
	type?: string;
	target?: string;
	targetType?: string;
	targetId?: string;
};

export class AuditLog {
	private readonly db: Db;
	private readonly tenantId: string;
	private readonly now: () => number;

	constructor(db: Db, tenantId: string, now: () => number = Date.now) {
		this.db = db;
		this.tenantId = tenantId;
		this.now = now;
	}

	record(event: AuditEvent): string {
		const id = randomUUID();
		this.db
			.prepare(
				`INSERT INTO audit_events (id, tenant_id, actor_user_id, type, target_type, target_id, detail_json, created_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				id,
				this.tenantId,
				event.actorUserId ?? null,
				event.type,
				event.targetType ?? null,
				event.targetId ?? null,
				event.detail ? JSON.stringify(event.detail) : null,
				nowIso(new Date(this.now())),
			);
		return id;
	}

	/**
	 * 操作と監査Eventを同じTransactionでcommitし、どちらかが失敗したら両方rollbackする。
	 */
	recordAndApply<T>(event: AuditEvent, apply: () => T): T {
		return this.db.transaction(() => {
			this.record(event);
			return apply();
		})();
	}

	list(input: number | AuditListOptions = 100): AuditEventRow[] {
		const options = typeof input === "number" ? { limit: input } : input;
		const where = ["tenant_id = ?"];
		const params: (string | number)[] = [this.tenantId];

		if (options.from) {
			where.push("created_at >= ?");
			params.push(options.from);
		}
		if (options.to) {
			where.push("created_at <= ?");
			params.push(options.to);
		}
		if (options.actorUserId) {
			where.push("actor_user_id = ?");
			params.push(options.actorUserId);
		}
		if (options.type) {
			where.push("type = ?");
			params.push(options.type);
		}
		if (options.targetType) {
			where.push("target_type = ?");
			params.push(options.targetType);
		}
		if (options.targetId) {
			where.push("target_id = ?");
			params.push(options.targetId);
		}
		if (options.target) {
			where.push("(target_type LIKE ? OR target_id LIKE ?)");
			const target = `%${options.target}%`;
			params.push(target, target);
		}

		// 一覧 API 側は route で 500 までに絞る。ここではエクスポートまで許す。
		// +1 はエクスポートの上限超過検出用 probe のため。利用者向けの出力は
		// 一覧 500 件・CSV AUDIT_EXPORT_LIMIT 件で別に絞る。
		const limit = Math.min(
			Math.max(Math.trunc(options.limit ?? 100), 1),
			AUDIT_EXPORT_LIMIT + 1,
		);
		params.push(limit);
		return this.db
			.prepare(
				`SELECT * FROM audit_events WHERE ${where.join(" AND ")} ORDER BY created_at DESC, id DESC LIMIT ?`,
			)
			.all(...params) as AuditEventRow[];
	}
}
