/**
 * SYSLOGからStructured Eventを抽出する(#6、docs/core/syslog-design.md §3.2)。
 *
 * Raw SYSLOG行をEventへ複製しない。運用上意味のある状態変化(PPPoEの接続・切断、
 * IP Tunnelの接続・切断、WANのIPアドレスの変更)だけを、`EventRecorder`へ渡す。
 * 同じ対象の状態変化は`transitionKey`でまとめ、フラッピングの判定は`EventRecorder`が行う。
 *
 * 文言は、YAMAHAの公式資料に載っているRouterのログから取った
 * (https://network.yamaha.com/setting/router_firewall/ts_router/internet_connect、
 * .../vpn_connect)。実機のfirmwareや設定で文言が違うログは、Eventにならない。
 * 規則を足すときは、`events.test.ts`のfixtureへ実例を足す。
 */
import type { EventRecorder } from "../events/recorder.ts";

/** Event種別。既存(`agent.rollback`等)に合わせ、dot区切りの小文字にする。 */
export const EventType = {
	PppUp: "ppp.up",
	PppDown: "ppp.down",
	TunnelUp: "tunnel.up",
	TunnelDown: "tunnel.down",
	IpChanged: "ip.changed",
	DeviceRebooted: "device.rebooted",
	AgentOnline: "agent.online",
	AgentOffline: "agent.offline",
} as const;

export type ClassifiedEvent = {
	type: string;
	severity: "info" | "warning";
	detail: Record<string, unknown>;
	/** フラッピングを判定する、同じ対象の識別子(例: `ppp:1`) */
	transitionKey: string;
};

export type Classification =
	| { kind: "event"; event: ClassifiedEvent }
	/** WANのIPアドレスの観測。前回と違えば`ip.changed`になる(状態が要るため、呼び出し側で判定する) */
	| { kind: "ip"; pp: number; address: string }
	| null;

/** Routerの日時の接頭辞(`2026/09/20 22:03:49: `)。Agentが付けて送るものと、付かないものがある。 */
const TIMESTAMP = /^\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2}: /;

const PPP_UP = /^PP\[(\d+)\] PPP\/IPCP up\b/;
const PPP_DOWN = /^PPPOE\[(\d+)\] Disconnected(?:, cause \[(.*)\])?\s*$/;
const TUNNEL_STATE = /^IP Tunnel\[(\d+)\] (Up|Down)\s*$/;
const PP_LOCAL_IP =
	/^PP\[(\d+)\] Local {1,}PP IP address (\d{1,3}(?:\.\d{1,3}){3})\s*$/;

export function classifySyslogLine(raw: string): Classification {
	const message = raw.replace(TIMESTAMP, "").trim();

	const up = PPP_UP.exec(message);
	if (up) {
		const pp = Number(up[1]);
		return {
			kind: "event",
			event: {
				type: EventType.PppUp,
				severity: "info",
				detail: { pp },
				transitionKey: `ppp:${pp}`,
			},
		};
	}

	const down = PPP_DOWN.exec(message);
	if (down) {
		const pp = Number(down[1]);
		return {
			kind: "event",
			event: {
				type: EventType.PppDown,
				severity: "warning",
				detail: down[2] ? { pp, cause: down[2] } : { pp },
				transitionKey: `ppp:${pp}`,
			},
		};
	}

	const tunnel = TUNNEL_STATE.exec(message);
	if (tunnel) {
		const id = Number(tunnel[1]);
		const isUp = tunnel[2] === "Up";
		return {
			kind: "event",
			event: {
				type: isUp ? EventType.TunnelUp : EventType.TunnelDown,
				severity: isUp ? "info" : "warning",
				detail: { tunnel: id },
				transitionKey: `tunnel:${id}`,
			},
		};
	}

	const ip = PP_LOCAL_IP.exec(message);
	if (ip?.[2]) {
		// 取得に失敗したときの`0.0.0.0`は、アドレスの変更ではない
		if (ip[2] === "0.0.0.0") return null;
		return { kind: "ip", pp: Number(ip[1]), address: ip[2] };
	}

	return null;
}

/**
 * SYSLOGのbatchからEventを抽出し、`EventRecorder`へ記録する。
 *
 * WANのIPアドレスは、Deviceごと・PPごとに最後に観測した値をメモリに持ち、違う値を観測した
 * ときだけ`ip.changed`にする。Serverの起動後の最初の観測は基準になるだけで、Eventにしない。
 */
export class SyslogEventExtractor {
	private readonly recorder: EventRecorder;
	private readonly lastAddress = new Map<string, string>();

	constructor(options: { recorder: EventRecorder }) {
		this.recorder = options.recorder;
	}

	/** 記録を試みたEventの件数を返す(抑制されたものを含む)。 */
	process(deviceId: string, messages: string[]): number {
		let count = 0;
		for (const message of messages) {
			const result = classifySyslogLine(message);
			if (!result) continue;
			if (result.kind === "event") {
				this.recorder.record({ deviceId, ...result.event });
				count++;
				continue;
			}
			const key = `${deviceId}\u0000${result.pp}`;
			const previous = this.lastAddress.get(key);
			this.lastAddress.set(key, result.address);
			if (previous !== undefined && previous !== result.address) {
				this.recorder.record({
					deviceId,
					type: EventType.IpChanged,
					severity: "info",
					detail: { pp: result.pp, from: previous, to: result.address },
					transitionKey: `ip:${result.pp}`,
				});
				count++;
			}
		}
		return count;
	}

	/** Deviceを削除したときなど、持っている基準を捨てる。 */
	forget(deviceId: string): void {
		for (const key of this.lastAddress.keys()) {
			if (key.startsWith(`${deviceId}\u0000`)) this.lastAddress.delete(key);
		}
	}
}
