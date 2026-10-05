/**
 * Job(Router操作の実行記録)と任意command実行(#25)。
 *
 * - 実行はAdminのみ(認可はroute側、docs/core/access-control-design.md §4)
 * - 実行の記録はJobとして残し、Viewerは履歴を閲覧できる
 * - timeoutしたcommandは再送しない(重複実行を避ける、docs/core/agent-protocol.md §11)
 */
import { randomUUID } from "node:crypto";
import {
	type AgentGateway,
	CommandTimeoutError,
	DeviceNotConnectedError,
} from "@routemon/gateway";
import { AuditEventType, type AuditLog } from "../auth/audit.ts";
import { type Db, nowIso } from "../storage/db.ts";

export type JobStatus =
	| "queued"
	| "running"
	| "success"
	| "failed"
	| "timeout"
	| "cancelled";

export type JobRow = {
	id: string;
	tenant_id: string;
	device_id: string;
	type: string;
	status: JobStatus;
	request: string | null;
	output: string | null;
	error: string | null;
	timeout_ms: number;
	requested_by_user_id: string | null;
	/** 予約実行の時刻(#54)。即時実行ならnull */
	scheduled_at: string | null;
	created_at: string;
	started_at: string | null;
	finished_at: string | null;
};

export class DeviceNotFoundError extends Error {}
export class InvalidScheduleError extends Error {}
export class JobNotFoundError extends Error {}
export class CommandNotAllowedError extends Error {}
export class DeviceOperationBusyError extends Error {}

export const DEFAULT_COMMAND_TIMEOUT_MS = 60_000;

/**
 * 既定の禁止command(#25の判断事項)。
 *
 * Routemon自身の管理経路を壊すものだけを既定で止める。権限としてはAdminがNative
 * WebGUIから同じ操作をできるため、これは誤操作の防止であり権限境界ではない。
 */
export const DEFAULT_DENIED_COMMANDS = [
	/^\s*terminate\s+lua\b/i,
	/^\s*no\s+schedule\s+at\b/i,
	/^\s*load\b/i,
	/^\s*save\b/i,
	/^\s*restart\b/i,
	/^\s*confirm\b/i,
	/^\s*rollback(?:[- ]timer)\b/i,
];

/**
 * 再起動要求の応答待ち(#54)。Routerが落ちるので応答は基本返らない。
 * 送れたことだけ確認できればよいので短くする。
 */
const REBOOT_ACK_TIMEOUT_MS = 5_000;

/** rt.command()のcommand長上限(docs/core/lua-api-notes.md) */
const MAX_COMMAND_LENGTH = 4095;

export type JobsOptions = {
	deniedCommands?: RegExp[];
	commandTimeoutMs?: number;
	/** 再起動要求の応答待ち(#54)。応答は基本返らないので短くてよい */
	rebootAckTimeoutMs?: number;
	now?: () => number;
};

export class Jobs {
	private readonly db: Db;
	private readonly tenantId: string;
	private readonly gateway: AgentGateway;
	private readonly audit: AuditLog;
	private readonly denied: RegExp[];
	private readonly timeoutMs: number;
	private readonly rebootAckTimeoutMs: number;
	private readonly now: () => number;

	constructor(
		db: Db,
		tenantId: string,
		gateway: AgentGateway,
		audit: AuditLog,
		options: JobsOptions = {},
	) {
		this.db = db;
		this.tenantId = tenantId;
		this.gateway = gateway;
		this.audit = audit;
		this.denied = options.deniedCommands ?? DEFAULT_DENIED_COMMANDS;
		this.timeoutMs = options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
		this.rebootAckTimeoutMs =
			options.rebootAckTimeoutMs ?? REBOOT_ACK_TIMEOUT_MS;
		this.now = options.now ?? Date.now;
	}

	isAllowed(command: string): boolean {
		return !this.denied.some((pattern) => pattern.test(command));
	}

	/** 任意CLI commandをJobとして実行する。 */
	async runCommand(input: {
		deviceId: string;
		command: string;
		userId: string;
	}): Promise<JobRow> {
		const command = input.command.trim();
		if (!command) throw new CommandNotAllowedError("command is empty");
		if (command.length > MAX_COMMAND_LENGTH) {
			throw new CommandNotAllowedError(
				`command must be ${MAX_COMMAND_LENGTH} characters or fewer`,
			);
		}
		if (!this.isAllowed(command)) {
			throw new CommandNotAllowedError("command is not allowed");
		}
		const device = this.db
			.prepare("SELECT id FROM devices WHERE id = ? AND tenant_id = ?")
			.get(input.deviceId, this.tenantId) as { id: string } | undefined;
		if (!device)
			throw new DeviceNotFoundError(`device not found: ${input.deviceId}`);

		const id = this.create({
			deviceId: input.deviceId,
			type: "command",
			request: command,
			userId: input.userId,
		});
		this.update(id, {
			status: "running",
			started_at: nowIso(new Date(this.now())),
		});
		this.audit.record({
			type: AuditEventType.COMMAND_EXECUTED,
			actorUserId: input.userId,
			targetType: "device",
			targetId: input.deviceId,
			detail: { job_id: id, command },
		});

		try {
			const result = await this.gateway.sendCommand(
				input.deviceId,
				new TextEncoder().encode(command),
				{
					timeoutMs: this.timeoutMs,
				},
			);
			// rt.command()の出力はShift_JIS(docs/core/lua-api-notes.md)
			const output = new TextDecoder("shift_jis").decode(result.output);
			this.update(id, {
				status: result.success ? "success" : "failed",
				output,
				finished_at: nowIso(new Date(this.now())),
			});
		} catch (error) {
			const timedOut = error instanceof CommandTimeoutError;
			if (!timedOut && !(error instanceof DeviceNotConnectedError)) throw error;
			this.update(id, {
				status: timedOut ? "timeout" : "failed",
				error: (error as Error).message,
				finished_at: nowIso(new Date(this.now())),
			});
		}
		return this.get(id) as JobRow;
	}

	/**
	 * 動作中CONFIGを保存する単独操作。saveの成功応答だけではCONFIG0への保存を
	 * 確定できないため、CONFIG_SAVED SYSLOGはConfigApplyService側で検知する。
	 */
	async save(input: {
		deviceId: string;
		userId: string;
		applyId?: string;
		batchId?: string;
		batchItemId?: string;
		onCreated?: (jobId: string) => void;
	}): Promise<JobRow> {
		this.requireDevice(input.deviceId);
		this.assertDeviceWriteAvailable(input.deviceId);
		const id = this.create({
			deviceId: input.deviceId,
			type: "config_save",
			request: "save",
			userId: input.userId,
		});
		input.onCreated?.(id);
		this.audit.record({
			type: AuditEventType.CONFIG_SAVE_REQUESTED,
			actorUserId: input.userId,
			targetType: "device",
			targetId: input.deviceId,
			detail: {
				job_id: id,
				...(input.applyId ? { apply_id: input.applyId } : {}),
				...(input.batchId ? { batch_id: input.batchId } : {}),
				...(input.batchItemId ? { batch_item_id: input.batchItemId } : {}),
			},
		});
		this.update(id, {
			status: "running",
			started_at: nowIso(new Date(this.now())),
		});

		try {
			const result = await this.gateway.sendCommand(
				input.deviceId,
				new TextEncoder().encode("save"),
				{ timeoutMs: this.timeoutMs },
			);
			const output = new TextDecoder("shift_jis").decode(result.output);
			this.update(id, {
				status: result.success ? "success" : "failed",
				output,
				finished_at: nowIso(new Date(this.now())),
			});
			if (!result.success) {
				this.audit.record({
					type: AuditEventType.CONFIG_SAVE_FAILED,
					actorUserId: input.userId,
					targetType: "device",
					targetId: input.deviceId,
					detail: {
						job_id: id,
						...(input.applyId ? { apply_id: input.applyId } : {}),
						...(input.batchId ? { batch_id: input.batchId } : {}),
						...(input.batchItemId ? { batch_item_id: input.batchItemId } : {}),
						reason: "command_failed",
					},
				});
			}
		} catch (error) {
			const timedOut = error instanceof CommandTimeoutError;
			if (!timedOut && !(error instanceof DeviceNotConnectedError)) throw error;
			this.update(id, {
				status: timedOut ? "timeout" : "failed",
				error: (error as Error).message,
				finished_at: nowIso(new Date(this.now())),
			});
			this.audit.record({
				type: AuditEventType.CONFIG_SAVE_FAILED,
				actorUserId: input.userId,
				targetType: "device",
				targetId: input.deviceId,
				detail: {
					job_id: id,
					...(input.applyId ? { apply_id: input.applyId } : {}),
					...(input.batchId ? { batch_id: input.batchId } : {}),
					...(input.batchItemId ? { batch_item_id: input.batchItemId } : {}),
					reason: timedOut ? "timeout" : "not_connected",
				},
			});
		}
		return this.get(id) as JobRow;
	}

	/**
	 * Deviceを再起動する(#54)。
	 *
	 * `restart`はRouterが落ちるため応答が返らない。これは正常系なので、
	 * timeoutを失敗として記録しない。未保存の設定を残すかどうかは呼び出し側が決める。
	 */
	async reboot(input: {
		deviceId: string;
		userId: string;
		/** trueなら再起動前に`save`する(未保存の設定を残す) */
		save?: boolean;
	}): Promise<JobRow> {
		this.requireDevice(input.deviceId);
		this.assertDeviceWriteAvailable(input.deviceId);
		const id = this.create({
			deviceId: input.deviceId,
			type: "reboot",
			request: input.save ? "save + restart" : "restart",
			userId: input.userId,
		});
		this.audit.record({
			type: AuditEventType.DEVICE_REBOOT_REQUESTED,
			actorUserId: input.userId,
			targetType: "device",
			targetId: input.deviceId,
			detail: { job_id: id, save: input.save === true },
		});
		return this.runReboot(id, input.deviceId, input.save === true);
	}

	/** 予約した再起動を登録する(#54)。実行はrunDue()が行う。 */
	scheduleReboot(input: {
		deviceId: string;
		userId: string;
		save?: boolean;
		/** 実行時刻。過去は受け付けない */
		at: Date;
	}): JobRow {
		this.requireDevice(input.deviceId);
		this.assertDeviceWriteAvailable(input.deviceId);
		if (input.at.getTime() <= this.now()) {
			throw new InvalidScheduleError("scheduled time must be in the future");
		}
		const id = this.create({
			deviceId: input.deviceId,
			type: "reboot",
			request: input.save ? "save + restart" : "restart",
			userId: input.userId,
			scheduledAt: nowIso(input.at),
		});
		this.audit.record({
			type: AuditEventType.DEVICE_REBOOT_SCHEDULED,
			actorUserId: input.userId,
			targetType: "device",
			targetId: input.deviceId,
			detail: {
				job_id: id,
				save: input.save === true,
				scheduled_at: nowIso(input.at),
			},
		});
		return this.get(id) as JobRow;
	}

	/** 予約を取り消す。実行済みのJobは取り消せない。 */
	cancelScheduled(jobId: string, userId: string): JobRow {
		const job = this.get(jobId);
		if (!job?.scheduled_at) throw new JobNotFoundError(jobId);
		if (job.status !== "queued") {
			throw new InvalidScheduleError("job is not pending");
		}
		this.update(jobId, {
			status: "cancelled",
			finished_at: nowIso(new Date(this.now())),
		});
		this.audit.record({
			type: AuditEventType.DEVICE_REBOOT_CANCELLED,
			actorUserId: userId,
			targetType: "device",
			targetId: job.device_id,
			detail: { job_id: jobId, scheduled_at: job.scheduled_at },
		});
		return this.get(jobId) as JobRow;
	}

	/** 予約中のJob(未実行)。 */
	pending(deviceId?: string): JobRow[] {
		if (deviceId) {
			return this.db
				.prepare(
					"SELECT * FROM jobs WHERE tenant_id = ? AND device_id = ? AND status = 'queued' AND scheduled_at IS NOT NULL ORDER BY scheduled_at",
				)
				.all(this.tenantId, deviceId) as JobRow[];
		}
		return this.db
			.prepare(
				"SELECT * FROM jobs WHERE tenant_id = ? AND status = 'queued' AND scheduled_at IS NOT NULL ORDER BY scheduled_at",
			)
			.all(this.tenantId) as JobRow[];
	}

	/** 時刻が来た予約を実行する。定期的に呼ぶ(#54)。 */
	async runDue(): Promise<JobRow[]> {
		const due = this.db
			.prepare(
				"SELECT * FROM jobs WHERE tenant_id = ? AND status = 'queued' AND scheduled_at IS NOT NULL AND scheduled_at <= ? ORDER BY scheduled_at",
			)
			.all(this.tenantId, nowIso(new Date(this.now()))) as JobRow[];
		const done: JobRow[] = [];
		for (const job of due) {
			this.audit.record({
				type: AuditEventType.DEVICE_REBOOT_REQUESTED,
				actorUserId: job.requested_by_user_id ?? undefined,
				targetType: "device",
				targetId: job.device_id,
				detail: { job_id: job.id, scheduled_at: job.scheduled_at },
			});
			done.push(
				await this.runReboot(
					job.id,
					job.device_id,
					job.request === "save + restart",
				),
			);
		}
		return done;
	}

	private async runReboot(
		id: string,
		deviceId: string,
		save: boolean,
	): Promise<JobRow> {
		this.update(id, {
			status: "running",
			started_at: nowIso(new Date(this.now())),
		});

		try {
			if (save) {
				// saveは応答が返る。失敗したら再起動しない(設定を失わせないため)
				const saved = await this.gateway.sendCommand(
					deviceId,
					new TextEncoder().encode("save"),
					{ timeoutMs: this.timeoutMs },
				);
				if (!saved.success) {
					this.update(id, {
						status: "failed",
						output: new TextDecoder("shift_jis").decode(saved.output),
						error: "save failed",
						finished_at: nowIso(new Date(this.now())),
					});
					return this.get(id) as JobRow;
				}
			}
			await this.gateway.sendCommand(
				deviceId,
				new TextEncoder().encode("restart"),
				{ timeoutMs: this.rebootAckTimeoutMs },
			);
			// 応答が返ってきた場合も、再起動は始まっているものとして扱う
			this.update(id, {
				status: "success",
				finished_at: nowIso(new Date(this.now())),
			});
		} catch (error) {
			if (error instanceof CommandTimeoutError) {
				// Routerが落ちて応答が返らないのが正常系
				this.update(id, {
					status: "success",
					finished_at: nowIso(new Date(this.now())),
				});
			} else if (error instanceof DeviceNotConnectedError) {
				this.update(id, {
					status: "failed",
					error: (error as Error).message,
					finished_at: nowIso(new Date(this.now())),
				});
				throw error;
			} else {
				throw error;
			}
		}
		return this.get(id) as JobRow;
	}

	private requireDevice(deviceId: string): void {
		const device = this.db
			.prepare("SELECT id FROM devices WHERE id = ? AND tenant_id = ?")
			.get(deviceId, this.tenantId) as { id: string } | undefined;
		if (!device) throw new DeviceNotFoundError(`device not found: ${deviceId}`);
	}

	private assertDeviceWriteAvailable(deviceId: string): void {
		const activeApply = this.db
			.prepare(
				`SELECT 1 FROM config_applies
				 WHERE tenant_id = ? AND device_id = ?
				   AND phase IN ('prepare', 'confirm', 'transfer', 'activate', 'verify')
				 LIMIT 1`,
			)
			.get(this.tenantId, deviceId);
		const activeJob = this.db
			.prepare(
				`SELECT 1 FROM jobs
				 WHERE tenant_id = ? AND device_id = ?
				   AND type IN ('config_save', 'reboot')
				   AND status IN ('queued', 'running')
				 LIMIT 1`,
			)
			.get(this.tenantId, deviceId);
		if (activeApply || activeJob) {
			throw new DeviceOperationBusyError(
				`device write operation is already in progress for ${deviceId}`,
			);
		}
	}

	private create(input: {
		deviceId: string;
		type: string;
		request: string;
		userId: string;
		scheduledAt?: string;
	}): string {
		const id = randomUUID();
		this.db
			.prepare(
				`INSERT INTO jobs (id, tenant_id, device_id, type, status, request, timeout_ms, requested_by_user_id, created_at, scheduled_at)
				 VALUES (?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?)`,
			)
			.run(
				id,
				this.tenantId,
				input.deviceId,
				input.type,
				input.request,
				this.timeoutMs,
				input.userId,
				nowIso(new Date(this.now())),
				input.scheduledAt ?? null,
			);
		return id;
	}

	private update(
		id: string,
		fields: Partial<
			Pick<JobRow, "status" | "output" | "error" | "started_at" | "finished_at">
		>,
	): void {
		const entries = Object.entries(fields);
		if (entries.length === 0) return;
		const set = entries.map(([key]) => `${key} = ?`).join(", ");
		this.db
			.prepare(`UPDATE jobs SET ${set} WHERE id = ?`)
			.run(...entries.map(([, value]) => value ?? null), id);
	}

	get(id: string): JobRow | undefined {
		return this.db
			.prepare("SELECT * FROM jobs WHERE id = ? AND tenant_id = ?")
			.get(id, this.tenantId) as JobRow | undefined;
	}

	list(options: { deviceId?: string; limit?: number } = {}): JobRow[] {
		const limit = Math.min(options.limit ?? 50, 200);
		if (options.deviceId) {
			return this.db
				.prepare(
					"SELECT * FROM jobs WHERE tenant_id = ? AND device_id = ? ORDER BY created_at DESC, id DESC LIMIT ?",
				)
				.all(this.tenantId, options.deviceId, limit) as JobRow[];
		}
		return this.db
			.prepare(
				"SELECT * FROM jobs WHERE tenant_id = ? ORDER BY created_at DESC, id DESC LIMIT ?",
			)
			.all(this.tenantId, limit) as JobRow[];
	}
}
