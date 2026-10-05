/**
 * CONFIG Apply専用frameのpayload(#62、docs/core/config-restore-design.md §6)。
 *
 * frame headerはframes.tsが扱い、ここではpayloadだけを扱う。整数はすべて
 * big-endian。CONFIG本文はShift_JISを含むraw byte列なので、文字列へ変換しない。
 */

export const CONFIG_APPLY_OPERATION_ID_BYTES = 16;
export const CONFIG_APPLY_SHA256_BYTES = 32;
export const MAX_CONFIG_APPLY_CHUNK_PAYLOAD_BYTES = 32 * 1024;
export const CONFIG_APPLY_CHUNK_SEQUENCE_BYTES = 4;
/** raw CONFIG bytesの上限。CHUNK payloadのseq 4 byteを除く。 */
export const MAX_CONFIG_APPLY_CHUNK_BYTES =
	MAX_CONFIG_APPLY_CHUNK_PAYLOAD_BYTES - CONFIG_APPLY_CHUNK_SEQUENCE_BYTES;
export const CONFIG_APPLY_BEGIN_PAYLOAD_LENGTH =
	CONFIG_APPLY_OPERATION_ID_BYTES + 4 + 2 + CONFIG_APPLY_SHA256_BYTES;
export const CONFIG_APPLY_END_PAYLOAD_LENGTH = 8;
export const CONFIG_APPLY_RESULT_PAYLOAD_LENGTH = 6;

const UINT32_MAX = 0xffffffff;
const RESULT_SEQ_NOT_APPLICABLE = UINT32_MAX;

export const CONFIG_APPLY_RESULT_STATUS_CODES = {
	ready: 0x01,
	chunk_ack: 0x02,
	staged: 0x03,
	loaded: 0x04,
	write_failed: 0x05,
	load_failed: 0x06,
	busy: 0x07,
	invalid: 0x08,
} as const;

export type ConfigApplyResultStatus =
	keyof typeof CONFIG_APPLY_RESULT_STATUS_CODES;

export const CONFIG_APPLY_ERROR_CODES = {
	none: 0x00,
	invalid_payload: 0x01,
	invalid_sequence: 0x02,
	chunk_too_large: 0x03,
	byte_count_mismatch: 0x04,
	chunk_count_mismatch: 0x05,
	busy: 0x06,
	file_open_failed: 0x07,
	file_write_failed: 0x08,
	file_close_failed: 0x09,
	load_failed: 0x0a,
	not_staged: 0x0b,
	already_activated: 0x0c,
	aborted: 0x0d,
	unknown: 0xff,
} as const;

export type ConfigApplyErrorCode = keyof typeof CONFIG_APPLY_ERROR_CODES;

export type ConfigApplyBegin = {
	operationId: Uint8Array;
	totalBytes: number;
	chunkBytes: number;
	targetSha256: Uint8Array;
};

export type ConfigApplyChunk = {
	seq: number;
	bytes: Uint8Array;
};

export type ConfigApplyEnd = {
	totalBytes: number;
	chunkCount: number;
};

export type ConfigApplyResult = {
	status: ConfigApplyResultStatus;
	/** chunk ACKのseq。chunk以外の結果では省略する。 */
	seq?: number;
	errorCode: ConfigApplyErrorCode;
};

export class ConfigApplyError extends Error {
	readonly code: ConfigApplyErrorCode;

	constructor(code: ConfigApplyErrorCode, message: string) {
		super(message);
		this.name = "ConfigApplyError";
		this.code = code;
	}
}

function invalidPayload(message: string): never {
	throw new ConfigApplyError("invalid_payload", message);
}

function assertBytes(value: Uint8Array, length: number, field: string): void {
	if (!(value instanceof Uint8Array) || value.length !== length) {
		invalidPayload(`${field} must be ${length} bytes`);
	}
}

function assertUint(value: number, max: number, field: string): void {
	if (!Number.isInteger(value) || value < 0 || value > max) {
		invalidPayload(`${field} must be an unsigned integer <= ${max}`);
	}
}

function assertPayloadLength(
	payload: Uint8Array,
	expected: number,
	field: string,
): void {
	if (payload.length !== expected) {
		invalidPayload(`${field} payload must be ${expected} bytes`);
	}
}

function readView(payload: Uint8Array): DataView {
	return new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
}

function codeFor<T extends string>(
	codes: Readonly<Record<T, number>>,
	value: T,
	field: string,
): number {
	const code = codes[value];
	if (code === undefined) invalidPayload(`unknown ${field}: ${value}`);
	return code;
}

function nameForCode<T extends string>(
	codes: Readonly<Record<T, number>>,
	code: number,
	field: string,
): T {
	for (const name of Object.keys(codes) as T[]) {
		if (codes[name] === code) return name;
	}
	invalidPayload(`unknown ${field} code: ${code}`);
}

function validateBegin(begin: ConfigApplyBegin): void {
	assertBytes(
		begin.operationId,
		CONFIG_APPLY_OPERATION_ID_BYTES,
		"operationId",
	);
	assertUint(begin.totalBytes, UINT32_MAX, "totalBytes");
	if (begin.totalBytes === 0) {
		invalidPayload("totalBytes must be greater than zero");
	}
	assertUint(begin.chunkBytes, MAX_CONFIG_APPLY_CHUNK_BYTES, "chunkBytes");
	if (begin.chunkBytes === 0) {
		invalidPayload("chunkBytes must be greater than zero");
	}
	assertBytes(begin.targetSha256, CONFIG_APPLY_SHA256_BYTES, "targetSha256");
}

export function encodeConfigApplyBeginPayload(
	begin: ConfigApplyBegin,
): Uint8Array {
	validateBegin(begin);
	const payload = new Uint8Array(CONFIG_APPLY_BEGIN_PAYLOAD_LENGTH);
	const view = readView(payload);
	payload.set(begin.operationId, 0);
	view.setUint32(16, begin.totalBytes);
	view.setUint16(20, begin.chunkBytes);
	payload.set(begin.targetSha256, 22);
	return payload;
}

export function decodeConfigApplyBeginPayload(
	payload: Uint8Array,
): ConfigApplyBegin {
	assertPayloadLength(
		payload,
		CONFIG_APPLY_BEGIN_PAYLOAD_LENGTH,
		"CONFIG_APPLY_BEGIN",
	);
	const view = readView(payload);
	const begin: ConfigApplyBegin = {
		operationId: payload.slice(0, 16),
		totalBytes: view.getUint32(16),
		chunkBytes: view.getUint16(20),
		targetSha256: payload.slice(22, 54),
	};
	validateBegin(begin);
	return begin;
}

export function encodeConfigApplyChunkPayload(
	chunk: ConfigApplyChunk,
): Uint8Array {
	assertUint(chunk.seq, UINT32_MAX, "seq");
	if (!(chunk.bytes instanceof Uint8Array) || chunk.bytes.length === 0) {
		invalidPayload("chunk bytes must not be empty");
	}
	if (chunk.bytes.length > MAX_CONFIG_APPLY_CHUNK_BYTES) {
		throw new ConfigApplyError(
			"chunk_too_large",
			`chunk bytes must be <= ${MAX_CONFIG_APPLY_CHUNK_BYTES}`,
		);
	}
	const payload = new Uint8Array(4 + chunk.bytes.length);
	readView(payload).setUint32(0, chunk.seq);
	payload.set(chunk.bytes, 4);
	return payload;
}

export function decodeConfigApplyChunkPayload(
	payload: Uint8Array,
): ConfigApplyChunk {
	if (payload.length < 5) {
		invalidPayload("CONFIG_APPLY_CHUNK payload must include seq and bytes");
	}
	if (payload.length > MAX_CONFIG_APPLY_CHUNK_PAYLOAD_BYTES) {
		throw new ConfigApplyError(
			"chunk_too_large",
			`chunk payload must be <= ${MAX_CONFIG_APPLY_CHUNK_PAYLOAD_BYTES}`,
		);
	}
	return {
		seq: readView(payload).getUint32(0),
		bytes: payload.slice(4),
	};
}

export function encodeConfigApplyEndPayload(end: ConfigApplyEnd): Uint8Array {
	assertUint(end.totalBytes, UINT32_MAX, "totalBytes");
	assertUint(end.chunkCount, UINT32_MAX, "chunkCount");
	const payload = new Uint8Array(CONFIG_APPLY_END_PAYLOAD_LENGTH);
	const view = readView(payload);
	view.setUint32(0, end.totalBytes);
	view.setUint32(4, end.chunkCount);
	return payload;
}

export function decodeConfigApplyEndPayload(
	payload: Uint8Array,
): ConfigApplyEnd {
	assertPayloadLength(
		payload,
		CONFIG_APPLY_END_PAYLOAD_LENGTH,
		"CONFIG_APPLY_END",
	);
	const view = readView(payload);
	return {
		totalBytes: view.getUint32(0),
		chunkCount: view.getUint32(4),
	};
}

function encodeEmptyPayload(): Uint8Array {
	return new Uint8Array(0);
}

function decodeEmptyPayload(payload: Uint8Array, name: string): void {
	if (payload.length !== 0) {
		invalidPayload(`${name} payload must be empty`);
	}
}

export function encodeConfigApplyActivatePayload(): Uint8Array {
	return encodeEmptyPayload();
}

export function decodeConfigApplyActivatePayload(payload: Uint8Array): void {
	decodeEmptyPayload(payload, "CONFIG_APPLY_ACTIVATE");
}

export function encodeConfigApplyAbortPayload(): Uint8Array {
	return encodeEmptyPayload();
}

export function decodeConfigApplyAbortPayload(payload: Uint8Array): void {
	decodeEmptyPayload(payload, "CONFIG_APPLY_ABORT");
}

export function encodeConfigApplyResultPayload(
	result: ConfigApplyResult,
): Uint8Array {
	const statusCode = codeFor(
		CONFIG_APPLY_RESULT_STATUS_CODES,
		result.status,
		"status",
	);
	const errorCode = codeFor(
		CONFIG_APPLY_ERROR_CODES,
		result.errorCode,
		"error code",
	);
	if (result.seq !== undefined) {
		assertUint(result.seq, UINT32_MAX - 1, "seq");
	}
	const payload = new Uint8Array(CONFIG_APPLY_RESULT_PAYLOAD_LENGTH);
	const view = readView(payload);
	payload[0] = statusCode;
	view.setUint32(1, result.seq ?? RESULT_SEQ_NOT_APPLICABLE);
	payload[5] = errorCode;
	return payload;
}

export function decodeConfigApplyResultPayload(
	payload: Uint8Array,
): ConfigApplyResult {
	assertPayloadLength(
		payload,
		CONFIG_APPLY_RESULT_PAYLOAD_LENGTH,
		"CONFIG_APPLY_RESULT",
	);
	const view = readView(payload);
	const seq = view.getUint32(1);
	return {
		status: nameForCode(
			CONFIG_APPLY_RESULT_STATUS_CODES,
			payload[0] as number,
			"status",
		),
		seq: seq === RESULT_SEQ_NOT_APPLICABLE ? undefined : seq,
		errorCode: nameForCode(
			CONFIG_APPLY_ERROR_CODES,
			payload[5] as number,
			"error code",
		),
	};
}

/**
 * CHUNKをsync responseの境界をまたいで検査する状態機械。
 * seqは0から連続している必要があり、同じseqの再送や欠落を受け付けない。
 */
export class ConfigApplyTransferValidator {
	private readonly expectedTotalBytes: number;
	private readonly maxChunkBytes: number;
	private nextSeq = 0;
	private receivedBytes = 0;
	private receivedChunks = 0;
	private finished = false;

	constructor(begin: ConfigApplyBegin) {
		validateBegin(begin);
		this.expectedTotalBytes = begin.totalBytes;
		this.maxChunkBytes = begin.chunkBytes;
	}

	accept(chunk: ConfigApplyChunk): void {
		if (this.finished) {
			invalidPayload("cannot accept a chunk after END");
		}
		assertUint(chunk.seq, UINT32_MAX, "seq");
		if (chunk.seq !== this.nextSeq) {
			throw new ConfigApplyError(
				"invalid_sequence",
				`expected seq ${this.nextSeq}, got ${chunk.seq}`,
			);
		}
		if (!(chunk.bytes instanceof Uint8Array) || chunk.bytes.length === 0) {
			invalidPayload("chunk bytes must not be empty");
		}
		if (chunk.bytes.length > MAX_CONFIG_APPLY_CHUNK_BYTES) {
			throw new ConfigApplyError(
				"chunk_too_large",
				`chunk bytes must be <= ${MAX_CONFIG_APPLY_CHUNK_BYTES}`,
			);
		}
		if (chunk.bytes.length > this.maxChunkBytes) {
			throw new ConfigApplyError(
				"chunk_too_large",
				`chunk bytes must be <= declared chunkBytes ${this.maxChunkBytes}`,
			);
		}
		if (this.receivedBytes + chunk.bytes.length > this.expectedTotalBytes) {
			throw new ConfigApplyError(
				"byte_count_mismatch",
				"received bytes exceed begin totalBytes",
			);
		}
		this.receivedBytes += chunk.bytes.length;
		this.receivedChunks++;
		this.nextSeq++;
	}

	finish(end: ConfigApplyEnd): void {
		if (this.finished) {
			invalidPayload("END was already accepted");
		}
		assertUint(end.totalBytes, UINT32_MAX, "totalBytes");
		assertUint(end.chunkCount, UINT32_MAX, "chunkCount");
		if (this.receivedBytes !== this.expectedTotalBytes) {
			throw new ConfigApplyError(
				"byte_count_mismatch",
				`received ${this.receivedBytes} bytes, expected ${this.expectedTotalBytes}`,
			);
		}
		if (end.totalBytes !== this.expectedTotalBytes) {
			throw new ConfigApplyError(
				"byte_count_mismatch",
				`END totalBytes ${end.totalBytes} does not match BEGIN totalBytes ${this.expectedTotalBytes}`,
			);
		}
		if (end.chunkCount !== this.receivedChunks) {
			throw new ConfigApplyError(
				"chunk_count_mismatch",
				`received ${this.receivedChunks} chunks, expected ${end.chunkCount}`,
			);
		}
		this.finished = true;
	}
}

export function validateConfigApplyTransfer(
	begin: ConfigApplyBegin,
	chunks: readonly ConfigApplyChunk[],
	end: ConfigApplyEnd,
): void {
	const validator = new ConfigApplyTransferValidator(begin);
	for (const chunk of chunks) validator.accept(chunk);
	validator.finish(end);
}
