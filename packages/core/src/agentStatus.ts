/**
 * AGENT_STATUS frameのpayload(#35、docs/core/agent-protocol.md §7.7)。
 *
 * payload = version / slot / Supervisorの直前理由(ASCII、LF区切り)
 *
 *   0.3.0
 *   a
 *   rollback:0.4.0 health_timeout   <- rollback理由
 *   rollback:recovered_both_slots_invalid   <- recovery結果
 *
 * wire上の行名はrollbackのまま、Supervisorのrollback理由またはrecovery結果を載せる。
 * Agentは値を解釈しない(判断はServer側)。
 */

export type AgentStatus = {
	version: string;
	slot?: string;
	/** 直前のSupervisor理由。rollbackは`<version> <reason>`、recoveryは結果識別子 */
	rollback?: string;
	/** 動いているSupervisorのversion(0.3.0以上のAgentが報告する、#159) */
	supervisorVersion?: string;
	/** Supervisor自身の更新を、直前に戻した理由(`<version> <reason>`、#159) */
	supervisorRollback?: string;
};

const ROLLBACK_PREFIX = "rollback:";
const SUPERVISOR_PREFIX = "supervisor:";
const SUPERVISOR_ROLLBACK_PREFIX = "supervisor_rollback:";

export function encodeAgentStatus(status: AgentStatus): Uint8Array {
	const lines = [status.version, status.slot ?? ""];
	if (status.rollback) lines.push(`${ROLLBACK_PREFIX}${status.rollback}`);
	if (status.supervisorVersion)
		lines.push(`${SUPERVISOR_PREFIX}${status.supervisorVersion}`);
	if (status.supervisorRollback)
		lines.push(`${SUPERVISOR_ROLLBACK_PREFIX}${status.supervisorRollback}`);
	return new TextEncoder().encode(lines.join("\n"));
}

export function decodeAgentStatus(payload: Uint8Array): AgentStatus {
	const [version = "", slot = "", ...rest] = new TextDecoder()
		.decode(payload)
		.split("\n")
		.map((line) => line.trim());
	const rollback = rest
		.find((line) => line.startsWith(ROLLBACK_PREFIX))
		?.slice(ROLLBACK_PREFIX.length);
	const supervisorVersion = rest
		.find((line) => line.startsWith(SUPERVISOR_PREFIX))
		?.slice(SUPERVISOR_PREFIX.length);
	const supervisorRollback = rest
		.find((line) => line.startsWith(SUPERVISOR_ROLLBACK_PREFIX))
		?.slice(SUPERVISOR_ROLLBACK_PREFIX.length);
	return {
		version,
		slot: slot || undefined,
		rollback: rollback || undefined,
		supervisorVersion: supervisorVersion || undefined,
		supervisorRollback: supervisorRollback || undefined,
	};
}
