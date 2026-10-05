/**
 * Agent Protocolのframe(docs/core/agent-protocol.md §5)。
 *
 * header 8 byte: version(u8) / type(u8) / stream id(u16 BE) / length(u32 BE)
 */

export const PROTOCOL_VERSION = 1;
export const HEADER_LENGTH = 8;
export const MAX_STREAM_ID = 0xffff;

export const FrameType = {
	AUTH: 0x01,
	AUTH_OK: 0x02,
	HEARTBEAT: 0x03,
	COMMAND_REQUEST: 0x10,
	COMMAND_RESPONSE: 0x11,
	STREAM_OPEN: 0x20,
	STREAM_DATA: 0x21,
	STREAM_CLOSE: 0x22,
	STREAM_ERROR: 0x23,
	TELEMETRY: 0x30,
	EVENT: 0x31,
	/** Agent -> Gateway: Raw SYSLOG batch(LF区切りの生の行) */
	SYSLOG: 0x32,
	/** Gateway -> Agent: Live mode切り替え(payload 1 byte: 1 = on、0 = off) */
	SYSLOG_LIVE: 0x33,
	/** Agent -> Gateway: CONFIG snapshot(reason + LF + 生のCONFIG本文、#6) */
	CONFIG_BACKUP: 0x40,
	/** Gateway -> Agent: CONFIG snapshotの取得要求(payloadはreason、#6) */
	CONFIG_REQUEST: 0x41,
	/** Gateway -> Agent: 導入すべきAgent version(#35) */
	UPDATE_AVAILABLE: 0x42,
	/** Agent -> Gateway: 起動中のversion / slot / 直前のrollback理由(#35) */
	AGENT_STATUS: 0x43,
	/** Gateway -> Agent: CONFIG Applyの転送開始 */
	CONFIG_APPLY_BEGIN: 0x44,
	/** Gateway -> Agent: CONFIG Applyのchunk */
	CONFIG_APPLY_CHUNK: 0x45,
	/** Gateway -> Agent: CONFIG Applyのstaging完了 */
	CONFIG_APPLY_END: 0x46,
	/** Gateway -> Agent: staged CONFIGのactivate */
	CONFIG_APPLY_ACTIVATE: 0x47,
	/** Agent -> Gateway: CONFIG Applyの結果 / ACK */
	CONFIG_APPLY_RESULT: 0x48,
	/** Gateway -> Agent: CONFIG Applyの中止 */
	CONFIG_APPLY_ABORT: 0x49,
	/** Gateway -> Agent: Agentが接続するGatewayのendpoint一覧(#147) */
	GATEWAY_ENDPOINTS: 0x4a,
} as const;

export type Frame = {
	type: number;
	streamId: number;
	payload: Uint8Array;
};

export class FrameError extends Error {}

export function encodeFrame(
	type: number,
	streamId: number,
	payload: Uint8Array = new Uint8Array(0),
): Uint8Array {
	if (streamId < 0 || streamId > MAX_STREAM_ID) {
		throw new FrameError(`stream id out of range: ${streamId}`);
	}
	const frame = new Uint8Array(HEADER_LENGTH + payload.length);
	const view = new DataView(frame.buffer);
	view.setUint8(0, PROTOCOL_VERSION);
	view.setUint8(1, type);
	view.setUint16(2, streamId);
	view.setUint32(4, payload.length);
	frame.set(payload, HEADER_LENGTH);
	return frame;
}

/**
 * 連結されたframe列を先頭から切り出す。未知のtypeも呼び出し側へ渡す
 * (無視するかは呼び出し側の判断、§5)。
 */
export function decodeFrames(data: Uint8Array): Frame[] {
	const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
	const frames: Frame[] = [];
	let offset = 0;
	while (offset < data.length) {
		if (data.length - offset < HEADER_LENGTH) {
			throw new FrameError(`truncated header at ${offset}`);
		}
		const length = view.getUint32(offset + 4);
		const end = offset + HEADER_LENGTH + length;
		if (end > data.length) {
			throw new FrameError(
				`truncated payload at ${offset}: need ${length} bytes`,
			);
		}
		frames.push({
			type: view.getUint8(offset + 1),
			streamId: view.getUint16(offset + 2),
			payload: data.subarray(offset + HEADER_LENGTH, end),
		});
		offset = end;
	}
	return frames;
}

export function concatFrames(frames: Uint8Array[]): Uint8Array {
	const total = frames.reduce((sum, f) => sum + f.length, 0);
	const out = new Uint8Array(total);
	let offset = 0;
	for (const frame of frames) {
		out.set(frame, offset);
		offset += frame.length;
	}
	return out;
}
