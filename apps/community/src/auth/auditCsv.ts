/**
 * 監査ログのCSVエクスポート(#118)。
 *
 * もっとも重要な制約: detail は `filterAuditDetail()` (apps/community/src/auth/audit.ts)
 * を通した結果だけを出力する。`detail_json` をそのまま出してはならない。
 * allowlist に無い field や未知の Event 種別の detail が混ざると不合格になるため、
 * このファイルから `detail_json` を直接読む経路を作らないこと。
 */
import {
	AUDIT_EXPORT_LIMIT,
	type AuditEventRow,
	filterAuditDetail,
} from "./audit.ts";

export { AUDIT_EXPORT_LIMIT };

/** 上限で打ち切ったかどうかを利用者へ伝えるレスポンスヘッダ。 */
export const AUDIT_EXPORT_TRUNCATED_HEADER = "x-audit-export-truncated";
export const AUDIT_EXPORT_COUNT_HEADER = "x-audit-export-count";
export const AUDIT_EXPORT_LIMIT_HEADER = "x-audit-export-limit";

export const AUDIT_EXPORT_HEADER = "日時,実行者,種別,対象種別,対象ID,詳細";

/**
 * ISO 8601 (UTC)で出す。`toISOString()` は常に `Z` 付きUTCなので、
 * サーバーと閲覧者のtimezoneが違ってもズレない。画面(閲覧者のlocale表示)
 * とは意図的に書式が違う。監査ログは「いつ起きたか」が争点になるため、
 * 曖昧さの排除を画面との一致より優先する(#118)。
 */
export function formatCsvTime(iso: string): string {
	return new Date(iso).toISOString();
}

/** 画面(AuditLog.tsx の formatDetailValue)と同じ見せ方にする。CSV の空欄と区別するため null は空文字。 */
export function formatDetailValue(value: unknown): string {
	if (value === null || value === undefined) return "";
	if (typeof value === "string") return value;
	if (
		typeof value === "number" ||
		typeof value === "boolean" ||
		typeof value === "bigint"
	)
		return String(value);
	if (Array.isArray(value)) return value.map(formatDetailValue).join(", ");
	return JSON.stringify(value) ?? "";
}

/** allowlist を通した detail を `key=value` を `; ` で連結した1つの文字列にする。空なら空欄。 */
export function formatDetail(type: string, detailJson: string | null): string {
	const detail = filterAuditDetail(type, detailJson);
	if (!detail) return "";
	return Object.entries(detail)
		.map(([key, value]) => `${key}=${formatDetailValue(value)}`)
		.join("; ");
}

/** RFC 4180 に従う。`,` `"` 改行のいずれかを含む値だけ `"` で囲み、内部の `"` は `""` にする。 */
export function escapeCsvField(value: string): string {
	if (!/[",\r\n]/.test(value)) return value;
	return `"${value.replaceAll('"', '""')}"`;
}

/**
 * CSV 全文を返す。Excel で日本語が壊れないよう先頭に BOM を付け、改行は CRLF にする。
 * `actorNameOf` は一覧 API と同じ表示名解決(user.displayName ?? loginId ?? email ?? id、無ければ null)。
 * 実行者不明は画面と同じく "System" と出す。
 */
export function buildAuditCsv(
	rows: AuditEventRow[],
	actorNameOf: (actorUserId: string | null) => string | null,
): string {
	const lines = rows.map((row) =>
		[
			formatCsvTime(row.created_at),
			actorNameOf(row.actor_user_id) ?? "System",
			row.type,
			row.target_type ?? "",
			row.target_id ?? "",
			formatDetail(row.type, row.detail_json),
		]
			.map(escapeCsvField)
			.join(","),
	);
	return `\uFEFF${[AUDIT_EXPORT_HEADER, ...lines].join("\r\n")}\r\n`;
}
