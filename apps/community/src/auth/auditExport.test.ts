/**
 * 監査ログCSVエクスポート(#118)のテスト。
 *
 * 最重要: allowlist に無い field と未知種別の detail がファイルへ出ないことを固定する。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createApp } from "../app.ts";
import { nowIso } from "../storage/db.ts";
import {
	ensureDefaultTenant,
	openStorage,
	type Storage,
} from "../storage/index.ts";
import { AUDIT_EXPORT_LIMIT, AuditEventType, AuditLog } from "./audit.ts";
import {
	AUDIT_EXPORT_HEADER,
	buildAuditCsv,
	escapeCsvField,
	formatCsvTime,
	formatDetail,
} from "./auditCsv.ts";
import { LocalAuth } from "./localAuth.ts";

const PASSWORD = "correct horse battery";

let root: string;
let storage: Storage;
let tenantId: string;
let auth: LocalAuth;
let audit: AuditLog;
let now: number;

beforeEach(async () => {
	root = mkdtempSync(join(tmpdir(), "routemon-audit-export-"));
	storage = await openStorage({ root });
	tenantId = ensureDefaultTenant(storage.db);
	now = Date.parse("2026-09-16T00:00:00.000Z");
	auth = new LocalAuth(storage.db, tenantId, () => now);
	audit = new AuditLog(storage.db, tenantId, () => now);
});

afterEach(() => {
	storage.close();
	rmSync(root, { recursive: true, force: true });
});

async function setupUsers() {
	const admin = await auth.createFirstAdmin({
		loginId: "admin",
		password: PASSWORD,
	});
	const viewer = await auth.createUser({
		loginId: "viewer",
		password: PASSWORD,
		role: "viewer",
	});
	return { admin, viewer };
}

function api() {
	return createApp({ auth, audit, secureCookie: false });
}

async function login(app: ReturnType<typeof api>, identifier: string) {
	const res = await app.request("/api/auth/login", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ identifier, password: PASSWORD }),
	});
	return res.headers.get("set-cookie")?.split(";")[0] ?? "";
}

describe("escapeCsvField", () => {
	test('`,` `"` 改行を含む値だけを `"` で囲み、内部の `"` は `""` にする', () => {
		expect(escapeCsvField("plain")).toBe("plain");
		expect(escapeCsvField("a,b")).toBe('"a,b"');
		expect(escapeCsvField('a"b')).toBe('"a""b"');
		expect(escapeCsvField("a\nb")).toBe('"a\nb"');
		expect(escapeCsvField("a\r\nb")).toBe('"a\r\nb"');
		expect(escapeCsvField("")).toBe("");
	});
});

describe("formatCsvTime", () => {
	test("ISO 8601 (UTC)で固定し、サーバーのtimezoneに左右されない", () => {
		expect(formatCsvTime("2026-09-24T13:37:00.000Z")).toBe(
			"2026-09-24T13:37:00.000Z",
		);
		// オフセット付き入力もUTCへ正規化する。
		expect(formatCsvTime("2026-09-24T22:37:00+09:00")).toBe(
			"2026-09-24T13:37:00.000Z",
		);
	});

	test("buildAuditCsvの日時列がISO 8601 (UTC)になる", () => {
		const csv = buildAuditCsv(
			[
				{
					id: "1",
					tenant_id: "t",
					actor_user_id: null,
					type: AuditEventType.TAG_DELETED,
					target_type: null,
					target_id: null,
					detail_json: null,
					created_at: "2026-09-24T13:37:00.000Z",
				},
			],
			() => null,
		);
		const firstDataLine = csv.replace(/^\uFEFF/, "").split("\r\n")[1];
		expect(firstDataLine?.split(",")[0]).toBe("2026-09-24T13:37:00.000Z");
	});
});

describe("formatDetail", () => {
	test("allowlistを通した結果だけを `key=value` の `; ` 連結にする", () => {
		expect(
			formatDetail(
				AuditEventType.USER_ROLE_CHANGED,
				JSON.stringify({ from: "viewer", to: "admin", password: "secret" }),
			),
		).toBe("from=viewer; to=admin");
	});

	test("allowlistの結果が空・未知種別・不正JSONは空欄", () => {
		expect(
			formatDetail(
				AuditEventType.USER_ROLE_CHANGED,
				JSON.stringify({ password: "secret" }),
			),
		).toBe("");
		expect(
			formatDetail("FUTURE_EVENT", JSON.stringify({ token: "secret" })),
		).toBe("");
		expect(formatDetail(AuditEventType.USER_ROLE_CHANGED, null)).toBe("");
		expect(formatDetail(AuditEventType.USER_ROLE_CHANGED, "not json")).toBe("");
	});
});

describe("GET /api/audit-events/export", () => {
	test("CSV(BOM・CRLF・ヘッダー)を返し、一覧と同じ並び順になる", async () => {
		const { admin } = await setupUsers();
		const app = api();
		const cookie = await login(app, "admin");
		audit.record({
			type: AuditEventType.USER_ROLE_CHANGED,
			actorUserId: admin.id,
			targetType: "user",
			targetId: "u1",
			detail: { from: "viewer", to: "admin" },
		});
		now += 1000;
		audit.record({
			type: AuditEventType.USER_CREATED,
			actorUserId: admin.id,
			targetType: "user",
			targetId: "u2",
			detail: { role: "viewer" },
		});

		const res = await app.request("/api/audit-events/export", {
			headers: { cookie },
		});
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toContain("text/csv");
		expect(res.headers.get("content-disposition")).toContain("attachment");
		expect(res.headers.get("x-audit-export-truncated")).toBe("false");

		// BOM はバイト列で直接確かめる。本文は TextDecoder で読む(先頭 BOM は除去される)。
		const bytes = new Uint8Array(await res.arrayBuffer());
		expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
		const text = new TextDecoder().decode(bytes);
		const lines = text.split("\r\n").filter((line) => line.length > 0);
		expect(lines[0]).toBe(AUDIT_EXPORT_HEADER);
		expect(lines).toHaveLength(3);
		// 一覧と同じく新しい順。
		expect(lines[1]).toContain("USER_CREATED");
		expect(lines[1]).toContain("role=viewer");
		expect(lines[2]).toContain("USER_ROLE_CHANGED");
		expect(lines[2]).toContain("from=viewer; to=admin");
		// CRLFである(単独LFを含まない)。
		expect(text.replaceAll("\r\n", "")).not.toContain("\n");
	});

	test("allowlistに無いfieldと未知種別のdetailは出ない(DBへ直接書いた値も含む)", async () => {
		await setupUsers();
		const app = api();
		const cookie = await login(app, "admin");
		audit.record({
			type: AuditEventType.COMMAND_EXECUTED,
			targetType: "device",
			targetId: "d1",
			detail: {
				job_id: "job-1",
				command: "show log",
				password: "export-must-not-contain-password",
				config_body: "export-must-not-contain-config",
			},
		});
		audit.record({
			type: "FUTURE_EVENT",
			detail: { token: "export-must-not-contain-token" },
		});
		// 将来の版が書いたかもしれない行をDBへ直接入れる。
		storage.db
			.prepare(
				`INSERT INTO audit_events (id, tenant_id, actor_user_id, type, target_type, target_id, detail_json, created_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				"direct-row",
				tenantId,
				null,
				AuditEventType.USER_ROLE_CHANGED,
				"user",
				"u9",
				JSON.stringify({
					from: "viewer",
					to: "admin",
					password: "export-must-not-contain-direct-password",
				}),
				nowIso(new Date(now)),
			);

		const text = await (
			await app.request("/api/audit-events/export", { headers: { cookie } })
		).text();
		expect(text).toContain("job_id=job-1; command=show log");
		expect(text).toContain("from=viewer; to=admin");
		for (const secret of [
			"export-must-not-contain-password",
			"export-must-not-contain-config",
			"export-must-not-contain-token",
			"export-must-not-contain-direct-password",
		]) {
			expect(text).not.toContain(secret);
		}
	});

	test('`,` `"` 改行を含む値を正しくエスケープする', async () => {
		await setupUsers();
		const app = api();
		const cookie = await login(app, "admin");
		audit.record({
			type: AuditEventType.SITE_CREATED,
			targetType: "site",
			targetId: "s1",
			detail: { name: '本社, "支社"\n別館' },
		});

		const text = await (
			await app.request("/api/audit-events/export", { headers: { cookie } })
		).text();
		expect(text).toContain('"name=本社, ""支社""\n別館"');
	});

	test("画面の絞り込み条件がそのまま反映される", async () => {
		const { admin, viewer } = await setupUsers();
		const app = api();
		const cookie = await login(app, "admin");
		audit.record({
			type: "FILTERED_EVENT",
			actorUserId: admin.id,
			targetType: "device",
			targetId: "router-a",
		});
		audit.record({
			type: "OTHER_EVENT",
			actorUserId: viewer.id,
			targetType: "user",
			targetId: "user-a",
		});

		const text = await (
			await app.request(
				`/api/audit-events/export?actorUserId=${admin.id}&type=FILTERED_EVENT&target=router-a`,
				{ headers: { cookie } },
			)
		).text();
		const lines = text.split("\r\n").filter((line) => line.length > 0);
		expect(lines).toHaveLength(2);
		expect(lines[1]).toContain("FILTERED_EVENT");
		expect(lines[1]).not.toContain("OTHER_EVENT");
	});

	test("日時が不正なら400", async () => {
		await setupUsers();
		const app = api();
		const cookie = await login(app, "admin");
		const res = await app.request("/api/audit-events/export?from=not-a-date", {
			headers: { cookie },
		});
		expect(res.status).toBe(400);
	});

	test("Viewerは403、未認証は401", async () => {
		await setupUsers();
		const app = api();
		const viewerCookie = await login(app, "viewer");
		expect(
			(
				await app.request("/api/audit-events/export", {
					headers: { cookie: viewerCookie },
				})
			).status,
		).toBe(403);
		expect((await app.request("/api/audit-events/export")).status).toBe(401);
	});

	test("エクスポート操作が監査ログに残る", async () => {
		await setupUsers();
		const app = api();
		const cookie = await login(app, "admin");
		const res = await app.request("/api/audit-events/export", {
			headers: { cookie },
		});
		expect(res.status).toBe(200);
		const recorded = audit
			.list({ type: AuditEventType.AUDIT_LOG_EXPORTED })
			.at(0);
		expect(recorded).toBeTruthy();
		expect(JSON.parse(recorded?.detail_json ?? "{}")).toEqual({
			count: 0,
			truncated: false,
		});
		// 一覧APIでもallowlistを通して見える。
		const listRes = await app.request(
			`/api/audit-events?type=${AuditEventType.AUDIT_LOG_EXPORTED}`,
			{ headers: { cookie } },
		);
		const body = await listRes.json();
		expect(body.events[0].detail).toEqual({ count: 0, truncated: false });
	});

	test("上限を超えたら先頭までだけ出し、ヘッダーで分かる", async () => {
		await setupUsers();
		const app = api();
		const cookie = await login(app, "admin");
		const insert = storage.db.prepare(
			`INSERT INTO audit_events (id, tenant_id, actor_user_id, type, target_type, target_id, detail_json, created_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		);
		const at = nowIso(new Date(now));
		storage.db.transaction(() => {
			for (let i = 0; i < AUDIT_EXPORT_LIMIT + 1; i += 1) {
				insert.run(
					`bulk-${i}`,
					tenantId,
					null,
					AuditEventType.TAG_CREATED,
					"tag",
					`t${i}`,
					JSON.stringify({ name: `tag-${i}` }),
					at,
				);
			}
		})();

		const res = await app.request("/api/audit-events/export", {
			headers: { cookie },
		});
		expect(res.status).toBe(200);
		expect(res.headers.get("x-audit-export-truncated")).toBe("true");
		expect(res.headers.get("x-audit-export-count")).toBe(
			String(AUDIT_EXPORT_LIMIT),
		);
		expect(res.headers.get("x-audit-export-limit")).toBe(
			String(AUDIT_EXPORT_LIMIT),
		);
		const lines = (await res.text())
			.split("\r\n")
			.filter((line) => line.length > 0);
		expect(lines).toHaveLength(AUDIT_EXPORT_LIMIT + 1);
	}, 30_000);

	test("buildAuditCsvは実行者不明をSystemと出す", () => {
		const csv = buildAuditCsv(
			[
				{
					id: "1",
					tenant_id: "t",
					actor_user_id: null,
					type: AuditEventType.TAG_DELETED,
					target_type: null,
					target_id: null,
					detail_json: null,
					created_at: "2026-09-16T00:00:00.000Z",
				},
			],
			() => null,
		);
		expect(csv).toContain("System");
	});
});
