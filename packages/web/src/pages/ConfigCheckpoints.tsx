import { type FormEvent, Fragment, useEffect, useState } from "react";
import {
	api,
	type ConfigCheckpoint,
	type ConfigCheckpointItem,
	type ConfigDiff,
	type Device,
	type User,
} from "../api.ts";
import {
	Badge,
	Card,
	Empty,
	Field,
	formatTime,
	Loading,
	Notice,
	PresenceBadge,
} from "../ui.tsx";

const MAX_DEVICES = 50;

const CHECKPOINT_STATUS: Record<
	ConfigCheckpoint["status"],
	{ label: string; tone: "ok" | "warn" | "danger" | "neutral" }
> = {
	pending: { label: "取得中", tone: "warn" },
	partial: { label: "一部取得", tone: "warn" },
	captured: { label: "取得完了", tone: "ok" },
	failed: { label: "取得失敗", tone: "danger" },
};

const ITEM_STATUS: Record<
	ConfigCheckpointItem["status"],
	{ label: string; tone: "ok" | "warn" | "danger" }
> = {
	pending: { label: "応答待ち", tone: "warn" },
	captured: { label: "取得成功", tone: "ok" },
	failed: { label: "取得失敗", tone: "danger" },
};

const FAILURE_LABEL: Record<string, string> = {
	device_offline: "要求時にoffline",
	device_not_found: "要求時にDeviceが見つからない",
	checkpoint_in_progress: "別のcheckpoint取得中",
	request_failed: "取得要求を送信できない",
	response_timeout: "制限時間内に応答なし",
	server_restarted: "Server再起動により待機終了",
	backup_unavailable: "取得世代を参照できない",
};

export function ConfigCheckpoints({
	user,
	instanceName,
}: {
	user: User;
	instanceName: string | null;
}) {
	const [devices, setDevices] = useState<Device[] | null>(null);
	const [checkpoints, setCheckpoints] = useState<ConfigCheckpoint[] | null>(
		null,
	);
	const [selectedIds, setSelectedIds] = useState<string[]>([]);
	const [name, setName] = useState("");
	const [memo, setMemo] = useState("");
	const [loading, setLoading] = useState(true);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [message, setMessage] = useState<string | null>(null);
	const [diffs, setDiffs] = useState<Record<string, string | null>>({});
	const [diffLoading, setDiffLoading] = useState<string | null>(null);

	useEffect(() => {
		let active = true;
		const load = async () => {
			try {
				const [deviceResponse, checkpointResponse] = await Promise.all([
					api.devices(),
					api.configCheckpoints(),
				]);
				if (!active) return;
				setDevices(deviceResponse.devices);
				setCheckpoints(checkpointResponse.checkpoints);
				setError(null);
			} catch (cause) {
				if (active) setError(apiMessage(cause));
			} finally {
				if (active) setLoading(false);
			}
		};
		void load();
		// CONFIG_REQUESTを待つ間に結果が確定したら一覧へ反映する。
		const timer = setInterval(() => {
			void api
				.configCheckpoints()
				.then((result) => {
					if (active) setCheckpoints(result.checkpoints);
				})
				.catch((cause) => {
					if (active) setError(apiMessage(cause));
				});
		}, 3000);
		return () => {
			active = false;
			clearInterval(timer);
		};
	}, []);

	function toggleDevice(deviceId: string) {
		setSelectedIds((current) =>
			current.includes(deviceId)
				? current.filter((id) => id !== deviceId)
				: current.length < MAX_DEVICES
					? [...current, deviceId]
					: current,
		);
	}

	async function createCheckpoint(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		setError(null);
		setMessage(null);
		if (selectedIds.length === 0) {
			setError("Deviceを1台以上選択してください。");
			return;
		}
		setSaving(true);
		try {
			const result = await api.createConfigCheckpoint({
				name,
				memo,
				deviceIds: selectedIds,
			});
			setCheckpoints((current) => [
				result.checkpoint,
				...(current ?? []).filter((item) => item.id !== result.checkpoint.id),
			]);
			setSelectedIds([]);
			setName("");
			setMemo("");
			setMessage("checkpointを作成しました。CONFIG応答を待っています。");
		} catch (cause) {
			setError(apiMessage(cause));
		} finally {
			setSaving(false);
		}
	}

	async function refreshCheckpoints() {
		try {
			setCheckpoints((await api.configCheckpoints()).checkpoints);
			setError(null);
		} catch (cause) {
			setError(apiMessage(cause));
		}
	}

	async function deleteCheckpoint(checkpoint: ConfigCheckpoint) {
		if (!window.confirm(`「${checkpoint.name}」を削除しますか？`)) return;
		setError(null);
		try {
			await api.deleteConfigCheckpoint(checkpoint.id);
			setCheckpoints(
				(current) =>
					current?.filter((item) => item.id !== checkpoint.id) ?? null,
			);
		} catch (cause) {
			setError(apiMessage(cause));
		}
	}

	async function toggleDiff(item: ConfigCheckpointItem) {
		if (!item.deviceId || !item.backupId) return;
		if (Object.hasOwn(diffs, item.id)) {
			setDiffs((current) => {
				const next = { ...current };
				delete next[item.id];
				return next;
			});
			return;
		}
		setDiffLoading(item.id);
		setError(null);
		try {
			const diff: ConfigDiff = await api.configDiff(
				item.deviceId,
				item.backupId,
			);
			setDiffs((current) => ({ ...current, [item.id]: diff.diff }));
		} catch (cause) {
			setError(apiMessage(cause));
		} finally {
			setDiffLoading(null);
		}
	}

	return (
		<>
			<header className="topbar">
				<h1>CONFIG Checkpoints</h1>
				{instanceName && <span className="topbar__meta">{instanceName}</span>}
			</header>
			<div className="content">
				{error && <Notice tone="error">{error}</Notice>}
				{message && <Notice tone="accent">{message}</Notice>}

				{user.role === "admin" && (
					<Card title="作業前のCONFIGを取得">
						{loading || devices === null ? (
							<Loading />
						) : devices.length === 0 ? (
							<Empty title="Deviceがありません">
								Deviceを登録してからcheckpointを作成してください。
							</Empty>
						) : (
							<form className="stack" onSubmit={createCheckpoint}>
								<div className="toolbar">
									<Field label="名前">
										<input
											value={name}
											maxLength={120}
											placeholder="例: VPN設定変更前"
											required
											onChange={(event) => setName(event.target.value)}
										/>
									</Field>
									<Field label="メモ">
										<textarea
											value={memo}
											maxLength={4000}
											rows={2}
											onChange={(event) => setMemo(event.target.value)}
										/>
									</Field>
								</div>
								<div className="row row--spread">
									<strong>
										対象Device ({selectedIds.length}/{MAX_DEVICES})
									</strong>
									<button
										type="button"
										className="btn btn--ghost"
										onClick={() =>
											setSelectedIds(
												devices
													.slice(0, MAX_DEVICES)
													.map((device) => device.id),
											)
										}
									>
										先頭{Math.min(devices.length, MAX_DEVICES)}台を選択
									</button>
								</div>
								<div className="checkpoint-device-list">
									{devices.map((device) => {
										const checked = selectedIds.includes(device.id);
										return (
											<label className="checkpoint-device" key={device.id}>
												<input
													type="checkbox"
													checked={checked}
													disabled={
														!checked && selectedIds.length >= MAX_DEVICES
													}
													onChange={() => toggleDevice(device.id)}
												/>
												<span className="checkpoint-device__name">
													{device.name}
												</span>
												<PresenceBadge status={device.presence.status} />
											</label>
										);
									})}
								</div>
								<Notice>
									offlineのDeviceも選べます。取得できなかった結果は失敗として記録します。
									1台あたりの応答待ちは2分です。
								</Notice>
								<div className="row">
									<button
										type="submit"
										className="btn btn--primary"
										disabled={
											saving || selectedIds.length === 0 || !name.trim()
										}
									>
										{saving ? "作成中…" : "checkpointを作成して取得"}
									</button>
									<button
										type="button"
										className="btn btn--ghost"
										onClick={() => setSelectedIds([])}
									>
										選択解除
									</button>
								</div>
							</form>
						)}
					</Card>
				)}

				<Card
					title="Checkpoint履歴"
					actions={
						<button
							type="button"
							className="btn btn--ghost"
							onClick={() => void refreshCheckpoints()}
						>
							更新
						</button>
					}
				>
					{checkpoints === null ? (
						<Loading />
					) : checkpoints.length === 0 ? (
						<Empty title="Checkpointはありません" />
					) : (
						<div className="stack">
							{checkpoints.map((checkpoint) => (
								<CheckpointCard
									key={checkpoint.id}
									checkpoint={checkpoint}
									canDelete={user.role === "admin"}
									deleting={() => void deleteCheckpoint(checkpoint)}
									diff={toggleDiff}
									diffLoadingId={diffLoading}
									diffs={diffs}
									canOpenConfig={user.role === "admin"}
								/>
							))}
						</div>
					)}
				</Card>
			</div>
		</>
	);
}

function CheckpointCard({
	checkpoint,
	canDelete,
	deleting,
	diff,
	diffLoadingId,
	diffs,
	canOpenConfig,
}: {
	checkpoint: ConfigCheckpoint;
	canDelete: boolean;
	deleting: () => void;
	diff: (item: ConfigCheckpointItem) => void;
	diffLoadingId: string | null;
	diffs: Record<string, string | null>;
	canOpenConfig: boolean;
}) {
	const status = CHECKPOINT_STATUS[checkpoint.status];
	return (
		<section className="checkpoint-card">
			<header className="checkpoint-card__head">
				<div>
					<div className="row">
						<h3>{checkpoint.name}</h3>
						<Badge tone={status.tone}>{status.label}</Badge>
					</div>
					<p className="muted">
						作成 {formatTime(checkpoint.createdAt)} · 成功{" "}
						{checkpoint.capturedCount} · 待機 {checkpoint.pendingCount} · 失敗{" "}
						{checkpoint.failedCount}
					</p>
				</div>
				{canDelete && (
					<button
						type="button"
						className="btn btn--ghost"
						disabled={checkpoint.pendingCount > 0}
						title={
							checkpoint.pendingCount > 0
								? "取得完了後に削除できます"
								: undefined
						}
						onClick={deleting}
					>
						削除
					</button>
				)}
			</header>
			{checkpoint.memo && (
				<p className="checkpoint-card__memo">{checkpoint.memo}</p>
			)}
			<div className="table-wrap">
				<table>
					<thead>
						<tr>
							<th>Device</th>
							<th>取得結果</th>
							<th>世代 / 取得日時</th>
							<th>操作</th>
						</tr>
					</thead>
					<tbody>
						{checkpoint.items.map((item) => {
							const itemStatus = ITEM_STATUS[item.status];
							return (
								<Fragment key={item.id}>
									<tr>
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
												{item.failureCode && (
													<span className="hint">
														{FAILURE_LABEL[item.failureCode] ??
															"取得できませんでした"}
													</span>
												)}
												{item.status === "pending" && (
													<span className="hint">応答待ち</span>
												)}
											</div>
										</td>
										<td>
											{item.status === "captured" ? (
												<div className="stack stack--tight">
													<span>{formatTime(item.capturedAt)}</span>
													{item.backupAvailable && item.backupId ? (
														<code className="mono">
															{item.backupId.slice(0, 8)}
														</code>
													) : (
														<span className="hint">
															世代は保持期間で削除済み
														</span>
													)}
												</div>
											) : (
												<span className="hint">
													要求 {formatTime(item.requestedAt)}
												</span>
											)}
										</td>
										<td>
											{item.backupAvailable &&
												item.deviceId &&
												item.backupId && (
													<div className="user-actions">
														{canOpenConfig && (
															<>
																<button
																	type="button"
																	className="btn btn--ghost"
																	disabled={diffLoadingId === item.id}
																	onClick={() => diff(item)}
																>
																	{diffLoadingId === item.id
																		? "取得中…"
																		: Object.hasOwn(diffs, item.id)
																			? "差分を隠す"
																			: "差分"}
																</button>
																<a
																	className="btn btn--ghost"
																	href={api.configBackupDownloadUrl(
																		item.deviceId,
																		item.backupId,
																	)}
																	download
																>
																	DL
																</a>
															</>
														)}
														<a
															className="btn btn--ghost"
															href={`#/devices/${encodeURIComponent(item.deviceId)}`}
														>
															Device詳細
														</a>
													</div>
												)}
										</td>
									</tr>
									{Object.hasOwn(diffs, item.id) && (
										<tr>
											<td colSpan={4}>
												<pre className="checkpoint-diff">
													{diffs[item.id] ?? "差分はありません。"}
												</pre>
											</td>
										</tr>
									)}
								</Fragment>
							);
						})}
					</tbody>
				</table>
			</div>
		</section>
	);
}

function apiMessage(cause: unknown): string {
	return cause instanceof Error
		? cause.message
		: "Checkpointの処理に失敗しました";
}
