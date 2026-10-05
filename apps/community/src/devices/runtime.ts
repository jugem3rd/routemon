/**
 * Routerの稼働状態の観測(#54)。
 *
 * `show environment`の「起動時刻」を取り込み、いつから動いているかを表示できるようにする。
 * 利用者の操作ではないためJob履歴とaudit logには残さない(内部的な観測)。
 */
import type { AgentGateway } from "@routemon/gateway";
import { type Db, nowIso } from "../storage/db.ts";

/** 例: `起動時刻: 2026/09/18 22:30:36 +09:00` */
const BOOT_TIME =
	/起動時刻:\s*(\d{4})\/(\d{2})\/(\d{2})\s+(\d{2}:\d{2}:\d{2})\s*([+-]\d{2}:\d{2})?/;

/** 観測が古くなったDeviceだけを測り直す間隔 */
export const RUNTIME_REFRESH_MS = 10 * 60 * 1000;

export function parseBootTime(output: string): string | null {
	const match = BOOT_TIME.exec(output);
	if (!match) return null;
	const [, year, month, day, time, offset] = match;
	const parsed = Date.parse(
		`${year}-${month}-${day}T${time}${offset ?? "Z"}`.replace(" ", ""),
	);
	return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
}

export class DeviceRuntime {
	private readonly db: Db;
	private readonly tenantId: string;
	private readonly gateway: AgentGateway;
	private readonly now: () => number;
	private readonly timeoutMs: number;

	constructor(options: {
		db: Db;
		tenantId: string;
		gateway: AgentGateway;
		now?: () => number;
		timeoutMs?: number;
	}) {
		this.db = options.db;
		this.tenantId = options.tenantId;
		this.gateway = options.gateway;
		this.now = options.now ?? Date.now;
		this.timeoutMs = options.timeoutMs ?? 30_000;
	}

	/** 1台の稼働状態を観測する。取れなければ何も更新しない。 */
	async probe(deviceId: string): Promise<string | null> {
		const result = await this.gateway.sendCommand(
			deviceId,
			new TextEncoder().encode("show environment"),
			{ timeoutMs: this.timeoutMs },
		);
		if (!result.success) return null;
		// rt.command()の出力はShift_JIS(docs/core/lua-api-notes.md)
		const bootedAt = parseBootTime(
			new TextDecoder("shift_jis").decode(result.output),
		);
		if (!bootedAt) return null;
		this.db
			.prepare(
				"UPDATE devices SET booted_at = ?, runtime_observed_at = ? WHERE id = ? AND tenant_id = ?",
			)
			.run(bootedAt, nowIso(new Date(this.now())), deviceId, this.tenantId);
		return bootedAt;
	}

	/** 観測が無い / 古いDeviceを測り直す。接続していないDeviceは飛ばす。 */
	async sweep(): Promise<void> {
		const threshold = nowIso(new Date(this.now() - RUNTIME_REFRESH_MS));
		const rows = this.db
			.prepare(
				`SELECT id FROM devices
				 WHERE tenant_id = ? AND lifecycle_status = 'active'
				   AND (runtime_observed_at IS NULL OR runtime_observed_at < ?)`,
			)
			.all(this.tenantId, threshold) as { id: string }[];
		for (const row of rows) {
			if (this.gateway.presence(row.id).status !== "online") continue;
			await this.probe(row.id).catch(() => null);
		}
	}
}
