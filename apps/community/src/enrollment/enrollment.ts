/**
 * Device Enrollment(docs/core/device-enrollment-design.md、#23)。
 *
 * - GUIでPending Deviceとone-time Enrollment Codeを作る
 * - RouterはCodeをBearerで送り、Bootstrap Luaを取得する
 * - BootstrapがRouter identityを送り、Device固有credentialを受け取る
 * - Code平文もDevice Token平文も保存しない(docs/core/data-model.md §2.5)
 */
import {
	createHash,
	randomBytes,
	randomUUID,
	timingSafeEqual,
} from "node:crypto";
import { AuditEventType, type AuditLog } from "../auth/audit.ts";
import { type Db, nowIso } from "../storage/db.ts";
import { resolveUrl, type UrlSource } from "./urlSource.ts";

export const CODE_TTL_MS = 15 * 60 * 1000;
/** 表示形式: K7PF-3MTQ-X9RW(docs/core/device-enrollment-design.md §4) */
const CODE_GROUPS = 3;
const CODE_GROUP_LENGTH = 4;
/** 紛らわしい文字(I, O, 0, 1)を除く */
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export class EnrollmentError extends Error {}
export class InvalidCodeError extends EnrollmentError {}
export class DeviceNotFoundError extends EnrollmentError {}

export type PendingDevice = {
	deviceId: string;
	code: string;
	expiresAt: string;
};

export type RouterIdentity = {
	model?: string;
	serialNumber?: string;
	firmwareRevision?: string;
	hostname?: string;
	luaVersion?: string;
	bootstrapVersion?: string;
};

export type EnrollmentResult = {
	deviceId: string;
	deviceToken: string;
	gateway: string;
	agentVersion: string;
};

export function generateCode(): string {
	const groups: string[] = [];
	for (let g = 0; g < CODE_GROUPS; g++) {
		let group = "";
		for (const byte of randomBytes(CODE_GROUP_LENGTH)) {
			group += CODE_ALPHABET[byte % CODE_ALPHABET.length];
		}
		groups.push(group);
	}
	return groups.join("-");
}

export function hashSecret(secret: string): string {
	return createHash("sha256")
		.update(secret.trim().toUpperCase(), "utf8")
		.digest("hex");
}

function hashToken(token: string): string {
	return createHash("sha256").update(token, "utf8").digest("hex");
}

export type EnrollmentOptions = {
	/** Agentが接続するAgent Gateway endpoint(Setupで設定する、#12)。Setup後の値を使うため、関数でもよい */
	gatewayUrl: UrlSource;
	/** 初回導入するAgent version */
	agentVersion?: string;
	now?: () => number;
};

export class Enrollment {
	private readonly db: Db;
	private readonly tenantId: string;
	private readonly audit: AuditLog;
	private readonly options: EnrollmentOptions;
	private readonly now: () => number;

	constructor(
		db: Db,
		tenantId: string,
		audit: AuditLog,
		options: EnrollmentOptions,
	) {
		this.db = db;
		this.tenantId = tenantId;
		this.audit = audit;
		this.options = options;
		this.now = options.now ?? Date.now;
	}

	/** Pending Deviceとone-time Codeを作る。Codeは平文で保存しない。 */
	createPendingDevice(input: {
		name: string;
		siteId?: string | null;
		userId: string;
	}): PendingDevice {
		const deviceId = randomUUID();
		const at = nowIso(new Date(this.now()));
		this.db
			.prepare(
				`INSERT INTO devices (id, tenant_id, site_id, name, lifecycle_status, created_at, updated_at)
				 VALUES (?, ?, ?, ?, 'pending', ?, ?)`,
			)
			.run(deviceId, this.tenantId, input.siteId ?? null, input.name, at, at);
		const pending = this.issueCode(deviceId, input.userId);
		this.audit.record({
			type: AuditEventType.DEVICE_PENDING_CREATED,
			actorUserId: input.userId,
			targetType: "device",
			targetId: deviceId,
			detail: { name: input.name },
		});
		return pending;
	}

	/** 新しいCodeを発行し、そのDeviceの未使用Codeを失効させる(再発行)。 */
	issueCode(deviceId: string, userId: string): PendingDevice {
		const device = this.db
			.prepare("SELECT id FROM devices WHERE id = ? AND tenant_id = ?")
			.get(deviceId, this.tenantId) as { id: string } | undefined;
		if (!device) throw new DeviceNotFoundError(`device not found: ${deviceId}`);

		const at = new Date(this.now());
		// 旧Codeは使用済みとして失効させる
		this.db
			.prepare(
				"UPDATE device_enrollments SET used_at = ? WHERE device_id = ? AND used_at IS NULL",
			)
			.run(nowIso(at), deviceId);

		const code = generateCode();
		const expiresAt = nowIso(new Date(at.getTime() + CODE_TTL_MS));
		this.db
			.prepare(
				`INSERT INTO device_enrollments (id, device_id, code_hash, expires_at, created_by_user_id, created_at)
				 VALUES (?, ?, ?, ?, ?, ?)`,
			)
			.run(
				randomUUID(),
				deviceId,
				hashSecret(code),
				expiresAt,
				userId,
				nowIso(at),
			);
		return { deviceId, code, expiresAt };
	}

	/** Codeを検証する(使用済みにはしない)。Bootstrap取得時に使う。 */
	verifyCode(code: string): { enrollmentId: string; deviceId: string } {
		const row = this.db
			.prepare(
				`SELECT e.id, e.device_id, e.expires_at, e.used_at
				 FROM device_enrollments e JOIN devices d ON d.id = e.device_id AND d.tenant_id = ?
				 WHERE e.code_hash = ?`,
			)
			.get(this.tenantId, hashSecret(code)) as
			| {
					id: string;
					device_id: string;
					expires_at: string;
					used_at: string | null;
			  }
			| undefined;
		if (!row) throw new InvalidCodeError("invalid enrollment code");
		if (row.used_at) throw new InvalidCodeError("enrollment code already used");
		if (Date.parse(row.expires_at) <= this.now())
			throw new InvalidCodeError("enrollment code expired");
		return { enrollmentId: row.id, deviceId: row.device_id };
	}

	/**
	 * Enrollmentを完了し、Device固有credentialを発行する。
	 * 同じCodeでの同時実行でも1つのcredentialだけを発行する。
	 */
	complete(code: string, identity: RouterIdentity = {}): EnrollmentResult {
		const at = nowIso(new Date(this.now()));
		const result = this.db.transaction(() => {
			const { enrollmentId, deviceId } = this.verifyCode(code);
			// 使用済みにできた場合だけ発行する(race / replay対策)
			const used = this.db
				.prepare(
					"UPDATE device_enrollments SET used_at = ? WHERE id = ? AND used_at IS NULL",
				)
				.run(at, enrollmentId);
			if (used.changes === 0)
				throw new InvalidCodeError("enrollment code already used");

			const token = randomBytes(32).toString("base64url");
			// 既存credentialはrevokeしてから新しいものを発行する
			this.db
				.prepare(
					"UPDATE device_credentials SET status = 'revoked', revoked_at = ? WHERE device_id = ? AND status = 'active'",
				)
				.run(at, deviceId);
			this.db
				.prepare(
					"INSERT INTO device_credentials (id, device_id, token_hash, status, created_at) VALUES (?, ?, ?, 'active', ?)",
				)
				.run(randomUUID(), deviceId, hashToken(token), at);
			this.db
				.prepare(
					`UPDATE devices SET lifecycle_status = 'active', registered_at = COALESCE(registered_at, ?),
					 model = COALESCE(?, model), serial_number = COALESCE(?, serial_number),
					 firmware_revision = COALESCE(?, firmware_revision), hostname = COALESCE(?, hostname),
					 agent_version = COALESCE(?, agent_version), updated_at = ?
					 WHERE id = ?`,
				)
				.run(
					at,
					identity.model ?? null,
					identity.serialNumber ?? null,
					identity.firmwareRevision ?? null,
					identity.hostname ?? null,
					identity.bootstrapVersion ?? null,
					at,
					deviceId,
				);
			return { deviceId, deviceToken: token };
		})();

		this.audit.record({
			type: AuditEventType.DEVICE_ENROLLED,
			targetType: "device",
			targetId: result.deviceId,
			detail: {
				model: identity.model ?? null,
				firmware_revision: identity.firmwareRevision ?? null,
			},
		});
		return {
			...result,
			gateway: resolveUrl(this.options.gatewayUrl),
			agentVersion: this.options.agentVersion ?? "stable",
		};
	}

	/** Deviceのcredentialをrevokeする(再Enrollment用)。 */
	revokeCredentials(deviceId: string, userId: string): number {
		const at = nowIso(new Date(this.now()));
		const result = this.db
			.prepare(
				"UPDATE device_credentials SET status = 'revoked', revoked_at = ? WHERE device_id = ? AND status = 'active'",
			)
			.run(at, deviceId);
		if (result.changes > 0) {
			this.audit.record({
				type: AuditEventType.DEVICE_CREDENTIAL_REVOKED,
				actorUserId: userId,
				targetType: "device",
				targetId: deviceId,
			});
		}
		return result.changes;
	}

	/** Enrollmentの進捗(GUI表示用、docs/core/device-enrollment-design.md §8)。 */
	status(deviceId: string): {
		lifecycle: string;
		hasActiveCredential: boolean;
		pendingCodeExpiresAt: string | null;
	} {
		const device = this.db
			.prepare(
				"SELECT lifecycle_status FROM devices WHERE id = ? AND tenant_id = ?",
			)
			.get(deviceId, this.tenantId) as { lifecycle_status: string } | undefined;
		if (!device) throw new DeviceNotFoundError(`device not found: ${deviceId}`);
		const credential = this.db
			.prepare(
				"SELECT 1 FROM device_credentials WHERE device_id = ? AND status = 'active'",
			)
			.get(deviceId);
		const pending = this.db
			.prepare(
				"SELECT expires_at FROM device_enrollments WHERE device_id = ? AND used_at IS NULL ORDER BY created_at DESC LIMIT 1",
			)
			.get(deviceId) as { expires_at: string } | undefined;
		return {
			lifecycle: device.lifecycle_status,
			hasActiveCredential: credential !== undefined,
			pendingCodeExpiresAt: pending?.expires_at ?? null,
		};
	}
}

/** Device credentialの検証(Agent Gatewayから使う)。 */
export function createDeviceStore(db: Db) {
	return {
		async resolveCredential(credential: string): Promise<string | null> {
			const row = db
				.prepare(
					`SELECT c.device_id
					 FROM device_credentials c
					 JOIN devices d ON d.id = c.device_id
					 WHERE c.token_hash = ? AND c.status = 'active'
					   AND d.lifecycle_status <> 'disabled'`,
				)
				.get(hashToken(credential)) as { device_id: string } | undefined;
			return row?.device_id ?? null;
		},
	};
}

/** timingSafeEqualを使う比較(hash同士の比較で使う)。 */
export function safeEqual(a: string, b: string): boolean {
	const left = Buffer.from(a);
	const right = Buffer.from(b);
	return left.length === right.length && timingSafeEqual(left, right);
}
