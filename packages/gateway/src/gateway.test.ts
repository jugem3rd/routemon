import {
	type ConfigApplyBegin,
	cobsDecode,
	concatFrames,
	decodeConfigApplyBeginPayload,
	decodeConfigApplyChunkPayload,
	decodeFrames,
	encodeConfigApplyResultPayload,
	encodeFrame,
	FrameType,
	MAX_CONFIG_APPLY_CHUNK_BYTES,
	textEscape,
} from "@routemon/core";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { MemoryDeviceStore } from "./deviceStore.ts";
import {
	AgentGateway,
	ConfigApplyAckTimeoutError,
	ConfigApplyBusyError,
	ConfigApplyOptionsError,
	DeviceNotConnectedError,
	type Presence,
} from "./gateway.ts";

const HEARTBEAT = encodeFrame(FrameType.HEARTBEAT, 0);
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function applyBegin(
	totalBytes: number,
	chunkBytes = Math.min(totalBytes, 32_764),
): ConfigApplyBegin {
	return {
		operationId: Uint8Array.from({ length: 16 }, (_, index) => index),
		totalBytes,
		chunkBytes,
		targetSha256: new Uint8Array(32),
	};
}

function configBytes(length: number): Uint8Array {
	return Uint8Array.from({ length }, (_, index) => index % 256);
}

function applyResultFrame(
	streamId: number,
	result: Parameters<typeof encodeConfigApplyResultPayload>[0],
): Uint8Array {
	return encodeFrame(
		FrameType.CONFIG_APPLY_RESULT,
		streamId,
		encodeConfigApplyResultPayload(result),
	);
}

let store: MemoryDeviceStore;
let now: number;
let presenceChanges: Presence[];

function makeGateway(
	options: Partial<ConstructorParameters<typeof AgentGateway>[0]> = {},
) {
	return new AgentGateway({
		store,
		coalesceWaitMs: 5,
		now: () => now,
		onPresenceChange: (p) => presenceChanges.push(p),
		...options,
	});
}

/** Agentが送るsync request相当。bodyはtext escapeして渡す。 */
async function sync(
	gateway: AgentGateway,
	credential: string,
	waitSeconds = 0,
	frames: Uint8Array[] = [HEARTBEAT],
) {
	const response = await gateway.handleSync({
		authorization: `Bearer ${credential}`,
		waitSeconds,
		body: textEscape(concatFrames(frames)),
		remoteAddress: "192.0.2.10",
	});
	return {
		status: response.status,
		frames:
			response.status === 200 ? decodeFrames(cobsDecode(response.body)) : [],
	};
}

beforeEach(() => {
	store = new MemoryDeviceStore();
	store.add("device-1", "token-1");
	store.add("device-2", "token-2");
	now = 1_000_000;
	presenceChanges = [];
});

describe("authentication", () => {
	test("有効なcredentialは200", async () => {
		expect((await sync(makeGateway(), "token-1")).status).toBe(200);
	});

	test("未知・revoke済み・形式違いのcredentialは401", async () => {
		const gateway = makeGateway();
		expect((await sync(gateway, "unknown")).status).toBe(401);
		store.revoke("device-1");
		expect((await sync(gateway, "token-1")).status).toBe(401);
		expect(
			(await gateway.handleSync({ waitSeconds: 0, body: new Uint8Array(0) }))
				.status,
		).toBe(401);
		expect(
			(
				await gateway.handleSync({
					authorization: "Basic x",
					waitSeconds: 0,
					body: new Uint8Array(0),
				})
			).status,
		).toBe(401);
	});

	test("credentialを平文で保持しない", () => {
		expect(JSON.stringify(store)).not.toContain("token-1");
	});

	test("認証に失敗したbodyのframeは処理しない", async () => {
		const gateway = makeGateway();
		await sync(gateway, "token-1"); // device-1を観測済みにする
		const stream = gateway.openStream("device-1", new Uint8Array(0), {
			onData: () => {},
			onClose: () => {},
		});
		const closed = vi.fn();
		gateway.openStream("device-1", new Uint8Array(0), {
			onData: () => {},
			onClose: closed,
		});
		await gateway.handleSync({
			authorization: "Bearer wrong",
			waitSeconds: 0,
			body: textEscape(encodeFrame(FrameType.STREAM_CLOSE, stream.id)),
		});
		expect(closed).not.toHaveBeenCalled();
	});
});

describe("body validation", () => {
	test("壊れたframeは400", async () => {
		const gateway = makeGateway();
		const truncated = encodeFrame(
			FrameType.STREAM_DATA,
			101,
			Uint8Array.of(1, 2, 3),
		).subarray(0, 6);
		const response = await gateway.handleSync({
			authorization: "Bearer token-1",
			waitSeconds: 0,
			body: textEscape(truncated),
		});
		expect(response.status).toBe(400);
	});

	test("末尾が単独のescape byteなら400", async () => {
		const gateway = makeGateway();
		const response = await gateway.handleSync({
			authorization: "Bearer token-1",
			waitSeconds: 0,
			body: Uint8Array.of(0x41, 0xff),
		});
		expect(response.status).toBe(400);
	});
});

describe("device registry", () => {
	test("frameは対象Deviceのsyncだけに返る", async () => {
		const gateway = makeGateway();
		await sync(gateway, "token-1");
		await sync(gateway, "token-2");
		gateway.openStream("device-1", Uint8Array.of(0x47), {
			onData: () => {},
			onClose: () => {},
		});

		const second = await sync(gateway, "token-2");
		expect(second.frames).toHaveLength(0);
		const first = await sync(gateway, "token-1");
		expect(first.frames.map((f) => f.type)).toEqual([FrameType.STREAM_OPEN]);
	});

	test("未接続のDeviceへstreamを開けない", async () => {
		const gateway = makeGateway();
		expect(() =>
			gateway.openStream("device-1", new Uint8Array(0), {
				onData: () => {},
				onClose: () => {},
			}),
		).toThrow(DeviceNotConnectedError);
	});
});

describe("streams", () => {
	test("Agentからのdata / closeがhandlerへ届く", async () => {
		const gateway = makeGateway();
		await sync(gateway, "token-1");
		const received: Uint8Array[] = [];
		const onClose = vi.fn();
		const stream = gateway.openStream("device-1", Uint8Array.of(1), {
			onData: (d) => received.push(d),
			onClose,
		});

		await sync(gateway, "token-1", 0, [
			encodeFrame(FrameType.STREAM_DATA, stream.id, Uint8Array.of(9, 8)),
		]);
		expect(received).toEqual([Uint8Array.of(9, 8)]);

		await sync(gateway, "token-1", 0, [
			encodeFrame(FrameType.STREAM_CLOSE, stream.id),
		]);
		expect(onClose).toHaveBeenCalledWith(undefined);
	});

	test("STREAM_ERRORはreason付きでcloseになる", async () => {
		const gateway = makeGateway();
		await sync(gateway, "token-1");
		const onClose = vi.fn();
		const stream = gateway.openStream("device-1", new Uint8Array(0), {
			onData: () => {},
			onClose,
		});
		const reason = new TextEncoder().encode("webgui connect failed");
		await sync(gateway, "token-1", 0, [
			encodeFrame(FrameType.STREAM_ERROR, stream.id, reason),
		]);
		expect(onClose).toHaveBeenCalledWith("webgui connect failed");
	});

	test("使用中のstream idを再利用しない", async () => {
		const gateway = makeGateway();
		await sync(gateway, "token-1");
		const handlers = { onData: () => {}, onClose: () => {} };
		const open = [...Array(5)].map(() =>
			gateway.openStream("device-1", new Uint8Array(0), handlers),
		);
		open[1]?.close();
		const reopened = gateway.openStream(
			"device-1",
			new Uint8Array(0),
			handlers,
		);
		expect(open.map((s) => s.id)).toEqual([101, 102, 103, 104, 105]);
		expect(reopened.id).toBe(106);
		const ids = new Set(open.filter((_, i) => i !== 1).map((s) => s.id));
		expect(ids.has(reopened.id)).toBe(false);
	});

	test("閉じたstreamへのsendは無視する", async () => {
		const gateway = makeGateway();
		await sync(gateway, "token-1");
		const stream = gateway.openStream("device-1", new Uint8Array(0), {
			onData: () => {},
			onClose: () => {},
		});
		await sync(gateway, "token-1"); // STREAM_OPENを受け取る
		stream.close();
		stream.send(Uint8Array.of(1, 2, 3));
		const { frames } = await sync(gateway, "token-1");
		expect(frames.map((f) => f.type)).toEqual([FrameType.STREAM_CLOSE]);
	});
});

describe("wait semantics", () => {
	test("待機中にframeが積まれたら応答する", async () => {
		const gateway = makeGateway();
		await sync(gateway, "token-1");
		const pending = sync(gateway, "token-1", 5);
		await delay(20);
		gateway.openStream("device-1", Uint8Array.of(7), {
			onData: () => {},
			onClose: () => {},
		});
		const { frames } = await pending;
		expect(frames.map((f) => f.type)).toEqual([FrameType.STREAM_OPEN]);
	});

	test("同一Deviceの新しいsyncが来たら古いlong-pollは空で返る", async () => {
		const gateway = makeGateway();
		await sync(gateway, "token-1");
		const first = sync(gateway, "token-1", 25);
		await delay(20);
		const second = sync(gateway, "token-1", 25);
		expect((await first).frames).toHaveLength(0);

		await delay(20);
		gateway.openStream("device-1", Uint8Array.of(7), {
			onData: () => {},
			onClose: () => {},
		});
		expect((await second).frames.map((f) => f.type)).toEqual([
			FrameType.STREAM_OPEN,
		]);
	});

	test("wait=0なら待たずに返る", async () => {
		const gateway = makeGateway();
		const started = Date.now();
		await sync(gateway, "token-1", 0);
		expect(Date.now() - started).toBeLessThan(1000);
	});
});

describe("shutdown(#151)", () => {
	test("待機中のlong-pollは、frameが無ければ空の応答ですぐに返る", async () => {
		const gateway = makeGateway();
		await sync(gateway, "token-1");
		const pending = sync(gateway, "token-1", 25);
		await delay(20);

		const started = Date.now();
		gateway.shutdown();
		const response = await pending;

		expect(response.status).toBe(200);
		expect(response.frames).toHaveLength(0);
		expect(Date.now() - started).toBeLessThan(1000);
	});

	test("shutdown後のsyncは待たずに応答する", async () => {
		const gateway = makeGateway();
		gateway.shutdown();

		const started = Date.now();
		const response = await sync(gateway, "token-1", 25);

		expect(response.status).toBe(200);
		expect(Date.now() - started).toBeLessThan(1000);
	});

	test("shutdown後も、認証に失敗したsyncは401を返す", async () => {
		const gateway = makeGateway();
		gateway.shutdown();
		const response = await sync(gateway, "unknown-token", 25);
		expect(response.status).toBe(401);
	});

	test("開いているstreamは理由つきで閉じられる", async () => {
		const gateway = makeGateway();
		await sync(gateway, "token-1");
		const closed: (string | undefined)[] = [];
		gateway.openStream("device-1", Uint8Array.of(7), {
			onData: () => {},
			onClose: (reason) => closed.push(reason),
		});

		gateway.shutdown();

		expect(closed).toEqual(["gateway_shutdown"]);
	});
});

describe("limits", () => {
	test("1回の応答はmaxResponseBytesに収まり、残りは次のsyncで返る", async () => {
		const gateway = makeGateway({ maxResponseBytes: 5000 });
		await sync(gateway, "token-1");
		const stream = gateway.openStream("device-1", new Uint8Array(0), {
			onData: () => {},
			onClose: () => {},
		});
		for (let i = 0; i < 4; i++) {
			stream.send(new Uint8Array(2000));
		}
		const first = await sync(gateway, "token-1");
		const firstBytes = first.frames.reduce(
			(sum, f) => sum + f.payload.length + 8,
			0,
		);
		expect(firstBytes).toBeLessThanOrEqual(5000);
		const second = await sync(gateway, "token-1");
		expect(first.frames.length + second.frames.length).toBe(5); // STREAM_OPEN + 4 STREAM_DATA
	});

	test("queueが上限を超えたらstreamを閉じる", async () => {
		const gateway = makeGateway({ maxQueueBytes: 10_000 });
		await sync(gateway, "token-1");
		const onClose = vi.fn();
		const stream = gateway.openStream("device-1", new Uint8Array(0), {
			onData: () => {},
			onClose,
		});
		for (let i = 0; i < 10; i++) {
			stream.send(new Uint8Array(2000));
		}
		expect(onClose).toHaveBeenCalledWith("queue_overflow");
		expect((await sync(gateway, "token-1")).frames).toHaveLength(0);
	});

	test("waitはmaxSyncWaitSecondsで頭打ちにする", async () => {
		const gateway = makeGateway({ maxSyncWaitSeconds: 0 });
		const started = Date.now();
		await sync(gateway, "token-1", 25);
		expect(Date.now() - started).toBeLessThan(1000);
	});
});

describe("CONFIG Apply stream", () => {
	test("Deviceごとに1本だけで、Command / WebGUIとIDを共有しない", async () => {
		const gateway = makeGateway();
		await sync(gateway, "token-1");
		const webgui = gateway.openStream("device-1", new Uint8Array(0), {
			onData: () => {},
			onClose: () => {},
		});
		const command = gateway.sendCommand("device-1", Uint8Array.of(0x41));
		const handle = gateway.startConfigApply(
			"device-1",
			applyBegin(1, 1),
			configBytes(1),
		);

		const first = await sync(gateway, "token-1");
		const commandFrame = first.frames.find(
			(frame) => frame.type === FrameType.COMMAND_REQUEST,
		);
		const beginFrame = first.frames.find(
			(frame) => frame.type === FrameType.CONFIG_APPLY_BEGIN,
		);
		expect(webgui.id).toBe(101);
		expect(commandFrame?.streamId).toBe(102);
		expect(beginFrame?.streamId).toBe(103);
		expect(handle.id).toBe(103);
		expect(() =>
			gateway.startConfigApply("device-1", applyBegin(1, 1), configBytes(1)),
		).toThrow(ConfigApplyBusyError);

		handle.abort();
		const commandResponse = await sync(gateway, "token-1", 0, [
			encodeFrame(
				FrameType.COMMAND_RESPONSE,
				commandFrame?.streamId ?? 0,
				Uint8Array.of(1, 0x4f, 0x4b),
			),
		]);
		expect(commandResponse.frames.map((frame) => frame.type)).toEqual([
			FrameType.CONFIG_APPLY_ABORT,
		]);
		expect(await command).toEqual({
			success: true,
			output: Uint8Array.of(0x4f, 0x4b),
		});
	});

	test("ready後はwindow分だけ送り、ACK済みのchunkだけ進める", async () => {
		const gateway = makeGateway();
		await sync(gateway, "token-1");
		const handle = gateway.startConfigApply(
			"device-1",
			applyBegin(10, 2),
			configBytes(10),
			{},
			{ windowSize: 2 },
		);

		const beginResponse = await sync(gateway, "token-1");
		const beginFrame = beginResponse.frames[0];
		expect(beginFrame?.type).toBe(FrameType.CONFIG_APPLY_BEGIN);
		expect(
			decodeConfigApplyBeginPayload(beginFrame?.payload ?? new Uint8Array()),
		).toEqual(applyBegin(10, 2));

		const readyResponse = await sync(gateway, "token-1", 0, [
			applyResultFrame(handle.id, {
				status: "ready",
				errorCode: "none",
			}),
		]);
		const firstWindow = readyResponse.frames.filter(
			(frame) => frame.type === FrameType.CONFIG_APPLY_CHUNK,
		);
		expect(firstWindow).toHaveLength(2);
		expect(
			firstWindow.map(
				(frame) => decodeConfigApplyChunkPayload(frame.payload).seq,
			),
		).toEqual([0, 1]);

		expect(
			(await sync(gateway, "token-1")).frames.filter(
				(frame) => frame.type === FrameType.CONFIG_APPLY_CHUNK,
			),
		).toHaveLength(0);

		const afterAck0 = await sync(gateway, "token-1", 0, [
			applyResultFrame(handle.id, {
				status: "chunk_ack",
				seq: 0,
				errorCode: "none",
			}),
		]);
		expect(
			afterAck0.frames
				.filter((frame) => frame.type === FrameType.CONFIG_APPLY_CHUNK)
				.map((frame) => decodeConfigApplyChunkPayload(frame.payload).seq),
		).toEqual([2]);

		const afterAck1 = await sync(gateway, "token-1", 0, [
			applyResultFrame(handle.id, {
				status: "chunk_ack",
				seq: 1,
				errorCode: "none",
			}),
		]);
		expect(
			afterAck1.frames
				.filter((frame) => frame.type === FrameType.CONFIG_APPLY_CHUNK)
				.map((frame) => decodeConfigApplyChunkPayload(frame.payload).seq),
		).toEqual([3]);

		handle.abort();
	});

	test("ACK timeoutは未確認chunkの追送ではなくBEGINから再初期化する", async () => {
		vi.useFakeTimers();
		try {
			const gateway = makeGateway({ maxResponseBytes: 20 });
			await sync(gateway, "token-1");
			const handle = gateway.startConfigApply(
				"device-1",
				applyBegin(4, 1),
				configBytes(4),
				{},
				{ ackTimeoutMs: 10, maxRetries: 1 },
			);
			const first = await sync(gateway, "token-1");
			const firstId = handle.id;
			expect(first.frames.map((frame) => frame.type)).toEqual([
				FrameType.CONFIG_APPLY_BEGIN,
			]);

			const ready = await sync(gateway, "token-1", 0, [
				applyResultFrame(firstId, {
					status: "ready",
					errorCode: "none",
				}),
			]);
			expect(ready.frames.map((frame) => frame.type)).toEqual([
				FrameType.CONFIG_APPLY_CHUNK,
			]);

			await vi.advanceTimersByTimeAsync(11);
			const retry = await sync(gateway, "token-1");
			expect(retry.frames.map((frame) => frame.type)).toEqual([
				FrameType.CONFIG_APPLY_BEGIN,
			]);
			expect(handle.id).not.toBe(firstId);
			handle.abort();
		} finally {
			vi.clearAllTimers();
			vi.useRealTimers();
		}
	});

	test("ACTIVATE timeoutではACTIVATEを自動再送しない", async () => {
		vi.useFakeTimers();
		try {
			const errors: Error[] = [];
			const gateway = makeGateway();
			await sync(gateway, "token-1");
			const handle = gateway.startConfigApply(
				"device-1",
				applyBegin(1, 1),
				configBytes(1),
				{ onError: (error) => errors.push(error) },
				{ ackTimeoutMs: 10 },
			);
			await sync(gateway, "token-1");
			await sync(gateway, "token-1", 0, [
				applyResultFrame(handle.id, {
					status: "ready",
					errorCode: "none",
				}),
			]);
			const end = await sync(gateway, "token-1", 0, [
				applyResultFrame(handle.id, {
					status: "chunk_ack",
					seq: 0,
					errorCode: "none",
				}),
			]);
			expect(end.frames.map((frame) => frame.type)).toEqual([
				FrameType.CONFIG_APPLY_END,
			]);
			await sync(gateway, "token-1", 0, [
				applyResultFrame(handle.id, {
					status: "staged",
					errorCode: "none",
				}),
			]);

			handle.activate();
			const activate = await sync(gateway, "token-1");
			expect(activate.frames.map((frame) => frame.type)).toEqual([
				FrameType.CONFIG_APPLY_ACTIVATE,
			]);
			await vi.advanceTimersByTimeAsync(11);
			expect((await sync(gateway, "token-1")).frames).toHaveLength(0);
			expect(errors).toHaveLength(1);
			expect(errors[0]).toBeInstanceOf(ConfigApplyAckTimeoutError);
		} finally {
			vi.clearAllTimers();
			vi.useRealTimers();
		}
	});

	test("1 responseのchunk数を4に制限し、ABORTを送れる", async () => {
		const gateway = makeGateway();
		await sync(gateway, "token-1");
		expect(() =>
			gateway.startConfigApply(
				"device-1",
				applyBegin(1, 1),
				configBytes(1),
				{},
				{ windowSize: 5 },
			),
		).toThrow(ConfigApplyOptionsError);

		const totalBytes = MAX_CONFIG_APPLY_CHUNK_BYTES * 5;
		const handle = gateway.startConfigApply(
			"device-1",
			applyBegin(totalBytes, MAX_CONFIG_APPLY_CHUNK_BYTES),
			configBytes(totalBytes),
		);
		await sync(gateway, "token-1");
		const ready = await sync(gateway, "token-1", 0, [
			applyResultFrame(handle.id, {
				status: "ready",
				errorCode: "none",
			}),
		]);
		const chunks = ready.frames.filter(
			(frame) => frame.type === FrameType.CONFIG_APPLY_CHUNK,
		);
		expect(chunks).toHaveLength(4);
		expect(
			ready.frames.reduce((sum, frame) => sum + frame.payload.length + 8, 0),
		).toBeLessThanOrEqual(256 * 1024);

		handle.abort();
		const aborted = await sync(gateway, "token-1");
		expect(aborted.frames.map((frame) => frame.type)).toEqual([
			FrameType.CONFIG_APPLY_ABORT,
		]);
	});
});

describe("presence", () => {
	test("観測が無いDeviceはunknown", () => {
		expect(makeGateway().presence("device-1")).toEqual({
			deviceId: "device-1",
			status: "unknown",
		});
	});

	test("経過時間からonline / unstable / offlineを導出する", async () => {
		const gateway = makeGateway();
		await sync(gateway, "token-1");
		expect(gateway.presence("device-1")).toMatchObject({
			status: "online",
			observedSourceIp: "192.0.2.10",
		});

		now += 60_000;
		expect(gateway.presence("device-1").status).toBe("unstable");
		now += 120_000;
		expect(gateway.presence("device-1").status).toBe("offline");

		await sync(gateway, "token-1");
		expect(gateway.presence("device-1").status).toBe("online");
	});

	test("status変化を通知する(sweepで観測が途絶えたDeviceも判定する)", async () => {
		const gateway = makeGateway();
		await sync(gateway, "token-1");
		now += 200_000;
		gateway.sweepPresence();
		await sync(gateway, "token-2");
		await sync(gateway, "token-1");
		expect(presenceChanges.map((p) => `${p.deviceId}:${p.status}`)).toEqual([
			"device-1:online",
			"device-1:offline",
			"device-2:online",
			"device-1:online",
		]);
	});
});
