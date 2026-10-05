/**
 * 一括適用(Batch)のGUI(#120)。
 *
 * 対象選択 → 準備(読み取りのみ) → 計画の確認1回 → 順次実行 → 結果の流れを
 * 画面から追えるようにする。状態の正本はServerで、GUIは返す値をそのまま
 * 反映するだけ(独自の状態機械を持たない)。
 *
 * やってはいけないこと(詳細設計 6 章): 再試行・自動継続・適用済みの自動復旧の
 * 導線を出さない。apply_verify一致前・CONFIG_SAVED SYSLOG受信前を「成功」
 * 「保存確認済み」と表示しない。Viewerには何も出さない(App.tsxでAdmin限定)。
 */
import { Fragment, useEffect, useMemo, useState } from "react";
import {
	api,
	type ConfigApplyBatch,
	type ConfigApplyBatchItem,
	type ConfigApplyBatchItemStatus,
	type ConfigApplyBatchStatus,
	type ConfigBackup,
	type ConfigCheckpoint,
	type Device,
	type User,
} from "../api.ts";
import {
	Badge,
	Card,
	Empty,
	formatTime,
	Loading,
	Notice,
	PresenceBadge,
	RISK_LABEL,
} from "../ui.tsx";

const MAX_BATCH_DEVICES = 50;
const POLL_INTERVAL_MS = 3000;

export type BatchItemGroup = "applied" | "notApplied" | "unconfirmed";

/**
 * 停止後の3群分け。Serverが付けたapplyEffectだけを見る。
 * confirmed=適用確認済み、unknown=適用結果未確認(設定が変わっている可能性)、
 * それ以外(not_applied / 未確定)=未適用。load開始後の失敗を未適用へ混ぜない。
 */
export function classifyBatchItem(item: ConfigApplyBatchItem): BatchItemGroup {
	if (item.applyEffect === "confirmed") return "applied";
	if (item.applyEffect === "unknown") return "unconfirmed";
	return "notApplied";
}

export function isBatchActive(batch: ConfigApplyBatch): boolean {
	return (
		batch.status === "preparing" ||
		batch.status === "awaiting_confirmation" ||
		batch.status === "running" ||
		batch.status === "stopping"
	);
}

export function summarizeBatch(batch: ConfigApplyBatch): {
	done: number;
	total: number;
	applied: number;
	notApplied: number;
	unconfirmed: number;
} {
	const terminal: ConfigApplyBatchItemStatus[] = [
		"applied",
		"failed",
		"skipped",
		"no_change",
		"excluded",
	];
	let done = 0;
	let applied = 0;
	let notApplied = 0;
	let unconfirmed = 0;
	for (const item of batch.items) {
		if (terminal.includes(item.status)) done += 1;
		const group = classifyBatchItem(item);
		if (group === "applied") applied += 1;
		else if (group === "unconfirmed") unconfirmed += 1;
		else notApplied += 1;
	}
	return { done, total: batch.items.length, applied, notApplied, unconfirmed };
}

const BATCH_STATUS: Record<
	ConfigApplyBatchStatus,
	{ label: string; tone: "ok" | "warn" | "danger" | "neutral" }
> = {
	preparing: { label: "準備中", tone: "warn" },
	awaiting_confirmation: { label: "確認待ち", tone: "warn" },
	running: { label: "実行中", tone: "warn" },
	stopping: { label: "停止中", tone: "warn" },
	stopped: { label: "停止", tone: "danger" },
	complete: { label: "完了", tone: "ok" },
};

const ITEM_STATUS: Record<
	ConfigApplyBatchItemStatus,
	{ label: string; tone: "ok" | "warn" | "danger" | "neutral" }
> = {
	preparing: { label: "準備中", tone: "warn" },
	prepared: { label: "準備済み", tone: "neutral" },
	no_change: { label: "差分なし", tone: "neutral" },
	excluded: { label: "対象外", tone: "neutral" },
	queued: { label: "待機中", tone: "neutral" },
	guarding: { label: "直前検査中", tone: "warn" },
	awaiting_confirmation: { label: "確認待ち", tone: "warn" },
	applying: { label: "適用中", tone: "warn" },
	applied: { label: "適用確認済み", tone: "ok" },
	failed: { label: "失敗", tone: "danger" },
	skipped: { label: "未開始", tone: "neutral" },
};

/** Serverの停止理由・失敗コードをそのまま出さず、意味を添える。未知のcodeはraw表示。 */
const FAILURE_LABEL: Record<string, string> = {
	prepare_request_failed: "準備の取得要求を送信できない",
	prepare_failed: "準備の取得に失敗",
	prepare_timeout: "準備の応答待ちがタイムアウト",
	target_invalid: "対象世代の検証に失敗",
	target_empty: "対象世代が空",
	target_too_large: "対象世代が大きすぎる",
	target_too_many_lines: "対象世代の行数が多すぎる",
	target_backup_unavailable: "対象世代を参照できない",
	device_offline: "Deviceがoffline",
	device_not_found: "Deviceが見つからない",
	device_not_active: "Deviceが有効でない",
	guard_request_failed: "直前検査の取得要求を送信できない",
	guard_timeout: "直前検査の応答待ちがタイムアウト",
	guard_snapshot_unavailable: "直前検査の世代を参照できない",
	prepared_config_changed: "準備時から設定が変わっている",
	apply_failed: "適用に失敗",
	apply_unavailable: "適用履歴を参照できない",
	apply_state_conflict: "適用状態の競合",
	verify_mismatch: "apply_verifyが一致しない",
	verify_unavailable: "apply_verifyを確認できない",
	verify_timeout: "apply_verifyの確認がタイムアウト",
	save_failed: "保存に失敗",
	save_confirmation_timeout: "保存の確認がタイムアウト",
	batch_stopped: "Batchの停止により未開始",
	admin_stopped: "Adminが停止",
	server_restarted: "Server再起動により停止",
	confirmation_expired: "確認期限(10分)が切れた",
	acknowledgement_required: "確認チェックが必要",
	request_failed: "要求を送信できない",
	response_timeout: "制限時間内に応答なし",
};

export function failureLabel(code: string | null): string {
	if (!code) return "";
	return FAILURE_LABEL[code] ?? code;
}

function saveResultLabel(
	item: ConfigApplyBatchItem,
	saveAfterApply: boolean,
): string | null {
	// 適用確認済み(apply_verify一致)のDeviceだけ保存結果を持つ。
	if (item.applyEffect !== "confirmed") return null;
	if (!saveAfterApply) return "未保存";
	switch (item.saveResult) {
		case "confirmed":
			return "保存確認済み";
		case "failed":
			return "保存失敗";
		case "unconfirmed":
			return "保存未確認";
		case "pending":
			return "保存待ち";
		default:
			return "保存未確認";
	}
}

/** WAN / PPPoEを壊すと遠隔から戻せないことの明示(計画確認と停止後に必須)。 */
function RecoveryScopeNotice() {
	return (
		<div className="config-risk" role="alert">
			<strong>⚠ 遠隔から戻せない条件があります</strong>
			<p>
				WAN / PPPoEを壊すCONFIGを適用すると、RouterがServerへ再接続できず、
				この一括適用では戻せません。復旧はRouterの再起動または現地対応になります。
				この機能が効くのは「保存まで通って確定した後に不具合へ気付いた」場合です。
			</p>
		</div>
	);
}

function apiMessage(cause: unknown): string {
	return cause instanceof Error
		? cause.message
		: "一括適用の処理に失敗しました";
}

function shortId(id: string): string {
	return id.length > 8 ? id.slice(0, 8) : id;
}

/** byte sizeの表示。上限と並べるため実測・上限とも同じ書式にする。 */
function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	return `${(bytes / 1024).toFixed(1)} KiB`;
}

export function BulkApplies({
	user,
	instanceName,
}: {
	user: User;
	instanceName: string | null;
}) {
	const [batches, setBatches] = useState<ConfigApplyBatch[] | null>(null);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		let active = true;
		void api
			.configApplyBatches()
			.then((result) => {
				if (active) setBatches(result.batches);
			})
			.catch((cause) => {
				if (active) setError(apiMessage(cause));
			});
		return () => {
			active = false;
		};
	}, []);

	return (
		<>
			<header className="topbar">
				<h1>一括適用</h1>
				{instanceName && <span className="topbar__meta">{instanceName}</span>}
			</header>
			<div className="content">
				{error && <Notice tone="error">{error}</Notice>}
				{user.role === "admin" && (
					<BulkApplyCreator
						onCreated={(batch) => {
							setBatches((current) => [
								batch,
								...(current ?? []).filter((item) => item.id !== batch.id),
							]);
							location.hash = `#/bulk-applies/${encodeURIComponent(batch.id)}`;
						}}
					/>
				)}
				<Card title="一括適用の履歴">
					{batches === null ? (
						<Loading />
					) : batches.length === 0 ? (
						<Empty title="一括適用はありません" />
					) : (
						<div className="table-wrap">
							<table>
								<thead>
									<tr>
										<th>作成</th>
										<th>対象</th>
										<th>状態</th>
										<th>進捗</th>
										<th>停止理由</th>
										<th>操作</th>
									</tr>
								</thead>
								<tbody>
									{batches.map((batch) => {
										const status = BATCH_STATUS[batch.status];
										const summary = summarizeBatch(batch);
										return (
											<tr key={batch.id}>
												<td>{formatTime(batch.createdAt)}</td>
												<td className="cell-strong">
													{batch.source === "checkpoint"
														? (batch.sourceCheckpointName ?? "checkpoint")
														: "Device個別指定"}{" "}
													({batch.items.length}台)
												</td>
												<td>
													<Badge tone={status.tone}>{status.label}</Badge>
												</td>
												<td>
													{summary.done} / {summary.total}
												</td>
												<td>
													{batch.stopReason ? (
														<span className="hint">
															{failureLabel(batch.stopReason)}
														</span>
													) : (
														<span className="hint">—</span>
													)}
												</td>
												<td>
													<a
														className="btn btn--ghost"
														href={`#/bulk-applies/${encodeURIComponent(batch.id)}`}
													>
														詳細
													</a>
												</td>
											</tr>
										);
									})}
								</tbody>
							</table>
						</div>
					)}
				</Card>
			</div>
		</>
	);
}

type SelectedTarget = { deviceId: string; backupId: string };

/** checkpointが一括指定できるのは、全itemがcapturedで世代を参照できるときだけ。 */
function checkpointEligibility(checkpoint: ConfigCheckpoint): string | null {
	if (checkpoint.items.length === 0) return "Deviceが含まれていません";
	if (checkpoint.items.length > MAX_BATCH_DEVICES)
		return `${MAX_BATCH_DEVICES}台を超えているため選択できません(個別指定を使ってください)`;
	const failed = checkpoint.items.filter((item) => item.status !== "captured");
	if (failed.length > 0)
		return `未取得のDeviceが${failed.length}台あるため選択できません(個別指定を使ってください)`;
	const unavailable = checkpoint.items.filter((item) => !item.backupAvailable);
	if (unavailable.length > 0)
		return `世代を参照できないDeviceが${unavailable.length}台あるため選択できません`;
	return null;
}

function BulkApplyCreator({
	onCreated,
}: {
	onCreated: (batch: ConfigApplyBatch) => void;
}) {
	const [devices, setDevices] = useState<Device[] | null>(null);
	const [checkpoints, setCheckpoints] = useState<ConfigCheckpoint[] | null>(
		null,
	);
	const [sourceType, setSourceType] = useState<"checkpoint" | "devices">(
		"checkpoint",
	);
	const [checkpointId, setCheckpointId] = useState("");
	const [targets, setTargets] = useState<SelectedTarget[]>([]);
	const [backupsByDevice, setBackupsByDevice] = useState<
		Record<string, ConfigBackup[]>
	>({});
	const [saveAfterApply, setSaveAfterApply] = useState(false);
	const [confirmationMode, setConfirmationMode] = useState<
		"batch" | "per_device"
	>("batch");
	const [loading, setLoading] = useState(true);
	const [creating, setCreating] = useState(false);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		let active = true;
		Promise.all([api.devices(), api.configCheckpoints()])
			.then(([deviceResponse, checkpointResponse]) => {
				if (!active) return;
				setDevices(deviceResponse.devices);
				setCheckpoints(checkpointResponse.checkpoints);
				const firstEligible = checkpointResponse.checkpoints.find(
					(checkpoint) => checkpointEligibility(checkpoint) === null,
				);
				if (firstEligible) setCheckpointId(firstEligible.id);
			})
			.catch((cause) => {
				if (active) setError(apiMessage(cause));
			})
			.finally(() => {
				if (active) setLoading(false);
			});
		return () => {
			active = false;
		};
	}, []);

	async function ensureBackups(deviceId: string) {
		if (Object.hasOwn(backupsByDevice, deviceId)) return;
		try {
			const result = await api.configBackups(deviceId);
			setBackupsByDevice((current) => ({
				...current,
				[deviceId]: result.backups,
			}));
			// 既定は最新の世代を選ぶ。世代はBatch作成時にIDで固定される。
			setTargets((current) =>
				current.map((target) =>
					target.deviceId === deviceId && !target.backupId
						? { ...target, backupId: result.backups[0]?.id ?? "" }
						: target,
				),
			);
		} catch (cause) {
			setError(apiMessage(cause));
		}
	}

	function toggleDevice(device: Device) {
		setError(null);
		setTargets((current) => {
			if (current.some((target) => target.deviceId === device.id)) {
				return current.filter((target) => target.deviceId !== device.id);
			}
			if (current.length >= MAX_BATCH_DEVICES) return current;
			void ensureBackups(device.id);
			return [...current, { deviceId: device.id, backupId: "" }];
		});
	}

	function moveTarget(index: number, direction: -1 | 1) {
		setTargets((current) => {
			const next = [...current];
			const other = index + direction;
			if (other < 0 || other >= next.length) return current;
			const target = next[index];
			const swapped = next[other];
			if (!target || !swapped) return current;
			next[index] = swapped;
			next[other] = target;
			return next;
		});
	}

	const deviceById = useMemo(() => {
		const map = new Map<string, Device>();
		for (const device of devices ?? []) map.set(device.id, device);
		return map;
	}, [devices]);

	const createDisabled =
		creating ||
		(sourceType === "checkpoint"
			? !checkpointId
			: targets.length === 0 || targets.some((target) => !target.backupId));

	async function create() {
		if (createDisabled) return;
		setCreating(true);
		setError(null);
		try {
			const source =
				sourceType === "checkpoint"
					? { type: "checkpoint" as const, checkpointId }
					: {
							type: "devices" as const,
							items: targets.map((target) => ({
								deviceId: target.deviceId,
								backupId: target.backupId,
							})),
						};
			const result = await api.createConfigApplyBatch({
				source,
				confirmationMode,
				saveAfterApply,
			});
			onCreated(result.batch);
		} catch (cause) {
			setError(apiMessage(cause));
		} finally {
			setCreating(false);
		}
	}

	return (
		<Card title="新しく一括適用を作る">
			{error && <Notice tone="error">{error}</Notice>}
			{loading || devices === null || checkpoints === null ? (
				<Loading />
			) : (
				<div className="stack">
					<fieldset className="apply-choice">
						<legend>対象の選び方</legend>
						<label>
							<input
								type="radio"
								name="bulk-source"
								checked={sourceType === "checkpoint"}
								onChange={() => setSourceType("checkpoint")}
							/>
							<strong>checkpointから</strong>
							<span>全itemが取得済みのcheckpointを丸ごと適用します。</span>
						</label>
						<label>
							<input
								type="radio"
								name="bulk-source"
								checked={sourceType === "devices"}
								onChange={() => setSourceType("devices")}
							/>
							<strong>Deviceと世代を個別に</strong>
							<span>
								Deviceごとに適用する保存済み世代を選びます(最大
								{MAX_BATCH_DEVICES}台)。
							</span>
						</label>
					</fieldset>

					{sourceType === "checkpoint" ? (
						checkpoints.length === 0 ? (
							<Empty title="Checkpointはありません">
								先にCONFIG Checkpointsで取得してください。
							</Empty>
						) : (
							<div className="table-wrap">
								<table>
									<thead>
										<tr>
											<th>選択</th>
											<th>名前</th>
											<th>Device数</th>
											<th>選べない理由</th>
										</tr>
									</thead>
									<tbody>
										{checkpoints.map((checkpoint) => {
											const reason = checkpointEligibility(checkpoint);
											return (
												<tr key={checkpoint.id}>
													<td>
														<input
															type="radio"
															name="bulk-checkpoint"
															aria-label={checkpoint.name}
															checked={checkpointId === checkpoint.id}
															disabled={reason !== null}
															onChange={() => setCheckpointId(checkpoint.id)}
														/>
													</td>
													<td className="cell-strong">{checkpoint.name}</td>
													<td>{checkpoint.items.length}台</td>
													<td>
														{reason !== null ? (
															<span className="hint">{reason}</span>
														) : (
															<span className="hint">—</span>
														)}
													</td>
												</tr>
											);
										})}
									</tbody>
								</table>
							</div>
						)
					) : devices.length === 0 ? (
						<Empty title="Deviceがありません" />
					) : (
						<>
							<div className="row row--spread">
								<strong>
									対象Device ({targets.length}/{MAX_BATCH_DEVICES})
								</strong>
							</div>
							<div className="checkpoint-device-list">
								{devices.map((device) => {
									const checked = targets.some(
										(target) => target.deviceId === device.id,
									);
									return (
										<label className="checkpoint-device" key={device.id}>
											<input
												type="checkbox"
												checked={checked}
												disabled={
													!checked && targets.length >= MAX_BATCH_DEVICES
												}
												onChange={() => toggleDevice(device)}
											/>
											<span className="checkpoint-device__name">
												{device.name}
											</span>
											<PresenceBadge status={device.presence.status} />
										</label>
									);
								})}
							</div>
							{targets.length > 0 && (
								<div className="table-wrap">
									<table>
										<thead>
											<tr>
												<th>適用順</th>
												<th>Device</th>
												<th>適用する世代</th>
												<th>順序</th>
											</tr>
										</thead>
										<tbody>
											{targets.map((target, index) => {
												const device = deviceById.get(target.deviceId);
												const backups = backupsByDevice[target.deviceId];
												return (
													<tr key={target.deviceId}>
														<td>{index + 1}</td>
														<td className="cell-strong">
															{device?.name ?? target.deviceId}
														</td>
														<td>
															{backups === undefined ? (
																<span className="hint">世代を読込中…</span>
															) : backups.length === 0 ? (
																<span className="hint">
																	保存済み世代がありません
																</span>
															) : (
																<select
																	aria-label={`${device?.name ?? target.deviceId}の世代`}
																	value={target.backupId}
																	onChange={(event) =>
																		setTargets((current) =>
																			current.map((item) =>
																				item.deviceId === target.deviceId
																					? {
																							...item,
																							backupId: event.target.value,
																						}
																					: item,
																			),
																		)
																	}
																>
																	<option value="">世代を選ぶ</option>
																	{backups.map((backup) => (
																		<option key={backup.id} value={backup.id}>
																			{formatTime(backup.capturedAt)}
																		</option>
																	))}
																</select>
															)}
														</td>
														<td>
															<div className="user-actions">
																<button
																	type="button"
																	className="btn btn--ghost"
																	disabled={index === 0}
																	onClick={() => moveTarget(index, -1)}
																>
																	上へ
																</button>
																<button
																	type="button"
																	className="btn btn--ghost"
																	disabled={index === targets.length - 1}
																	onClick={() => moveTarget(index, 1)}
																>
																	下へ
																</button>
															</div>
														</td>
													</tr>
												);
											})}
										</tbody>
									</table>
								</div>
							)}
						</>
					)}

					<fieldset className="apply-choice">
						<legend>保存方針(作成時に1回だけ選ぶ・後から変えられない)</legend>
						<label>
							<input
								type="radio"
								name="bulk-save"
								checked={!saveAfterApply}
								onChange={() => setSaveAfterApply(false)}
							/>
							<strong>保存しない</strong>
							<span>
								apply_verifyが一致したら次へ進みます。Deviceは未保存のままです。
							</span>
						</label>
						<label>
							<input
								type="radio"
								name="bulk-save"
								checked={saveAfterApply}
								onChange={() => setSaveAfterApply(true)}
							/>
							<strong>すぐ保存する</strong>
							<span>
								保存SYSLOGの確認まで待ってから次へ進みます。保存の成否は保存SYSLOGで確認します。
							</span>
						</label>
					</fieldset>

					<fieldset className="apply-choice">
						<legend>確認モード</legend>
						<label>
							<input
								type="radio"
								name="bulk-confirm"
								checked={confirmationMode === "batch"}
								onChange={() => setConfirmationMode("batch")}
							/>
							<strong>事前一括確認</strong>
							<span>全台の計画を1回だけ確認してから順次実行します。</span>
						</label>
						<label>
							<input
								type="radio"
								name="bulk-confirm"
								checked={confirmationMode === "per_device"}
								onChange={() => setConfirmationMode("per_device")}
							/>
							<strong>Deviceごとに確認</strong>
							<span>
								全台の計画は同じく表示し、実行中に各Deviceの確認を挟みます。
							</span>
						</label>
					</fieldset>

					<div className="row">
						<button
							type="button"
							className="btn btn--primary"
							disabled={createDisabled}
							onClick={() => void create()}
						>
							{creating ? "作成中…" : "作成して準備を開始"}
						</button>
					</div>
					<Notice>
						準備は読み取りのみで、Routerの設定を変更しません。offlineのDeviceは作成時に拒否されます。
					</Notice>
				</div>
			)}
		</Card>
	);
}

// 適用する世代の取得日時を、checkpointとDeviceの世代一覧から引く。
// 世代日時の取得失敗は表示だけの問題に留め、呼び出し側でBatch本体は出す。
async function loadTargetAt(
	target: ConfigApplyBatch,
): Promise<Record<string, string>> {
	const at: Record<string, string> = {};
	try {
		const checkpoints = await api.configCheckpoints();
		for (const checkpoint of checkpoints.checkpoints) {
			for (const item of checkpoint.items) {
				if (item.backupId && item.capturedAt)
					at[item.backupId] = item.capturedAt;
			}
		}
	} catch {
		// 世代日時の表示だけの失敗に留め、Batch本体の表示は続ける。
	}
	const deviceIds = [
		...new Set(
			target.items.flatMap((item) => (item.deviceId ? [item.deviceId] : [])),
		),
	];
	await Promise.all(
		deviceIds.map(async (deviceId) => {
			try {
				const backups = await api.configBackups(deviceId);
				for (const backup of backups.backups) {
					at[backup.id] ??= backup.capturedAt;
				}
			} catch {
				// 同上。
			}
		}),
	);
	return at;
}

export function BulkApplyDetail({
	batchId,
	instanceName,
}: {
	batchId: string;
	instanceName: string | null;
}) {
	const [batch, setBatch] = useState<ConfigApplyBatch | null>(null);
	const [targetAt, setTargetAt] = useState<Record<string, string>>({});
	const [error, setError] = useState<string | null>(null);
	const [actionError, setActionError] = useState<string | null>(null);
	const [acting, setActing] = useState(false);
	const [planOrder, setPlanOrder] = useState<string[] | null>(null);
	const [planSelected, setPlanSelected] = useState<Record<
		string,
		boolean
	> | null>(null);
	const [planEditFor, setPlanEditFor] = useState<string | null>(null);
	const [acknowledged, setAcknowledged] = useState(false);

	useEffect(() => {
		let active = true;
		setBatch(null);
		setTargetAt({});
		setPlanOrder(null);
		setPlanSelected(null);
		setPlanEditFor(null);
		setAcknowledged(false);
		setError(null);
		void (async () => {
			try {
				const result = await api.configApplyBatch(batchId);
				if (!active) return;
				setBatch(result.batch);
				// 適用する世代の取得日時はBatchと一緒に一度だけ引く(表示用)。
				const at = await loadTargetAt(result.batch);
				if (active) setTargetAt(at);
			} catch (cause) {
				if (active) setError(apiMessage(cause));
			}
		})();
		return () => {
			active = false;
		};
	}, [batchId]);

	// 進行中だけ3秒ごとにServerの状態を読み直す。GUI側で状態を進めない。
	const activeStatus = batch && isBatchActive(batch) ? batch.status : null;
	useEffect(() => {
		if (!activeStatus) return;
		let active = true;
		const timer = setInterval(() => {
			void api
				.configApplyBatch(batchId)
				.then((result) => {
					if (active) setBatch(result.batch);
				})
				.catch((cause) => {
					if (active) setError(apiMessage(cause));
				});
		}, POLL_INTERVAL_MS);
		return () => {
			active = false;
			clearInterval(timer);
		};
	}, [batchId, activeStatus]);

	// 計画の編集状態はServerの計画が読めたときにだけ初期化し、pollで上書きしない。
	useEffect(() => {
		if (batch?.status !== "awaiting_confirmation") return;
		if (planEditFor === batch.id) return;
		const ordered = [...batch.items].sort((a, b) => a.sequence - b.sequence);
		setPlanOrder(ordered.map((item) => item.id));
		setPlanSelected(
			Object.fromEntries(
				ordered.map((item) => [item.id, item.selectedForExecution]),
			),
		);
		setPlanEditFor(batch.id);
	}, [batch, planEditFor]);

	async function refresh() {
		try {
			setBatch((await api.configApplyBatch(batchId)).batch);
			setActionError(null);
		} catch (cause) {
			setActionError(apiMessage(cause));
		}
	}

	async function runAction(action: () => Promise<{ batch: ConfigApplyBatch }>) {
		setActing(true);
		setActionError(null);
		try {
			const result = await action();
			setBatch(result.batch);
			// 計画の保存後はServerの値を編集の起点にし直す。
			const ordered = [...result.batch.items].sort(
				(a, b) => a.sequence - b.sequence,
			);
			setPlanOrder(ordered.map((item) => item.id));
			setPlanSelected(
				Object.fromEntries(
					ordered.map((item) => [item.id, item.selectedForExecution]),
				),
			);
			setPlanEditFor(result.batch.id);
			setAcknowledged(false);
		} catch (cause) {
			setActionError(apiMessage(cause));
		} finally {
			setActing(false);
		}
	}

	function stop() {
		if (!window.confirm("一括適用を停止しますか？未開始の残りは実行しません。"))
			return;
		void runAction(() => api.stopConfigApplyBatch(batchId));
	}

	const orderedItems = useMemo(() => {
		if (!batch) return [];
		if (planOrder && planEditFor === batch.id) {
			const byId = new Map(batch.items.map((item) => [item.id, item]));
			return planOrder.flatMap((id) => {
				const item = byId.get(id);
				return item ? [item] : [];
			});
		}
		return [...batch.items].sort((a, b) => a.sequence - b.sequence);
	}, [batch, planOrder, planEditFor]);

	if (error && !batch) {
		return (
			<>
				<header className="topbar">
					<h1>一括適用の詳細</h1>
					{instanceName && <span className="topbar__meta">{instanceName}</span>}
				</header>
				<div className="content">
					<Notice tone="error">{error}</Notice>
					<a className="btn btn--ghost" href="#/bulk-applies">
						一覧へ戻る
					</a>
				</div>
			</>
		);
	}
	if (!batch) {
		return (
			<>
				<header className="topbar">
					<h1>一括適用の詳細</h1>
					{instanceName && <span className="topbar__meta">{instanceName}</span>}
				</header>
				<div className="content">
					<Loading />
				</div>
			</>
		);
	}

	const status = BATCH_STATUS[batch.status];
	return (
		<>
			<header className="topbar">
				<h1>一括適用の詳細</h1>
				{instanceName && <span className="topbar__meta">{instanceName}</span>}
			</header>
			<div className="content">
				{actionError && <Notice tone="error">{actionError}</Notice>}
				<Card
					title={
						<div className="row">
							<span>
								{batch.source === "checkpoint"
									? (batch.sourceCheckpointName ?? "checkpoint")
									: "Device個別指定"}
							</span>
							<Badge tone={status.tone}>{status.label}</Badge>
						</div>
					}
					actions={
						<a className="btn btn--ghost" href="#/bulk-applies">
							一覧へ戻る
						</a>
					}
				>
					<dl className="kv">
						<dt>Batch</dt>
						<dd className="mono">{shortId(batch.id)}</dd>
						<dt>確認モード</dt>
						<dd>
							{batch.confirmationMode === "batch"
								? "事前一括確認"
								: "Deviceごとに確認"}
						</dd>
						<dt>保存方針</dt>
						<dd>{batch.saveAfterApply ? "すぐ保存する" : "保存しない"}</dd>
						<dt>作成</dt>
						<dd>{formatTime(batch.createdAt)}</dd>
						{batch.confirmedAt && (
							<>
								<dt>実行承認</dt>
								<dd>{formatTime(batch.confirmedAt)}</dd>
							</>
						)}
						{batch.finishedAt && (
							<>
								<dt>終了</dt>
								<dd>{formatTime(batch.finishedAt)}</dd>
							</>
						)}
						{batch.stopReason && (
							<>
								<dt>停止理由</dt>
								<dd>{failureLabel(batch.stopReason)}</dd>
							</>
						)}
					</dl>
					{isBatchActive(batch) && batch.status !== "awaiting_confirmation" && (
						<div className="row">
							<button
								type="button"
								className="btn btn--danger"
								disabled={acting}
								onClick={stop}
							>
								{acting ? "停止中…" : "停止する"}
							</button>
						</div>
					)}
				</Card>

				{batch.status === "preparing" && (
					<PreparingView batch={batch} stopping={acting} onStop={stop} />
				)}
				{batch.status === "awaiting_confirmation" && (
					<PlanView
						batch={batch}
						items={orderedItems}
						targetAt={targetAt}
						planSelected={planSelected}
						acting={acting}
						acknowledged={acknowledged}
						onAcknowledged={setAcknowledged}
						onMove={(index, direction) =>
							setPlanOrder((current) => {
								if (!current) return current;
								const next = [...current];
								const other = index + direction;
								if (other < 0 || other >= next.length) return current;
								const target = next[index];
								const swapped = next[other];
								if (target === undefined || swapped === undefined)
									return current;
								next[index] = swapped;
								next[other] = target;
								return next;
							})
						}
						onToggleSelected={(itemId, selected) =>
							setPlanSelected((current) =>
								current ? { ...current, [itemId]: selected } : current,
							)
						}
						onSavePlan={() => {
							if (!planOrder) return;
							void runAction(() =>
								api.updateConfigApplyBatchPlan(
									batchId,
									planOrder.map((itemId) => ({
										itemId,
										selected: planSelected?.[itemId] ?? true,
									})),
								),
							);
						}}
						onConfirm={() =>
							void runAction(() => api.confirmConfigApplyBatch(batchId))
						}
						onConfirmItem={(itemId) =>
							void runAction(() =>
								api.confirmConfigApplyBatchItem(batchId, itemId),
							)
						}
						onStop={stop}
						onRefresh={() => void refresh()}
					/>
				)}
				{(batch.status === "running" || batch.status === "stopping") && (
					<ExecutionView
						batch={batch}
						items={[...batch.items].sort((a, b) => a.sequence - b.sequence)}
						acting={acting}
						onConfirmItem={(itemId) =>
							void runAction(() =>
								api.confirmConfigApplyBatchItem(batchId, itemId),
							)
						}
						onStop={stop}
						onRefresh={() => void refresh()}
					/>
				)}
				{(batch.status === "stopped" || batch.status === "complete") && (
					<ResultView
						batch={batch}
						items={[...batch.items].sort((a, b) => a.sequence - b.sequence)}
						targetAt={targetAt}
					/>
				)}
			</div>
		</>
	);
}

export function PreparingView({
	batch,
	stopping,
	onStop,
}: {
	batch: ConfigApplyBatch;
	stopping: boolean;
	onStop: () => void;
}) {
	const prepared = batch.items.filter((item) => item.plan !== null).length;
	return (
		<Card title="準備中">
			<div className="stack">
				<Notice tone="accent">
					全対象のCONFIGを読み取り、差分と検証結果を集めています。Routerの設定は変更しません。
				</Notice>
				<div className="stat-grid">
					<div className="stat">
						<span className="stat__label">準備の進捗</span>
						<div className="stat__value">
							{prepared} / {batch.items.length}
						</div>
					</div>
				</div>
				<div className="table-wrap">
					<table>
						<thead>
							<tr>
								<th>適用順</th>
								<th>Device</th>
								<th>状態</th>
							</tr>
						</thead>
						<tbody>
							{[...batch.items]
								.sort((a, b) => a.sequence - b.sequence)
								.map((item, index) => {
									const itemStatus = ITEM_STATUS[item.status];
									return (
										<tr key={item.id}>
											<td>{index + 1}</td>
											<td className="cell-strong">{item.deviceName}</td>
											<td>
												<Badge tone={itemStatus.tone}>{itemStatus.label}</Badge>
											</td>
										</tr>
									);
								})}
						</tbody>
					</table>
				</div>
				<div className="row">
					<button
						type="button"
						className="btn btn--danger"
						disabled={stopping}
						onClick={onStop}
					>
						{stopping ? "停止中…" : "準備を中止する"}
					</button>
				</div>
			</div>
		</Card>
	);
}

/** 計画の確認可否。準備失敗・検証NGが残っていたら実行へ進めない。 */
export function planBlockers(batch: ConfigApplyBatch): string[] {
	const blockers: string[] = [];
	for (const item of batch.items) {
		if (!item.selectedForExecution) continue;
		if (!item.plan || item.status === "preparing") {
			blockers.push(`${item.deviceName}: 準備が終わっていません`);
		} else if (!item.plan.validation.valid) {
			blockers.push(
				`${item.deviceName}: 検証NG(${item.plan.validation.code ?? "target_invalid"})`,
			);
		} else if (item.status === "failed") {
			blockers.push(
				`${item.deviceName}: 準備に失敗(${failureLabel(item.failureCode)})`,
			);
		}
	}
	return blockers;
}

export function PlanView({
	batch,
	items,
	targetAt,
	planSelected,
	acting,
	acknowledged,
	onAcknowledged,
	onMove,
	onToggleSelected,
	onSavePlan,
	onConfirm,
	onConfirmItem,
	onStop,
	onRefresh,
}: {
	batch: ConfigApplyBatch;
	items: ConfigApplyBatchItem[];
	targetAt: Record<string, string>;
	planSelected: Record<string, boolean> | null;
	acting: boolean;
	acknowledged: boolean;
	onAcknowledged: (value: boolean) => void;
	onMove: (index: number, direction: -1 | 1) => void;
	onToggleSelected: (itemId: string, selected: boolean) => void;
	onSavePlan: () => void;
	onConfirm: () => void;
	onConfirmItem: (itemId: string) => void;
	onStop: () => void;
	onRefresh: () => void;
}) {
	const dirty =
		planSelected !== null &&
		(items.some(
			(item) => (planSelected[item.id] ?? true) !== item.selectedForExecution,
		) ||
			items.some((item, index) => {
				const ordered = [...batch.items].sort(
					(a, b) => a.sequence - b.sequence,
				)[index];
				return ordered?.id !== item.id;
			}));
	const blockers = planBlockers(batch);
	const selectedCount = items.filter(
		(item) => planSelected?.[item.id] ?? item.selectedForExecution,
	).length;
	const perDevice = batch.confirmationMode === "per_device";
	const currentItem = perDevice
		? (batch.items.find((item) => item.id === batch.currentItemId) ?? null)
		: null;
	const canConfirm =
		!acting && !dirty && blockers.length === 0 && selectedCount > 0;

	return (
		<Card
			title={`計画の確認 (${items.length}台)`}
			actions={
				<button type="button" className="btn btn--ghost" onClick={onRefresh}>
					更新
				</button>
			}
		>
			<div className="stack">
				<RecoveryScopeNotice />
				{blockers.length > 0 && (
					<Notice tone="error">
						準備に失敗した対象または検証NGがあるため、実行に進めません。対象を見直して新しい一括適用を作り直してください。
						<ul className="hint-list">
							{blockers.map((blocker) => (
								<li key={blocker}>{blocker}</li>
							))}
						</ul>
						<a className="btn btn--ghost" href="#/bulk-applies">
							一覧へ戻って作り直す
						</a>
					</Notice>
				)}
				<div className="table-wrap">
					<table>
						<thead>
							<tr>
								<th>適用順</th>
								<th>Device</th>
								<th>適用する世代</th>
								<th>差分</th>
								<th>検証</th>
								<th>高リスク</th>
								<th>実行対象</th>
							</tr>
						</thead>
						<tbody>
							{items.map((item, index) => (
								<Fragment key={item.id}>
									<tr>
										<td>
											<div className="row">
												<span>{index + 1}</span>
												<div className="user-actions">
													<button
														type="button"
														className="btn btn--ghost"
														disabled={index === 0 || acting}
														onClick={() => onMove(index, -1)}
														aria-label={`${item.deviceName}を上へ`}
													>
														↑
													</button>
													<button
														type="button"
														className="btn btn--ghost"
														disabled={index === items.length - 1 || acting}
														onClick={() => onMove(index, 1)}
														aria-label={`${item.deviceName}を下へ`}
													>
														↓
													</button>
												</div>
											</div>
										</td>
										<td className="cell-strong">
											{item.deviceId ? (
												<a
													href={`#/devices/${encodeURIComponent(item.deviceId)}`}
												>
													{item.deviceName}
												</a>
											) : (
												item.deviceName
											)}
										</td>
										<td>
											<div className="stack stack--tight">
												<span>
													{targetAt[item.targetBackupId]
														? formatTime(targetAt[item.targetBackupId])
														: "取得日時不明"}
												</span>
												<code className="mono">
													{shortId(item.targetBackupId)}
												</code>
											</div>
										</td>
										<td>
											{item.plan === null ? (
												<span className="hint">準備中…</span>
											) : item.plan.changed ? (
												<span>
													+{item.plan.addedLines}行 / -{item.plan.removedLines}
													行
												</span>
											) : (
												<Badge tone="neutral">差分なし</Badge>
											)}
										</td>
										<td>
											{item.plan === null ? (
												<span className="hint">準備中…</span>
											) : (
												<PlanValidation plan={item.plan} />
											)}
										</td>
										<td>
											{item.plan !== null && item.plan.risks.length > 0 ? (
												<div className="stack stack--tight">
													<Badge tone="danger">高リスクあり</Badge>
													<span className="hint">
														{item.plan.risks
															.map((risk) => RISK_LABEL[risk])
															.join(" / ")}
													</span>
												</div>
											) : (
												<span className="hint">—</span>
											)}
										</td>
										<td>
											<label className="checkbox">
												<input
													type="checkbox"
													checked={
														planSelected?.[item.id] ?? item.selectedForExecution
													}
													disabled={acting}
													onChange={(event) =>
														onToggleSelected(item.id, event.target.checked)
													}
												/>
												実行する
											</label>
										</td>
									</tr>
									<PlanDiffRow item={item} />
								</Fragment>
							))}
						</tbody>
					</table>
				</div>
				<Notice>
					差分のないDeviceは実行対象から外せます。外さず残した場合は直前検査の後に何も適用せず終えます。
					順序と実行対象の変更は「計画を保存」で確定します。
				</Notice>
				<div className="row">
					<button
						type="button"
						className="btn"
						disabled={acting || !dirty}
						onClick={onSavePlan}
					>
						{acting ? "保存中…" : "計画を保存"}
					</button>
					<button
						type="button"
						className="btn btn--danger"
						disabled={acting}
						onClick={onStop}
					>
						中止する
					</button>
				</div>
				{perDevice ? (
					<div className="stack">
						<Notice>
							Deviceごとに確認モードです。実行中、順番が来たDeviceを確認してから適用します(確認の期限は10分です)。
						</Notice>
						{currentItem && (
							<div className="row">
								<span>
									確認待ち: <strong>{currentItem.deviceName}</strong>
								</span>
								<button
									type="button"
									className="btn btn--primary"
									disabled={!canConfirm || acting}
									onClick={() => onConfirmItem(currentItem.id)}
								>
									{acting ? "確認中…" : "このDeviceを確認して実行"}
								</button>
							</div>
						)}
					</div>
				) : (
					<div className="stack">
						<label className="checkbox">
							<input
								type="checkbox"
								checked={acknowledged}
								onChange={(event) => onAcknowledged(event.target.checked)}
							/>
							全{items.length}
							台の計画と高リスク警告を確認しました(確認は1回です)
						</label>
						<div className="row">
							<button
								type="button"
								className="btn btn--primary"
								disabled={!canConfirm || !acknowledged}
								onClick={onConfirm}
							>
								{acting ? "実行中…" : `${selectedCount}台を順次実行`}
							</button>
						</div>
					</div>
				)}
			</div>
		</Card>
	);
}

function PlanValidation({ plan }: { plan: ConfigApplyBatchItem["plan"] }) {
	if (!plan) return <span className="hint">準備中…</span>;
	const validation = plan.validation;
	// バッジだけでなく期待値・実測値・上限も出す。NGのときに何が合わないか読めるようにする。
	const checks: { label: string; value: string; ok: boolean | null }[] = [
		{
			label: "Model",
			value: `対象 ${validation.model.expected ?? "—"} / 実機 ${validation.model.actual ?? "—"}`,
			ok: validation.model.valid,
		},
		{
			label: "Firmware",
			value: `対象 ${validation.firmware.expected ?? "—"} / 実機 ${validation.firmware.actual ?? "—"}`,
			ok: validation.firmware.valid,
		},
		{
			label: "行数",
			value: `${validation.lineCount.actual} / ${validation.lineCount.maximum}`,
			ok: validation.lineCount.valid,
		},
		{
			label: "サイズ",
			value: `${formatBytes(validation.sizeBytes.actual)} / ${formatBytes(validation.sizeBytes.maximum)}`,
			ok: validation.sizeBytes.valid,
		},
		{
			label: "Supervisor自動起動",
			value: validation.supervisorAutostart.present ? "あり" : "なし",
			ok: validation.supervisorAutostart.valid,
		},
	];
	return (
		<div className="stack stack--tight">
			{checks.map((check) => (
				<span key={check.label}>
					{check.label} {check.value}{" "}
					<Badge tone={check.ok === false ? "danger" : "ok"}>
						{check.ok === false ? "NG" : "OK"}
					</Badge>
				</span>
			))}
			{!validation.valid && validation.code && (
				<span className="hint">{failureLabel(validation.code)}</span>
			)}
		</div>
	);
}

/** 計画の差分中身。適用対象と準備時snapshotの差分を既存APIで読む。 */
function PlanDiffRow({ item }: { item: ConfigApplyBatchItem }) {
	const [open, setOpen] = useState(false);
	const [diff, setDiff] = useState<string | null>(null);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);

	if (!item.deviceId || !item.plan?.changed) return null;
	return (
		<tr>
			<td colSpan={7}>
				<button
					type="button"
					className="btn btn--ghost"
					disabled={loading}
					onClick={() => {
						if (open) {
							setOpen(false);
							return;
						}
						if (diff !== null || error !== null) {
							setOpen(true);
							return;
						}
						setLoading(true);
						setError(null);
						void api
							.configDiff(
								item.deviceId ?? "",
								item.targetBackupId,
								item.preparedBackupId ?? undefined,
							)
							.then((result) => {
								setDiff(result.diff);
								setOpen(true);
							})
							.catch((cause) => setError(apiMessage(cause)))
							.finally(() => setLoading(false));
					}}
				>
					{loading ? "取得中…" : open ? "差分を隠す" : "差分を見る"}
				</button>
				{open && error && <Notice tone="error">{error}</Notice>}
				{open && !error && (
					<pre className="config-diff">
						{(diff ?? "").split("\n").map((line, index) => {
							const type = line.startsWith("+")
								? "added"
								: line.startsWith("-")
									? "removed"
									: "context";
							return (
								<span
									// biome-ignore lint/suspicious/noArrayIndexKey: diff lines can repeat; position keeps each rendered line unique
									key={`${index}-${line}`}
									className={`diff-line diff-line--${type}`}
								>
									{line}
									{"\n"}
								</span>
							);
						})}
					</pre>
				)}
			</td>
		</tr>
	);
}

/** 適用結果の1行表示。applyEffectだけを見て3群の文言にする。 */
function EffectBadge({ item }: { item: ConfigApplyBatchItem }) {
	const group = classifyBatchItem(item);
	if (group === "applied") return <Badge tone="ok">適用確認済み</Badge>;
	if (group === "unconfirmed")
		return <Badge tone="danger">適用結果未確認</Badge>;
	return <Badge tone="neutral">未適用</Badge>;
}

export function ExecutionView({
	batch,
	items,
	acting,
	onConfirmItem,
	onStop,
	onRefresh,
}: {
	batch: ConfigApplyBatch;
	items: ConfigApplyBatchItem[];
	acting: boolean;
	onConfirmItem: (itemId: string) => void;
	onStop: () => void;
	onRefresh: () => void;
}) {
	const summary = summarizeBatch(batch);
	const currentItem =
		batch.currentItemId !== null
			? (items.find((item) => item.id === batch.currentItemId) ?? null)
			: null;
	const awaitingItem =
		batch.confirmationMode === "per_device"
			? (items.find((item) => item.status === "awaiting_confirmation") ?? null)
			: null;
	return (
		<Card
			title="順次実行中"
			actions={
				<button type="button" className="btn btn--ghost" onClick={onRefresh}>
					更新
				</button>
			}
		>
			<div className="stack">
				{batch.status === "stopping" && (
					<Notice tone="error">
						停止を受け付けました。実行中の適用が終端化するまで停止中です(実行中のloadを取り消す経路はありません)。
					</Notice>
				)}
				<div className="stat-grid">
					<div className="stat">
						<span className="stat__label">進捗</span>
						<div className="stat__value">
							{summary.done} / {summary.total}
						</div>
					</div>
					<div className={`stat${summary.applied === 0 ? " stat--zero" : ""}`}>
						<span className="stat__label">
							<span className="dot dot--ok" />
							適用確認済み
						</span>
						<div className="stat__value">{summary.applied}</div>
					</div>
					<div
						className={`stat${summary.notApplied === 0 ? " stat--zero" : ""}`}
					>
						<span className="stat__label">
							<span className="dot dot--neutral" />
							未適用
						</span>
						<div className="stat__value">{summary.notApplied}</div>
					</div>
					<div
						className={`stat${summary.unconfirmed === 0 ? " stat--zero" : ""}`}
					>
						<span className="stat__label">
							<span className="dot dot--danger" />
							適用結果未確認
						</span>
						<div className="stat__value">{summary.unconfirmed}</div>
					</div>
				</div>
				{currentItem && (
					<Notice>
						実行中: <strong>{currentItem.deviceName}</strong>(
						{ITEM_STATUS[currentItem.status].label})
					</Notice>
				)}
				<div className="table-wrap">
					<table>
						<thead>
							<tr>
								<th>適用順</th>
								<th>Device</th>
								<th>状態</th>
								<th>適用結果</th>
								<th>保存結果</th>
								<th>理由</th>
							</tr>
						</thead>
						<tbody>
							{items.map((item, index) => {
								const itemStatus = ITEM_STATUS[item.status];
								return (
									<tr key={item.id}>
										<td>{index + 1}</td>
										<td className="cell-strong">
											{item.deviceId ? (
												<a
													href={`#/devices/${encodeURIComponent(item.deviceId)}`}
												>
													{item.deviceName}
												</a>
											) : (
												item.deviceName
											)}
										</td>
										<td>
											<div className="stack stack--tight">
												<Badge tone={itemStatus.tone}>{itemStatus.label}</Badge>
												{batch.saveAfterApply &&
													item.saveResult === "pending" && (
														<span className="hint">保存待ち</span>
													)}
												{awaitingItem?.id === item.id && (
													<button
														type="button"
														className="btn btn--primary"
														disabled={acting}
														onClick={() => onConfirmItem(item.id)}
													>
														{acting ? "確認中…" : "確認して実行"}
													</button>
												)}
											</div>
										</td>
										<td>
											<EffectBadge item={item} />
										</td>
										<td>
											{saveResultLabel(item, batch.saveAfterApply) ?? (
												<span className="hint">—</span>
											)}
										</td>
										<td>
											{item.failureCode ? (
												<span className="hint">
													{failureLabel(item.failureCode)}
												</span>
											) : (
												<span className="hint">—</span>
											)}
										</td>
									</tr>
								);
							})}
						</tbody>
					</table>
				</div>
				<Notice>
					適用する世代の日時は計画の確認画面で見られます。失敗したら止まり、残りは実行しません。続きが必要なら新しい一括適用を作り直してください。
				</Notice>
				{batch.status === "running" && (
					<div className="row">
						<button
							type="button"
							className="btn btn--danger"
							disabled={acting}
							onClick={onStop}
						>
							{acting ? "停止中…" : "停止する"}
						</button>
					</div>
				)}
			</div>
		</Card>
	);
}

export function ResultView({
	batch,
	items,
	targetAt,
}: {
	batch: ConfigApplyBatch;
	items: ConfigApplyBatchItem[];
	targetAt: Record<string, string>;
}) {
	const groups: { key: BatchItemGroup; title: string }[] = [
		{ key: "applied", title: "適用確認済み" },
		{ key: "notApplied", title: "未適用" },
		{ key: "unconfirmed", title: "適用結果未確認" },
	];
	return (
		<div className="stack">
			{batch.status === "stopped" ? (
				<Card title="停止しました">
					<div className="stack">
						<Notice tone="error">
							停止理由: {failureLabel(batch.stopReason)}
							。残りのDeviceは実行していません。続きが必要なら新しい一括適用を作り直してください。
						</Notice>
						<RecoveryScopeNotice />
					</div>
				</Card>
			) : (
				<Card title="完了しました">
					<Notice tone="accent">
						全対象の適用が終わりました。差分なし・対象外のDeviceは何も適用していません。
					</Notice>
				</Card>
			)}
			{groups.map((group) => {
				const members = items.filter(
					(item) => classifyBatchItem(item) === group.key,
				);
				return (
					<Card key={group.key} title={`${group.title} (${members.length}台)`}>
						{members.length === 0 ? (
							<Empty title="該当なし" />
						) : (
							<>
								{group.key === "unconfirmed" && (
									<Notice tone="error">
										load開始後に失敗・切断したDeviceです。Router側の設定が変わっている可能性があります。未開始のDeviceとは扱いが違うため、現地の状態を確認してください。
									</Notice>
								)}
								<div className="table-wrap">
									<table>
										<thead>
											<tr>
												<th>適用順</th>
												<th>Device</th>
												<th>適用した世代</th>
												<th>状態</th>
												<th>保存結果</th>
												<th>理由</th>
											</tr>
										</thead>
										<tbody>
											{members.map((item) => {
												const itemStatus = ITEM_STATUS[item.status];
												return (
													<tr key={item.id}>
														<td>{items.indexOf(item) + 1}</td>
														<td className="cell-strong">
															{item.deviceId ? (
																<a
																	href={`#/devices/${encodeURIComponent(item.deviceId)}`}
																>
																	{item.deviceName}
																</a>
															) : (
																item.deviceName
															)}
														</td>
														<td>
															{/* load開始後の失敗でもどの世代を入れようとしたか分かるようにする */}
															{group.key === "applied" ||
															group.key === "unconfirmed" ? (
																<div className="stack stack--tight">
																	<span>
																		{targetAt[item.targetBackupId]
																			? formatTime(
																					targetAt[item.targetBackupId],
																				)
																			: "取得日時不明"}
																	</span>
																	<code className="mono">
																		{shortId(item.targetBackupId)}
																	</code>
																</div>
															) : (
																<span className="hint">—</span>
															)}
														</td>
														<td>
															<div className="stack stack--tight">
																<Badge tone={itemStatus.tone}>
																	{itemStatus.label}
																</Badge>
																{/* バッジと同じ文言(skippedの「未開始」など)は二重に出さない */}
																{group.key === "notApplied" &&
																	notAppliedReason(item) !==
																		itemStatus.label && (
																		<span className="hint">
																			{notAppliedReason(item)}
																		</span>
																	)}
															</div>
														</td>
														<td>
															{saveResultLabel(item, batch.saveAfterApply) ?? (
																<span className="hint">—</span>
															)}
														</td>
														<td>
															{item.failureCode ? (
																<span className="hint">
																	{failureLabel(item.failureCode)}
																</span>
															) : (
																<span className="hint">—</span>
															)}
														</td>
													</tr>
												);
											})}
										</tbody>
									</table>
								</div>
							</>
						)}
					</Card>
				);
			})}
			<div className="row">
				<a className="btn" href="#/bulk-applies">
					新しく一括適用を作る
				</a>
			</div>
		</div>
	);
}

/** 未適用の内訳。load前に止まったか、未開始・対象外かを文字で区別する。 */
export function notAppliedReason(item: ConfigApplyBatchItem): string {
	switch (item.status) {
		case "excluded":
			return "計画で対象外";
		case "no_change":
			return "差分なしのため未実行";
		case "skipped":
			return "未開始";
		case "failed":
			return `load前に停止(${failureLabel(item.failureCode)})`;
		default:
			return ITEM_STATUS[item.status].label;
	}
}
