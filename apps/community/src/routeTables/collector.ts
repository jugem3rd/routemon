import { parseRouteTable, type RouteTableFamily } from "@routemon/core";
import {
	type AgentGateway,
	CommandTimeoutError,
	DeviceNotConnectedError,
} from "@routemon/gateway";
import type { Db } from "../storage/db.ts";
import { nowIso } from "../storage/db.ts";
import type {
	DeviceRouteTables,
	RouteTableErrorCode,
	RouteTableRepository,
} from "./repository.ts";

/** 定期取得は1日ごと。Serverを常時pollingしない。 */
export const ROUTE_TABLE_RECONCILE_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** 次の取得位相を確認する間隔。 */
export const ROUTE_TABLE_RECONCILE_CHECK_MS = 10 * 60 * 1000;
/** 1 familyのCOMMAND出力に許可する最大受信byte数。 */
export const MAX_ROUTE_TABLE_OUTPUT_BYTES = 128 * 1024;
export const ROUTE_TABLE_PARSER_VERSION = "1";

const COMMANDS = {
	ipv4: "show ip route",
	ipv6: "show ipv6 route",
} as const satisfies Record<RouteTableFamily, string>;

export class RouteTableRefreshBusyError extends Error {}
export class RouteTableDeviceInactiveError extends Error {}

type RouteTableCollectorOptions = {
	db: Db;
	tenantId: string;
	gateway: Pick<AgentGateway, "presence" | "sendCommand">;
	repository: RouteTableRepository;
	intervalMs?: number;
	commandTimeoutMs?: number;
	now?: () => number;
};

export class RouteTableCollector {
	private readonly db: Db;
	private readonly tenantId: string;
	private readonly gateway: Pick<AgentGateway, "presence" | "sendCommand">;
	private readonly repository: RouteTableRepository;
	private readonly intervalMs: number;
	private readonly commandTimeoutMs: number;
	private readonly now: () => number;
	private readonly nextDueAt = new Map<string, number>();
	private readonly refreshing = new Set<string>();

	constructor(options: RouteTableCollectorOptions) {
		const intervalMs = options.intervalMs ?? ROUTE_TABLE_RECONCILE_INTERVAL_MS;
		if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
			throw new RangeError(
				"route table reconcile interval must be positive and finite",
			);
		}
		this.db = options.db;
		this.tenantId = options.tenantId;
		this.gateway = options.gateway;
		this.repository = options.repository;
		this.intervalMs = intervalMs;
		this.commandTimeoutMs = options.commandTimeoutMs ?? 60_000;
		this.now = options.now ?? Date.now;
	}

	isOnline(deviceId: string): boolean {
		return this.gateway.presence(deviceId).status === "online";
	}

	isRefreshing(deviceId: string): boolean {
		return this.refreshing.has(deviceId);
	}

	get(deviceId: string): DeviceRouteTables {
		return this.repository.get(deviceId);
	}

	/** 初回もDeviceごとの未来の位相へ予約し、起動直後の一斉取得を避ける。 */
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
		const dueDeviceIds: string[] = [];
		for (const row of rows) {
			const dueAt = this.nextDueAt.get(row.id);
			if (dueAt === undefined) {
				this.nextDueAt.set(row.id, nextPhaseAt(row.id, now, this.intervalMs));
				continue;
			}
			if (
				dueAt <= now &&
				this.isOnline(row.id) &&
				!this.refreshing.has(row.id)
			) {
				dueDeviceIds.push(row.id);
			}
		}

		await Promise.all(
			dueDeviceIds.map(async (deviceId) => {
				try {
					await this.refresh(deviceId);
				} catch (error) {
					// Offlineへ変わった、または無効化された場合は次のsweepで再確認する。
					if (
						error instanceof DeviceNotConnectedError ||
						error instanceof RouteTableDeviceInactiveError ||
						error instanceof RouteTableRefreshBusyError
					) {
						return;
					}
					throw error;
				}
			}),
		);
	}

	/** IPv4とIPv6を順番に取得する。familyの失敗は他familyへ影響させない。 */
	async refresh(deviceId: string): Promise<DeviceRouteTables> {
		this.assertActive(deviceId);
		if (!this.isOnline(deviceId)) throw new DeviceNotConnectedError();
		if (this.refreshing.has(deviceId)) throw new RouteTableRefreshBusyError();

		this.refreshing.add(deviceId);
		try {
			await this.collectFamily(deviceId, "ipv4");
			await this.collectFamily(deviceId, "ipv6");
			this.nextDueAt.set(
				deviceId,
				nextPhaseAt(deviceId, this.now(), this.intervalMs),
			);
			return this.repository.get(deviceId);
		} finally {
			this.refreshing.delete(deviceId);
		}
	}

	private assertActive(deviceId: string): void {
		const device = this.db
			.prepare(
				"SELECT id FROM devices WHERE id = ? AND tenant_id = ? AND lifecycle_status = 'active'",
			)
			.get(deviceId, this.tenantId);
		if (!device) throw new RouteTableDeviceInactiveError();
	}

	private async collectFamily(
		deviceId: string,
		family: RouteTableFamily,
	): Promise<void> {
		try {
			const result = await this.gateway.sendCommand(
				deviceId,
				new TextEncoder().encode(COMMANDS[family]),
				{ timeoutMs: this.commandTimeoutMs },
			);
			if (!result.success) {
				this.recordFailure(deviceId, family, "command_failed");
				return;
			}
			if (result.output.byteLength > MAX_ROUTE_TABLE_OUTPUT_BYTES) {
				this.recordFailure(deviceId, family, "output_too_large");
				return;
			}

			const output = new TextDecoder("shift_jis").decode(result.output);
			const parsed = parseRouteTable(output, family);
			if (parsed.status === "unrecognized_output") {
				this.recordFailure(deviceId, family, "unrecognized_output");
				return;
			}
			this.repository.recordSnapshot({
				deviceId,
				family,
				result: parsed,
				capturedAt: nowIso(new Date(this.now())),
				outputBytes: result.output.byteLength,
				parserVersion: ROUTE_TABLE_PARSER_VERSION,
			});
		} catch (error) {
			if (error instanceof DeviceNotConnectedError) throw error;
			const errorCode: RouteTableErrorCode =
				error instanceof CommandTimeoutError ? "timeout" : "collection_failed";
			this.recordFailure(deviceId, family, errorCode);
		}
	}

	private recordFailure(
		deviceId: string,
		family: RouteTableFamily,
		errorCode: RouteTableErrorCode,
	): void {
		this.repository.recordFailure({
			deviceId,
			family,
			attemptedAt: nowIso(new Date(this.now())),
			errorCode,
		});
	}
}

/** Device IDごとの安定した位相へ、現在より後の取得時刻を割り当てる。 */
function nextPhaseAt(
	deviceId: string,
	now: number,
	intervalMs: number,
): number {
	const phase = phaseFor(deviceId, intervalMs);
	const cycles = Math.floor((now - phase) / intervalMs) + 1;
	return phase + cycles * intervalMs;
}

function phaseFor(deviceId: string, intervalMs: number): number {
	let hash = 2_166_136_261;
	for (let index = 0; index < deviceId.length; index += 1) {
		hash ^= deviceId.charCodeAt(index);
		hash = Math.imul(hash, 16_777_619);
	}
	return (hash >>> 0) % intervalMs;
}
