/**
 * CONFIG snapshot frameのpayload(#6、docs/core/agent-protocol.md §7.6)。
 *
 * payload = reason(ASCII) + LF + CONFIG本文(Router出力そのまま、Shift_JIS)
 *
 * Agentは本文を解釈せず、`show config`の出力をそのまま載せる。metadataのうち
 * device_id / model / firmware / agent versionはGateway側が既に持っているため
 * payloadへは入れない(Agentを薄く保つ)。
 */

export const SNAPSHOT_REASONS = [
	"agent_start",
	"config_changed",
	"manual",
	"periodic_reconcile",
	"pre_apply",
	"apply_verify",
	"checkpoint",
] as const;

export type SnapshotReason = (typeof SNAPSHOT_REASONS)[number];

export type ConfigSnapshot = {
	reason: SnapshotReason;
	/** CONFIG本文(生のbyte列。復元可能な形のまま扱う) */
	config: Uint8Array;
};

const LF = 0x0a;

function isReason(value: string): value is SnapshotReason {
	return (SNAPSHOT_REASONS as readonly string[]).includes(value);
}

export function encodeSnapshotPayload(snapshot: ConfigSnapshot): Uint8Array {
	const head = new TextEncoder().encode(`${snapshot.reason}\n`);
	const payload = new Uint8Array(head.length + snapshot.config.length);
	payload.set(head, 0);
	payload.set(snapshot.config, head.length);
	return payload;
}

export function decodeSnapshotPayload(payload: Uint8Array): ConfigSnapshot {
	const separator = payload.indexOf(LF);
	if (separator < 0) {
		throw new Error("config snapshot payload has no reason line");
	}
	const reason = new TextDecoder()
		.decode(payload.subarray(0, separator))
		.trim();
	return {
		// 知らないreasonでもsnapshot自体は捨てない(取りこぼしの方が困る)
		reason: isReason(reason) ? reason : "manual",
		config: payload.subarray(separator + 1),
	};
}

/**
 * 内容が同じかどうかの判定から外すheader行。
 *
 * `show config`は取得のたびに`# Reporting Date:`が変わるため、これを含めたまま
 * hashすると毎回別世代になる(RTX830実機で確認、#6)。保存する本文は加工しない
 * (docs/core/config-backup-design.md §4)。
 */
const VOLATILE_PREFIXES = ["# Reporting Date:"];

export function stripVolatileLines(config: Uint8Array): Uint8Array {
	const prefixes = VOLATILE_PREFIXES.map((prefix) =>
		new TextEncoder().encode(prefix),
	);
	const out: number[] = [];
	let start = 0;
	while (start <= config.length) {
		const end = config.indexOf(LF, start);
		const stop = end === -1 ? config.length : end;
		const line = config.subarray(start, stop);
		const volatileLine = prefixes.some(
			(prefix) =>
				line.length >= prefix.length &&
				prefix.every((byte, index) => line[index] === byte),
		);
		if (!volatileLine) {
			for (const byte of line) out.push(byte);
			if (end !== -1) out.push(LF);
		}
		if (end === -1) break;
		start = end + 1;
	}
	return Uint8Array.from(out);
}
