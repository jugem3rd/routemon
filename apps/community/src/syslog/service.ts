/**
 * SYSLOG収集とLive Logs(docs/core/syslog-design.md、#26)。
 *
 * - Agentは既存のHTTPS syncへSYSLOG batchをpiggybackする(§4)
 * - Gatewayで受け取り、Live subscriberへfan-outし、Raw SYSLOG storageへ渡す(§5)
 * - Live subscriberが居る間だけAgentのflush周期を短くする(§4.2)
 * - Raw SYSLOG行をStructured Eventへ複製しない(§3)
 */

import type { SyslogLine, SyslogStorage } from "@routemon/core";
import { FrameType } from "@routemon/core";
import { type AgentGateway, DeviceNotConnectedError } from "@routemon/gateway";
import type { ConfigSnapshots } from "../config/configSnapshots.ts";

/** MVPの検索上限(docs/core/syslog-design.md §9.4) */
export const MAX_TIME_RANGE_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_RESULT_LINES = 1_000;
export const MAX_RESULT_LINES = 10_000;
export const CONFIG_CHANGE_DEBOUNCE_MS = 30_000;

/** RTX830のCONFIG保存SYSLOG。日時部分はRouterの通常のSYSLOG形式に合わせる。 */
const CONFIG_SAVED_LINE =
	/^(?:\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2}: )?Configuration saved in "CONFIG\d+" by \S+$/;

export function isConfigSavedLine(message: string): boolean {
	return CONFIG_SAVED_LINE.test(message);
}

export type LiveSubscriber = (line: SyslogLine) => void;

export type SyslogHistoryOptions = {
	from?: Date;
	to?: Date;
	limit?: number;
	keyword?: string;
	exclude?: string;
};

export type SyslogHistoryResult = {
	lines: SyslogLine[];
	/** 表示上限を超えたため、後続の行を返していない。 */
	truncated: boolean;
};

type SyslogServiceOptions = {
	/** CONFIG変更時の再取得先。CONFIG実装を注入する。 */
	configSnapshots?: Pick<ConfigSnapshots, "request">;
	/** CONFIG保存SYSLOGを、未保存状態の解除へ通知する。 */
	onConfigSaved?: (deviceId: string) => void | Promise<void>;
	debounceMs?: number;
	/** 状態変化のStructured Eventを抽出する(#6)。Raw SYSLOG行は、Eventへ複製しない。 */
	events?: { process(deviceId: string, messages: string[]): number };
};

export class TimeRangeTooLargeError extends Error {}

export class InvalidTimeRangeError extends Error {}

export class SyslogService {
	private readonly gateway: AgentGateway;
	private readonly storage: SyslogStorage;
	private readonly now: () => number;
	private readonly configSnapshots?: Pick<ConfigSnapshots, "request">;
	private readonly onConfigSaved?: SyslogServiceOptions["onConfigSaved"];
	private readonly debounceMs: number;
	private readonly events?: SyslogServiceOptions["events"];
	private readonly subscribers = new Map<string, Set<LiveSubscriber>>();
	private readonly configChangeTimers = new Map<
		string,
		ReturnType<typeof setTimeout>
	>();

	constructor(
		gateway: AgentGateway,
		storage: SyslogStorage,
		now: () => number = Date.now,
		options: SyslogServiceOptions = {},
	) {
		this.gateway = gateway;
		this.storage = storage;
		this.now = now;
		this.configSnapshots = options.configSnapshots;
		this.onConfigSaved = options.onConfigSaved;
		this.debounceMs = options.debounceMs ?? CONFIG_CHANGE_DEBOUNCE_MS;
		this.events = options.events;
	}

	/** Agentから届いたSYSLOG batch(LF区切りの生の行、Shift_JIS)を取り込む。 */
	async handleBatch(
		deviceId: string,
		payload: Uint8Array,
	): Promise<SyslogLine[]> {
		const at = new Date(this.now()).toISOString();
		const text = new TextDecoder("shift_jis").decode(payload);
		const lines: SyslogLine[] = text
			.split("\n")
			.map((line) => line.replace(/\r$/, "").trim())
			.filter((line) => line.length > 0)
			.map((message) => ({ ts: at, message }));
		if (lines.length === 0) return [];

		for (const line of lines) {
			if (isConfigSavedLine(line.message)) {
				this.scheduleConfigRefresh(deviceId);
				void this.onConfigSaved?.(deviceId);
			}
		}

		// Event抽出の失敗で、SYSLOGの保存とLive Logsを止めない
		try {
			this.events?.process(
				deviceId,
				lines.map((line) => line.message),
			);
		} catch (error) {
			console.warn(
				`syslog event extraction failed for ${deviceId}: ${(error as Error).message}`,
			);
		}

		for (const subscriber of this.subscribers.get(deviceId) ?? []) {
			for (const line of lines) subscriber(line);
		}
		await this.storage.append(deviceId, lines, new Date(this.now()));
		return lines;
	}

	/** CONFIG保存SYSLOGを連続して受け取った場合は最後の行から数える。 */
	private scheduleConfigRefresh(deviceId: string): void {
		if (!this.configSnapshots) return;
		const previous = this.configChangeTimers.get(deviceId);
		if (previous) clearTimeout(previous);

		const timer = setTimeout(() => {
			this.configChangeTimers.delete(deviceId);
			this.requestConfigRefresh(deviceId);
		}, this.debounceMs);
		timer.unref();
		this.configChangeTimers.set(deviceId, timer);
	}

	/** 未接続時は要求を捨て、次のsaveまたは手動取得に委ねる。 */
	private requestConfigRefresh(deviceId: string): void {
		if (this.gateway.presence(deviceId).status !== "online") return;
		try {
			this.configSnapshots?.request(deviceId, "config_changed");
		} catch (error) {
			// Presence確認とenqueueの間に切断した場合も、未接続時と同じ扱いにする。
			if (!(error instanceof DeviceNotConnectedError)) throw error;
		}
	}

	/**
	 * Live Logsの購読。最初の購読者でAgentのLive modeを有効にし、最後の購読者が
	 * 離れたら戻す。
	 */
	subscribe(deviceId: string, subscriber: LiveSubscriber): () => void {
		let set = this.subscribers.get(deviceId);
		if (!set) {
			set = new Set();
			this.subscribers.set(deviceId, set);
		}
		set.add(subscriber);
		if (set.size === 1) this.setLive(deviceId, true);
		return () => {
			set.delete(subscriber);
			if (set.size === 0) {
				this.subscribers.delete(deviceId);
				this.setLive(deviceId, false);
			}
		};
	}

	private setLive(deviceId: string, enabled: boolean): void {
		try {
			this.gateway.sendFrame(
				deviceId,
				FrameType.SYSLOG_LIVE,
				0,
				Uint8Array.of(enabled ? 1 : 0),
			);
		} catch {
			// Agent未接続。次に接続した時点ではLive modeはoffなので、購読者が居れば再送される
		}
	}

	/** Live modeを再通知する(Agent再接続時など)。 */
	resyncLive(deviceId: string): void {
		if ((this.subscribers.get(deviceId)?.size ?? 0) > 0)
			this.setLive(deviceId, true);
	}

	/** Device 1台 + time rangeの履歴(§9)。 */
	async history(
		deviceId: string,
		options: SyslogHistoryOptions = {},
	): Promise<SyslogLine[]> {
		return (await this.historyResult(deviceId, options)).lines;
	}

	/** 履歴本体と、10,000行上限に達したかを返す。 */
	async historyResult(
		deviceId: string,
		options: SyslogHistoryOptions = {},
	): Promise<SyslogHistoryResult> {
		const to = options.to ?? new Date(this.now());
		const from = options.from ?? new Date(to.getTime() - 60 * 60 * 1000);
		const duration = to.getTime() - from.getTime();
		if (!Number.isFinite(duration) || duration < 0) {
			throw new InvalidTimeRangeError("time range must be valid");
		}
		if (duration > MAX_TIME_RANGE_MS) {
			throw new TimeRangeTooLargeError("time range must be 24 hours or less");
		}
		const requestedLimit = Number.isFinite(options.limit)
			? Math.trunc(options.limit as number)
			: DEFAULT_RESULT_LINES;
		const limit = Math.min(Math.max(requestedLimit, 1), MAX_RESULT_LINES);
		const lines = await this.storage.read(deviceId, {
			from,
			to,
			limit: limit + 1,
			keyword: normalizeSearchTerm(options.keyword),
			exclude: normalizeSearchTerm(options.exclude),
		});
		return {
			lines: lines.slice(0, limit),
			truncated: lines.length > limit,
		};
	}

	usage(deviceId: string) {
		return this.storage.usage(deviceId);
	}
}

function normalizeSearchTerm(value: string | undefined): string | undefined {
	const term = value?.trim();
	return term ? term : undefined;
}
