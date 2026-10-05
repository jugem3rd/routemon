/**
 * Structured Eventの記録(#158、docs/core/data-model.md §4.11)。
 *
 * 回線が不安定なDeviceが、Event一覧のノイズ、容量の増加、将来の通知の過剰を
 * 引き起こさないよう、`device_events`への記録を抑制する。
 *
 * - フラッピング: 同じDeviceの同じ対象の状態変化が、一定時間(既定10分)に一定回数(既定5回)
 *   起きたら、個別のEventを止めて1件の`event.flapping`にまとめる。状態変化が一定時間
 *   (同じ長さ)途絶えたら、個別の記録を再開する
 * - 1日の上限: Deviceごとに1日(UTC)の件数の上限(既定200件)を設け、超えたら`event.limit_reached`
 *   を1件だけ記録し、その日の残りは捨てる
 * - 保持期間: 既定90日を過ぎたEventを`cleanup()`で削除する
 *
 * 数値は初期値で、運用しながら調整する。
 */
import { randomUUID } from "node:crypto";
import { type Db, nowIso } from "../storage/db.ts";

export const EVENT_FLAPPING = "event.flapping";
export const EVENT_LIMIT_REACHED = "event.limit_reached";

export type EventRecorderOptions = {
	/** フラッピングを判定する時間(ms) */
	flapWindowMs?: number;
	/** この回数以上の状態変化でフラッピングとする(その回の状態変化を含む) */
	flapThreshold?: number;
	/** Deviceごとの、1日(UTC)に記録できる件数 */
	dailyCap?: number;
	/** この日数を過ぎたEventを削除する */
	retentionDays?: number;
	now?: () => number;
};

export type RecordInput = {
	deviceId: string;
	type: string;
	severity: string;
	detail?: Record<string, unknown>;
	/**
	 * 状態変化(PPPのDOWN / UPなど)のときに、同じ対象を表す識別子(例: `ppp`)。
	 * 指定した場合だけ、フラッピングを判定する。
	 */
	transitionKey?: string;
};

export type RecordResult =
	| "recorded"
	| "flapping_started"
	| "suppressed_flapping"
	| "suppressed_cap";

type FlapState = {
	/** 窓の中の状態変化の時刻(ms) */
	times: number[];
	flapping: boolean;
	/** 最後に状態変化を観測した時刻(ms) */
	lastAt: number;
};

const DAY_MS = 86_400_000;

export class EventRecorder {
	private readonly db: Db;
	private readonly tenantId: string;
	private readonly flapWindowMs: number;
	private readonly flapThreshold: number;
	private readonly dailyCap: number;
	private readonly retentionDays: number;
	private readonly now: () => number;
	private readonly flaps = new Map<string, FlapState>();

	constructor(options: { db: Db; tenantId: string } & EventRecorderOptions) {
		this.db = options.db;
		this.tenantId = options.tenantId;
		this.flapWindowMs = options.flapWindowMs ?? 10 * 60_000;
		this.flapThreshold = options.flapThreshold ?? 5;
		this.dailyCap = options.dailyCap ?? 200;
		this.retentionDays = options.retentionDays ?? 90;
		this.now = options.now ?? Date.now;
	}

	record(input: RecordInput): RecordResult {
		const at = this.now();

		if (input.transitionKey) {
			const flap = this.observeTransition(
				input.deviceId,
				input.transitionKey,
				at,
			);
			if (flap === "suppressed") return "suppressed_flapping";
			if (flap === "started") {
				const result = this.insertWithinCap({
					deviceId: input.deviceId,
					type: EVENT_FLAPPING,
					severity: "warning",
					detail: {
						target: input.transitionKey,
						transitions: this.flapThreshold,
						window_seconds: this.flapWindowMs / 1000,
					},
					at,
				});
				return result === "recorded" ? "flapping_started" : result;
			}
		}

		return this.insertWithinCap({
			deviceId: input.deviceId,
			type: input.type,
			severity: input.severity,
			detail: input.detail,
			at,
		});
	}

	/** 保持期間を過ぎたEventを削除する。削除した件数を返す。 */
	cleanup(): number {
		const cutoff = nowIso(new Date(this.now() - this.retentionDays * DAY_MS));
		let deleted = 0;
		for (;;) {
			const result = this.db
				.prepare(
					`DELETE FROM device_events WHERE rowid IN (
						SELECT rowid FROM device_events
						WHERE tenant_id = ? AND occurred_at < ? LIMIT 1000)`,
				)
				.run(this.tenantId, cutoff);
			deleted += result.changes;
			if (result.changes < 1000) return deleted;
		}
	}

	private observeTransition(
		deviceId: string,
		key: string,
		at: number,
	): "normal" | "started" | "suppressed" {
		const mapKey = `${deviceId}\u0000${key}`;
		const state = this.flaps.get(mapKey) ?? {
			times: [],
			flapping: false,
			lastAt: at,
		};
		this.flaps.set(mapKey, state);

		if (state.flapping) {
			const quiet = at - state.lastAt >= this.flapWindowMs;
			state.lastAt = at;
			if (!quiet) return "suppressed";
			// 状態変化が途絶えたので、個別の記録を再開する
			state.flapping = false;
			state.times = [];
		}

		state.lastAt = at;
		state.times = state.times.filter((time) => at - time < this.flapWindowMs);
		state.times.push(at);
		if (state.times.length >= this.flapThreshold) {
			state.flapping = true;
			return "started";
		}
		return "normal";
	}

	private insertWithinCap(event: {
		deviceId: string;
		type: string;
		severity: string;
		detail?: Record<string, unknown>;
		at: number;
	}): "recorded" | "suppressed_cap" {
		const dayStart = nowIso(new Date(Math.floor(event.at / DAY_MS) * DAY_MS));
		if (event.type !== EVENT_LIMIT_REACHED) {
			const count = this.countToday(event.deviceId, dayStart);
			if (count >= this.dailyCap) {
				if (!this.hasLimitEvent(event.deviceId, dayStart)) {
					this.insert({
						deviceId: event.deviceId,
						type: EVENT_LIMIT_REACHED,
						severity: "warning",
						detail: { daily_cap: this.dailyCap },
						at: event.at,
					});
				}
				return "suppressed_cap";
			}
		}
		this.insert(event);
		return "recorded";
	}

	private countToday(deviceId: string, dayStart: string): number {
		const row = this.db
			.prepare(
				`SELECT COUNT(*) AS n FROM device_events
				 WHERE tenant_id = ? AND device_id = ? AND occurred_at >= ? AND type != ?`,
			)
			.get(this.tenantId, deviceId, dayStart, EVENT_LIMIT_REACHED) as {
			n: number;
		};
		return row.n;
	}

	private hasLimitEvent(deviceId: string, dayStart: string): boolean {
		return (
			this.db
				.prepare(
					`SELECT 1 FROM device_events
					 WHERE tenant_id = ? AND device_id = ? AND occurred_at >= ? AND type = ? LIMIT 1`,
				)
				.get(this.tenantId, deviceId, dayStart, EVENT_LIMIT_REACHED) !==
			undefined
		);
	}

	private insert(event: {
		deviceId: string;
		type: string;
		severity: string;
		detail?: Record<string, unknown>;
		at: number;
	}): void {
		const iso = nowIso(new Date(event.at));
		this.db
			.prepare(
				`INSERT INTO device_events (id, tenant_id, device_id, type, severity, detail_json, occurred_at, created_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				randomUUID(),
				this.tenantId,
				event.deviceId,
				event.type,
				event.severity,
				event.detail ? JSON.stringify(event.detail) : null,
				iso,
				iso,
			);
	}
}
