/**
 * Agent -> Gateway方向のtext escape(docs/core/agent-protocol.md §6.1)。
 *
 * rt.httprequest()のpost_textが拒否するbyteとescape byte 0xFF自身を
 * 0xFF, (b XOR 0x40) の2 byteへ置き換える。
 */

export const ESCAPE_BYTE = 0xff;

const UNSAFE = new Uint8Array(256);
for (let b = 0x00; b <= 0x08; b++) UNSAFE[b] = 1;
UNSAFE[0x0b] = 1;
UNSAFE[0x0c] = 1;
for (let b = 0x0e; b <= 0x1f; b++) UNSAFE[b] = 1;
UNSAFE[0x7f] = 1;
UNSAFE[ESCAPE_BYTE] = 1;

export function isUnsafeByte(b: number): boolean {
	return UNSAFE[b] === 1;
}

export function textEscape(data: Uint8Array): Uint8Array {
	let unsafe = 0;
	for (const b of data) {
		if (UNSAFE[b] === 1) unsafe++;
	}
	if (unsafe === 0) return data;
	const out = new Uint8Array(data.length + unsafe);
	let offset = 0;
	for (const b of data) {
		if (UNSAFE[b] === 1) {
			out[offset++] = ESCAPE_BYTE;
			out[offset++] = b ^ 0x40;
		} else {
			out[offset++] = b;
		}
	}
	return out;
}

export class EscapeError extends Error {}

export function textUnescape(data: Uint8Array): Uint8Array {
	const out = new Uint8Array(data.length);
	let offset = 0;
	for (let i = 0; i < data.length; i++) {
		const b = data[i] as number;
		if (b !== ESCAPE_BYTE) {
			out[offset++] = b;
			continue;
		}
		i++;
		if (i >= data.length) {
			throw new EscapeError("body ends with a lone escape byte");
		}
		out[offset++] = (data[i] as number) ^ 0x40;
	}
	return out.subarray(0, offset);
}
