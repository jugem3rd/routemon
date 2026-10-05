import { describe, expect, test } from "vitest";
import {
	CONFIG_APPLY_BEGIN_PAYLOAD_LENGTH,
	CONFIG_APPLY_END_PAYLOAD_LENGTH,
	CONFIG_APPLY_RESULT_PAYLOAD_LENGTH,
	ConfigApplyError,
	ConfigApplyTransferValidator,
	decodeConfigApplyAbortPayload,
	decodeConfigApplyActivatePayload,
	decodeConfigApplyBeginPayload,
	decodeConfigApplyChunkPayload,
	decodeConfigApplyEndPayload,
	decodeConfigApplyResultPayload,
	encodeConfigApplyAbortPayload,
	encodeConfigApplyActivatePayload,
	encodeConfigApplyBeginPayload,
	encodeConfigApplyChunkPayload,
	encodeConfigApplyEndPayload,
	encodeConfigApplyResultPayload,
	MAX_CONFIG_APPLY_CHUNK_BYTES,
	MAX_CONFIG_APPLY_CHUNK_PAYLOAD_BYTES,
} from "./configApply.ts";
import {
	concatFrames,
	decodeFrames,
	encodeFrame,
	FrameType,
} from "./frames.ts";

const operationId = Uint8Array.from({ length: 16 }, (_, index) => index);
const targetSha256 = Uint8Array.from(
	{ length: 32 },
	(_, index) => 0xa0 + index,
);

function begin(totalBytes: number, chunkBytes = MAX_CONFIG_APPLY_CHUNK_BYTES) {
	return {
		operationId,
		totalBytes,
		chunkBytes,
		targetSha256,
	};
}

function bytes(length: number, value = 0x5a): Uint8Array {
	return new Uint8Array(length).fill(value);
}

describe("CONFIG_APPLY payload", () => {
	test("BEGINをbig-endianで往復する", () => {
		const input = begin(123456, 4096);
		const payload = encodeConfigApplyBeginPayload(input);

		expect(payload).toHaveLength(CONFIG_APPLY_BEGIN_PAYLOAD_LENGTH);
		expect(decodeConfigApplyBeginPayload(payload)).toEqual(input);
	});

	test("totalBytesが0の空CONFIGを拒否する", () => {
		try {
			new ConfigApplyTransferValidator(begin(0, 1024));
			throw new Error("expected empty CONFIG error");
		} catch (error) {
			expect(error).toBeInstanceOf(ConfigApplyError);
			expect((error as ConfigApplyError).code).toBe("invalid_payload");
		}
	});

	test("CHUNKは32 KiBちょうどを受け付ける", () => {
		const input = { seq: 7, bytes: bytes(MAX_CONFIG_APPLY_CHUNK_BYTES) };
		const payload = encodeConfigApplyChunkPayload(input);

		expect(payload).toHaveLength(MAX_CONFIG_APPLY_CHUNK_PAYLOAD_BYTES);
		expect(decodeConfigApplyChunkPayload(payload)).toEqual(input);
	});

	test("32 KiBを超えるCHUNKを拒否する", () => {
		const tooLarge = {
			seq: 0,
			bytes: bytes(MAX_CONFIG_APPLY_CHUNK_BYTES + 1),
		};

		expect(() => encodeConfigApplyChunkPayload(tooLarge)).toThrow(
			ConfigApplyError,
		);
		expect(() =>
			decodeConfigApplyChunkPayload(
				Uint8Array.from([0, 0, 0, 0, ...tooLarge.bytes]),
			),
		).toThrow(ConfigApplyError);
	});

	test("END、空payload、RESULTを往復する", () => {
		const end = { totalBytes: 65537, chunkCount: 3 };
		const endPayload = encodeConfigApplyEndPayload(end);
		expect(endPayload).toHaveLength(CONFIG_APPLY_END_PAYLOAD_LENGTH);
		expect(decodeConfigApplyEndPayload(endPayload)).toEqual(end);

		const activatePayload = encodeConfigApplyActivatePayload();
		expect(activatePayload).toHaveLength(0);
		decodeConfigApplyActivatePayload(activatePayload);

		const result = {
			status: "chunk_ack" as const,
			seq: 12,
			errorCode: "none" as const,
		};
		const resultPayload = encodeConfigApplyResultPayload(result);
		expect(resultPayload).toHaveLength(CONFIG_APPLY_RESULT_PAYLOAD_LENGTH);
		expect(decodeConfigApplyResultPayload(resultPayload)).toEqual(result);

		const statusOnly = {
			status: "ready" as const,
			errorCode: "none" as const,
		};
		expect(
			decodeConfigApplyResultPayload(
				encodeConfigApplyResultPayload(statusOnly),
			),
		).toEqual({ ...statusOnly, seq: undefined });

		const abortPayload = encodeConfigApplyAbortPayload();
		expect(abortPayload).toHaveLength(0);
		decodeConfigApplyAbortPayload(abortPayload);
	});

	test("CONFIG_APPLYのframe typeを0x44-0x49へ固定する", () => {
		expect([
			FrameType.CONFIG_APPLY_BEGIN,
			FrameType.CONFIG_APPLY_CHUNK,
			FrameType.CONFIG_APPLY_END,
			FrameType.CONFIG_APPLY_ACTIVATE,
			FrameType.CONFIG_APPLY_RESULT,
			FrameType.CONFIG_APPLY_ABORT,
		]).toEqual([0x44, 0x45, 0x46, 0x47, 0x48, 0x49]);
	});

	test("seqの欠落を拒否する", () => {
		const validator = new ConfigApplyTransferValidator(begin(2, 2));
		validator.accept({ seq: 0, bytes: bytes(1) });

		try {
			validator.accept({ seq: 2, bytes: bytes(1) });
			throw new Error("expected sequence error");
		} catch (error) {
			expect(error).toBeInstanceOf(ConfigApplyError);
			expect((error as ConfigApplyError).code).toBe("invalid_sequence");
		}
	});

	test("seqの重複を拒否する", () => {
		const validator = new ConfigApplyTransferValidator(begin(2, 1));
		validator.accept({ seq: 0, bytes: bytes(1) });

		expect(() => validator.accept({ seq: 0, bytes: bytes(1) })).toThrow(
			ConfigApplyError,
		);
	});

	test("total bytesとchunk countをENDで検証する", () => {
		const validator = new ConfigApplyTransferValidator(begin(3, 2));
		validator.accept({ seq: 0, bytes: bytes(2) });

		expect(() => validator.finish({ totalBytes: 3, chunkCount: 1 })).toThrow(
			ConfigApplyError,
		);

		validator.accept({ seq: 1, bytes: bytes(1) });
		expect(() => validator.finish({ totalBytes: 3, chunkCount: 3 })).toThrow(
			ConfigApplyError,
		);
		validator.finish({ totalBytes: 3, chunkCount: 2 });
	});

	test("ENDのtotal bytes不一致を拒否する", () => {
		const validator = new ConfigApplyTransferValidator(begin(1, 1));
		validator.accept({ seq: 0, bytes: bytes(1) });

		expect(() => validator.finish({ totalBytes: 2, chunkCount: 1 })).toThrow(
			ConfigApplyError,
		);
	});

	test("32 KiB CHUNKを複数HTTP responseに分けて検証する", () => {
		const first = bytes(MAX_CONFIG_APPLY_CHUNK_BYTES, 0x11);
		const second = bytes(1, 0x22);
		const applyBegin = begin(first.length + second.length);
		const streamId = 42;
		const validator = new ConfigApplyTransferValidator(applyBegin);
		const response1 = concatFrames([
			encodeFrame(
				FrameType.CONFIG_APPLY_BEGIN,
				streamId,
				encodeConfigApplyBeginPayload(applyBegin),
			),
			encodeFrame(
				FrameType.CONFIG_APPLY_CHUNK,
				streamId,
				encodeConfigApplyChunkPayload({ seq: 0, bytes: first }),
			),
		]);
		const response2 = concatFrames([
			encodeFrame(
				FrameType.CONFIG_APPLY_CHUNK,
				streamId,
				encodeConfigApplyChunkPayload({ seq: 1, bytes: second }),
			),
			encodeFrame(
				FrameType.CONFIG_APPLY_END,
				streamId,
				encodeConfigApplyEndPayload({
					totalBytes: first.length + second.length,
					chunkCount: 2,
				}),
			),
		]);

		const responses = [response1, response2];
		for (const response of responses) {
			for (const frame of decodeFrames(response)) {
				switch (frame.type) {
					case FrameType.CONFIG_APPLY_BEGIN:
						expect(decodeConfigApplyBeginPayload(frame.payload)).toEqual(
							applyBegin,
						);
						break;
					case FrameType.CONFIG_APPLY_CHUNK:
						validator.accept(decodeConfigApplyChunkPayload(frame.payload));
						break;
					case FrameType.CONFIG_APPLY_END:
						validator.finish(decodeConfigApplyEndPayload(frame.payload));
						break;
					default:
						throw new Error(`unexpected frame type ${frame.type}`);
				}
			}
		}
	});
});
