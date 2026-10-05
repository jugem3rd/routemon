import { describe, expect, test } from "vitest";
import { cobsDecode, cobsEncode } from "./cobs.ts";
import {
	EscapeError,
	isUnsafeByte,
	textEscape,
	textUnescape,
} from "./escape.ts";
import {
	decodeFrames,
	encodeFrame,
	FrameError,
	FrameType,
	HEADER_LENGTH,
} from "./frames.ts";

const allBytes = Uint8Array.from({ length: 256 }, (_, i) => i);
const hex = (data: Uint8Array) =>
	Array.from(data, (b) => b.toString(16).padStart(2, "0")).join(" ");

function pseudoRandom(length: number, seed: number): Uint8Array {
	let x = seed;
	return Uint8Array.from({ length }, () => {
		x = (x * 1103515245 + 12345) % 2147483648;
		return x % 256;
	});
}

describe("COBS", () => {
	// docs/core/agent-protocol.md §6.2のtest vectorと同じ結果になること
	test.each([
		[new Uint8Array(0), "01"],
		[Uint8Array.of(0x00), "01 01"],
		[Uint8Array.of(0x00, 0x00), "01 01 01"],
		[Uint8Array.of(0x00, 0x11, 0x00), "01 02 11 01"],
	])("encodes %s", (input, expected) => {
		expect(hex(cobsEncode(input))).toBe(expected);
	});

	test("長さがPython実装と一致する", () => {
		expect(cobsEncode(allBytes).length).toBe(258);
		expect(cobsEncode(new Uint8Array(300)).length).toBe(301);
	});

	test("0x00を含まず、round tripする", () => {
		for (const input of [
			allBytes,
			new Uint8Array(300),
			pseudoRandom(1000, 7),
			pseudoRandom(5000, 99),
		]) {
			const encoded = cobsEncode(input);
			expect(encoded.includes(0)).toBe(false);
			expect(cobsDecode(encoded)).toEqual(input);
		}
	});
});

describe("text escape", () => {
	test("post_textが拒否するbyteと0xFFだけをescapeする", () => {
		const unsafe = new Set([
			...Array(9).keys(),
			0x0b,
			0x0c,
			...Array(18)
				.keys()
				.map((i) => i + 0x0e),
			0x7f,
			0xff,
		]);
		for (let b = 0; b < 256; b++) {
			expect(isUnsafeByte(b)).toBe(unsafe.has(b));
		}
		// 9(TAB) / 10(LF) / 13(CR) / 32(space)はそのまま送れる
		for (const safe of [0x09, 0x0a, 0x0d, 0x20]) {
			expect(isUnsafeByte(safe)).toBe(false);
		}
	});

	test("escape後のbyteはescape対象に含まれない", () => {
		const escaped = textEscape(allBytes);
		expect(escaped.length).toBe(287); // Python参照実装と一致
		for (let i = 0; i < escaped.length; i++) {
			if (escaped[i] === 0xff) {
				i++;
				expect(isUnsafeByte(escaped[i] as number)).toBe(false);
			}
		}
	});

	test("round tripする", () => {
		for (const input of [allBytes, new Uint8Array(0), pseudoRandom(2000, 3)]) {
			expect(textUnescape(textEscape(input))).toEqual(input);
		}
	});

	test("末尾が単独の0xFFならerror", () => {
		expect(() => textUnescape(Uint8Array.of(0x41, 0xff))).toThrow(EscapeError);
	});
});

describe("frames", () => {
	test("encode / decodeがround tripする", () => {
		const payload = pseudoRandom(100, 11);
		const frames = decodeFrames(
			encodeFrame(FrameType.STREAM_DATA, 4242, payload),
		);
		expect(frames).toHaveLength(1);
		expect(frames[0]).toMatchObject({
			type: FrameType.STREAM_DATA,
			streamId: 4242,
		});
		expect(frames[0]?.payload).toEqual(payload);
	});

	test("連結したframeを順に切り出す", () => {
		const a = encodeFrame(FrameType.HEARTBEAT, 0);
		const b = encodeFrame(FrameType.STREAM_OPEN, 101, Uint8Array.of(1, 2, 3));
		const joined = new Uint8Array([...a, ...b]);
		expect(decodeFrames(joined).map((f) => f.type)).toEqual([
			FrameType.HEARTBEAT,
			FrameType.STREAM_OPEN,
		]);
	});

	test("HEARTBEATはheaderだけ", () => {
		expect(encodeFrame(FrameType.HEARTBEAT, 0).length).toBe(HEADER_LENGTH);
		expect(hex(encodeFrame(FrameType.HEARTBEAT, 0))).toBe(
			"01 03 00 00 00 00 00 00",
		);
	});

	test("途中で切れたframeはerror", () => {
		const frame = encodeFrame(FrameType.STREAM_DATA, 1, Uint8Array.of(1, 2, 3));
		expect(() => decodeFrames(frame.subarray(0, 4))).toThrow(FrameError);
		expect(() => decodeFrames(frame.subarray(0, frame.length - 1))).toThrow(
			FrameError,
		);
	});

	test("stream idの範囲を検査する", () => {
		expect(() => encodeFrame(FrameType.STREAM_DATA, 65536)).toThrow(FrameError);
		expect(() => encodeFrame(FrameType.STREAM_DATA, -1)).toThrow(FrameError);
	});
});
