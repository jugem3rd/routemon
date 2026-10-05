/**
 * CONFIGの定期再取得(#81、docs/core/device-profile-discovery-design.md §5.4)。
 *
 * Server起動時に全Deviceへ同時に要求しないため、Device IDから取得時刻の位相を
 * 決める。位相はUnix epochを基準にするので、Serverを再起動してもDeviceごとの
 * 取得時刻は変わらない。
 */
import { type AgentGateway, DeviceNotConnectedError } from "@routemon/gateway";
import type { Db } from "../storage/db.ts";
import type { ConfigSnapshots } from "./configSnapshots.ts";

/** RouterへCONFIGを取りに行く間隔。常時Pollingにしないため1日とする。 */
export const CONFIG_RECONCILE_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** 位相を確認する間隔。DBとGatewayのpresenceだけを確認し、CONFIGは取得しない。 */
export const CONFIG_RECONCILE_CHECK_MS = 10 * 60 * 1000;

type ConfigReconcilerOptions = {
	db: Db;
	tenantId: string;
	gateway: Pick<AgentGateway, "presence">;
	configSnapshots: Pick<ConfigSnapshots, "request">;
	intervalMs?: number;
	now?: () => number;
};

export class ConfigReconciler {
	private readonly db: Db;
	private readonly tenantId: string;
	private readonly gateway: Pick<AgentGateway, "presence">;
	private readonly configSnapshots: Pick<ConfigSnapshots, "request">;
	private readonly intervalMs: number;
	private readonly now: () => number;
	private readonly nextDueAt = new Map<string, number>();

	constructor(options: ConfigReconcilerOptions) {
		if (!Number.isFinite(options.intervalMs ?? CONFIG_RECONCILE_INTERVAL_MS)) {
			throw new RangeError("reconcile interval must be finite");
		}
		if ((options.intervalMs ?? CONFIG_RECONCILE_INTERVAL_MS) <= 0) {
			throw new RangeError("reconcile interval must be positive");
		}
		this.db = options.db;
		this.tenantId = options.tenantId;
		this.gateway = options.gateway;
		this.configSnapshots = options.configSnapshots;
		this.intervalMs = options.intervalMs ?? CONFIG_RECONCILE_INTERVAL_MS;
		this.now = options.now ?? Date.now;
	}

	/** active Deviceのうち、取得時刻になったonline Deviceだけを再取得する。 */
	async sweep(): Promise<void> {
		const rows = this.db
			.prepare(
				`SELECT id FROM devices
				 WHERE tenant_id = ? AND lifecycle_status = 'active'
				 ORDER BY id`,
			)
			.all(this.tenantId) as { id: string }[];
		const activeIds = new Set(rows.map((row) => row.id));
		for (const deviceId of this.nextDueAt.keys()) {
			if (!activeIds.has(deviceId)) this.nextDueAt.delete(deviceId);
		}

		const now = this.now();
		for (const row of rows) {
			const dueAt = this.nextDueAt.get(row.id);
			if (dueAt === undefined) {
				// 初回は必ず未来の位相へ置く。再起動直後の一斉取得と、
				// 直前の取得を再起動直後に重ねることを避ける。
				this.nextDueAt.set(row.id, nextPhaseAt(row.id, now, this.intervalMs));
				continue;
			}
			if (dueAt > now || this.gateway.presence(row.id).status !== "online")
				continue;

			try {
				this.configSnapshots.request(row.id, "periodic_reconcile");
			} catch (error) {
				// Presence確認とenqueueの間に切断した場合は、次のスイープで再試行する。
				if (error instanceof DeviceNotConnectedError) continue;
				throw error;
			}
			this.nextDueAt.set(row.id, nextPhaseAt(row.id, now, this.intervalMs));
		}
	}
}

/** Device IDごとの安定した位相を返す。暗号学的なハッシュは不要。 */
function phaseFor(deviceId: string, intervalMs: number): number {
	let hash = 2_166_136_261;
	for (let index = 0; index < deviceId.length; index += 1) {
		hash ^= deviceId.charCodeAt(index);
		hash = Math.imul(hash, 16_777_619);
	}
	return (hash >>> 0) % intervalMs;
}

/** 現在時刻より後にある、Device固有の次回取得時刻を返す。 */
function nextPhaseAt(
	deviceId: string,
	now: number,
	intervalMs: number,
): number {
	const phase = phaseFor(deviceId, intervalMs);
	const cycles = Math.floor((now - phase) / intervalMs) + 1;
	return phase + cycles * intervalMs;
}
