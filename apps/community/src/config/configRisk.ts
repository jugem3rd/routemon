/**
 * CONFIG差分の高リスク判定(#126)。
 *
 * 単体Applyの確認ダイアログと一括適用の計画確認の両方がこの関数を使う。
 * 判定は行頭のコマンドで行い(先頭の空白は無視する)、description等の
 * 自由記述に含まれる単語には反応させない。
 * `ip pp secure filter` のようなWAN側フィルタ適用行の漏れを防ぐため、
 * 迷う行は検出する側に倒している。
 */

export type ConfigRisk = "wan" | "pppoe" | "filter" | "supervisor_autostart";

// WANを壊すとAgentが再接続できず、遠隔から前のCONFIGへ戻せなくなる行。
const WAN_PATTERNS = [
	/^\s*ip\s+route\b/i,
	/^\s*ipv6\s+route\b/i,
	/^\s*ip\s+lan\d+\s+address\b/i,
	/^\s*ipv6\s+lan\d+\s+address\b/i,
	/^\s*ip\s+lan\d+\s+secure\s+filter\b/i,
	/^\s*ip\s+pp\s+address\b/i,
	/^\s*ipv6\s+pp\s+address\b/i,
	/^\s*ip\s+pp\s+mtu\b/i,
	/^\s*(?:ip\s+pp\s+select|pp\s+select)\b/i,
	/^\s*pppoe\s+use\b/i,
	/^\s*ip\s+wan\b/i,
	/^\s*tunnel\b/i,
	/^\s*ip\s+tunnel\b/i,
	/^\s*ipsec\b.*\btunnel\b/i,
	/^\s*(?:ip\s+\S+\s+)?nat\s+descriptor\b/i,
	/^\s*dns\s+server\b/i,
	/^\s*ipv6\s+prefix\b/i,
	/^\s*ipv6\s+lan\d+\s+dhcp\b/i,
	/^\s*ngn\s+type\b/i,
];

// PPPoE回線そのものに関わる行。pp配下はすべてPPPoE関連として扱う。
const PPPOE_PATTERNS = [/^\s*pp\b/i, /^\s*pppoe\b/i];

// フィルタ定義と、インタフェースへのフィルタ適用行。
const FILTER_PATTERNS = [
	/^\s*(?:ip|ipv6)\b.*\bfilter\b/i,
	/^\s*ethernet\b.*\bfilter\b/i,
	/^\s*filter\b/i,
];

// Supervisorの自動起動行。これが無いtargetは別途検証で拒否される。
const SUPERVISOR_AUTOSTART_PATTERNS = [
	/^\s*schedule\s+at\b.*\blua\s+\/routemon_bootstrap\.lua/i,
];

/**
 * 差分の追加行・削除行の本文を受け取り、当たったリスク分類を返す。
 * 1行が複数の分類に当たってよい。分類の順序は wan / pppoe / filter /
 * supervisor_autostart で固定する(一括適用のplan_summaryに保存済みのため)。
 */
export function classifyConfigRisks(lines: string[]): ConfigRisk[] {
	const risks: ConfigRisk[] = [];
	if (
		lines.some((line) => WAN_PATTERNS.some((pattern) => pattern.test(line)))
	) {
		risks.push("wan");
	}
	if (
		lines.some((line) => PPPOE_PATTERNS.some((pattern) => pattern.test(line)))
	) {
		risks.push("pppoe");
	}
	if (
		lines.some((line) => FILTER_PATTERNS.some((pattern) => pattern.test(line)))
	) {
		risks.push("filter");
	}
	if (
		lines.some((line) =>
			SUPERVISOR_AUTOSTART_PATTERNS.some((pattern) => pattern.test(line)),
		)
	) {
		risks.push("supervisor_autostart");
	}
	return risks;
}
