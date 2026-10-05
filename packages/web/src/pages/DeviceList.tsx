import { useEffect, useState } from "react";
import { api, type Device, type Site, type Tag, type User } from "../api.ts";
import {
	Badge,
	Card,
	Empty,
	Field,
	formatTime,
	formatValue,
	Loading,
	Notice,
	PresenceBadge,
} from "../ui.tsx";

/** Enrollment(#23)の結果。CLI blockはそのままRouterへ貼れる形で表示する。 */
type Enrolled = { code: string; expiresAt: string; cliBlock: string };

export function DeviceList({
	user,
	instanceName,
}: {
	user: User;
	instanceName: string | null;
}) {
	const [devices, setDevices] = useState<Device[] | null>(null);
	const [sites, setSites] = useState<Site[] | null>(null);
	const [tags, setTags] = useState<Tag[] | null>(null);
	const [siteId, setSiteId] = useState("");
	const [tagId, setTagId] = useState("");
	const [name, setName] = useState("");
	const [adding, setAdding] = useState(false);
	const [enrolled, setEnrolled] = useState<Enrolled | null>(null);
	const [copied, setCopied] = useState(false);
	const [error, setError] = useState<string | null>(null);

	async function loadDevices() {
		setError(null);
		try {
			setDevices(
				(
					await api.devices({
						siteId: siteId || undefined,
						tagId: tagId || undefined,
					})
				).devices,
			);
		} catch (cause) {
			setError((cause as Error).message);
		}
	}

	async function loadMetadata() {
		try {
			const [siteResponse, tagResponse] = await Promise.all([
				api.sites(),
				api.tags(),
			]);
			setSites(siteResponse.sites);
			setTags(tagResponse.tags);
		} catch (cause) {
			setError((cause as Error).message);
		}
	}

	// Deviceの絞り込みを変更したら、サーバー側の絞り込み結果を読み直す。
	// biome-ignore lint/correctness/useExhaustiveDependencies: フィルター変更時に読む
	useEffect(() => {
		void loadDevices();
	}, [siteId, tagId]);
	// biome-ignore lint/correctness/useExhaustiveDependencies: 初回のみ読む
	useEffect(() => {
		void loadMetadata();
	}, []);

	async function addDevice() {
		if (!name.trim()) return;
		setError(null);
		try {
			const created = await api.createDevice(name.trim());
			setEnrolled(created.enrollment);
			setCopied(false);
			setName("");
			setAdding(false);
			await loadDevices();
		} catch (e) {
			setError((e as Error).message);
		}
	}

	return (
		<>
			<header className="topbar">
				<h1>Devices</h1>
				{instanceName && <span className="topbar__meta">{instanceName}</span>}
			</header>

			<div className="content">
				{enrolled && (
					<Card
						title="ルーターに貼り付けてください"
						actions={
							<>
								<button
									type="button"
									className="btn"
									onClick={() => {
										void navigator.clipboard
											?.writeText(enrolled.cliBlock)
											.then(() => setCopied(true));
									}}
								>
									{copied ? "コピーしました" : "コピー"}
								</button>
								<button
									type="button"
									className="btn btn--ghost"
									onClick={() => setEnrolled(null)}
								>
									閉じる
								</button>
							</>
						}
					>
						<div className="stack">
							<div className="row">
								<Badge tone="accent" plain>
									{enrolled.code}
								</Badge>
								<span className="hint">
									{formatTime(enrolled.expiresAt)}まで有効(1回だけ使えます)
								</span>
							</div>
							<pre>{enrolled.cliBlock}</pre>
							<p className="hint">
								ルーターのコンソールへ2行そのまま貼り付けてください。Supervisorの自動起動scheduleが
								未設定の場合は登録時に1行追加してsaveします。未保存の設定変更があれば一緒に保存されます。
							</p>
							<p className="hint">
								すでに設定済みのscheduleは追加しません。Supervisor経由でAgentが起動すると、
								この一覧にOnlineとして現れます。
							</p>
						</div>
					</Card>
				)}

				{error && <Notice tone="error">{error}</Notice>}

				{!devices ? (
					<Loading />
				) : (
					<Card
						title={`${devices.length} 台`}
						actions={
							<>
								{sites && (
									<select
										value={siteId}
										onChange={(e) => setSiteId(e.target.value)}
									>
										<option value="">すべてのSite</option>
										{sites.map((site) => (
											<option key={site.id} value={site.id}>
												{site.name}
											</option>
										))}
									</select>
								)}
								{tags && (
									<select
										value={tagId}
										onChange={(e) => setTagId(e.target.value)}
									>
										<option value="">すべてのTag</option>
										{tags.map((tag) => (
											<option key={tag.id} value={tag.id}>
												{tag.name}
											</option>
										))}
									</select>
								)}
								{user.role === "admin" && !adding && (
									<button
										type="button"
										className="btn btn--primary"
										onClick={() => setAdding(true)}
									>
										Deviceを追加
									</button>
								)}
							</>
						}
						flush
					>
						{adding && (
							<div className="card__body">
								<div className="toolbar">
									<Field label="Device名">
										<input
											value={name}
											placeholder="例: 本社 RTX830"
											// biome-ignore lint/a11y/noAutofocus: 追加操作の直後に入力する
											autoFocus
											onChange={(e) => setName(e.target.value)}
											onKeyDown={(e) => {
												if (e.key === "Enter") void addDevice();
											}}
										/>
									</Field>
									<button
										type="button"
										className="btn btn--primary"
										disabled={!name.trim()}
										onClick={() => void addDevice()}
									>
										Enrollment Codeを発行
									</button>
									<button
										type="button"
										className="btn btn--ghost"
										onClick={() => {
											setAdding(false);
											setName("");
										}}
									>
										やめる
									</button>
								</div>
							</div>
						)}

						{devices.length === 0 ? (
							<Empty title="Deviceがありません">
								{siteId || tagId
									? "選択した条件に一致するDeviceがありません。"
									: user.role === "admin"
										? "「Deviceを追加」でEnrollment Codeを発行し、ルーターへ貼り付けてください。"
										: "Adminがルーターを登録すると、ここに一覧が出ます。"}
							</Empty>
						) : (
							<div className="table-wrap">
								<table>
									<thead>
										<tr>
											<th>Device</th>
											<th>状態</th>
											<th>Site</th>
											<th>Tag</th>
											<th>Model</th>
											<th>Firmware</th>
											<th>Agent</th>
											<th>Last seen</th>
										</tr>
									</thead>
									<tbody>
										{devices.map((device) => (
											<tr key={device.id}>
												<td className="cell-strong">
													<a href={`#/devices/${device.id}`}>{device.name}</a>
												</td>
												<td>
													<div className="row">
														{device.lifecycle === "pending" ? (
															<Badge tone="accent">未Enrollment</Badge>
														) : device.lifecycle === "disabled" ? (
															<Badge tone="danger">無効</Badge>
														) : (
															<PresenceBadge status={device.presence.status} />
														)}
														{device.configState === "unsaved" && (
															<Badge tone="warn">未保存</Badge>
														)}
													</div>
												</td>
												<td>{formatValue(device.siteName)}</td>
												<td>
													{device.tags.length > 0 ? (
														<div className="row">
															{device.tags.map((tag) => (
																<Badge key={tag.id} tone="neutral" plain>
																	{tag.name}
																</Badge>
															))}
														</div>
													) : (
														formatValue(null)
													)}
												</td>
												<td>{formatValue(device.model)}</td>
												<td>{formatValue(device.firmwareRevision)}</td>
												<td className="mono">
													{formatValue(device.agentVersion)}
												</td>
												<td>{formatTime(device.presence.lastSeenAt)}</td>
											</tr>
										))}
									</tbody>
								</table>
							</div>
						)}
					</Card>
				)}
			</div>
		</>
	);
}
