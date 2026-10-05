/**
 * GATEWAY_ENDPOINTS frameのpayload(#147、docs/core/agent-protocol.md §7.10)。
 *
 * payload = Agentが接続するGatewayのendpoint URL(ASCII、LF区切り)。先頭が優先する接続先で、
 * 2つ目以降は将来のfailoverで使う。
 *
 *   https://gw.example.com
 *   https://gw2.example.com
 */

/** このversion以上のAgentだけが、GATEWAY_ENDPOINTSを処理できる */
export const GATEWAY_ENDPOINTS_MIN_AGENT_VERSION = "0.2.0";

/** RTX830の`rt.httprequest()`のURL上限(255文字)から、path(`/v1/tunnel/sync/<wait>`)の分を引いた長さ */
const MAX_ENDPOINT_LENGTH = 200;
const MAX_ENDPOINTS = 4;

export function isValidGatewayEndpoint(url: string): boolean {
	return (
		url.length <= MAX_ENDPOINT_LENGTH &&
		/^https?:\/\/[A-Za-z0-9.\-_[\]:]+(:\d+)?(\/[A-Za-z0-9._~\-/]*)?$/.test(
			url,
		) &&
		!url.endsWith("/")
	);
}

export function encodeGatewayEndpoints(urls: string[]): Uint8Array {
	if (urls.length === 0 || urls.length > MAX_ENDPOINTS) {
		throw new RangeError(`endpoints must be 1 to ${MAX_ENDPOINTS}`);
	}
	for (const url of urls) {
		if (!isValidGatewayEndpoint(url)) {
			throw new RangeError(`invalid gateway endpoint: ${url}`);
		}
	}
	return new TextEncoder().encode(urls.join("\n"));
}

/** 不正な行があれば、全体を不正として空配列を返す(一部だけ採用しない)。 */
export function decodeGatewayEndpoints(payload: Uint8Array): string[] {
	const urls = new TextDecoder()
		.decode(payload)
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);
	if (urls.length === 0 || urls.length > MAX_ENDPOINTS) return [];
	return urls.every(isValidGatewayEndpoint) ? urls : [];
}

/** `major.minor.patch`の数値比較。解釈できないversionは非対応として扱う。 */
export function supportsGatewayEndpoints(agentVersion: string): boolean {
	const parse = (v: string) =>
		/^(\d+)\.(\d+)\.(\d+)/.exec(v)?.slice(1).map(Number);
	const actual = parse(agentVersion);
	const min = parse(GATEWAY_ENDPOINTS_MIN_AGENT_VERSION);
	if (!actual || !min) return false;
	for (let i = 0; i < 3; i++) {
		const a = actual[i] as number;
		const m = min[i] as number;
		if (a !== m) return a > m;
	}
	return true;
}
