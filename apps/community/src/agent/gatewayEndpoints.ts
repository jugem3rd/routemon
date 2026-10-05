/**
 * Agentへ接続先の一覧を通知する(#147、docs/core/agent-protocol.md §7.10)。
 *
 * AGENT_STATUSで報告されたversionが対応済み(`GATEWAY_ENDPOINTS_MIN_AGENT_VERSION`以上)の
 * Agentにだけ送る。古いAgentには送らない(未知のframeは無視されるが、送る意味が無い)。
 * Agentは受け取った一覧が現在と同じなら何もしないため、接続し直すたびに送ってよい。
 */
import {
	encodeGatewayEndpoints,
	FrameType,
	isValidGatewayEndpoint,
	supportsGatewayEndpoints,
} from "@routemon/core";
import type { AgentGateway } from "@routemon/gateway";

/** `AGENT_ENDPOINTS`(カンマ区切り)を解釈する。不正な値は`undefined`を返す。 */
export function parseGatewayEndpoints(value: string): string[] | undefined {
	const urls = value
		.split(",")
		.map((url) => url.trim())
		.filter(Boolean);
	if (urls.length === 0 || urls.length > 4) return undefined;
	return urls.every(isValidGatewayEndpoint) ? urls : undefined;
}

export class GatewayEndpointsNotifier {
	private readonly gateway: AgentGateway;
	private readonly payload: Uint8Array;
	private readonly log?: (message: string) => void;

	constructor(options: {
		gateway: AgentGateway;
		endpoints: string[];
		log?: (message: string) => void;
	}) {
		this.gateway = options.gateway;
		this.payload = encodeGatewayEndpoints(options.endpoints);
		this.log = options.log;
	}

	/** 送った場合はtrue。versionが不明、または未対応のAgentには送らない。 */
	notify(deviceId: string, agentVersion: string | null | undefined): boolean {
		if (!agentVersion || !supportsGatewayEndpoints(agentVersion)) return false;
		try {
			this.gateway.sendFrame(
				deviceId,
				FrameType.GATEWAY_ENDPOINTS,
				0,
				this.payload,
			);
			this.log?.(
				`gateway endpoints sent to ${deviceId} (agent ${agentVersion})`,
			);
			return true;
		} catch {
			// 接続していないDeviceへは送れない。次に接続したときに送る
			return false;
		}
	}
}
