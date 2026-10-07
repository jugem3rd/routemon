/**
 * AgentのPresenceの変化から、`agent.offline` / `agent.online`のEventを記録する(#6)。
 *
 * - `offline`へ変わったら`agent.offline`(warning)
 * - `offline`から`online`へ戻ったら`agent.online`(info)
 * - `unstable`(Agentからのsyncが遅れている途中)は、Eventにしない
 * - Server起動後の最初の観測は、基準になるだけで、Eventにしない(Serverの再起動で、
 *   全Deviceの`agent.online`が一斉に出ないようにする)
 *
 * `transitionKey: agent`で、接続が不安定なDeviceのフラッピングを`EventRecorder`がまとめる。
 */
import type { Presence } from "@routemon/gateway";
import type { EventRecorder } from "./recorder.ts";

export const AGENT_OFFLINE = "agent.offline";
export const AGENT_ONLINE = "agent.online";

export class PresenceEvents {
	private readonly recorder: EventRecorder;
	private readonly last = new Map<string, Presence["status"]>();

	constructor(options: { recorder: EventRecorder }) {
		this.recorder = options.recorder;
	}

	handle(presence: Presence): void {
		const previous = this.last.get(presence.deviceId);
		this.last.set(presence.deviceId, presence.status);
		if (presence.status === "offline" && previous !== "offline") {
			if (previous === undefined) return;
			this.recorder.record({
				deviceId: presence.deviceId,
				type: AGENT_OFFLINE,
				severity: "warning",
				detail: presence.lastSeenAt
					? { last_seen_at: presence.lastSeenAt.toISOString() }
					: undefined,
				transitionKey: "agent",
			});
		} else if (presence.status === "online" && previous === "offline") {
			this.recorder.record({
				deviceId: presence.deviceId,
				type: AGENT_ONLINE,
				severity: "info",
				transitionKey: "agent",
			});
		}
	}

	/** Deviceを削除したときなど、持っている基準を捨てる。 */
	forget(deviceId: string): void {
		this.last.delete(deviceId);
	}
}
