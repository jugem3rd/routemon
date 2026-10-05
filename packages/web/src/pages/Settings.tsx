import { type FormEvent, useEffect, useState } from "react";
import {
	ApiError,
	api,
	type Backup,
	type Device,
	type SetupCheck,
	type SetupStatus,
	type SyslogStorageStatus,
} from "../api.ts";
import {
	Badge,
	Card,
	Empty,
	Field,
	formatTime,
	Loading,
	Modal,
	Notice,
	Spinner,
} from "../ui.tsx";
import { SiteTagManagement } from "./SiteTagManagement.tsx";

type SettingsProps = {
	setup: SetupStatus | null;
	onSetupChanged: (status: SetupStatus) => void;
};

type StorageRow = {
	device: Device;
	status: SyslogStorageStatus;
};

export function Settings({ setup, onSetupChanged }: SettingsProps) {
	const [instanceName, setInstanceName] = useState(setup?.instanceName ?? "");
	const [timezone, setTimezone] = useState(setup?.timezone ?? "UTC");
	const [publicBaseUrl, setPublicBaseUrl] = useState(
		setup?.publicBaseUrl ?? "",
	);
	const [saving, setSaving] = useState(false);
	const [settingsError, setSettingsError] = useState<string | null>(null);
	const [message, setMessage] = useState<string | null>(null);
	const [checks, setChecks] = useState<SetupCheck[] | null>(null);
	const [checking, setChecking] = useState(false);
	const [connectivityError, setConnectivityError] = useState<string | null>(
		null,
	);
	const [storageRows, setStorageRows] = useState<StorageRow[] | null>(null);
	const [storageLoading, setStorageLoading] = useState(false);
	const [storageError, setStorageError] = useState<string | null>(null);
	const [backups, setBackups] = useState<Backup[] | null>(null);
	const [backupsLoading, setBackupsLoading] = useState(false);
	const [backupsError, setBackupsError] = useState<string | null>(null);
	const [creatingBackup, setCreatingBackup] = useState(false);
	const [includeSyslog, setIncludeSyslog] = useState(false);
	const [backupMessage, setBackupMessage] = useState<string | null>(null);
	const [deletingBackup, setDeletingBackup] = useState<Backup | null>(null);
	const [deletingBackupNow, setDeletingBackupNow] = useState(false);
	const [backupDeleteError, setBackupDeleteError] = useState<string | null>(
		null,
	);

	useEffect(() => {
		setInstanceName(setup?.instanceName ?? "");
		setTimezone(setup?.timezone ?? "UTC");
		setPublicBaseUrl(setup?.publicBaseUrl ?? "");
	}, [setup?.instanceName, setup?.timezone, setup?.publicBaseUrl]);

	async function loadStorage() {
		setStorageLoading(true);
		setStorageError(null);
		try {
			const devices = (await api.devices()).devices;
			const rows = await Promise.all(
				devices.map(async (device) => ({
					device,
					status: await api.syslogStorage(device.id),
				})),
			);
			setStorageRows(rows);
		} catch (error) {
			setStorageError(
				apiMessage(error, "SYSLOGの保存状況を読み込めませんでした。"),
			);
		} finally {
			setStorageLoading(false);
		}
	}

	async function loadBackups() {
		setBackupsLoading(true);
		setBackupsError(null);
		try {
			setBackups((await api.backups()).backups);
		} catch (error) {
			setBackupsError(
				apiMessage(error, "Backupの一覧を読み込めませんでした。"),
			);
		} finally {
			setBackupsLoading(false);
		}
	}

	// Settingsを開いたときにDeviceごとのSYSLOG使用量を取得する。
	// biome-ignore lint/correctness/useExhaustiveDependencies: 画面表示時に1回だけ読み込む
	useEffect(() => {
		void loadStorage();
	}, []);

	// Settingsを開いたときに、利用者が作成したBackupの世代を取得する。
	// biome-ignore lint/correctness/useExhaustiveDependencies: 画面表示時に1回だけ読み込む
	useEffect(() => {
		void loadBackups();
	}, []);

	async function createBackup() {
		setCreatingBackup(true);
		setBackupsError(null);
		setBackupMessage(null);
		try {
			const created = (await api.createBackup(includeSyslog)).backup;
			setBackups((current) => [created, ...(current ?? [])]);
			setBackupMessage(
				includeSyslog
					? "SYSLOGを含むBackupを作成しました。"
					: "Backupを作成しました。",
			);
		} catch (error) {
			setBackupsError(apiMessage(error, "Backupを作成できませんでした。"));
		} finally {
			setCreatingBackup(false);
		}
	}

	function askDeleteBackup(backup: Backup) {
		setBackupDeleteError(null);
		setDeletingBackup(backup);
	}

	function closeDeleteBackup() {
		if (!deletingBackupNow) setDeletingBackup(null);
	}

	async function deleteBackup() {
		if (!deletingBackup) return;
		setDeletingBackupNow(true);
		setBackupDeleteError(null);
		try {
			await api.deleteBackup(deletingBackup.id);
			setBackups(
				(current) =>
					current?.filter((backup) => backup.id !== deletingBackup.id) ?? null,
			);
			setDeletingBackup(null);
			setBackupMessage("Backupを削除しました。");
		} catch (error) {
			setBackupDeleteError(apiMessage(error, "Backupを削除できませんでした。"));
		} finally {
			setDeletingBackupNow(false);
		}
	}

	async function save(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		const name = instanceName.trim();
		const zone = timezone.trim();
		const url = publicBaseUrl.trim();
		if (!name || !zone || !url) return;

		setSaving(true);
		setSettingsError(null);
		setMessage(null);
		try {
			let status = setup;
			if (name !== (setup?.instanceName ?? "")) {
				status = await api.updateInstanceName(name);
			}
			if (zone !== (status?.timezone ?? "")) {
				status = await api.updateTimezone(zone);
			}
			if (url.replace(/\/$/, "") !== (status?.publicBaseUrl ?? "")) {
				status = await api.updatePublicUrl(url);
			}
			if (status) {
				onSetupChanged(status);
				setInstanceName(status.instanceName ?? "");
				setTimezone(status.timezone ?? "UTC");
				setPublicBaseUrl(status.publicBaseUrl ?? "");
			}
			setMessage("Settingsを保存しました。");
		} catch (error) {
			setSettingsError(apiMessage(error, "Settingsを保存できませんでした。"));
		} finally {
			setSaving(false);
		}
	}

	async function runConnectivityCheck() {
		const url = publicBaseUrl.trim();
		if (!url) return;
		setChecking(true);
		setConnectivityError(null);
		try {
			setChecks((await api.connectivityCheck(url)).checks);
		} catch (error) {
			setConnectivityError(
				apiMessage(error, "接続確認を実行できませんでした。"),
			);
		} finally {
			setChecking(false);
		}
	}

	return (
		<>
			<header className="topbar">
				<h1>Settings</h1>
				{instanceName && <span className="topbar__meta">{instanceName}</span>}
			</header>

			<div className="content">
				{message && <Notice tone="accent">{message}</Notice>}
				{settingsError && <Notice tone="error">{settingsError}</Notice>}

				<Card title="General">
					<form className="stack" onSubmit={save}>
						<Field label="Instance名">
							<input
								value={instanceName}
								onChange={(event) => setInstanceName(event.target.value)}
								placeholder="例: 本社ネットワーク"
							/>
						</Field>
						<Field label="Timezone">
							<input
								value={timezone}
								onChange={(event) => setTimezone(event.target.value)}
								placeholder="例: Asia/Tokyo"
							/>
						</Field>
						<Field label="Public URL">
							<input
								value={publicBaseUrl}
								onChange={(event) => {
									setPublicBaseUrl(event.target.value);
									setChecks(null);
								}}
								placeholder="https://routemon.example.com"
							/>
						</Field>
						<p className="hint">
							Public URLを変更すると、Caddy設定は最大30秒以内に追従します。
						</p>
						<div className="row row--end">
							<button
								type="submit"
								className="btn btn--primary"
								disabled={
									saving ||
									!instanceName.trim() ||
									!timezone.trim() ||
									!publicBaseUrl.trim()
								}
							>
								{saving && <Spinner />}
								{saving ? "保存中…" : "変更を保存"}
							</button>
						</div>
					</form>
				</Card>

				<Card title="Network / Connectivity">
					<div className="stack">
						<p className="hint">
							現在入力されているPublic URLから、DNS・HTTPS・証明書・Agent
							Endpointを確認します。
						</p>
						<div className="row">
							<button
								type="button"
								className="btn"
								disabled={checking || !publicBaseUrl.trim()}
								onClick={() => void runConnectivityCheck()}
							>
								{checking && <Spinner />}
								{checking ? "確認中…" : "接続確認を再実行"}
							</button>
						</div>
						{connectivityError && (
							<Notice tone="error">{connectivityError}</Notice>
						)}
						{checks && (
							<div className="table-wrap">
								<table>
									<tbody>
										{checks.map((check) => (
											<tr key={check.name}>
												<td className="cell-strong">{check.name}</td>
												<td>
													<Badge tone={check.status === "ok" ? "ok" : "danger"}>
														{check.status === "ok" ? "OK" : "Error"}
													</Badge>
												</td>
												<td style={{ whiteSpace: "normal" }}>{check.detail}</td>
											</tr>
										))}
									</tbody>
								</table>
							</div>
						)}
					</div>
				</Card>

				<SiteTagManagement />

				<Card
					title="Backup"
					actions={
						<button
							type="button"
							className="btn"
							disabled={backupsLoading}
							onClick={() => void loadBackups()}
						>
							{backupsLoading && <Spinner />}
							再読み込み
						</button>
					}
				>
					<div className="stack">
						<p className="hint">
							BackupにはDB・master
							key・暗号化CONFIGが含まれる可能性があります。安全な場所で保管してください。
						</p>
						<label className="checkbox">
							<input
								type="checkbox"
								checked={includeSyslog}
								onChange={(event) => setIncludeSyslog(event.target.checked)}
							/>
							SYSLOGを含める
						</label>
						<div className="row">
							<button
								type="button"
								className="btn btn--primary"
								disabled={creatingBackup}
								onClick={() => void createBackup()}
							>
								{creatingBackup && <Spinner />}
								{creatingBackup ? "作成中…" : "Backupを作成"}
							</button>
							<span className="hint">{backups?.length ?? "—"}世代を保存中</span>
						</div>
						{backupMessage && <Notice tone="accent">{backupMessage}</Notice>}
						{backupsError && <Notice tone="error">{backupsError}</Notice>}
					</div>

					{backupsLoading && !backups ? (
						<div className="stack">
							<Loading />
						</div>
					) : backups?.length === 0 ? (
						<Empty title="Backupがありません">
							作成したBackupがここに表示されます。
						</Empty>
					) : backups ? (
						<div className="table-wrap">
							<table>
								<thead>
									<tr>
										<th>作成日時</th>
										<th>サイズ</th>
										<th>操作</th>
									</tr>
								</thead>
								<tbody>
									{backups.map((backup) => (
										<tr key={backup.id}>
											<td>{formatTime(backup.createdAt)}</td>
											<td className="num">{formatBytes(backup.sizeBytes)}</td>
											<td>
												<div className="row">
													<a
														className="btn"
														href={api.backupDownloadUrl(backup.id)}
														download={backup.id}
													>
														ダウンロード
													</a>
													<button
														type="button"
														className="btn btn--danger"
														disabled={deletingBackupNow}
														onClick={() => askDeleteBackup(backup)}
													>
														削除
													</button>
												</div>
											</td>
										</tr>
									))}
								</tbody>
							</table>
						</div>
					) : null}
				</Card>

				<Card title="Restore">
					<div className="stack">
						<p className="hint">
							Restoreはデータの上書きとサービス停止・再起動を伴うため、GUIからは実行しません。
						</p>
						<p className="hint">
							サービスを停止し、サーバー上で
							<code>routemon restore &lt;archive&gt; --force</code>
							を実行してから再起動してください。
						</p>
					</div>
				</Card>

				<Card
					title="SYSLOG Storage"
					actions={
						<button
							type="button"
							className="btn"
							disabled={storageLoading}
							onClick={() => void loadStorage()}
						>
							{storageLoading && <Spinner />}
							再読み込み
						</button>
					}
					flush
				>
					{storageError && (
						<div className="card__body">
							<Notice tone="error">{storageError}</Notice>
						</div>
					)}
					{storageLoading && !storageRows ? (
						<div className="card__body">
							<Loading />
						</div>
					) : storageRows?.length === 0 ? (
						<Empty title="Deviceがありません">
							SYSLOGの保存状況はDevice登録後に表示されます。
						</Empty>
					) : storageRows ? (
						<div className="table-wrap">
							<table>
								<thead>
									<tr>
										<th>Device</th>
										<th>使用量 / 容量</th>
										<th>Retention</th>
										<th>現在の最古ログ</th>
									</tr>
								</thead>
								<tbody>
									{storageRows.map(({ device, status }) => {
										const ratio =
											status.maxBytes > 0
												? Math.min(status.usedBytes / status.maxBytes, 1)
												: 0;
										return (
											<tr key={device.id}>
												<td className="cell-strong">{device.name}</td>
												<td>
													<div className="storage-usage">
														{formatBytes(status.usedBytes)} /{" "}
														{formatBytes(status.maxBytes)}
													</div>
													<div className="storage-meter">
														<span style={{ width: `${ratio * 100}%` }} />
													</div>
												</td>
												<td>最大 {status.retentionDays}日</td>
												<td>{formatTime(status.oldestAt)}</td>
											</tr>
										);
									})}
								</tbody>
							</table>
						</div>
					) : null}
				</Card>
			</div>

			{deletingBackup && (
				<Modal
					title="Backupを削除"
					onClose={closeDeleteBackup}
					footer={
						<>
							<button
								type="button"
								className="btn btn--ghost"
								disabled={deletingBackupNow}
								onClick={closeDeleteBackup}
							>
								キャンセル
							</button>
							<button
								type="button"
								className="btn btn--danger"
								disabled={deletingBackupNow}
								onClick={() => void deleteBackup()}
							>
								{deletingBackupNow && <Spinner />}
								{deletingBackupNow ? "削除中…" : "削除する"}
							</button>
						</>
					}
				>
					<p>この操作は元に戻せません。Backup archiveを削除します。</p>
					<p className="hint">
						{formatTime(deletingBackup.createdAt)}・
						{formatBytes(deletingBackup.sizeBytes)}
					</p>
					{backupDeleteError && (
						<Notice tone="error">{backupDeleteError}</Notice>
					)}
				</Modal>
			)}
		</>
	);
}

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	const units = ["KiB", "MiB", "GiB", "TiB"];
	let value = bytes;
	let unit = "B";
	for (const next of units) {
		value /= 1024;
		unit = next;
		if (value < 1024) break;
	}
	return `${value.toFixed(value >= 10 ? 0 : 1)} ${unit}`;
}

function apiMessage(error: unknown, fallback: string): string {
	if (error instanceof ApiError && error.status === 401)
		return "Sessionの有効期限が切れています。もう一度Loginしてください。";
	if (error instanceof ApiError && error.status === 403)
		return "この操作はAdminだけが実行できます。";
	return error instanceof ApiError ? error.message : fallback;
}
