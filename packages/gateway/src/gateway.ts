/**
 * Agent Gateway(docs/core/agent-gateway-design.md、docs/core/agent-protocol.md)。
 *
 * Agentのsyncを終端し、Device単位で接続・Presence・streamを管理する。
 * 永続stateは持たない(Gateway再起動でPresenceは失われ、次のsyncで復帰する)。
 */

import type {
	ConfigApplyBegin,
	ConfigApplyResult,
	Frame,
} from "@routemon/core";
import {
	ConfigApplyError,
	ConfigApplyTransferValidator,
	cobsEncode,
	concatFrames,
	decodeConfigApplyResultPayload,
	decodeFrames,
	EscapeError,
	encodeConfigApplyAbortPayload,
	encodeConfigApplyActivatePayload,
	encodeConfigApplyBeginPayload,
	encodeConfigApplyChunkPayload,
	encodeConfigApplyEndPayload,
	encodeFrame,
	FrameError,
	FrameType,
	MAX_STREAM_ID,
	textUnescape,
} from "@routemon/core";

export type PresenceStatus = "online" | "unstable" | "offline" | "unknown";

export type Presence = {
	deviceId: string;
	status: PresenceStatus;
	lastSeenAt?: Date;
	observedSourceIp?: string;
};

/** credentialの発行・保存は#23。Gatewayは検証結果のdevice idだけを受け取る。 */
export interface DeviceStore {
	/** credentialが有効ならdevice idを返す。未知・revoke済みならnull。 */
	resolveCredential(credential: string): Promise<string | null>;
}

export type StreamHandlers = {
	onData(data: Uint8Array): void;
	onClose(reason?: string): void;
};

export type StreamHandle = {
	id: number;
	send(data: Uint8Array): void;
	close(): void;
};

export type SyncRequest = {
	authorization?: string;
	waitSeconds: number;
	body: Uint8Array;
	remoteAddress?: string;
};

export type SyncResponse = {
	status: number;
	body: Uint8Array;
};

export type GatewayOptions = {
	store: DeviceStore;
	/** <wait>の上限(秒)。docs/core/agent-protocol.md §12 */
	maxSyncWaitSeconds?: number;
	/** long-pollの起床後、後続frameをまとめる時間(ms) */
	coalesceWaitMs?: number;
	/** 1回の応答に入れるframeの上限(byte)。rt.httprequest()のbody上限640 KBより小さくする */
	maxResponseBytes?: number;
	/** Agentが受け取らない間に溜められるframeの上限(byte) */
	maxQueueBytes?: number;
	/** Presence: この時間内に観測していればonline */
	onlineWithinMs?: number;
	/** Presence: この時間内なら unstable、超えたらoffline */
	unstableWithinMs?: number;
	/** COMMAND_RESPONSEを待つ既定時間 */
	commandTimeoutMs?: number;
	/** STREAM以外のframe(COMMAND_RESPONSE / TELEMETRY / EVENT / CONFIG_BACKUP等) */
	onFrame?: (deviceId: string, frame: Frame) => void;
	/** Presenceのstatusが変わったとき(Eventとして永続化できる、docs/core/data-model.md §5) */
	onPresenceChange?: (presence: Presence) => void;
	logger?: { info(msg: string): void; warn(msg: string): void };
	now?: () => number;
};

export class DeviceNotConnectedError extends Error {}
export class CommandTimeoutError extends Error {}
export class ConfigApplyBusyError extends Error {}
export class ConfigApplyOptionsError extends Error {}
export class ConfigApplyProtocolError extends Error {}
export class ConfigApplyAckTimeoutError extends Error {}

export const MAX_CONFIG_APPLY_CHUNKS_PER_RESPONSE = 4;
export const DEFAULT_CONFIG_APPLY_WINDOW_SIZE =
	MAX_CONFIG_APPLY_CHUNKS_PER_RESPONSE;
export const DEFAULT_CONFIG_APPLY_ACK_TIMEOUT_MS = 60_000;
export const DEFAULT_CONFIG_APPLY_MAX_RETRIES = 3;

export type ConfigApplyHandlers = {
	onResult?: (result: ConfigApplyResult) => void;
	onError?: (error: Error) => void;
};

export type ConfigApplyOptions = {
	/** 一度にAgentへ送ってACKを待つchunk数(最大4)。 */
	windowSize?: number;
	/** BEGIN / CHUNK / END / ABORTの結果を待つ時間。 */
	ackTimeoutMs?: number;
	/** ACK timeout時にBEGINから再初期化する回数。 */
	maxRetries?: number;
};

export type ConfigApplyHandle = {
	readonly id: number;
	activate(): void;
	abort(): void;
};

export type CommandResult = {
	/** rt.command()の成否 */
	success: boolean;
	/** rt.command()の出力(Shift_JIS、CR/LFを含む) */
	output: Uint8Array;
};

const DEFAULTS = {
	commandTimeoutMs: 60_000,
	maxSyncWaitSeconds: 25,
	coalesceWaitMs: 30,
	maxResponseBytes: 256 * 1024,
	maxQueueBytes: 4 * 1024 * 1024,
	onlineWithinMs: 45_000,
	unstableWithinMs: 120_000,
};

const FIRST_STREAM_ID = 101;

type Waiter = {
	resolve: () => void;
	timer: ReturnType<typeof setTimeout>;
};

type PendingCommand = {
	resolve: (result: CommandResult) => void;
	reject: (error: Error) => void;
	timer: ReturnType<typeof setTimeout>;
};

type ConfigApplyPhase =
	| "awaiting_ready"
	| "transferring"
	| "awaiting_staged"
	| "staged"
	| "awaiting_activate"
	| "failed"
	| "done";

type PendingConfigApply = {
	id: number;
	begin: ConfigApplyBegin;
	chunks: Uint8Array[];
	nextChunk: number;
	inFlight: Set<number>;
	phase: ConfigApplyPhase;
	windowSize: number;
	ackTimeoutMs: number;
	maxRetries: number;
	retries: number;
	ackTimer?: ReturnType<typeof setTimeout>;
	handlers: ConfigApplyHandlers;
};

type QueueEntry = {
	frame: Uint8Array;
	/** timeoutで再初期化するときに古いApply frameだけを捨てるためのID。 */
	applyStreamId?: number;
};

type DeviceState = {
	deviceId: string;
	queue: QueueEntry[];
	queuedBytes: number;
	waiter?: Waiter;
	streams: Map<number, StreamHandlers>;
	commands: Map<number, PendingCommand>;
	apply?: PendingConfigApply;
	nextStreamId: number;
	lastSeenAt: Date;
	observedSourceIp?: string;
	status: PresenceStatus;
};

export class AgentGateway {
	private readonly options: Required<
		Omit<
			GatewayOptions,
			"store" | "onFrame" | "onPresenceChange" | "logger" | "now"
		>
	>;
	private readonly devices = new Map<string, DeviceState>();
	private readonly config: GatewayOptions;
	private shuttingDown = false;

	constructor(config: GatewayOptions) {
		this.config = config;
		this.options = { ...DEFAULTS, ...stripUndefined(config) };
	}

	/**
	 * 停止の準備をする(#151)。待機中のlong-pollは、溜まっているframeがあればそれを、
	 * 無ければ空の応答ですぐに返し、以降のsyncは待たせずに応答する。開いているstreamは
	 * 閉じる。Agentはエラーではなく通常の応答として受け取り、すぐ次のsyncを送る。
	 */
	shutdown(): void {
		this.shuttingDown = true;
		for (const device of this.devices.values()) {
			this.wake(device);
			this.closeAllStreams(device, "gateway_shutdown");
		}
	}

	private now(): number {
		return this.config.now?.() ?? Date.now();
	}

	private log(level: "info" | "warn", msg: string): void {
		this.config.logger?.[level](msg);
	}

	/**
	 * POST /v1/tunnel/sync/<wait> の処理(docs/core/agent-protocol.md §4)。
	 */
	async handleSync(request: SyncRequest): Promise<SyncResponse> {
		const credential = bearerCredential(request.authorization);
		const deviceId = credential
			? await this.config.store.resolveCredential(credential)
			: null;
		if (!deviceId) {
			this.log(
				"warn",
				`unauthorized sync from ${request.remoteAddress ?? "unknown"}`,
			);
			return { status: 401, body: encodeText("unauthorized") };
		}

		let frames: Frame[];
		try {
			// bodyを最後まで解析してから処理する(途中まで処理して400を返さない)
			frames = decodeFrames(textUnescape(request.body));
		} catch (error) {
			if (error instanceof FrameError || error instanceof EscapeError) {
				this.log(
					"warn",
					`malformed sync body from ${deviceId}: ${error.message}`,
				);
				return { status: 400, body: encodeText("malformed frame") };
			}
			throw error;
		}

		const device = this.touch(deviceId, request.remoteAddress);
		for (const frame of frames) {
			this.dispatch(device, frame);
		}

		const waitSeconds = Math.min(
			Math.max(request.waitSeconds, 0),
			this.options.maxSyncWaitSeconds,
		);
		await this.waitForFrames(device, waitSeconds);
		return { status: 200, body: cobsEncode(this.drain(device)) };
	}

	/** Agentからのframeを振り分ける(未知のtypeは無視する)。 */
	private dispatch(device: DeviceState, frame: Frame): void {
		switch (frame.type) {
			case FrameType.HEARTBEAT:
				return;
			case FrameType.STREAM_DATA: {
				device.streams.get(frame.streamId)?.onData(frame.payload);
				return;
			}
			case FrameType.COMMAND_RESPONSE: {
				const pending = device.commands.get(frame.streamId);
				if (!pending) {
					// timeout後に届いた応答は捨てる(再実行はしない)
					this.log("warn", `late command response from ${device.deviceId}`);
					return;
				}
				device.commands.delete(frame.streamId);
				clearTimeout(pending.timer);
				pending.resolve({
					success: frame.payload[0] === 1,
					output: frame.payload.subarray(1),
				});
				return;
			}
			case FrameType.CONFIG_APPLY_RESULT:
				this.handleConfigApplyResult(device, frame);
				return;
			case FrameType.STREAM_CLOSE:
			case FrameType.STREAM_ERROR: {
				const handlers = device.streams.get(frame.streamId);
				if (!handlers) return;
				device.streams.delete(frame.streamId);
				handlers.onClose(
					frame.type === FrameType.STREAM_ERROR
						? decodeText(frame.payload)
						: undefined,
				);
				return;
			}
			default: {
				if (this.config.onFrame) {
					this.config.onFrame(device.deviceId, frame);
				} else {
					this.log(
						"warn",
						`unhandled frame type 0x${frame.type.toString(16)} from ${device.deviceId}`,
					);
				}
			}
		}
	}

	/**
	 * 応答するframeが無ければwait秒まで待つ。最初のframeが来たらcoalesce時間だけ
	 * 追加で待ち、同時に発生したframeを同じ応答へまとめる。
	 */
	private async waitForFrames(
		device: DeviceState,
		waitSeconds: number,
	): Promise<void> {
		if (this.shuttingDown || device.queue.length > 0 || waitSeconds <= 0)
			return;
		await new Promise<void>((resolve) => {
			const waiter: Waiter = {
				resolve,
				timer: setTimeout(() => {
					device.waiter = undefined;
					resolve();
				}, waitSeconds * 1000),
			};
			device.waiter = waiter;
		});
		if (device.queue.length > 0 && this.options.coalesceWaitMs > 0) {
			await delay(this.options.coalesceWaitMs);
		}
	}

	private wake(device: DeviceState): void {
		const waiter = device.waiter;
		if (!waiter) return;
		device.waiter = undefined;
		clearTimeout(waiter.timer);
		waiter.resolve();
	}

	/** 応答へ入れるframeを上限まで取り出す。残りは次のsyncで返す。 */
	private drain(device: DeviceState): Uint8Array {
		const out: Uint8Array[] = [];
		let bytes = 0;
		while (device.queue.length > 0) {
			const next = device.queue[0] as QueueEntry;
			if (
				out.length > 0 &&
				bytes + next.frame.length > this.options.maxResponseBytes
			)
				break;
			device.queue.shift();
			device.queuedBytes -= next.frame.length;
			out.push(next.frame);
			bytes += next.frame.length;
		}
		return concatFrames(out);
	}

	private enqueue(
		device: DeviceState,
		frame: Uint8Array,
		metadata: { applyStreamId?: number } = {},
	): void {
		device.queue.push({ frame, ...metadata });
		device.queuedBytes += frame.length;
		if (device.queuedBytes > this.options.maxQueueBytes) {
			this.log(
				"warn",
				`queue overflow for ${device.deviceId}, dropping ${device.streams.size} stream(s)`,
			);
			device.queue.length = 0;
			device.queuedBytes = 0;
			this.closeAllStreams(device, "queue_overflow");
			if (device.apply) {
				this.failConfigApply(
					device,
					device.apply,
					new ConfigApplyProtocolError("CONFIG Apply queue overflow"),
				);
			}
			return;
		}
		this.wake(device);
	}

	private removeQueuedApplyFrames(
		device: DeviceState,
		applyStreamId: number,
	): void {
		const retained: QueueEntry[] = [];
		let queuedBytes = 0;
		for (const entry of device.queue) {
			if (entry.applyStreamId === applyStreamId) continue;
			retained.push(entry);
			queuedBytes += entry.frame.length;
		}
		device.queue = retained;
		device.queuedBytes = queuedBytes;
	}

	private closeAllStreams(device: DeviceState, reason: string): void {
		for (const [id, handlers] of device.streams) {
			device.streams.delete(id);
			handlers.onClose(reason);
		}
	}

	private touch(deviceId: string, remoteAddress?: string): DeviceState {
		const existing = this.devices.get(deviceId);
		const device: DeviceState = existing ?? {
			deviceId,
			queue: [],
			queuedBytes: 0,
			streams: new Map(),
			commands: new Map(),
			nextStreamId: FIRST_STREAM_ID,
			lastSeenAt: new Date(this.now()),
			status: "unknown",
			observedSourceIp: remoteAddress,
		};
		device.lastSeenAt = new Date(this.now());
		device.observedSourceIp = remoteAddress ?? device.observedSourceIp;
		if (!existing) {
			this.devices.set(deviceId, device);
		} else {
			// 同一Deviceの古いlong-pollは、新しいsyncが来た時点で空応答で返す
			this.wake(device);
		}
		this.updateStatus(device);
		return device;
	}

	private updateStatus(device: DeviceState): void {
		const status = this.deriveStatus(device.lastSeenAt);
		if (status === device.status) return;
		device.status = status;
		this.config.onPresenceChange?.(this.toPresence(device));
	}

	private deriveStatus(lastSeenAt: Date): PresenceStatus {
		const age = this.now() - lastSeenAt.getTime();
		if (age <= this.options.onlineWithinMs) return "online";
		if (age <= this.options.unstableWithinMs) return "unstable";
		return "offline";
	}

	private toPresence(device: DeviceState): Presence {
		return {
			deviceId: device.deviceId,
			status: device.status,
			lastSeenAt: device.lastSeenAt,
			observedSourceIp: device.observedSourceIp,
		};
	}

	/**
	 * Presence(docs/core/data-model.md §5)。Gateway再起動直後など、観測が無い
	 * Deviceはunknownとする。
	 */
	presence(deviceId: string): Presence {
		const device = this.devices.get(deviceId);
		if (!device) return { deviceId, status: "unknown" };
		this.updateStatus(device);
		return this.toPresence(device);
	}

	/**
	 * 観測が途絶えたDeviceのstatusを再判定し、変化をonPresenceChangeへ通知する。
	 * syncが来ないDeviceはsyncを契機に判定できないため、呼び出し側が定期的に呼ぶ
	 * (Communityでは Routemon Server が一定間隔で呼ぶ)。
	 */
	sweepPresence(): void {
		for (const device of this.devices.values()) {
			this.updateStatus(device);
		}
	}

	observedDevices(): string[] {
		return [...this.devices.keys()];
	}

	/**
	 * Device上のAgentへstreamを開く(WebGUI relayの入口、#27)。
	 * 使用中のstream idは再利用しない。
	 */
	openStream(
		deviceId: string,
		initial: Uint8Array,
		handlers: StreamHandlers,
	): StreamHandle {
		const device = this.devices.get(deviceId);
		if (!device || this.deriveStatus(device.lastSeenAt) === "offline") {
			throw new DeviceNotConnectedError(`device not connected: ${deviceId}`);
		}
		const id = this.allocateStreamId(device);
		device.streams.set(id, handlers);
		this.enqueue(device, encodeFrame(FrameType.STREAM_OPEN, id, initial));
		return {
			id,
			send: (data: Uint8Array) => {
				if (!device.streams.has(id)) return;
				this.enqueue(device, encodeFrame(FrameType.STREAM_DATA, id, data));
			},
			close: () => {
				if (!device.streams.delete(id)) return;
				this.enqueue(device, encodeFrame(FrameType.STREAM_CLOSE, id));
			},
		};
	}

	/**
	 * Agentへcommandを送り、COMMAND_RESPONSEを待つ(docs/core/agent-protocol.md §7.3)。
	 * 対応付けにはStream IDと同じID空間を使い、使用中のIDは再利用しない。
	 * timeoutしても再送しない(重複実行を避けるため、§11)。
	 */
	sendCommand(
		deviceId: string,
		command: Uint8Array,
		options: { timeoutMs?: number } = {},
	): Promise<CommandResult> {
		const device = this.devices.get(deviceId);
		if (!device || this.deriveStatus(device.lastSeenAt) === "offline") {
			return Promise.reject(
				new DeviceNotConnectedError(`device not connected: ${deviceId}`),
			);
		}
		const id = this.allocateStreamId(device);
		const timeoutMs = options.timeoutMs ?? this.options.commandTimeoutMs;
		return new Promise<CommandResult>((resolve, reject) => {
			const timer = setTimeout(() => {
				device.commands.delete(id);
				reject(
					new CommandTimeoutError(`command timed out after ${timeoutMs}ms`),
				);
			}, timeoutMs);
			device.commands.set(id, { resolve, reject, timer });
			this.enqueue(device, encodeFrame(FrameType.COMMAND_REQUEST, id, command));
		});
	}

	/**
	 * Device単位のCONFIG Apply streamを開始する(#62、design §6.1 / §7.3)。
	 * BEGINだけを先にqueueへ入れ、Agentのreadyを受けてからchunkをwindow分送る。
	 */
	startConfigApply(
		deviceId: string,
		begin: ConfigApplyBegin,
		config: Uint8Array,
		handlers: ConfigApplyHandlers = {},
		options: ConfigApplyOptions = {},
	): ConfigApplyHandle {
		const device = this.devices.get(deviceId);
		if (!device || this.deriveStatus(device.lastSeenAt) === "offline") {
			throw new DeviceNotConnectedError(`device not connected: ${deviceId}`);
		}
		if (device.apply) {
			throw new ConfigApplyBusyError(
				`CONFIG Apply already exists for ${deviceId}`,
			);
		}
		if (!(config instanceof Uint8Array)) {
			throw new ConfigApplyError(
				"invalid_payload",
				"CONFIG Apply config must be Uint8Array",
			);
		}
		const applyOptions = this.normalizeConfigApplyOptions(options);
		const validator = new ConfigApplyTransferValidator(begin);
		const chunks: Uint8Array[] = [];
		for (
			let offset = 0, seq = 0;
			offset < config.length;
			offset += begin.chunkBytes, seq++
		) {
			const chunk = config.slice(offset, offset + begin.chunkBytes);
			chunks.push(chunk);
			validator.accept({ seq, bytes: chunk });
		}
		validator.finish({ totalBytes: config.length, chunkCount: chunks.length });

		const pending: PendingConfigApply = {
			id: this.allocateStreamId(device),
			begin,
			chunks,
			nextChunk: 0,
			inFlight: new Set(),
			phase: "awaiting_ready",
			windowSize: applyOptions.windowSize,
			ackTimeoutMs: applyOptions.ackTimeoutMs,
			maxRetries: applyOptions.maxRetries,
			retries: 0,
			handlers,
		};
		const handle: ConfigApplyHandle = {
			get id() {
				return pending.id;
			},
			activate: () => this.activateConfigApply(device, pending),
			abort: () => this.abortConfigApply(device, pending),
		};

		device.apply = pending;
		this.enqueueConfigApplyFrame(
			device,
			pending,
			FrameType.CONFIG_APPLY_BEGIN,
			encodeConfigApplyBeginPayload(begin),
		);
		this.armConfigApplyTimeout(device, pending);
		return handle;
	}

	/** Server-side APIからAgentへ任意のframeを送る(Command等、#25)。 */
	sendFrame(
		deviceId: string,
		type: number,
		streamId: number,
		payload?: Uint8Array,
	): void {
		const device = this.devices.get(deviceId);
		if (!device)
			throw new DeviceNotConnectedError(`device not connected: ${deviceId}`);
		this.enqueue(device, encodeFrame(type, streamId, payload));
	}

	private normalizeConfigApplyOptions(
		options: ConfigApplyOptions,
	): Required<ConfigApplyOptions> {
		const windowSize = options.windowSize ?? DEFAULT_CONFIG_APPLY_WINDOW_SIZE;
		const ackTimeoutMs =
			options.ackTimeoutMs ?? DEFAULT_CONFIG_APPLY_ACK_TIMEOUT_MS;
		const maxRetries = options.maxRetries ?? DEFAULT_CONFIG_APPLY_MAX_RETRIES;
		if (
			!Number.isInteger(windowSize) ||
			windowSize < 1 ||
			windowSize > MAX_CONFIG_APPLY_CHUNKS_PER_RESPONSE
		) {
			throw new ConfigApplyOptionsError(
				`windowSize must be between 1 and ${MAX_CONFIG_APPLY_CHUNKS_PER_RESPONSE}`,
			);
		}
		if (!Number.isInteger(ackTimeoutMs) || ackTimeoutMs <= 0) {
			throw new ConfigApplyOptionsError(
				"ackTimeoutMs must be a positive integer",
			);
		}
		if (!Number.isInteger(maxRetries) || maxRetries < 0) {
			throw new ConfigApplyOptionsError(
				"maxRetries must be a non-negative integer",
			);
		}
		return { windowSize, ackTimeoutMs, maxRetries };
	}

	private enqueueConfigApplyFrame(
		device: DeviceState,
		pending: PendingConfigApply,
		type: number,
		payload: Uint8Array,
	): void {
		this.enqueue(device, encodeFrame(type, pending.id, payload), {
			applyStreamId: pending.id,
		});
	}

	private handleConfigApplyResult(device: DeviceState, frame: Frame): void {
		const pending = device.apply;
		if (!pending || pending.id !== frame.streamId) {
			this.log("warn", `late CONFIG Apply result from ${device.deviceId}`);
			return;
		}

		let result: ConfigApplyResult;
		try {
			result = decodeConfigApplyResultPayload(frame.payload);
		} catch (error) {
			this.failConfigApply(
				device,
				pending,
				error instanceof Error
					? error
					: new ConfigApplyProtocolError("invalid CONFIG Apply result"),
			);
			return;
		}
		this.clearConfigApplyTimeout(pending);

		if (pending.phase === "awaiting_ready") {
			if (
				result.status !== "ready" ||
				result.seq !== undefined ||
				result.errorCode !== "none"
			) {
				pending.handlers.onResult?.(result);
				this.failConfigApply(
					device,
					pending,
					this.unexpectedConfigApplyResult(pending, result),
				);
				return;
			}
			pending.phase = "transferring";
			pending.handlers.onResult?.(result);
			this.fillConfigApplyWindow(device, pending);
			return;
		}

		if (pending.phase === "transferring") {
			if (
				result.status !== "chunk_ack" ||
				result.seq === undefined ||
				result.errorCode !== "none" ||
				!pending.inFlight.has(result.seq)
			) {
				pending.handlers.onResult?.(result);
				this.failConfigApply(
					device,
					pending,
					this.unexpectedConfigApplyResult(pending, result),
				);
				return;
			}
			pending.inFlight.delete(result.seq);
			pending.handlers.onResult?.(result);
			this.fillConfigApplyWindow(device, pending);
			return;
		}

		if (pending.phase === "awaiting_staged") {
			if (
				result.status !== "staged" ||
				result.seq !== undefined ||
				result.errorCode !== "none"
			) {
				pending.handlers.onResult?.(result);
				this.failConfigApply(
					device,
					pending,
					this.unexpectedConfigApplyResult(pending, result),
				);
				return;
			}
			pending.phase = "staged";
			pending.handlers.onResult?.(result);
			return;
		}

		if (pending.phase === "awaiting_activate") {
			pending.handlers.onResult?.(result);
			if (
				result.status === "loaded" &&
				result.seq === undefined &&
				result.errorCode === "none"
			) {
				this.completeConfigApply(device, pending);
				return;
			}
			this.failConfigApply(
				device,
				pending,
				this.unexpectedConfigApplyResult(pending, result),
			);
			return;
		}

		this.failConfigApply(
			device,
			pending,
			new ConfigApplyProtocolError(
				`unexpected CONFIG Apply result in ${pending.phase}`,
			),
		);
	}

	private unexpectedConfigApplyResult(
		pending: PendingConfigApply,
		result: ConfigApplyResult,
	): ConfigApplyProtocolError {
		return new ConfigApplyProtocolError(
			`unexpected CONFIG Apply result ${result.status}/${result.errorCode} in ${pending.phase}`,
		);
	}

	private fillConfigApplyWindow(
		device: DeviceState,
		pending: PendingConfigApply,
	): void {
		if (device.apply !== pending || pending.phase !== "transferring") return;
		while (
			pending.inFlight.size < pending.windowSize &&
			pending.nextChunk < pending.chunks.length
		) {
			const seq = pending.nextChunk;
			const bytes = pending.chunks[seq] as Uint8Array;
			pending.inFlight.add(seq);
			pending.nextChunk++;
			this.enqueueConfigApplyFrame(
				device,
				pending,
				FrameType.CONFIG_APPLY_CHUNK,
				encodeConfigApplyChunkPayload({ seq, bytes }),
			);
			if (device.apply !== pending) return;
		}

		if (pending.inFlight.size > 0) {
			this.armConfigApplyTimeout(device, pending);
			return;
		}
		pending.phase = "awaiting_staged";
		this.enqueueConfigApplyFrame(
			device,
			pending,
			FrameType.CONFIG_APPLY_END,
			encodeConfigApplyEndPayload({
				totalBytes: pending.begin.totalBytes,
				chunkCount: pending.chunks.length,
			}),
		);
		if (device.apply === pending) this.armConfigApplyTimeout(device, pending);
	}

	private activateConfigApply(
		device: DeviceState,
		pending: PendingConfigApply,
	): void {
		if (device.apply !== pending) return;
		if (pending.phase !== "staged") {
			throw new ConfigApplyProtocolError(
				`CONFIG Apply is not staged: ${pending.phase}`,
			);
		}
		pending.phase = "awaiting_activate";
		this.enqueueConfigApplyFrame(
			device,
			pending,
			FrameType.CONFIG_APPLY_ACTIVATE,
			encodeConfigApplyActivatePayload(),
		);
		if (device.apply === pending) this.armConfigApplyTimeout(device, pending);
	}

	private abortConfigApply(
		device: DeviceState,
		pending: PendingConfigApply,
	): void {
		if (device.apply !== pending) return;
		if (pending.phase === "awaiting_activate") {
			throw new ConfigApplyProtocolError(
				"CONFIG Apply cannot be aborted after ACTIVATE",
			);
		}
		this.clearConfigApplyTimeout(pending);
		this.removeQueuedApplyFrames(device, pending.id);
		pending.inFlight.clear();
		this.enqueueConfigApplyFrame(
			device,
			pending,
			FrameType.CONFIG_APPLY_ABORT,
			encodeConfigApplyAbortPayload(),
		);
		pending.phase = "done";
		device.apply = undefined;
	}

	private armConfigApplyTimeout(
		device: DeviceState,
		pending: PendingConfigApply,
	): void {
		this.clearConfigApplyTimeout(pending);
		pending.ackTimer = setTimeout(() => {
			if (device.apply !== pending) return;
			if (pending.phase === "awaiting_activate") {
				this.failConfigApply(
					device,
					pending,
					new ConfigApplyAckTimeoutError(
						"CONFIG_APPLY_ACTIVATE response timed out",
					),
				);
				return;
			}
			if (pending.retries >= pending.maxRetries) {
				this.failConfigApply(
					device,
					pending,
					new ConfigApplyAckTimeoutError(
						`CONFIG Apply ACK timed out after ${pending.retries} retries`,
					),
				);
				return;
			}
			pending.retries++;
			this.reinitializeConfigApply(device, pending);
		}, pending.ackTimeoutMs);
	}

	private reinitializeConfigApply(
		device: DeviceState,
		pending: PendingConfigApply,
	): void {
		const previousId = pending.id;
		this.removeQueuedApplyFrames(device, previousId);
		let nextId: number;
		try {
			nextId = this.allocateStreamId(device);
		} catch (error) {
			this.failConfigApply(
				device,
				pending,
				error instanceof Error
					? error
					: new ConfigApplyProtocolError("no free Apply stream ID"),
			);
			return;
		}
		pending.id = nextId;
		pending.nextChunk = 0;
		pending.inFlight.clear();
		pending.phase = "awaiting_ready";
		this.enqueueConfigApplyFrame(
			device,
			pending,
			FrameType.CONFIG_APPLY_BEGIN,
			encodeConfigApplyBeginPayload(pending.begin),
		);
		if (device.apply === pending) this.armConfigApplyTimeout(device, pending);
	}

	private clearConfigApplyTimeout(pending: PendingConfigApply): void {
		if (pending.ackTimer !== undefined) clearTimeout(pending.ackTimer);
		pending.ackTimer = undefined;
	}

	private failConfigApply(
		device: DeviceState,
		pending: PendingConfigApply,
		error: Error,
	): void {
		if (device.apply !== pending) return;
		this.clearConfigApplyTimeout(pending);
		this.removeQueuedApplyFrames(device, pending.id);
		pending.phase = "failed";
		device.apply = undefined;
		pending.handlers.onError?.(error);
	}

	private completeConfigApply(
		device: DeviceState,
		pending: PendingConfigApply,
	): void {
		if (device.apply !== pending) return;
		this.clearConfigApplyTimeout(pending);
		pending.phase = "done";
		device.apply = undefined;
	}

	private allocateStreamId(device: DeviceState): number {
		for (let i = 0; i <= MAX_STREAM_ID - FIRST_STREAM_ID; i++) {
			const id = device.nextStreamId;
			device.nextStreamId = id >= MAX_STREAM_ID ? FIRST_STREAM_ID : id + 1;
			if (
				!device.streams.has(id) &&
				!device.commands.has(id) &&
				device.apply?.id !== id
			)
				return id;
		}
		throw new Error(`no free stream id for ${device.deviceId}`);
	}
}

function stripUndefined<T extends object>(value: T): Partial<T> {
	return Object.fromEntries(
		Object.entries(value).filter(([, v]) => v !== undefined),
	) as Partial<T>;
}

function bearerCredential(authorization?: string): string | null {
	if (!authorization) return null;
	const [scheme, ...rest] = authorization.trim().split(/\s+/);
	if (scheme?.toLowerCase() !== "bearer" || rest.length !== 1) return null;
	return rest[0] ?? null;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const encodeText = (text: string) => encoder.encode(text);
const decodeText = (data: Uint8Array) => decoder.decode(data);
const delay = (ms: number) =>
	new Promise<void>((resolve) => setTimeout(resolve, ms));
