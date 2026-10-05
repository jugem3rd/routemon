/**
 * 初期Setup(#12、docs/community/installation-setup-design.md)。
 *
 * 未初期化のInstanceはBootstrap Modeで起動し、GUIの`/setup`から
 * Instance情報 / 最初のAdmin / Public URLを設定する。完了後は再実行できない。
 *
 * CLIでのUser作成やDevice登録は標準手順にしない(UX原則: CLIは起動まで)。
 */

import { lookup } from "node:dns/promises";
import { connect as tlsConnect } from "node:tls";
import type { LocalAuth } from "../auth/localAuth.ts";
import { type Db, nowIso } from "../storage/db.ts";

export const SETTING_KEYS = {
	initializedAt: "setup.initialized_at",
	instanceName: "instance.name",
	timezone: "instance.timezone",
	publicBaseUrl: "instance.public_base_url",
} as const;

export class SetupAlreadyDoneError extends Error {}

export type SetupStatus = {
	initialized: boolean;
	instanceName: string | null;
	timezone: string | null;
	publicBaseUrl: string | null;
};

export type CheckResult = {
	name: string;
	status: "ok" | "error";
	/** Network Engineerが切り分けられる説明(stack traceは出さない) */
	detail: string;
};

export class Setup {
	private readonly db: Db;
	private readonly auth: LocalAuth;
	private readonly now: () => number;

	constructor(db: Db, auth: LocalAuth, now: () => number = Date.now) {
		this.db = db;
		this.auth = auth;
		this.now = now;
	}

	status(): SetupStatus {
		return {
			initialized: this.get(SETTING_KEYS.initializedAt) !== null,
			instanceName: this.get(SETTING_KEYS.instanceName),
			timezone: this.get(SETTING_KEYS.timezone),
			publicBaseUrl: this.get(SETTING_KEYS.publicBaseUrl),
		};
	}

	/** Setupを完了する。最初のUserはAdmin固定で、以降は再実行できない。 */
	async complete(input: {
		instanceName: string;
		timezone: string;
		publicBaseUrl: string;
		admin: { loginId: string; password: string };
	}): Promise<void> {
		if (this.status().initialized) {
			throw new SetupAlreadyDoneError("setup is already completed");
		}
		await this.auth.createFirstAdmin({
			loginId: input.admin.loginId,
			password: input.admin.password,
		});
		this.set(SETTING_KEYS.instanceName, input.instanceName);
		this.set(SETTING_KEYS.timezone, input.timezone);
		this.set(SETTING_KEYS.publicBaseUrl, input.publicBaseUrl);
		this.set(SETTING_KEYS.initializedAt, nowIso(new Date(this.now())));
	}

	/** Public URLをあとから変更する(Admin専用のSettingsから呼ぶ)。 */
	setPublicBaseUrl(url: string): void {
		this.set(SETTING_KEYS.publicBaseUrl, url);
	}

	/** Instance名をあとから変更する(Admin専用のSettingsから呼ぶ)。 */
	setInstanceName(name: string): void {
		this.set(SETTING_KEYS.instanceName, name);
	}

	/** Timezoneをあとから変更する(Admin専用のSettingsから呼ぶ)。 */
	setTimezone(timezone: string): void {
		this.set(SETTING_KEYS.timezone, timezone);
	}

	get(key: string): string | null {
		const row = this.db
			.prepare("SELECT value FROM settings WHERE key = ?")
			.get(key) as { value: string } | undefined;
		return row?.value ?? null;
	}

	private set(key: string, value: string): void {
		this.db
			.prepare(
				`INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
				 ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
			)
			.run(key, value, nowIso(new Date(this.now())));
	}
}

/**
 * Connectivity check(docs/community/installation-setup-design.md §5)。
 *
 * Server自身から見た到達性を確認する。Routerから見た到達性まではここでは分からないため、
 * 失敗時は「何を直すか」が分かる文言を返す。
 */
export async function checkConnectivity(
	publicBaseUrl: string,
	options: { fetchImpl?: typeof fetch; agentPath?: string } = {},
): Promise<CheckResult[]> {
	const results: CheckResult[] = [];
	let url: URL;
	try {
		url = new URL(publicBaseUrl);
	} catch {
		return [
			{
				name: "Public URL",
				status: "error",
				detail: `URLとして解釈できません: ${publicBaseUrl}`,
			},
		];
	}
	const port = url.port
		? Number(url.port)
		: url.protocol === "https:"
			? 443
			: 80;

	// DNS
	let address: string | null = null;
	try {
		address = (await lookup(url.hostname)).address;
		results.push({
			name: "DNS",
			status: "ok",
			detail: `${url.hostname} -> ${address}`,
		});
	} catch {
		results.push({
			name: "DNS",
			status: "error",
			detail: `${url.hostname}を解決できません。DNS recordがこのServerを指しているか確認してください。`,
		});
	}

	// Certificate / Hostname(TLSハンドシェイクだけを見る)
	if (url.protocol === "https:") {
		results.push(await checkCertificate(url.hostname, port));
	} else {
		results.push({
			name: "Certificate",
			status: "error",
			detail:
				"Public URLがhttpです。初期設定後はHTTPSを標準にしてください(Caddyが証明書を取得します)。",
		});
	}

	// HTTPS到達性
	const fetchImpl = options.fetchImpl ?? fetch;
	try {
		const response = await fetchImpl(new URL("/healthz", url), {
			signal: AbortSignal.timeout(5000),
		});
		results.push(
			response.ok
				? {
						name: "HTTPS",
						status: "ok",
						detail: `${url.origin} に到達できます`,
					}
				: {
						name: "HTTPS",
						status: "error",
						detail: `${url.origin} が ${response.status} を返しました。Reverse Proxyの設定を確認してください。`,
					},
		);
	} catch {
		results.push({
			name: "HTTPS",
			status: "error",
			detail: `${url.origin} へ接続できません。TCP/${port}がFirewall / NATで開いているか確認してください。`,
		});
	}

	// Agent endpoint(Routerが接続する経路。Agent APIだけを通す)
	const agentPath = options.agentPath ?? "/v1/tunnel/sync/0";
	try {
		const response = await fetchImpl(new URL(agentPath, url), {
			method: "POST",
			signal: AbortSignal.timeout(5000),
		});
		// 認証していないので401が正常。404ならRouting設定が足りない
		results.push(
			response.status === 401
				? {
						name: "Agent Endpoint",
						status: "ok",
						detail: `${agentPath} がAgent Gatewayへ届いています`,
					}
				: {
						name: "Agent Endpoint",
						status: "error",
						detail: `${agentPath} が ${response.status} を返しました。Reverse ProxyがAgent Gatewayへ転送しているか確認してください。`,
					},
		);
	} catch {
		results.push({
			name: "Agent Endpoint",
			status: "error",
			detail: `${agentPath} へ接続できません。RouterからのOutbound HTTPSが届く経路か確認してください。`,
		});
	}

	return results;
}

function checkCertificate(
	hostname: string,
	port: number,
): Promise<CheckResult> {
	return new Promise((resolve) => {
		const socket = tlsConnect(
			{ host: hostname, port, servername: hostname, timeout: 5000 },
			() => {
				const authorized = socket.authorized;
				const error = socket.authorizationError;
				socket.end();
				resolve(
					authorized
						? {
								name: "Certificate",
								status: "ok",
								detail: `${hostname} の証明書を検証できました`,
							}
						: {
								name: "Certificate",
								status: "error",
								detail: `証明書を検証できません(${error})。hostnameと証明書chainを確認してください。`,
							},
				);
			},
		);
		socket.on("timeout", () => {
			socket.destroy();
			resolve({
				name: "Certificate",
				status: "error",
				detail: `${hostname}:${port} へのTLS接続がtimeoutしました。`,
			});
		});
		socket.on("error", (error) => {
			resolve({
				name: "Certificate",
				status: "error",
				detail: `TLS接続に失敗しました(${(error as Error).message})。`,
			});
		});
	});
}
