/**
 * Device credentialのキャッシュ(#156)。
 *
 * Agentのsyncは待機中でも約20秒ごとに届き、毎回Tokenの確認が必要になる。取得元
 * (別のserviceにあるcredentialの保存先)へ毎回問い合わせると、リクエスト数が多すぎるため、credentialのhashと状態を
 * Gatewayが持ち、確認をGateway内で完結させる。
 *
 * - 定期取得: 最後に取得したversionからの差分を、一定間隔(既定5分)で取得して反映する
 * - 未知のTokenが来たとき: その場で取得元へ1回だけ問い合わせる。同じTokenへの再問い合わせは、
 *   短時間(既定30秒)あける(新規登録したDeviceが、取得間隔を待たずに接続できる)
 * - 取得元の障害時: 復旧するまで、古いキャッシュを使い続ける(時間による打ち切りは設けない)
 * - 復旧時: 最初に成功した取得で差分を反映する。差分を返せないほど間が空いた場合は、取得元が
 *   全件(`full`)を返し、キャッシュを置き換える
 * - diskへ保存し、Gatewayの再起動後も使える。保存するのはhashのみで、Token平文は持たない
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { hashCredential } from "./deviceStore.ts";
import type { DeviceStore } from "./gateway.ts";

export type CredentialEntry = {
	credentialHash: string;
	deviceId: string;
	revoked: boolean;
};

export type CredentialChanges = {
	/** 次の取得で`since`として渡す、取得元が決めるcursor(不透明な文字列) */
	version: string;
	/** trueなら、entriesが全件で、キャッシュを置き換える。falseなら差分(追加・更新・失効) */
	full: boolean;
	entries: CredentialEntry[];
};

/** 取得元(別のserviceにあるcredentialの保存先など)。利用する側が実装する。 */
export interface CredentialSource {
	/** `since`(前回の`version`、無ければnull)以降の変更を返す */
	fetchChanges(since: string | null): Promise<CredentialChanges>;
	/** 未知のTokenの、hashによる問い合わせ。無ければnull */
	lookup(credentialHash: string): Promise<CredentialEntry | null>;
}

export type CachedDeviceStoreOptions = {
	source: CredentialSource;
	/** キャッシュを保存するfile。指定しなければ、メモリだけ */
	persistPath?: string;
	/** 定期取得の間隔(ms)。既定5分 */
	refreshIntervalMs?: number;
	/** 問い合わせて無かったTokenを、再度問い合わせるまであける時間(ms)。既定30秒 */
	negativeTtlMs?: number;
	logger?: { info(msg: string): void; warn(msg: string): void };
	now?: () => number;
};

export type CacheStatus = {
	entries: number;
	version: string | null;
	/** 最後に取得に成功した時刻(ms)。一度も成功していなければnull */
	lastSuccessAt: number | null;
	lastError: string | null;
	consecutiveFailures: number;
};

type Persisted = { version: string | null; entries: CredentialEntry[] };

export class CachedDeviceStore implements DeviceStore {
	private readonly source: CredentialSource;
	private readonly persistPath?: string;
	private readonly refreshIntervalMs: number;
	private readonly negativeTtlMs: number;
	private readonly logger?: CachedDeviceStoreOptions["logger"];
	private readonly now: () => number;
	private readonly cache = new Map<string, CredentialEntry>();
	private readonly missing = new Map<string, number>();
	private readonly inflight = new Map<
		string,
		Promise<CredentialEntry | null>
	>();
	private version: string | null = null;
	private lastSuccessAt: number | null = null;
	private lastError: string | null = null;
	private consecutiveFailures = 0;
	private timer?: ReturnType<typeof setInterval>;
	private refreshing?: Promise<boolean>;

	constructor(options: CachedDeviceStoreOptions) {
		this.source = options.source;
		this.persistPath = options.persistPath;
		this.refreshIntervalMs = options.refreshIntervalMs ?? 5 * 60_000;
		this.negativeTtlMs = options.negativeTtlMs ?? 30_000;
		this.logger = options.logger;
		this.now = options.now ?? Date.now;
		this.load();
	}

	/** credentialが有効ならdevice idを返す。未知・失効済み・確認できないときはnull。 */
	async resolveCredential(credential: string): Promise<string | null> {
		const hash = hashCredential(credential);
		const cached = this.cache.get(hash);
		if (cached) return cached.revoked ? null : cached.deviceId;

		const missedAt = this.missing.get(hash);
		if (missedAt !== undefined && this.now() - missedAt < this.negativeTtlMs) {
			return null;
		}
		const entry = await this.lookupOnce(hash);
		if (!entry || entry.revoked) return null;
		return entry.deviceId;
	}

	/** 定期取得を始める。すぐに1回取得する。 */
	start(): void {
		if (this.timer) return;
		void this.refresh();
		this.timer = setInterval(() => void this.refresh(), this.refreshIntervalMs);
		this.timer.unref();
	}

	stop(): void {
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
	}

	/**
	 * 取得元から変更を取得して反映する。成功したらtrue。失敗したら、古いキャッシュを残して
	 * falseを返す(同時に複数回呼ばれても、取得は1回にまとめる)。
	 */
	refresh(): Promise<boolean> {
		this.refreshing ??= this.doRefresh().finally(() => {
			this.refreshing = undefined;
		});
		return this.refreshing;
	}

	status(): CacheStatus {
		return {
			entries: this.cache.size,
			version: this.version,
			lastSuccessAt: this.lastSuccessAt,
			lastError: this.lastError,
			consecutiveFailures: this.consecutiveFailures,
		};
	}

	private async doRefresh(): Promise<boolean> {
		try {
			const changes = await this.source.fetchChanges(this.version);
			if (changes.full) this.cache.clear();
			for (const entry of changes.entries) {
				this.cache.set(entry.credentialHash, entry);
				this.missing.delete(entry.credentialHash);
			}
			this.version = changes.version;
			this.lastSuccessAt = this.now();
			this.lastError = null;
			if (this.consecutiveFailures > 0) {
				this.logger?.info(
					`credential cache refreshed after ${this.consecutiveFailures} failures`,
				);
			}
			this.consecutiveFailures = 0;
			this.save();
			return true;
		} catch (error) {
			this.consecutiveFailures++;
			this.lastError = (error as Error).message;
			// 古いキャッシュを使い続ける。失敗が続いていることは、status()から分かる
			this.logger?.warn(
				`credential cache refresh failed (${this.consecutiveFailures}): ${this.lastError}`,
			);
			return false;
		}
	}

	/** 同じhashへの問い合わせは、同時には1回だけ行う。 */
	private lookupOnce(hash: string): Promise<CredentialEntry | null> {
		const existing = this.inflight.get(hash);
		if (existing) return existing;
		const promise = this.source
			.lookup(hash)
			.then((entry) => {
				if (entry) {
					this.cache.set(hash, entry);
					this.missing.delete(hash);
					this.save();
				} else {
					this.missing.set(hash, this.now());
				}
				return entry;
			})
			.catch((error) => {
				// 取得元に届かないとき。確認できないので拒否するが、短時間で再度問い合わせられる
				this.logger?.warn(
					`credential lookup failed: ${(error as Error).message}`,
				);
				return null;
			})
			.finally(() => {
				this.inflight.delete(hash);
			});
		this.inflight.set(hash, promise);
		return promise;
	}

	private load(): void {
		if (!this.persistPath) return;
		try {
			const saved = JSON.parse(
				readFileSync(this.persistPath, "utf8"),
			) as Persisted;
			if (!Array.isArray(saved.entries)) return;
			for (const entry of saved.entries) {
				if (
					typeof entry?.credentialHash === "string" &&
					typeof entry.deviceId === "string"
				) {
					this.cache.set(entry.credentialHash, {
						credentialHash: entry.credentialHash,
						deviceId: entry.deviceId,
						revoked: entry.revoked === true,
					});
				}
			}
			this.version = typeof saved.version === "string" ? saved.version : null;
		} catch {
			// fileが無い、または壊れている。空のキャッシュから始め、取得元から全件を取得する
		}
	}

	/** 一時fileへ書いてからrenameで置き換える(書き込みの途中で止まっても、壊れない)。 */
	private save(): void {
		if (!this.persistPath) return;
		try {
			mkdirSync(dirname(this.persistPath), { recursive: true });
			const tmp = `${this.persistPath}.tmp`;
			const body: Persisted = {
				version: this.version,
				entries: [...this.cache.values()],
			};
			writeFileSync(tmp, JSON.stringify(body), { mode: 0o600 });
			renameSync(tmp, this.persistPath);
		} catch (error) {
			this.logger?.warn(
				`credential cache save failed: ${(error as Error).message}`,
			);
		}
	}
}
