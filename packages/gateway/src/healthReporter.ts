/**
 * Gatewayのhealth / statusの定期報告(#157)。
 *
 * Gatewayが一定間隔(既定1分)で別のserviceへ状態を報告し、途絶えたことを受け取る側が検知できる
 * ようにする。報告の送信先と認証は`HealthSink`で差し替える。報告の送信が失敗しても、Agentのsyncの処理には影響させない。
 */
import { statfsSync } from "node:fs";
import { freemem, loadavg, totalmem } from "node:os";
import type { CacheStatus } from "./cachedDeviceStore.ts";

export type HealthReport = {
	gatewayId: string;
	version?: string;
	/** 報告の時刻(ISO 8601) */
	at: string;
	uptimeSeconds: number;
	process: { rssMB: number; heapUsedMB: number };
	/** Agent HTTPS listenerが待ち受けているか(取得できなければ省略) */
	agentListener?: { listening: boolean };
	/** Deviceのpresenceの内訳(取得できなければ省略) */
	devices?: { online: number; unstable: number; offline: number };
	/** credentialキャッシュの状態。更新の失敗が続いていることが分かる */
	credentialCache?: {
		entries: number;
		lastSuccessAt: string | null;
		consecutiveFailures: number;
		lastError: string | null;
	};
	/** SYSLOG spoolの使用量と、破棄した件数 */
	spool?: { bytes: number; droppedSegments: number };
	system: {
		/** 1分間のload average */
		loadAverage1m: number;
		memoryTotalMB: number;
		memoryFreeMB: number;
		diskTotalMB?: number;
		diskFreeMB?: number;
	};
};

/** 報告の送信先。失敗したらrejectする(HealthReporterが吸収する)。 */
export interface HealthSink {
	send(report: HealthReport): Promise<void>;
}

export type HealthProviders = {
	agentListening?: () => boolean;
	devices?: () => { online: number; unstable: number; offline: number };
	credentialCache?: () => CacheStatus;
	spool?: () => { bytes: number; droppedSegments: number };
	/** diskの空きを報告するpath(spoolやdataを置くdirectory) */
	diskPath?: string;
};

export type HealthReporterOptions = {
	gatewayId: string;
	sink: HealthSink;
	version?: string;
	/** 報告の間隔(ms)。既定1分 */
	intervalMs?: number;
	providers?: HealthProviders;
	logger?: { info(msg: string): void; warn(msg: string): void };
	now?: () => number;
	/** 起動時刻(ms)。uptimeの計算に使う */
	startedAt?: number;
};

const MB = 1024 * 1024;
const round1 = (n: number) => Math.round(n * 10) / 10;

export class HealthReporter {
	private readonly options: HealthReporterOptions;
	private readonly intervalMs: number;
	private readonly now: () => number;
	private readonly startedAt: number;
	private timer?: ReturnType<typeof setInterval>;
	private sending = false;
	private consecutiveFailures = 0;

	constructor(options: HealthReporterOptions) {
		this.options = options;
		this.intervalMs = options.intervalMs ?? 60_000;
		this.now = options.now ?? Date.now;
		this.startedAt = options.startedAt ?? this.now();
	}

	/** 報告を始める。すぐに1回送る。 */
	start(): void {
		if (this.timer) return;
		void this.report();
		this.timer = setInterval(() => void this.report(), this.intervalMs);
		this.timer.unref();
	}

	stop(): void {
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
	}

	/** 1回報告する。送れたらtrue。失敗しても投げず、falseを返す(Agentのsyncに影響させない)。 */
	async report(): Promise<boolean> {
		// 前回の送信が終わっていなければ重ねない(送信先が遅いときに、溜めない)
		if (this.sending) return false;
		this.sending = true;
		try {
			await this.options.sink.send(this.collect());
			if (this.consecutiveFailures > 0) {
				this.options.logger?.info(
					`health report recovered after ${this.consecutiveFailures} failures`,
				);
			}
			this.consecutiveFailures = 0;
			return true;
		} catch (error) {
			this.consecutiveFailures++;
			this.options.logger?.warn(
				`health report failed (${this.consecutiveFailures}): ${(error as Error).message}`,
			);
			return false;
		} finally {
			this.sending = false;
		}
	}

	/** 現在の状態から報告の内容を作る。providerが失敗した項目は省略する。 */
	collect(): HealthReport {
		const providers = this.options.providers ?? {};
		const at = this.now();
		const memory = process.memoryUsage();
		const report: HealthReport = {
			gatewayId: this.options.gatewayId,
			version: this.options.version,
			at: new Date(at).toISOString(),
			uptimeSeconds: Math.max(0, Math.round((at - this.startedAt) / 1000)),
			process: {
				rssMB: round1(memory.rss / MB),
				heapUsedMB: round1(memory.heapUsed / MB),
			},
			system: {
				loadAverage1m: round1(loadavg()[0] ?? 0),
				memoryTotalMB: Math.round(totalmem() / MB),
				memoryFreeMB: Math.round(freemem() / MB),
			},
		};
		attempt(() => {
			if (providers.agentListening)
				report.agentListener = { listening: providers.agentListening() };
		});
		attempt(() => {
			if (providers.devices) report.devices = providers.devices();
		});
		attempt(() => {
			if (providers.credentialCache) {
				const status = providers.credentialCache();
				report.credentialCache = {
					entries: status.entries,
					lastSuccessAt:
						status.lastSuccessAt === null
							? null
							: new Date(status.lastSuccessAt).toISOString(),
					consecutiveFailures: status.consecutiveFailures,
					lastError: status.lastError,
				};
			}
		});
		attempt(() => {
			if (providers.spool) report.spool = providers.spool();
		});
		attempt(() => {
			if (providers.diskPath) {
				const fs = statfsSync(providers.diskPath);
				report.system.diskTotalMB = Math.round((fs.blocks * fs.bsize) / MB);
				report.system.diskFreeMB = Math.round((fs.bavail * fs.bsize) / MB);
			}
		});
		return report;
	}
}

function attempt(fn: () => void): void {
	try {
		fn();
	} catch {
		// 取得できない項目は省略する。報告そのものは止めない
	}
}

/**
 * JSONをPOSTする`HealthSink`。Gateway固有のcredentialをBearerで送る。
 * 送信先(`url`)とcredentialは、利用する側が決める。
 */
export class HttpHealthSink implements HealthSink {
	private readonly url: string;
	private readonly credential: string;
	private readonly timeoutMs: number;

	constructor(options: {
		url: string;
		credential: string;
		timeoutMs?: number;
	}) {
		this.url = options.url;
		this.credential = options.credential;
		this.timeoutMs = options.timeoutMs ?? 10_000;
	}

	async send(report: HealthReport): Promise<void> {
		const response = await fetch(this.url, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				authorization: `Bearer ${this.credential}`,
			},
			body: JSON.stringify(report),
			signal: AbortSignal.timeout(this.timeoutMs),
		});
		if (!response.ok) {
			throw new Error(`health report rejected: HTTP ${response.status}`);
		}
	}
}
