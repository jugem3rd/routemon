/**
 * Routerの稼働状態の観測(#54)。
 *
 * `show environment`の「起動時刻」を取り込み、いつから動いているかを表示できるようにする。
 * 利用者の操作ではないためJob履歴とaudit logには残さない(内部的な観測)。
 */
import type { AgentGateway } from "@routemon/gateway";
import type { EventRecorder } from "../events/recorder.ts";
import { type Db, nowIso } from "../storage/db.ts";

/** 例: `起動時刻: 2026/09/18 22:30:36 +09:00` */
const BOOT_TIME =
	/起動時刻:\s*(\d{4})\/(\d{2})\/(\d{2})\s+(\d{2}:\d{2}:\d{2})\s*([+-]\d{2}:\d{2})?/;

/**
 * 起動時刻がこれ以上後ろへ動いたら、再起動とみなす。`show environment`の起動時刻は、
 * 現在時刻からの逆算のため、NTPの補正などで数秒〜数十秒ずれることがある。
 */
export const REBOOT_TOLERANCE_MS = 120_000;

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
	private readonly events?: EventRecorder;

	constructor(options: {
		db: Db;
		tenantId: string;
		gateway: AgentGateway;
		/** 指定すると、起動時刻が進んだとき(再起動)に`device.rebooted`を記録する(#6) */
		events?: EventRecorder;
		now?: () => number;
		timeoutMs?: number;
	}) {
		this.events = options.events;
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
		const previous = this.db
			.prepare("SELECT booted_at FROM devices WHERE id = ? AND tenant_id = ?")
			.get(deviceId, this.tenantId) as { booted_at: string | null } | undefined;
		this.db
			.prepare(
				"UPDATE devices SET booted_at = ?, runtime_observed_at = ? WHERE id = ? AND tenant_id = ?",
			)
			.run(bootedAt, nowIso(new Date(this.now())), deviceId, this.tenantId);
		// 初めての観測は、基準になるだけで、再起動にしない
		if (
			previous?.booted_at &&
			Date.parse(bootedAt) - Date.parse(previous.booted_at) >
				REBOOT_TOLERANCE_MS
		) {
			this.events?.record({
				deviceId,
				type: "device.rebooted",
				severity: "info",
				detail: { booted_at: bootedAt, previous_booted_at: previous.booted_at },
				transitionKey: "reboot",
			});
		}
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
