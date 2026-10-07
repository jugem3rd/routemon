import { useEffect, useState } from "react";
import {
	type AgentState,
	ApiError,
	api,
	type ConfigApply,
	type ConfigApplyDetails,
	type ConfigBackup,
	type ConfigDiff,
	type Device,
	type DeviceEvent,
	type DeviceProfile,
	type DeviceRouteSnapshot,
	type DeviceRoutes,
	isBatchActiveError,
	type Job,
	type ObservedRoute,
	type Site,
	subscribeSyslog,
	type Tag,
	type User,
} from "../api.ts";
import {
	Badge,
	Card,
	Empty,
	Field,
	formatTime,
	formatUptime,
	formatValue,
	Loading,
	Modal,
	Notice,
	PresenceBadge,
	RISK_LABEL,
	Spinner,
	StatusBadge,
} from "../ui.tsx";

type Tab =
	| "overview"
	| "events"
	| "routes"
	| "power"
	| "config"
	| "syslog"
	| "commands";
type Line = { ts: string; message: string };

const MAX_SYSLOG_TIME_RANGE_MS = 24 * 60 * 60 * 1000;
const MAX_SYSLOG_RESULT_LINES = 10_000;

const TABS: [Tab, string][] = [
	["overview", "概要"],
	["events", "イベント"],
	["routes", "経路"],
	["power", "電源"],
	["config", "CONFIG"],
	["syslog", "SYSLOG"],
	["commands", "Command"],
];

export function DeviceDetail({
	deviceId,
	user,
}: {
	deviceId: string;
	user: User;
}) {
	const [device, setDevice] = useState<Device | null>(null);
	const [tab, setTab] = useState<Tab>("overview");
	// 再起動中はheaderの状態表示も切り替える(#54)
	const [rebootingSince, setRebootingSince] = useState<number | null>(null);

	useEffect(() => {
		let active = true;
		const load = () =>
			api.device(deviceId).then((r) => {
				if (active) setDevice(r.device);
			});
		void load();
		const timer = setInterval(() => void load(), 10_000);
		return () => {
			active = false;
			clearInterval(timer);
		};
	}, [deviceId]);

	return (
		<>
			<header className="topbar">
				<a className="btn btn--ghost" href="#/devices">
					← Devices
				</a>
				<h1>{device?.name ?? "…"}</h1>
				{device &&
					(rebootingSince !== null ? (
						<Badge tone="warn">再起動中</Badge>
					) : device.lifecycle === "disabled" ? (
						<Badge tone="danger">無効</Badge>
					) : (
						<PresenceBadge status={device.presence.status} />
					))}
				{device?.presence.lastSeenAt && (
					<span className="topbar__meta">
						last seen {formatTime(device.presence.lastSeenAt)}
					</span>
				)}
			</header>

			<div className="content">
				{!device ? (
					<Loading />
				) : (
					<>
						<div className="tabs" role="tablist">
							{TABS.map(([key, label]) => (
								<button
									type="button"
									role="tab"
									key={key}
									className="tab"
									aria-selected={tab === key}
									onClick={() => setTab(key)}
								>
									{label}
								</button>
							))}
						</div>

						{tab === "overview" && (
							<Overview device={device} user={user} onChanged={setDevice} />
						)}
						{tab === "events" && <Events deviceId={deviceId} />}
						{tab === "routes" && <Routes deviceId={deviceId} user={user} />}
						{tab === "power" && (
							<Power
								device={device}
								user={user}
								rebootingSince={rebootingSince}
								onRebooted={setRebootingSince}
							/>
						)}
						{tab === "config" && (
							<Config
								device={device}
								deviceId={deviceId}
								user={user}
								onDeviceChanged={setDevice}
							/>
						)}
						{tab === "syslog" && <Syslog deviceId={deviceId} />}
						{tab === "commands" && <Commands deviceId={deviceId} user={user} />}
					</>
				)}
			</div>
		</>
	);
}

/** Eventの表示名と、色の区分。未知の種別は、種別名のまま中立の色で出す。 */
const EVENT_LABELS: Record<string, string> = {
	"ppp.up": "PPP接続",
	"ppp.down": "PPP切断",
	"tunnel.up": "Tunnel接続",
	"tunnel.down": "Tunnel切断",
	"ip.changed": "WANのIPアドレス変更",
	"device.rebooted": "再起動",
	"agent.online": "Agentがオンライン",
	"agent.offline": "Agentがオフライン",
	"agent.rollback": "Agentをrollback",
	"agent.recovered": "Agentを復旧",
	"supervisor.rollback": "Supervisorをrollback",
	"event.flapping": "状態が頻繁に変化(フラッピング)",
	"event.limit_reached": "1日のEvent数の上限に達した",
};

/** Eventのdetailを、1行の説明にする。Raw SYSLOG行は載せない。 */
export function formatEventDetail(
	type: string,
	detail: Record<string, unknown> | null,
): string {
	if (!detail) return "";
	const text = (key: string) =>
		detail[key] === undefined || detail[key] === null
			? null
			: String(detail[key]);
	const parts: (string | null)[] = [];
	switch (type) {
		case "ppp.up":
		case "ppp.down":
			parts.push(text("pp") && `PP ${text("pp")}`, text("cause"));
			break;
		case "tunnel.up":
		case "tunnel.down":
			parts.push(text("tunnel") && `Tunnel ${text("tunnel")}`);
			break;
		case "ip.changed":
			parts.push(
				text("pp") && `PP ${text("pp")}`,
				text("from") && text("to") && `${text("from")} → ${text("to")}`,
			);
			break;
		case "device.rebooted":
			parts.push(
				text("booted_at") && `起動時刻 ${formatTime(String(detail.booted_at))}`,
			);
			break;
		case "agent.offline":
			parts.push(
				text("last_seen_at") &&
					`最後の通信 ${formatTime(String(detail.last_seen_at))}`,
			);
			break;
		case "event.flapping":
			parts.push(
				text("target"),
				text("transitions") &&
					text("window_seconds") &&
					`${text("window_seconds")}秒に${text("transitions")}回以上`,
			);
			break;
		default:
			return Object.entries(detail)
				.map(([key, value]) => `${key}: ${String(value)}`)
				.join(", ");
	}
	return parts.filter(Boolean).join(" / ");
}

function eventTone(event: DeviceEvent): "warn" | "ok" | "neutral" {
	if (event.severity === "warning") return "warn";
	if (event.severity === "info") return "ok";
	return "neutral";
}

const EVENTS_PAGE_SIZE = 50;

/** 「イベント」タブ。SYSLOG等から抽出した状態変化の履歴(Raw SYSLOGとは別、#6)。 */
function Events({ deviceId }: { deviceId: string }) {
	const [events, setEvents] = useState<DeviceEvent[] | null>(null);
	const [hasMore, setHasMore] = useState(false);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);

	// 最初のページ(新しいEvent)を、30秒ごとに読み直す。続きを読み込んだ後も、先頭だけ更新する
	useEffect(() => {
		let active = true;
		const load = () =>
			api
				.deviceEvents(deviceId, { limit: EVENTS_PAGE_SIZE })
				.then((result) => {
					if (!active) return;
					setError(null);
					setEvents((current) => {
						if (!current) {
							setHasMore(result.hasMore);
							return result.events;
						}
						const known = new Set(result.events.map((event) => event.id));
						return [
							...result.events,
							...current.filter((event) => !known.has(event.id)),
						].sort(compareEventsNewestFirst);
					});
				})
				.catch((cause: unknown) => {
					if (active)
						setError(
							cause instanceof Error ? cause.message : "取得に失敗しました",
						);
				});
		void load();
		const timer = setInterval(() => void load(), 30_000);
		return () => {
			active = false;
			clearInterval(timer);
		};
	}, [deviceId]);

	const loadMore = async () => {
		const last = events?.at(-1);
		if (!last) return;
		setLoading(true);
		try {
			const result = await api.deviceEvents(deviceId, {
				limit: EVENTS_PAGE_SIZE,
				before: last.occurredAt,
				beforeSeq: last.seq,
			});
			setEvents((current) => [...(current ?? []), ...result.events]);
			setHasMore(result.hasMore);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : "取得に失敗しました");
		} finally {
			setLoading(false);
		}
	};

	if (!events)
		return error ? <Notice tone="error">{error}</Notice> : <Loading />;

	return (
		<Card title="イベント" flush>
			{error && <Notice tone="error">{error}</Notice>}
			{events.length === 0 ? (
				<Empty title="イベントはまだありません">
					PPPやTunnelの接続・切断、WANのIPアドレスの変更、再起動、Agentの接続の変化が、ここに記録されます。
				</Empty>
			) : (
				<div className="table-wrap">
					<table>
						<thead>
							<tr>
								<th>日時</th>
								<th>種別</th>
								<th>内容</th>
							</tr>
						</thead>
						<tbody>
							{events.map((event) => (
								<tr key={event.id}>
									<td>{formatTime(event.occurredAt)}</td>
									<td>
										<Badge tone={eventTone(event)}>
											{EVENT_LABELS[event.type] ?? event.type}
										</Badge>
									</td>
									<td className="mono">
										{formatEventDetail(event.type, event.detail)}
									</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			)}
			{hasMore && (
				<div style={{ padding: "12px 16px" }}>
					<button
						type="button"
						className="btn"
						disabled={loading}
						onClick={() => void loadMore()}
					>
						{loading ? <Spinner /> : "さらに読み込む"}
					</button>
				</div>
			)}
		</Card>
	);
}

function compareEventsNewestFirst(a: DeviceEvent, b: DeviceEvent): number {
	if (a.occurredAt !== b.occurredAt)
		return a.occurredAt < b.occurredAt ? 1 : -1;
	return b.seq - a.seq;
}

/**
 * 「経路」タブ。Configuredは`/profile`の静的経路、Observedは`/routes`の
 * 経路表snapshotを別セクションで表示する(#134)。両者を混ぜたり
 * 一致判定したりしない(設計8章)。
 */
function Routes({ deviceId, user }: { deviceId: string; user: User }) {
	const [profile, setProfile] = useState<DeviceProfile | null>(null);
	const [profileLoading, setProfileLoading] = useState(true);
	const [profileError, setProfileError] = useState<string | null>(null);
	const [routes, setRoutes] = useState<DeviceRoutes | null>(null);
	const [routesLoading, setRoutesLoading] = useState(true);
	const [routesError, setRoutesError] = useState<string | null>(null);
	const [refreshing, setRefreshing] = useState(false);
	const [refreshError, setRefreshError] = useState<string | null>(null);

	useEffect(() => {
		let active = true;
		setProfile(null);
		setProfileLoading(true);
		setProfileError(null);
		setRoutes(null);
		setRoutesLoading(true);
		setRoutesError(null);
		setRefreshError(null);
		api
			.profile(deviceId)
			.then((response) => {
				if (active) setProfile(response.profile);
			})
			.catch((cause: unknown) => {
				if (active) {
					setProfileError(
						cause instanceof Error
							? cause.message
							: "Device Profileを読み込めませんでした",
					);
				}
			})
			.finally(() => {
				if (active) setProfileLoading(false);
			});
		api
			.deviceRoutes(deviceId)
			.then((response) => {
				if (active) setRoutes(response);
			})
			.catch((cause: unknown) => {
				if (active) {
					setRoutesError(
						cause instanceof Error
							? cause.message
							: "経路表を読み込めませんでした",
					);
				}
			})
			.finally(() => {
				if (active) setRoutesLoading(false);
			});
		return () => {
			active = false;
		};
	}, [deviceId]);

	async function onRefresh() {
		setRefreshing(true);
		setRefreshError(null);
		try {
			setRoutes(await api.refreshDeviceRoutes(deviceId));
		} catch (cause) {
			setRefreshError(refreshErrorMessage(cause));
		} finally {
			setRefreshing(false);
		}
	}

	return (
		<RoutesView
			profile={profile}
			profileLoading={profileLoading}
			profileError={profileError}
			routes={routes}
			routesLoading={routesLoading}
			routesError={routesError}
			role={user.role}
			refreshing={refreshing}
			refreshError={refreshError}
			onRefresh={() => void onRefresh()}
		/>
	);
}

/** 再取得が409のときはofflineか実行中のため、その旨を伝える(設計7章)。 */
function refreshErrorMessage(cause: unknown): string {
	if (cause instanceof ApiError && cause.status === 409) {
		return "Deviceがofflineのため再取得できません。実行中の場合は完了後に試してください。";
	}
	return cause instanceof Error
		? cause.message
		: "経路表を再取得できませんでした";
}

/** Observed snapshotが24時間より古いときに「古い観測」を出す(設計8章)。 */
export const OBSERVED_STALE_MS = 24 * 60 * 60 * 1000;

export function isObservedStale(capturedAt: string | null): boolean {
	if (!capturedAt) return false;
	const elapsed = Date.now() - Date.parse(capturedAt);
	return Number.isFinite(elapsed) && elapsed > OBSERVED_STALE_MS;
}

/**
 * fetchを持たない純粋な経路タブ表示。SSR描画テストはここを直接描く
 * (BulkAppliesのPlanView/ResultViewと同じ書き方)。
 */
export function RoutesView({
	profile,
	profileLoading,
	profileError,
	routes,
	routesLoading,
	routesError,
	role,
	refreshing,
	refreshError,
	onRefresh,
}: {
	profile: DeviceProfile | null;
	profileLoading: boolean;
	profileError: string | null;
	routes: DeviceRoutes | null;
	routesLoading: boolean;
	routesError: string | null;
	role: User["role"];
	refreshing: boolean;
	refreshError: string | null;
	onRefresh: () => void;
}) {
	const configured = profile?.routes ?? [];
	const tunnels = profile?.tunnels ?? [];
	const ipsecTunnels = profile?.ipsecTunnels ?? [];

	return (
		<div className="stack">
			<Notice tone="accent">
				ConfiguredはCONFIGに書かれた設定値、Observedは取得日時点でルーターが保持していた経路表です。情報源が異なるため、一致・不一致の判定はしません。
			</Notice>
			{profileError && <Notice tone="error">{profileError}</Notice>}
			<Card title="Configured — CONFIGに設定された経路" flush>
				{profileLoading ? (
					<Loading />
				) : profileError ? null : profile === null ? (
					<Empty title="CONFIG未取得">
						CONFIGがまだ取り込まれていないため、経路を表示できません。
					</Empty>
				) : configured.length === 0 ? (
					<>
						<p className="hint">CONFIG取得: {formatTime(profile.capturedAt)}</p>
						<Empty title="設定された静的経路はありません" />
					</>
				) : (
					<>
						<p className="hint">CONFIG取得: {formatTime(profile.capturedAt)}</p>
						<div className="table-wrap">
							<table>
								<thead>
									<tr>
										<th>宛先prefix</th>
										<th>Gateway</th>
										<th>出口interface</th>
										<th>Default route</th>
									</tr>
								</thead>
								<tbody>
									{configured.map((route) => {
										const tunnelNumber = routeTunnelNumber(route);
										const hasTunnel =
											tunnelNumber !== undefined &&
											tunnels.some((tunnel) => tunnel.id === tunnelNumber);
										return (
											<tr
												key={`${route.destination}:${route.gateway.value}:${route.interface ?? ""}:${route.tunnel ?? ""}`}
											>
												<td className="mono">{route.destination}</td>
												<td className="mono">
													{hasTunnel ? (
														<a
															className="route-tunnel-link"
															href={`#vpn-tunnel-${tunnelNumber}`}
															onClick={(event) => {
																event.preventDefault();
																document
																	.getElementById(`vpn-tunnel-${tunnelNumber}`)
																	?.scrollIntoView({
																		behavior: "smooth",
																		block: "nearest",
																	});
															}}
														>
															{route.gateway.value}
														</a>
													) : (
														route.gateway.value
													)}
												</td>
												<td className="mono">{routeExitInterface(route)}</td>
												<td>
													{route.destination === "default" ? "はい" : "いいえ"}
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
			<Card
				title="Observed — ルーターが現在保持する経路表"
				actions={
					role === "admin" ? (
						<button
							type="button"
							className="btn"
							disabled={refreshing || routesLoading}
							onClick={onRefresh}
						>
							{refreshing ? "再取得中…" : "再取得"}
						</button>
					) : undefined
				}
			>
				<p className="hint">
					取得日時点でRouterが持つ経路表です。CONFIGの設定値(上)とは情報源が異なります。
				</p>
				{refreshError && <Notice tone="error">{refreshError}</Notice>}
				{routesLoading ? (
					<Loading />
				) : routesError ? (
					<Notice tone="error">{routesError}</Notice>
				) : (
					routes && (
						<>
							<ObservedFamilySection family="ipv4" snapshot={routes.ipv4} />
							<ObservedFamilySection family="ipv6" snapshot={routes.ipv6} />
						</>
					)
				)}
			</Card>
			{profile && tunnels.length > 0 && (
				<Card title="VPN tunnel情報" flush>
					<div className="table-wrap">
						<table>
							<thead>
								<tr>
									<th>Tunnel</th>
									<th>Encapsulation</th>
									<th>Local endpoint</th>
									<th>Remote endpoint</th>
								</tr>
							</thead>
							<tbody>
								{tunnels.map((tunnel) => {
									const ipsec = ipsecTunnels.find(
										(item) => item.id === tunnel.id,
									);
									return (
										<tr id={`vpn-tunnel-${tunnel.id}`} key={tunnel.id}>
											<td className="mono">tunnel {tunnel.id}</td>
											<td>{tunnel.encapsulation}</td>
											<td className="mono">
												{ipsec?.localEndpoint?.value ?? "—"}
											</td>
											<td className="mono">
												{ipsec?.remoteEndpoint?.value ?? "—"}
											</td>
										</tr>
									);
								})}
							</tbody>
						</table>
					</div>
				</Card>
			)}
		</div>
	);
}

/**
 * familyごとのObserved表示(設計8章)。状態はfamily単位で持ち、
 * Configuredとは混ぜない。
 */
export function ObservedFamilySection({
	family,
	snapshot,
}: {
	family: "ipv4" | "ipv6";
	snapshot: DeviceRouteSnapshot | null;
}) {
	const label = family === "ipv4" ? "IPv4" : "IPv6";
	if (snapshot === null) {
		return (
			<section aria-label={`Observed ${label}`}>
				<h3>{label}</h3>
				<Empty title="未取得">経路表をまだ取得していません。</Empty>
			</section>
		);
	}
	const failed = snapshot.lastAttemptStatus === "failed";
	const partial = snapshot.lastAttemptStatus === "partial";
	return (
		<section aria-label={`Observed ${label}`}>
			<h3>
				{label}
				{snapshot.capturedAt && isObservedStale(snapshot.capturedAt) && (
					<>
						{" "}
						<Badge tone="warn">古い観測</Badge>
					</>
				)}
			</h3>
			<p className="hint">
				最終取得: {formatTime(snapshot.capturedAt)}
				{snapshot.capturedAt && isObservedStale(snapshot.capturedAt)
					? " (24時間より古い観測です)"
					: ""}
			</p>
			{failed && (
				<Notice tone="error">
					前回取得に失敗しました。下は前回取得できた内容です。
				</Notice>
			)}
			{snapshot.capturedAt === null ? (
				<Empty title="前回取得に失敗しました">
					取得できた経路表がまだありません。
					{snapshot.lastAttemptAt &&
						` (前回試行: ${formatTime(snapshot.lastAttemptAt)})`}
				</Empty>
			) : snapshot.routes.length === 0 ? (
				<Empty title="経路なし" />
			) : (
				<div className="table-wrap">
					<table>
						<thead>
							<tr>
								<th>宛先</th>
								<th>Gateway</th>
								<th>出口</th>
								<th>種別 / 付加情報</th>
							</tr>
						</thead>
						<tbody>
							{snapshot.routes.map((route) => (
								<tr
									key={`${route.destination}:${route.gateway ?? "-"}:${route.interface ?? "-"}:${route.rawType}:${route.protocol ?? ""}:${route.metric ?? ""}:${route.cost ?? ""}:${route.rawDetails ?? ""}`}
								>
									<td className="mono">{route.destination}</td>
									<td className="mono">{route.gateway ?? "—"}</td>
									<td className="mono">{route.interface ?? "—"}</td>
									<td>
										<ObservedCategoryBadge route={route} />
										{route.rawDetails && (
											<span className="mono"> {route.rawDetails}</span>
										)}
									</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			)}
			{partial && (
				<>
					<Notice tone="error">
						一部の行を解析できませんでした。下は未解析の行です。
					</Notice>
					<pre className="mono">{snapshot.unparsedLines.join("\n")}</pre>
				</>
			)}
		</section>
	);
}

/** Observed行の分類をbadgeで区別する(設計8章)。 */
function ObservedCategoryBadge({ route }: { route: ObservedRoute }) {
	switch (route.category) {
		case "static":
			return <Badge tone="neutral">static</Badge>;
		case "dynamic":
			return <Badge tone="accent">{route.protocol ?? "dynamic"}</Badge>;
		case "implicit":
			return <Badge tone="ok">implicit</Badge>;
		case "temporary":
			return <Badge tone="warn">temporary</Badge>;
		default:
			return <Badge tone="danger">{route.rawType || "unknown"}</Badge>;
	}
}

function routeTunnelNumber(
	route: DeviceProfile["routes"][number],
): number | undefined {
	if (route.gateway.kind !== "tunnel") return undefined;
	if (route.tunnel !== undefined) return route.tunnel;
	const match = /^tunnel (\d+)$/.exec(route.gateway.value);
	return match ? Number(match[1]) : undefined;
}

function routeExitInterface(route: DeviceProfile["routes"][number]): string {
	if (route.interface) return route.interface;
	if (route.gateway.kind === "pp") {
		const match = /^pp (\d+)$/.exec(route.gateway.value);
		if (match) return `pp${match[1]}`;
	}
	const tunnelNumber = routeTunnelNumber(route);
	return tunnelNumber !== undefined ? `tunnel${tunnelNumber}` : "—";
}

function Overview({
	device,
	user,
	onChanged,
}: {
	device: Device;
	user: User;
	onChanged: (device: Device) => void;
}) {
	const [error, setError] = useState<string | null>(null);

	async function openNativeGui() {
		setError(null);
		try {
			const { session } = await api.webguiSession(device.id);
			open(session.url, "_blank", "noopener");
		} catch {
			setError("Native WebGUIを開けませんでした");
		}
	}

	return (
		<>
			<Card title="基本情報">
				<dl className="kv">
					<dt>Model</dt>
					<dd>{formatValue(device.model)}</dd>
					<dt>Serial</dt>
					<dd className="mono">{formatValue(device.serialNumber)}</dd>
					<dt>Firmware</dt>
					<dd>{formatValue(device.firmwareRevision)}</dd>
					<dt>Hostname</dt>
					<dd>{formatValue(device.hostname)}</dd>
					<dt>Site</dt>
					<dd>{formatValue(device.siteName)}</dd>
					<dt>Tag</dt>
					<dd>
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
					</dd>
					<dt>説明</dt>
					<dd>{formatValue(device.description)}</dd>
					<dt>メモ</dt>
					<dd>{formatValue(device.notes)}</dd>
					<dt>Lifecycle</dt>
					<dd>
						<Badge
							tone={
								device.lifecycle === "active"
									? "ok"
									: device.lifecycle === "disabled"
										? "danger"
										: "accent"
							}
						>
							{device.lifecycle}
						</Badge>
					</dd>
					<dt>登録日時</dt>
					<dd>{formatTime(device.registeredAt)}</dd>
					<dt>起動日時</dt>
					<dd>
						{formatTime(device.bootedAt)}
						{device.bootedAt && (
							<span className="hint">
								{" "}
								({formatUptime(device.bootedAt)}稼働)
							</span>
						)}
					</dd>
					<dt>Observed IP</dt>
					<dd className="mono">
						{formatValue(device.presence.observedSourceIp)}
					</dd>
				</dl>
			</Card>

			{user.role === "admin" && (
				<DeviceManagement device={device} onChanged={onChanged} />
			)}

			<Agent deviceId={device.id} user={user} />

			{/* Native WebGUIはAdminのみ(docs/core/access-control-design.md §5) */}
			{user.role === "admin" && (
				<Card
					title="Advanced"
					actions={
						<button
							type="button"
							className="btn"
							onClick={() => void openNativeGui()}
						>
							YAMAHA Native WebGUIを開く
						</button>
					}
				>
					<p className="hint">
						Routemonが中継してルーター本体の画面を開きます。 操作はaudit
						logに記録され、Adminだけが利用できます。
					</p>
					{error && <Notice tone="error">{error}</Notice>}
				</Card>
			)}
		</>
	);
}

type ManagementAction = "edit" | "disable" | "delete" | null;

function DeviceManagement({
	device,
	onChanged,
}: {
	device: Device;
	onChanged: (device: Device) => void;
}) {
	const [action, setAction] = useState<ManagementAction>(null);
	const [name, setName] = useState("");
	const [siteId, setSiteId] = useState("");
	const [tagIds, setTagIds] = useState<string[]>([]);
	const [sites, setSites] = useState<Site[] | null>(null);
	const [tags, setTags] = useState<Tag[] | null>(null);
	const [description, setDescription] = useState("");
	const [notes, setNotes] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		let active = true;
		Promise.all([api.sites(), api.tags()])
			.then(([siteResponse, tagResponse]) => {
				if (!active) return;
				setSites(siteResponse.sites);
				setTags(tagResponse.tags);
			})
			.catch((cause) => {
				if (active) setError((cause as Error).message);
			});
		return () => {
			active = false;
		};
	}, []);

	function startEdit() {
		setName(device.name);
		setSiteId(device.siteId ?? "");
		setTagIds(device.tags.map((tag) => tag.id));
		setDescription(device.description ?? "");
		setNotes(device.notes ?? "");
		setError(null);
		setAction("edit");
	}

	function closeAction() {
		if (!busy) setAction(null);
	}

	async function save() {
		if (!name.trim()) {
			setError("Device名を入力してください");
			return;
		}
		setBusy(true);
		setError(null);
		try {
			const result = await api.updateDevice(device.id, {
				name: name.trim(),
				siteId: siteId.trim() || null,
				tagIds,
				description: description.trim() || null,
				notes: notes.trim() || null,
			});
			onChanged(result.device);
			setAction(null);
		} catch (cause) {
			setError(
				cause instanceof Error ? cause.message : "Deviceを更新できませんでした",
			);
		} finally {
			setBusy(false);
		}
	}

	async function enable() {
		setBusy(true);
		setError(null);
		try {
			const result = await api.enableDevice(device.id);
			onChanged(result.device);
		} catch (cause) {
			setError(
				cause instanceof Error
					? cause.message
					: "Deviceを有効化できませんでした",
			);
		} finally {
			setBusy(false);
		}
	}

	async function disable() {
		setBusy(true);
		setError(null);
		try {
			const result = await api.disableDevice(device.id);
			onChanged(result.device);
			setAction(null);
		} catch (cause) {
			setError(
				cause instanceof Error
					? cause.message
					: "Deviceを無効化できませんでした",
			);
		} finally {
			setBusy(false);
		}
	}

	async function remove() {
		setBusy(true);
		setError(null);
		try {
			await api.deleteDevice(device.id);
			location.hash = "#/devices";
		} catch (cause) {
			setError(
				cause instanceof Error ? cause.message : "Deviceを削除できませんでした",
			);
			setBusy(false);
		}
	}

	return (
		<>
			<Card title="Device管理">
				<div className="stack">
					<div className="row">
						<button type="button" className="btn" onClick={startEdit}>
							編集
						</button>
						{device.lifecycle === "disabled" ? (
							<button
								type="button"
								className="btn btn--primary"
								disabled={busy}
								onClick={() => void enable()}
							>
								{busy ? "処理中…" : "有効化"}
							</button>
						) : (
							<button
								type="button"
								className="btn"
								disabled={busy}
								onClick={() => setAction("disable")}
							>
								無効化
							</button>
						)}
						<button
							type="button"
							className="btn btn--danger"
							disabled={busy}
							onClick={() => {
								setError(null);
								setAction("delete");
							}}
						>
							削除
						</button>
					</div>
					<p className="hint">
						無効化するとCredentialを保持したままAgentのsyncを拒否します。有効化すると再接続できます。
					</p>
					{error && !action && <Notice tone="error">{error}</Notice>}
				</div>
			</Card>

			{action === "edit" && (
				<Modal
					title="Deviceを編集"
					onClose={closeAction}
					footer={
						<>
							<button
								type="button"
								className="btn btn--ghost"
								disabled={busy}
								onClick={closeAction}
							>
								キャンセル
							</button>
							<button
								type="button"
								className="btn btn--primary"
								disabled={busy || !name.trim()}
								onClick={() => void save()}
							>
								{busy ? "保存中…" : "保存"}
							</button>
						</>
					}
				>
					<Field label="Device名">
						<input
							value={name}
							onChange={(event) => setName(event.target.value)}
						/>
					</Field>
					<Field label="Site">
						<select
							value={siteId}
							disabled={!sites}
							onChange={(event) => setSiteId(event.target.value)}
						>
							<option value="">Siteなし</option>
							{sites?.map((site) => (
								<option key={site.id} value={site.id}>
									{site.name}
								</option>
							))}
						</select>
					</Field>
					<Field label="Tags">
						<div className="stack">
							{!tags ? (
								<span className="hint">Tagを読み込んでいます…</span>
							) : tags.length === 0 ? (
								<span className="hint">
									Tagがありません。Settingsから追加してください。
								</span>
							) : (
								tags.map((tag) => (
									<label className="checkbox" key={tag.id}>
										<input
											type="checkbox"
											checked={tagIds.includes(tag.id)}
											onChange={(event) =>
												setTagIds((current) =>
													event.target.checked
														? [...current, tag.id]
														: current.filter((id) => id !== tag.id),
												)
											}
										/>
										{tag.name}
									</label>
								))
							)}
						</div>
					</Field>
					<Field label="説明">
						<textarea
							rows={3}
							value={description}
							onChange={(event) => setDescription(event.target.value)}
						/>
					</Field>
					<Field label="メモ">
						<textarea
							rows={3}
							value={notes}
							onChange={(event) => setNotes(event.target.value)}
						/>
					</Field>
					{error && <Notice tone="error">{error}</Notice>}
				</Modal>
			)}

			{action === "disable" && (
				<Modal
					title="Deviceを無効化しますか?"
					onClose={closeAction}
					footer={
						<>
							<button
								type="button"
								className="btn btn--ghost"
								onClick={closeAction}
							>
								キャンセル
							</button>
							<button
								type="button"
								className="btn btn--danger"
								disabled={busy}
								onClick={() => void disable()}
							>
								{busy ? "処理中…" : "無効化する"}
							</button>
						</>
					}
				>
					<p>
						<strong>{device.name}</strong>{" "}
						を無効化します。Credentialは保持されますが、Agentのsyncは拒否されます。
					</p>
					{error && <Notice tone="error">{error}</Notice>}
				</Modal>
			)}

			{action === "delete" && (
				<Modal
					title="Deviceを削除しますか?"
					onClose={closeAction}
					footer={
						<>
							<button
								type="button"
								className="btn btn--ghost"
								onClick={closeAction}
							>
								キャンセル
							</button>
							<button
								type="button"
								className="btn btn--danger"
								disabled={busy}
								onClick={() => void remove()}
							>
								{busy ? "削除中…" : "削除する"}
							</button>
						</>
					}
				>
					<p>
						<strong>{device.name}</strong>{" "}
						とCredentialを削除します。このDeviceのCONFIG
						BackupとSYSLOG履歴も削除され、元に戻せません。
					</p>
					{error && <Notice tone="error">{error}</Notice>}
				</Modal>
			)}
		</>
	);
}

/**
 * 電源操作(#54)。VPSのコンパネと同じ流れにする:
 * 電源パネル -> modalで確認 -> 実行中は状態を出してボタンを止める -> 復帰したら戻る。
 *
 * Routerが落ちて応答が返らないのは正常系。RTX830では起動からAgent自動起動まで
 * 約73秒(docs/core/agent-update-design.md §17.6)。
 */
function Power({
	device,
	user,
	rebootingSince,
	onRebooted,
}: {
	device: Device;
	user: User;
	rebootingSince: number | null;
	onRebooted: (since: number | null) => void;
}) {
	const [confirming, setConfirming] = useState(false);
	const [save, setSave] = useState(false);
	const [busy, setBusy] = useState(false);
	const [elapsed, setElapsed] = useState(0);
	const [error, setError] = useState<string | null>(null);
	const [history, setHistory] = useState<Job[]>([]);
	const [scheduled, setScheduled] = useState<Job[]>([]);
	const [scheduleAt, setScheduleAt] = useState("");

	// 電源操作の履歴(#25のJobからreboot分だけを出す)と、予約中のJob
	const loadHistory = () =>
		Promise.all([api.jobs(device.id), api.scheduledJobs(device.id)]).then(
			([all, pending]) => {
				setHistory(
					all.jobs.filter(
						(job) => job.type === "reboot" && job.scheduled_at === null,
					),
				);
				setScheduled(pending.jobs);
			},
		);
	// biome-ignore lint/correctness/useExhaustiveDependencies: deviceの切り替えと再起動後に読む
	useEffect(() => {
		void loadHistory();
	}, [device.id, rebootingSince]);

	// 実行中は経過秒数を出す(VPSのコンパネと同じく、待ち時間が分かるようにする)
	useEffect(() => {
		if (rebootingSince === null) return;
		const tick = () =>
			setElapsed(Math.floor((Date.now() - rebootingSince) / 1000));
		tick();
		const timer = setInterval(tick, 1000);
		return () => clearInterval(timer);
	}, [rebootingSince]);

	// 再起動要求より後にonlineを観測したら通常表示へ戻す
	useEffect(() => {
		if (rebootingSince === null) return;
		if (device.presence.status !== "online") return;
		const seen = device.presence.lastSeenAt
			? Date.parse(device.presence.lastSeenAt)
			: 0;
		if (seen > rebootingSince) onRebooted(null);
	}, [device.presence, rebootingSince, onRebooted]);

	/** 予約の時刻はdatetime-local(ローカル時刻)。ISOへ直して送る。 */
	async function schedule() {
		setError(null);
		setBusy(true);
		try {
			await api.reboot(device.id, save, new Date(scheduleAt).toISOString());
			setScheduleAt("");
			setConfirming(false);
			await loadHistory();
		} catch (e) {
			setError((e as Error).message);
		} finally {
			setBusy(false);
		}
	}

	async function cancel(jobId: string) {
		setError(null);
		try {
			await api.cancelJob(jobId);
			await loadHistory();
		} catch (e) {
			setError((e as Error).message);
		}
	}

	async function reboot() {
		setError(null);
		setBusy(true);
		try {
			await api.reboot(device.id, save);
			onRebooted(Date.now());
			setConfirming(false);
			await loadHistory();
		} catch (e) {
			setError((e as Error).message);
		} finally {
			setBusy(false);
		}
	}

	const online = device.presence.status === "online";
	return (
		<>
			<Card title="電源操作">
				<div className="power">
					{rebootingSince !== null ? (
						<>
							<span className="power__state">
								<Spinner />
								再起動中
							</span>
							<span className="hint power__elapsed">
								{elapsed}秒経過 / Agentの再接続を待っています(通常1〜2分)
							</span>
						</>
					) : (
						<>
							<span className="power__state">
								<span className={`dot dot--${online ? "ok" : "neutral"}`} />
								{online ? "稼働中" : "接続なし"}
							</span>
							<span className="hint">
								{online
									? "再起動するとルーター配下の通信が一時的に切れます。"
									: "Deviceがonlineのときだけ操作できます。"}
							</span>
							{user.role === "admin" && (
								<button
									type="button"
									className="btn"
									style={{ marginLeft: "auto" }}
									disabled={!online}
									onClick={() => setConfirming(true)}
								>
									再起動
								</button>
							)}
						</>
					)}
				</div>
				{error && <Notice tone="error">{error}</Notice>}

				{confirming && (
					<Modal
						title="ルーターを再起動しますか?"
						onClose={() => setConfirming(false)}
						footer={
							<>
								<button
									type="button"
									className="btn btn--ghost"
									onClick={() => setConfirming(false)}
								>
									キャンセル
								</button>
								<button
									type="button"
									className="btn btn--danger"
									disabled={busy}
									onClick={() => void reboot()}
								>
									{busy ? "送信中…" : "再起動する"}
								</button>
							</>
						}
					>
						<p>
							<strong>{device.name}</strong> を再起動します。
							復帰まで1〜2分かかり、その間このルーター配下の通信は切れます。
						</p>
						<label className="checkbox">
							<input
								type="checkbox"
								checked={save}
								onChange={(e) => setSave(e.target.checked)}
							/>
							未保存の設定を保存してから再起動する
						</label>
						<p className="hint">
							保存しない場合、ルーター上の未保存の変更は失われます。
							実行者はaudit logに記録されます。
						</p>
					</Modal>
				)}
			</Card>

			{user.role === "admin" && (
				<Card title="再起動の予約">
					<div className="stack">
						<div className="toolbar">
							<Field label="実行日時">
								<input
									type="datetime-local"
									value={scheduleAt}
									onChange={(e) => setScheduleAt(e.target.value)}
								/>
							</Field>
							<label className="checkbox">
								<input
									type="checkbox"
									checked={save}
									onChange={(e) => setSave(e.target.checked)}
								/>
								保存してから再起動
							</label>
							<button
								type="button"
								className="btn"
								disabled={busy || !scheduleAt}
								onClick={() => void schedule()}
							>
								予約する
							</button>
						</div>
						<p className="hint">
							指定した時刻にRoutemonが再起動を実行します。
							その時刻にDeviceが接続していない場合は失敗として記録されます。
						</p>
						{scheduled.length > 0 && (
							<table>
								<thead>
									<tr>
										<th>実行予定</th>
										<th>操作</th>
										<th />
									</tr>
								</thead>
								<tbody>
									{scheduled.map((job) => (
										<tr key={job.id}>
											<td>{formatTime(job.scheduled_at)}</td>
											<td className="mono">{job.request}</td>
											<td>
												<button
													type="button"
													className="btn btn--ghost"
													onClick={() => void cancel(job.id)}
												>
													取り消す
												</button>
											</td>
										</tr>
									))}
								</tbody>
							</table>
						)}
					</div>
				</Card>
			)}

			<Card title="操作履歴" flush>
				{history.length === 0 ? (
					<Empty title="電源操作の履歴はありません" />
				) : (
					<div className="table-wrap">
						<table>
							<thead>
								<tr>
									<th>実行日時</th>
									<th>操作</th>
									<th>結果</th>
								</tr>
							</thead>
							<tbody>
								{history.map((job) => (
									<tr key={job.id}>
										<td>{formatTime(job.created_at)}</td>
										<td className="mono">{job.request}</td>
										<td>
											<StatusBadge status={job.status} />
										</td>
									</tr>
								))}
							</tbody>
						</table>
					</div>
				)}
			</Card>
		</>
	);
}

/** Agent version(#35)。更新はSupervisorがA/B slotで行う。 */
function Agent({ deviceId, user }: { deviceId: string; user: User }) {
	const [state, setState] = useState<AgentState | null>(null);
	const [releases, setReleases] = useState<string[]>([]);
	const [message, setMessage] = useState<string | null>(null);

	const load = () =>
		api.agent(deviceId).then((r) => {
			setState(r.agent);
			setReleases(r.releases);
		});
	// biome-ignore lint/correctness/useExhaustiveDependencies: deviceIdが変わった時だけ読み直す
	useEffect(() => {
		void load();
	}, [deviceId]);

	async function update(version: string) {
		setMessage(null);
		try {
			await api.setAgentVersion(deviceId, version);
			setMessage(`${version}への更新を指示しました。`);
			await load();
		} catch (error) {
			setMessage((error as Error).message);
		}
	}

	if (!state) return null;
	const pending =
		state.desiredAgentVersion &&
		state.desiredAgentVersion !== state.agentVersion;

	return (
		<Card
			title="Agent"
			actions={
				user.role === "admin" && releases.length > 0 ? (
					<select
						value={state.desiredAgentVersion ?? state.agentVersion ?? ""}
						onChange={(e) => void update(e.target.value)}
					>
						<option value="">versionを選ぶ</option>
						{releases.map((release) => (
							<option key={release} value={release}>
								{release}
							</option>
						))}
					</select>
				) : undefined
			}
		>
			<dl className="kv">
				<dt>稼働version</dt>
				<dd>
					<span className="mono">{formatValue(state.agentVersion)}</span>
					{state.agentSlot && (
						<>
							{" "}
							<Badge plain>slot {state.agentSlot}</Badge>
						</>
					)}
				</dd>
				<dt>指定version</dt>
				<dd>
					<span className="mono">{formatValue(state.desiredAgentVersion)}</span>
					{pending && (
						<>
							{" "}
							<Badge tone="warn">更新待ち</Badge>
						</>
					)}
				</dd>
				{state.lastAgentReason && (
					<>
						<dt>
							{state.lastAgentReasonType === "recovery"
								? "直前の復旧"
								: "直前のrollback"}
						</dt>
						<dd>
							<Badge
								tone={
									state.lastAgentReasonType === "recovery" ? "accent" : "danger"
								}
							>
								{state.lastAgentReason === "recovered_both_slots_invalid"
									? "A/B両slot不正から復旧 (recovered_both_slots_invalid)"
									: state.lastAgentReason}
							</Badge>
						</dd>
					</>
				)}
			</dl>
			{message && <Notice tone="accent">{message}</Notice>}
		</Card>
	);
}

/** CONFIGから抽出したDevice Profileと世代一覧(#6)。本文操作はAdminのみ。 */
function Config({
	device,
	deviceId,
	user,
	onDeviceChanged,
}: {
	device: Device;
	deviceId: string;
	user: User;
	onDeviceChanged: (device: Device) => void;
}) {
	if (user.role !== "admin") {
		return (
			<Card title="CONFIG">
				<Notice tone="accent">
					CONFIGの操作と差分表示はAdminのみ利用できます。
				</Notice>
			</Card>
		);
	}
	return (
		<AdminConfig
			device={device}
			deviceId={deviceId}
			onDeviceChanged={onDeviceChanged}
		/>
	);
}

type ApplyAuditSummary = {
	applyId: string | null;
	createdAt: string;
	actorName: string | null;
};

const APPLY_ACTIVE_PHASES = new Set([
	"prepare",
	"confirm",
	"transfer",
	"activate",
	"verify",
]);

function isApplyBusy(apply: ConfigApply | null): boolean {
	if (!apply) return false;
	return (
		APPLY_ACTIVE_PHASES.has(apply.phase) ||
		(apply.phase === "complete" && apply.saveAfterApply && !apply.savedAt)
	);
}

function AdminConfig({
	device,
	deviceId,
	onDeviceChanged,
}: {
	device: Device;
	deviceId: string;
	onDeviceChanged: (device: Device) => void;
}) {
	const [profile, setProfile] = useState<DeviceProfile | null>(null);
	const [backups, setBackups] = useState<ConfigBackup[]>([]);
	const [applies, setApplies] = useState<ConfigApply[]>([]);
	const [message, setMessage] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(true);
	const [targetId, setTargetId] = useState("");
	const [againstId, setAgainstId] = useState("");
	const [diff, setDiff] = useState<ConfigDiff | null>(null);
	const [diffLoading, setDiffLoading] = useState(false);
	const [apply, setApply] = useState<ConfigApply | null>(null);
	const [applyDetails, setApplyDetails] = useState<ConfigApplyDetails | null>(
		null,
	);
	const [selectedBackup, setSelectedBackup] = useState<ConfigBackup | null>(
		null,
	);
	const [applyDialogOpen, setApplyDialogOpen] = useState(false);
	const [applyError, setApplyError] = useState<string | null>(null);
	const [applyBatchId, setApplyBatchId] = useState<string | null>(null);
	const [applyBusy, setApplyBusy] = useState(false);
	const [saveAfterApply, setSaveAfterApply] = useState(false);
	const [acknowledged, setAcknowledged] = useState(false);
	const [saveBusy, setSaveBusy] = useState(false);
	const [discardDialogOpen, setDiscardDialogOpen] = useState(false);
	const [discardBusy, setDiscardBusy] = useState(false);
	const [applyAudit, setApplyAudit] = useState<ApplyAuditSummary | null>(null);

	function rememberApply(next: ConfigApply) {
		setApply(next);
		setApplies((current) => [
			next,
			...current.filter((item) => item.id !== next.id),
		]);
	}

	async function refreshDevice() {
		try {
			onDeviceChanged((await api.device(deviceId)).device);
		} catch {
			// 再起動直後など、Device APIが一時的に失敗しても操作結果は失わない。
		}
	}

	async function load() {
		setLoading(true);
		try {
			const [profileResponse, backupResponse, applyResponse, auditResponse] =
				await Promise.all([
					api.profile(deviceId),
					api.configBackups(deviceId),
					api.configApplies(deviceId),
					api
						.auditEvents({
							type: "CONFIG_APPLY_REQUESTED",
							targetType: "device",
							targetId: deviceId,
						})
						.catch(() => ({ events: [] })),
				]);
			setError(null);
			setProfile(profileResponse.profile);
			setBackups(backupResponse.backups);
			setApplies(applyResponse.applies);
			setApplyAudit(findLatestApplyAudit(auditResponse.events));
			setTargetId((current) =>
				backupResponse.backups.some((backup) => backup.id === current)
					? current
					: (backupResponse.backups[0]?.id ?? ""),
			);
			setAgainstId((current) =>
				backupResponse.backups.some((backup) => backup.id === current)
					? current
					: (backupResponse.backups[1]?.id ?? ""),
			);
			setApply((current) => {
				if (current) return current;
				return (
					applyResponse.applies.find((item) =>
						APPLY_ACTIVE_PHASES.has(item.phase),
					) ?? null
				);
			});
		} catch (cause) {
			setError(
				cause instanceof Error ? cause.message : "CONFIGを読み込めませんでした",
			);
		} finally {
			setLoading(false);
		}
	}

	// Deviceを開いた時とDeviceを切り替えた時だけ初期データを読む。
	// biome-ignore lint/correctness/useExhaustiveDependencies: deviceIdが変わった時だけ読み直す
	useEffect(() => {
		void load();
	}, [deviceId]);

	const applyId = apply?.id;
	const applyPhase = apply?.phase;
	const applySaveAfterApply = apply?.saveAfterApply;
	const applySavedAt = apply?.savedAt;

	// Applyの進行はServerのphaseを読み取り、GUI側で別の状態機械を持たない。
	useEffect(() => {
		if (!applyId) return;
		const waitingForSave =
			applyPhase === "complete" && applySaveAfterApply && applySavedAt === null;
		const active = APPLY_ACTIVE_PHASES.has(applyPhase ?? "") || waitingForSave;
		if (!active) return;

		let current = true;
		let deviceStateRefreshed = false;
		let timer: ReturnType<typeof setInterval> | undefined;
		const stopPolling = () => {
			current = false;
			if (timer !== undefined) {
				clearInterval(timer);
				timer = undefined;
			}
		};
		const poll = async () => {
			if (!current) return;
			try {
				const details = await api.configApplyDetails(deviceId, applyId);
				if (!current) return;
				setApplyDetails(details);
				setApply(details.apply);
				setApplies((currentApplies) => [
					details.apply,
					...currentApplies.filter((item) => item.id !== details.apply.id),
				]);
				if (
					!deviceStateRefreshed &&
					(details.apply.phase === "verify" ||
						details.apply.phase === "complete" ||
						details.apply.phase === "failed")
				) {
					deviceStateRefreshed = true;
					try {
						onDeviceChanged((await api.device(deviceId)).device);
					} catch {
						// Deviceが再接続待ちでもApplyの進行表示は継続する。
					}
				}
				if (details.apply.phase === "failed") stopPolling();
			} catch (cause) {
				if (current) {
					stopPolling();
					setApplyError(
						(currentError) =>
							currentError ??
							formatConfigApplyRequestError(
								cause,
								"Apply状態を取得できませんでした",
							),
					);
				}
			}
		};
		timer = setInterval(() => void poll(), 1000);
		void poll();
		return () => {
			stopPolling();
		};
	}, [
		applyId,
		applyPhase,
		applySaveAfterApply,
		applySavedAt,
		deviceId,
		onDeviceChanged,
	]);

	async function refreshApplyDetails(applyId: string) {
		try {
			const details = await api.configApplyDetails(deviceId, applyId);
			setApplyError(null);
			setApplyDetails(details);
			rememberApply(details.apply);
			return details;
		} catch (cause) {
			setApplyError(
				formatConfigApplyRequestError(cause, "Apply状態を取得できませんでした"),
			);
			return null;
		}
	}

	async function requestConfig() {
		setMessage(null);
		setError(null);
		try {
			await api.requestConfig(deviceId);
			setMessage("再取得を要求しました。次回のsyncで反映されます。");
		} catch (cause) {
			setError(
				cause instanceof Error ? cause.message : "再取得を要求できませんでした",
			);
		}
	}

	async function showDiff() {
		if (!targetId) return;
		setError(null);
		setDiffLoading(true);
		try {
			setDiff(await api.configDiff(deviceId, targetId, againstId || undefined));
		} catch (cause) {
			setDiff(null);
			setError(
				cause instanceof Error ? cause.message : "差分を取得できませんでした",
			);
		} finally {
			setDiffLoading(false);
		}
	}

	async function showBackupDiff(id: string) {
		chooseTarget(id);
		const index = backups.findIndex((backup) => backup.id === id);
		const previousId = backups[index + 1]?.id;
		setError(null);
		setDiffLoading(true);
		try {
			setDiff(await api.configDiff(deviceId, id, previousId));
		} catch (cause) {
			setDiff(null);
			setError(
				cause instanceof Error ? cause.message : "差分を取得できませんでした",
			);
		} finally {
			setDiffLoading(false);
		}
	}

	function chooseTarget(id: string) {
		setTargetId(id);
		setAgainstId((current) => {
			if (current !== id) return current;
			const index = backups.findIndex((backup) => backup.id === id);
			return backups[index + 1]?.id ?? "";
		});
		setDiff(null);
	}

	function chooseAgainst(id: string) {
		setAgainstId(id);
		setDiff(null);
	}

	async function prepareApply(backup: ConfigBackup) {
		setSelectedBackup(backup);
		setApply(null);
		setApplyDetails(null);
		setApplyError(null);
		setApplyBatchId(null);
		setApplyBusy(false);
		setSaveAfterApply(false);
		setAcknowledged(false);
		setApplyDialogOpen(true);
		try {
			const result = await api.prepareConfigApply(deviceId, backup.id);
			rememberApply(result.apply);
			await refreshApplyDetails(result.apply.id);
		} catch (cause) {
			if (isBatchActiveError(cause)) {
				setApplyBatchId(cause.batchId);
			} else {
				setApplyError(
					formatConfigApplyRequestError(cause, "Applyの準備に失敗しました"),
				);
			}
		}
	}

	async function openApply(applyToOpen: ConfigApply) {
		setSelectedBackup(
			backups.find((backup) => backup.id === applyToOpen.targetBackupId) ??
				null,
		);
		setApplyError(null);
		setApplyBatchId(null);
		setApplyDialogOpen(true);
		setApplyDetails(null);
		rememberApply(applyToOpen);
		await refreshApplyDetails(applyToOpen.id);
	}

	async function confirmApply() {
		if (apply?.phase !== "confirm" || !acknowledged) return;
		setApplyBusy(true);
		setApplyError(null);
		setApplyBatchId(null);
		try {
			const result = await api.confirmConfigApply(deviceId, apply.id, {
				saveAfterApply,
				acknowledged: true,
			});
			rememberApply(result.apply);
			await refreshApplyDetails(result.apply.id);
		} catch (cause) {
			if (isBatchActiveError(cause)) {
				setApplyBatchId(cause.batchId);
			} else {
				setApplyError(
					formatConfigApplyRequestError(cause, "CONFIGを適用できませんでした"),
				);
			}
		} finally {
			setApplyBusy(false);
		}
	}

	async function saveConfig() {
		setSaveBusy(true);
		setMessage(null);
		setError(null);
		try {
			await api.saveConfig(deviceId);
			setMessage(
				"保存を要求しました。保存SYSLOGを受信するまで未保存表示を維持します。",
			);
			await refreshDevice();
		} catch (cause) {
			setError(
				cause instanceof Error ? cause.message : "CONFIGを保存できませんでした",
			);
		} finally {
			setSaveBusy(false);
		}
	}

	async function discardConfig() {
		const target = findDiscardApply(applies, apply);
		if (!target) {
			setError(
				"破棄再起動に必要なApply履歴が見つかりません。CONFIG Applyの結果を確認してください。",
			);
			return;
		}
		setDiscardBusy(true);
		setError(null);
		try {
			const result = await api.discardConfigApply(deviceId, target.id);
			rememberApply(result.apply);
			setDiscardDialogOpen(false);
			setMessage(
				"未保存の変更を破棄して再起動を要求しました。通信が切断されます。再接続後に保存済みCONFIGへ戻ったことを確認します。",
			);
			await refreshDevice();
		} catch (cause) {
			setError(
				cause instanceof Error
					? cause.message
					: "未保存の変更を破棄できませんでした",
			);
		} finally {
			setDiscardBusy(false);
		}
	}

	const internet = profile?.internet;
	const method = (value?: { method: string; interface?: string }): string =>
		value
			? value.method + (value.interface ? ` (${value.interface})` : "")
			: "—";
	const latestApply = findUnsavedApply(applies, apply, applyAudit?.applyId);
	const discardApplyTarget = findDiscardApply(applies, apply);
	const diffForDialog = applyDetails?.diff ?? null;

	return (
		<>
			{device.configState === "unsaved" && (
				<UnsavedConfigNotice
					apply={latestApply}
					audit={applyAudit}
					canDiscard={discardApplyTarget !== null && !isApplyBusy(apply)}
					saveBusy={saveBusy}
					operationBusy={isApplyBusy(apply)}
					onSave={() => void saveConfig()}
					onDiscard={() => setDiscardDialogOpen(true)}
				/>
			)}
			{error && <Notice tone="error">{error}</Notice>}
			{message && <Notice tone="accent">{message}</Notice>}
			{apply && (
				<ApplyProgressCard
					apply={apply}
					onOpen={() => void openApply(apply)}
					onClose={() => setApply(null)}
				/>
			)}
			<Card
				title="Device Profile"
				actions={
					<>
						<button
							type="button"
							className="btn"
							onClick={() => void requestConfig()}
						>
							CONFIGを再取得
						</button>
						<button
							type="button"
							className="btn btn--ghost"
							onClick={() => void load()}
						>
							更新
						</button>
					</>
				}
			>
				{profile ? (
					<dl className="kv">
						<dt>IPv4</dt>
						<dd>{method(internet?.ipv4)}</dd>
						<dt>IPv6</dt>
						<dd>{method(internet?.ipv6)}</dd>
						<dt>IPv4 over IPv6</dt>
						<dd>{formatValue(internet?.ipv4_over_ipv6?.method)}</dd>
						<dt>Default route</dt>
						<dd className="mono">{formatValue(profile.defaultRoute)}</dd>
						<dt>LAN</dt>
						<dd className="mono">
							{profile.lan.length > 0
								? profile.lan
										.map((l) => `${l.interface} ${l.address}`)
										.join(", ")
								: "—"}
						</dd>
						<dt>Tunnel</dt>
						<dd>
							{profile.tunnels.length > 0
								? profile.tunnels
										.map((t) => `${t.id}: ${t.encapsulation}`)
										.join(", ")
								: "—"}
						</dd>
						<dt>取得日時</dt>
						<dd>{formatTime(profile.capturedAt)}</dd>
					</dl>
				) : (
					<Empty title="CONFIGをまだ受け取っていません">
						AgentはRouter起動時にCONFIGを送ります。すぐに取りたい場合は「CONFIGを再取得」を押してください。
					</Empty>
				)}
			</Card>

			<Card title="CONFIG世代" flush>
				{loading ? (
					<Loading />
				) : backups.length === 0 ? (
					<Empty title="保存されたCONFIGはありません" />
				) : (
					<div className="table-wrap">
						<table>
							<thead>
								<tr>
									<th>取得日時</th>
									<th>サイズ</th>
									<th>hash</th>
									<th>操作</th>
								</tr>
							</thead>
							<tbody>
								{backups.map((backup) => (
									<tr key={backup.id}>
										<td>{formatTime(backup.capturedAt)}</td>
										<td className="num">{formatBytes(backup.sizeBytes)}</td>
										<td className="mono">{backup.contentHash.slice(0, 12)}</td>
										<td>
											<div className="user-actions">
												<button
													type="button"
													className="btn btn--ghost"
													disabled={diffLoading}
													onClick={() => void showBackupDiff(backup.id)}
												>
													差分
												</button>
												<a
													className="btn btn--ghost"
													href={api.configBackupDownloadUrl(
														deviceId,
														backup.id,
													)}
													download
												>
													DL
												</a>
												<button
													type="button"
													className="btn btn--primary"
													disabled={
														isApplyBusy(apply) ||
														device.lifecycle !== "active" ||
														device.presence.status === "offline"
													}
													onClick={() => void prepareApply(backup)}
												>
													適用
												</button>
											</div>
										</td>
									</tr>
								))}
							</tbody>
						</table>
					</div>
				)}
			</Card>

			{backups.length > 0 && (
				<Card title="CONFIG差分">
					<div className="stack">
						<div className="toolbar">
							<Field label="比較先">
								<select
									value={targetId}
									onChange={(event) => chooseTarget(event.target.value)}
								>
									<option value="">世代を選択</option>
									{backups.map((backup) => (
										<option key={backup.id} value={backup.id}>
											{formatTime(backup.capturedAt)} ({backup.id.slice(0, 8)})
										</option>
									))}
								</select>
							</Field>
							<Field label="比較元">
								<select
									value={againstId}
									onChange={(event) => chooseAgainst(event.target.value)}
								>
									<option value="">自動（1つ前の世代）</option>
									{backups
										.filter((backup) => backup.id !== targetId)
										.map((backup) => (
											<option key={backup.id} value={backup.id}>
												{formatTime(backup.capturedAt)} ({backup.id.slice(0, 8)}
												)
											</option>
										))}
								</select>
							</Field>
							<button
								type="button"
								className="btn btn--primary"
								disabled={!targetId || diffLoading}
								onClick={() => void showDiff()}
							>
								{diffLoading ? <Spinner /> : "差分を表示"}
							</button>
						</div>
						{diff ? (
							<DiffPreview diff={diff} />
						) : (
							<Empty title="比較する世代を選択してください">
								比較先と比較元を選び、「差分を表示」を押してください。
							</Empty>
						)}
					</div>
				</Card>
			)}

			{applyDialogOpen && (
				<ApplyDialog
					apply={applyDetails?.apply ?? apply}
					backup={selectedBackup}
					device={device}
					details={applyDetails}
					diff={diffForDialog}
					error={applyError}
					batchId={applyBatchId}
					busy={applyBusy}
					saveAfterApply={saveAfterApply}
					acknowledged={acknowledged}
					onSaveAfterApply={setSaveAfterApply}
					onAcknowledged={setAcknowledged}
					onConfirm={() => void confirmApply()}
					onClose={() => {
						if (!applyBusy) setApplyDialogOpen(false);
					}}
				/>
			)}

			{discardDialogOpen && (
				<Modal
					title="未保存の変更を破棄して再起動しますか"
					onClose={() => {
						if (!discardBusy) setDiscardDialogOpen(false);
					}}
					footer={
						<>
							<button
								type="button"
								className="btn btn--ghost"
								disabled={discardBusy}
								onClick={() => setDiscardDialogOpen(false)}
							>
								キャンセル
							</button>
							<button
								type="button"
								className="btn btn--danger"
								disabled={discardBusy}
								onClick={() => void discardConfig()}
							>
								{discardBusy ? <Spinner /> : "破棄して再起動"}
							</button>
						</>
					}
				>
					<Notice tone="error">
						saveは実行せず、動作中の未保存設定を破棄して再起動します。通信が一度切断され、再接続までDeviceを操作できません。
					</Notice>
					<p className="hint">
						再起動後に保存済みCONFIGへ戻ったことを確認してから、未保存表示を解除します。
					</p>
				</Modal>
			)}
		</>
	);
}

function UnsavedConfigNotice({
	apply,
	audit,
	canDiscard,
	saveBusy,
	operationBusy,
	onSave,
	onDiscard,
}: {
	apply: ConfigApply | null;
	audit: ApplyAuditSummary | null;
	canDiscard: boolean;
	saveBusy: boolean;
	operationBusy: boolean;
	onSave: () => void;
	onDiscard: () => void;
}) {
	const appliedAt =
		apply?.activatedAt ??
		apply?.finishedAt ??
		audit?.createdAt ??
		apply?.preparedAt ??
		null;
	const actor = audit?.actorName?.trim() || null;
	const appliedAtLabel = appliedAt ? formatTime(appliedAt) : null;
	const applicationSummary =
		appliedAtLabel && actor
			? `${appliedAtLabel} に ${actor} が適用`
			: appliedAtLabel
				? `${appliedAtLabel} に適用`
				: actor
					? `${actor} が適用`
					: null;
	return (
		<div className="config-warning" role="alert">
			<div>
				<strong>⚠ 未保存の変更があります</strong>
				{applicationSummary && <div>{applicationSummary}</div>}
				<div>Routerを再起動すると保存済みCONFIGへ戻ります</div>
			</div>
			<div className="row row--end">
				<button
					type="button"
					className="btn"
					disabled={saveBusy || operationBusy}
					onClick={onSave}
				>
					{saveBusy ? <Spinner /> : "保存する"}
				</button>
				<button
					type="button"
					className="btn btn--danger"
					disabled={!canDiscard}
					onClick={onDiscard}
				>
					破棄して再起動
				</button>
			</div>
			<p className="hint">
				この表示はRoutemonが適用して保存していない変更の管理状態です。telnet等で行われた未保存変更は完全には検出できません。
			</p>
		</div>
	);
}

function ApplyProgressCard({
	apply,
	onOpen,
	onClose,
}: {
	apply: ConfigApply;
	onOpen: () => void;
	onClose: () => void;
}) {
	const finished = apply.phase === "complete" || apply.phase === "failed";
	return (
		<Card
			title="CONFIG Applyの進行状況"
			actions={
				<>
					<button type="button" className="btn btn--ghost" onClick={onOpen}>
						詳細
					</button>
					{finished && (
						<button type="button" className="btn btn--ghost" onClick={onClose}>
							閉じる
						</button>
					)}
				</>
			}
		>
			<ApplyProgressSteps apply={apply} />
			{apply.phase === "failed" && (
				<Notice tone="error">
					適用できませんでした。{formatApplyError(apply.errorCode)}
					{apply.result === "mismatch" &&
						" apply_verifyが一致しませんでした。保存は実行していません。"}
				</Notice>
			)}
			{apply.phase === "complete" && apply.result === "matched" && (
				<Notice tone="accent">
					apply_verifyが一致しました。
					{apply.saveAfterApply && !apply.savedAt
						? "保存SYSLOGを待っています。"
						: apply.savedAt
							? "保存済みです。"
							: "未保存のまま完了しました。"}
				</Notice>
			)}
		</Card>
	);
}

function ApplyProgressSteps({ apply }: { apply: ConfigApply }) {
	const labels = ["送信中", "読み込み中", "確認中", "完了（未保存）"];
	const phaseIndex: Record<string, number> = {
		transfer: 0,
		activate: 1,
		verify: 2,
		complete: 3,
	};
	const current = phaseIndex[apply.phase] ?? -1;
	const saving =
		apply.phase === "complete" && apply.saveAfterApply && !apply.savedAt;
	return (
		<ol className="apply-steps">
			{labels.map((label, index) => {
				const state =
					apply.phase === "failed"
						? index < current
							? "done"
							: "failed"
						: index < current
							? "done"
							: index === current
								? "active"
								: "pending";
				const shownLabel =
					index === 3 && apply.savedAt
						? "完了（保存済み）"
						: index === 3 && saving
							? "保存中"
							: label;
				return (
					<li className={`apply-step apply-step--${state}`} key={label}>
						<span>{index + 1}</span>
						{shownLabel}
					</li>
				);
			})}
		</ol>
	);
}

function ApplyDialog({
	apply,
	backup,
	device,
	details,
	diff,
	error,
	batchId,
	busy,
	saveAfterApply,
	acknowledged,
	onSaveAfterApply,
	onAcknowledged,
	onConfirm,
	onClose,
}: {
	apply: ConfigApply | null;
	backup: ConfigBackup | null;
	device: Device;
	details: ConfigApplyDetails | null;
	diff: ConfigDiff | null;
	error: string | null;
	batchId: string | null;
	busy: boolean;
	saveAfterApply: boolean;
	acknowledged: boolean;
	onSaveAfterApply: (value: boolean) => void;
	onAcknowledged: (value: boolean) => void;
	onConfirm: () => void;
	onClose: () => void;
}) {
	const waiting = !error && !batchId && (!apply || apply.phase === "prepare");
	const review = apply?.phase === "confirm";
	const canConfirm =
		review &&
		acknowledged &&
		!busy &&
		details !== null &&
		!details.diffUnavailable;
	const summary = diff ? summarizeDiff(diff) : null;
	const identity = diff ? inspectTargetIdentity(diff) : null;
	// 高リスク判定はServerのconfigRisk.tsが行い、GUIはdetails.risksを表示するだけ。
	// risksがnull(差分なし)のときは警告を出さない。
	const risks = details?.risks ?? null;
	const preApplyAt = diff?.against?.capturedAt ?? apply?.preparedAt ?? null;
	const footer = waiting ? (
		<button type="button" className="btn btn--ghost" onClick={onClose}>
			閉じる
		</button>
	) : review ? (
		<>
			<button type="button" className="btn btn--ghost" onClick={onClose}>
				キャンセル
			</button>
			<button
				type="button"
				className="btn btn--primary"
				disabled={!canConfirm}
				onClick={onConfirm}
			>
				{busy ? <Spinner /> : "適用する"}
			</button>
		</>
	) : (
		<button type="button" className="btn btn--primary" onClick={onClose}>
			閉じる
		</button>
	);

	return (
		<Modal title="このCONFIGを適用しますか" onClose={onClose} footer={footer}>
			{error && <Notice tone="error">{error}</Notice>}
			{batchId && (
				<Notice tone="error">
					一括適用が実行中です (Batch {batchId.slice(0, 8)}
					)。Batchの実行中は単体Applyを開始できません。{" "}
					<a href={`#/bulk-applies/${encodeURIComponent(batchId)}`}>
						Batchの詳細を見る
					</a>
				</Notice>
			)}
			{waiting ? (
				<Notice tone="accent">
					<Spinner />{" "}
					現在の動作中CONFIGを取得し、適用前snapshotを作成しています。
				</Notice>
			) : review && apply ? (
				<>
					<dl className="kv">
						<dt>適用する世代</dt>
						<dd>
							{backup ? formatTime(backup.capturedAt) : "世代情報なし"}{" "}
							{backup && `(${formatBytes(backup.sizeBytes)})`}
						</dd>
						<dt>hash</dt>
						<dd className="mono">{backup?.contentHash.slice(0, 12) ?? "—"}</dd>
						<dt>適用前snapshot</dt>
						<dd>{formatTime(preApplyAt)}</dd>
						<dt>現在との差分</dt>
						<dd>
							{summary
								? `+${summary.added}行 / -${summary.removed}行`
								: details?.diffUnavailable
									? "取得できません"
									: "差分なし"}
						</dd>
					</dl>
					{details === null ? (
						<Notice tone="accent">
							<Spinner /> 適用前snapshotの差分を取得しています。
						</Notice>
					) : details.diffUnavailable ? (
						<Notice tone="error">
							適用前snapshotまたは対象世代の差分を取得できないため、安全確認を完了できません。世代の保持状況を確認してから、もう一度Prepareしてください。
						</Notice>
					) : (
						<>
							<div className="config-validation">
								<strong>事前検証</strong>
								<div>
									サイズ: {backup ? formatBytes(backup.sizeBytes) : "—"} / 1 MiB{" "}
									<Badge tone="ok">OK</Badge>
								</div>
								<div>
									行数:{" "}
									{summary ? summary.targetLines.toLocaleString() : "差分なし"}{" "}
									/ 2,000行未満 <Badge tone="ok">OK</Badge>
								</div>
								<div>
									Model: {identity?.model ?? "Server検証済み"}（現在{" "}
									{device.model ?? "不明"}） <Badge tone="ok">OK</Badge>
								</div>
								<div>
									Firmware: {identity?.firmware ?? "Server検証済み"}（現在{" "}
									{device.firmwareRevision ?? "不明"}）{" "}
									<Badge tone="ok">OK</Badge>
								</div>
							</div>
							{risks !== null && risks.length > 0 && (
								<div className="config-risk" role="alert">
									<strong>⚠ 高リスクな差分があります</strong>
									<ul>
										{risks.map((risk) => (
											<li key={risk}>{RISK_LABEL[risk]}に差分があります</li>
										))}
									</ul>
									<p>
										失敗するとWANが切断され、遠隔から前のCONFIGへ戻せなくなる可能性があります。再起動または現地対応が必要になる場合があります。
									</p>
								</div>
							)}
							<DiffPreview diff={diff} />
							<fieldset className="apply-choice">
								<legend>適用したあと</legend>
								<label>
									<input
										type="radio"
										name="save-after-apply"
										checked={!saveAfterApply}
										onChange={() => onSaveAfterApply(false)}
									/>
									<strong>保存しない</strong>
									<span>
										動作確認してから保存できます。再起動すれば元に戻ります。
									</span>
								</label>
								<label>
									<input
										type="radio"
										name="save-after-apply"
										checked={saveAfterApply}
										onChange={() => onSaveAfterApply(true)}
									/>
									<strong>すぐ保存する</strong>
									<span>
										apply_verifyが一致した場合だけ保存し、再起動しても戻りません。
									</span>
								</label>
							</fieldset>
							<label className="checkbox">
								<input
									type="checkbox"
									checked={acknowledged}
									onChange={(event) => onAcknowledged(event.target.checked)}
								/>
								内容と高リスク警告を確認しました
							</label>
						</>
					)}
				</>
			) : apply ? (
				<>
					<ApplyProgressSteps apply={apply} />
					{apply.phase === "failed" ? (
						<Notice tone="error">
							適用できませんでした。{formatApplyError(apply.errorCode)}
							{apply.result === "mismatch" &&
								" apply_verifyが一致しなかったため、保存は実行していません。"}
						</Notice>
					) : (
						<Notice tone="accent">
							{apply.phase === "transfer" && "CONFIGを送信しています。"}
							{apply.phase === "activate" &&
								"RouterへCONFIGを読み込んでいます。"}
							{apply.phase === "verify" &&
								"動作中CONFIGを取り直して確認しています。"}
							{apply.phase === "complete" &&
								(apply.savedAt
									? "保存SYSLOGを確認し、保存済みになりました。"
									: apply.saveAfterApply
										? "保存SYSLOGを待っています。"
										: "適用が完了しました。Deviceは未保存です。")}
						</Notice>
					)}
				</>
			) : batchId ? null : !error ? (
				<Notice tone="error">Apply状態を取得できませんでした。</Notice>
			) : null}
		</Modal>
	);
}

function DiffPreview({ diff }: { diff: ConfigDiff | null }) {
	if (!diff?.changed)
		return <Notice>選択したCONFIGに差分はありません。</Notice>;
	return (
		<pre className="config-diff">
			{diff.diff.split("\n").map((line, index) => {
				const type =
					index < 3
						? "meta"
						: line.startsWith("+")
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
	);
}

function summarizeDiff(diff: ConfigDiff) {
	let added = 0;
	let removed = 0;
	let targetLines = 0;
	let currentLines = 0;
	for (const line of diff.lines) {
		if (line.type === "added") {
			added++;
			targetLines++;
		} else if (line.type === "removed") {
			removed++;
			currentLines++;
		} else {
			targetLines++;
			currentLines++;
		}
	}
	return { added, removed, targetLines, currentLines };
}

function inspectTargetIdentity(diff: ConfigDiff): {
	model: string | null;
	firmware: string | null;
} {
	const candidates = diff.lines.filter((line) => line.type !== "removed");
	for (const line of candidates) {
		const match = /^#\s*(RTX[0-9A-Z-]+)(?:\s+Rev\.?\s*([0-9.]+))?/i.exec(
			line.text,
		);
		if (match) {
			return {
				model: match[1] ?? null,
				firmware: match[2] ? `Rev.${match[2]}` : null,
			};
		}
	}
	return { model: null, firmware: null };
}

function findLatestApplyAudit(
	events: Array<{
		type: string;
		created_at: string;
		actor_name: string | null;
		detail?: Record<string, unknown>;
	}>,
): ApplyAuditSummary | null {
	const event = events.find((item) => item.type === "CONFIG_APPLY_REQUESTED");
	if (!event) return null;
	const applyId =
		typeof event.detail?.apply_id === "string" ? event.detail.apply_id : null;
	return {
		applyId,
		createdAt: event.created_at,
		actorName: event.actor_name,
	};
}

function findUnsavedApply(
	applies: ConfigApply[],
	current: ConfigApply | null,
	auditApplyId: string | null | undefined,
): ConfigApply | null {
	if (auditApplyId) {
		const fromAudit = applies.find((item) => item.id === auditApplyId);
		if (fromAudit) return fromAudit;
	}
	if (current && (current.phase === "complete" || current.phase === "failed")) {
		return current;
	}
	return (
		applies.find(
			(item) => item.phase === "complete" || item.phase === "failed",
		) ?? null
	);
}

function findDiscardApply(
	applies: ConfigApply[],
	current: ConfigApply | null,
): ConfigApply | null {
	if (current && (current.phase === "complete" || current.phase === "failed")) {
		return current;
	}
	return (
		applies.find(
			(item) => item.phase === "complete" || item.phase === "failed",
		) ?? null
	);
}

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes.toLocaleString()} B`;
	return `${(bytes / 1024).toFixed(1)} KiB`;
}

function formatConfigApplyRequestError(
	cause: unknown,
	fallback: string,
): string {
	if (!(cause instanceof Error) || cause.message.length === 0) return fallback;
	if (/device\s+is\s+not\s+connected/i.test(cause.message)) {
		return "Deviceが接続されていません。";
	}
	return cause.message;
}

function formatApplyError(errorCode: string | null): string {
	const labels: Record<string, string> = {
		target_empty: "対象CONFIGが空です。",
		target_too_large: "対象CONFIGが1 MiBを超えています。",
		target_too_many_lines: "対象CONFIGの行数が上限を超えています。",
		supervisor_schedule_missing: "Supervisorの自動起動行がありません。",
		model_mismatch: "RouterのModelとCONFIGのModelが一致しません。",
		firmware_mismatch: "RouterのFirmwareとCONFIGのFirmwareが一致しません。",
		verify_mismatch: "適用後のCONFIGが対象世代と一致しません。",
		verify_timeout: "検証結果を確認できず、未保存のままです。",
		target_backup_not_found: "対象世代が削除されています。",
	};
	return labels[errorCode ?? ""] ?? "ServerまたはRouterから失敗が返りました。";
}

function Syslog({ deviceId }: { deviceId: string }) {
	const [lines, setLines] = useState<Line[]>([]);
	const [live, setLive] = useState(false);
	const [from, setFrom] = useState(() =>
		toDateTimeLocal(new Date(Date.now() - 60 * 60 * 1000)),
	);
	const [to, setTo] = useState(() => toDateTimeLocal(new Date()));
	const [keyword, setKeyword] = useState("");
	const [exclude, setExclude] = useState("");
	const [activeKeyword, setActiveKeyword] = useState("");
	const [activeExclude, setActiveExclude] = useState("");
	const [truncated, setTruncated] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	async function search() {
		const range = parseDateTimeRange(from, to);
		if (typeof range === "string") {
			setError(range);
			return;
		}

		setBusy(true);
		setError(null);
		try {
			const result = await api.syslog(deviceId, range.from, range.to, {
				keyword,
				exclude,
			});
			setLines(result.lines);
			setTruncated(result.truncated);
			setActiveKeyword(keyword.trim());
			setActiveExclude(exclude.trim());
		} catch (cause) {
			setError(
				cause instanceof Error ? cause.message : "SYSLOGを取得できませんでした",
			);
		} finally {
			setBusy(false);
		}
	}

	// biome-ignore lint/correctness/useExhaustiveDependencies: Device変更時に現在の条件で読み直す
	useEffect(() => {
		void search();
	}, [deviceId]);

	useEffect(() => {
		if (!live) return;
		return subscribeSyslog(deviceId, (line) =>
			setLines((prev) => {
				if (!matchesSyslogFilter(line, activeKeyword, activeExclude))
					return prev;
				return [...prev, line].slice(-MAX_SYSLOG_RESULT_LINES);
			}),
		);
	}, [deviceId, live, activeKeyword, activeExclude]);

	const parsedRange = parseDateTimeRange(from, to);
	const downloadUrl =
		typeof parsedRange === "string"
			? null
			: api.syslogDownloadUrl(deviceId, parsedRange.from, parsedRange.to, {
					keyword,
					exclude,
				});

	return (
		<Card
			title="SYSLOG履歴"
			actions={
				<label className="checkbox">
					<input
						type="checkbox"
						checked={live}
						onChange={(e) => setLive(e.target.checked)}
					/>
					Live Logs
					{live && <Badge tone="ok">受信中</Badge>}
				</label>
			}
		>
			<form
				className="syslog-filters stack"
				onSubmit={(event) => {
					event.preventDefault();
					void search();
				}}
			>
				<div className="syslog-filters__fields">
					<Field label="開始">
						<input
							type="datetime-local"
							step="1"
							value={from}
							onChange={(event) => setFrom(event.target.value)}
							required
						/>
					</Field>
					<Field label="終了">
						<input
							type="datetime-local"
							step="1"
							value={to}
							onChange={(event) => setTo(event.target.value)}
							required
						/>
					</Field>
					<Field label="含む文字列（部分一致）">
						<input
							type="text"
							value={keyword}
							onChange={(event) => setKeyword(event.target.value)}
							placeholder="例: PPP"
						/>
					</Field>
					<Field label="除外する文字列">
						<input
							type="text"
							value={exclude}
							onChange={(event) => setExclude(event.target.value)}
							placeholder="例: DEBUG"
						/>
					</Field>
				</div>
				<div className="row">
					<button type="submit" className="btn btn--primary" disabled={busy}>
						{busy ? "検索中…" : "検索"}
					</button>
					<a
						className="btn"
						href={downloadUrl ?? "#"}
						download
						aria-disabled={downloadUrl === null}
						onClick={(event) => {
							if (!downloadUrl) {
								event.preventDefault();
								setError(
									typeof parsedRange === "string"
										? parsedRange
										: "期間を指定してください",
								);
							}
						}}
					>
						ダウンロード
					</a>
					<span className="hint">期間は最大24時間、表示は最大10,000行</span>
				</div>
			</form>

			{error && <Notice tone="error">{error}</Notice>}
			{truncated && (
				<Notice tone="accent">
					結果が10,000行に達したため、続きは表示していません。期間を短くするか、検索条件を追加してください。
				</Notice>
			)}
			{!busy && lines.length === 0 ? (
				<Empty title="logはまだありません">
					条件を変えて再検索するか、Live
					Logsをonにすると新しい行が1〜3秒で届きます。
				</Empty>
			) : lines.length > 0 ? (
				<div className="stack">
					<p className="hint">{lines.length.toLocaleString()}行</p>
					<pre className="log">
						{lines
							.map((l) => `${new Date(l.ts).toLocaleTimeString()} ${l.message}`)
							.join("\n")}
					</pre>
				</div>
			) : null}
			{busy && lines.length === 0 && <Loading />}
		</Card>
	);
}

function toDateTimeLocal(date: Date): string {
	const pad = (value: number) => String(value).padStart(2, "0");
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function parseDateTimeRange(
	from: string,
	to: string,
): { from: Date; to: Date } | string {
	const fromDate = new Date(from);
	const toDate = new Date(to);
	if (Number.isNaN(fromDate.getTime()) || Number.isNaN(toDate.getTime())) {
		return "開始と終了を指定してください";
	}
	const duration = toDate.getTime() - fromDate.getTime();
	if (duration < 0) return "終了は開始より後にしてください";
	if (duration > MAX_SYSLOG_TIME_RANGE_MS)
		return "SYSLOGの検索期間は24時間以内で指定してください";
	return { from: fromDate, to: toDate };
}

function matchesSyslogFilter(
	line: Line,
	keyword: string,
	exclude: string,
): boolean {
	const message = line.message.toLowerCase();
	return (
		(!keyword || message.includes(keyword.toLowerCase())) &&
		(!exclude || !message.includes(exclude.toLowerCase()))
	);
}

function Commands({ deviceId, user }: { deviceId: string; user: User }) {
	const [jobs, setJobs] = useState<Job[]>([]);
	const [command, setCommand] = useState("show status pp 1");
	const [error, setError] = useState<string | null>(null);
	const [running, setRunning] = useState(false);

	const load = () => api.jobs(deviceId).then((r) => setJobs(r.jobs));
	// biome-ignore lint/correctness/useExhaustiveDependencies: deviceIdが変わった時だけ読み直す
	useEffect(() => {
		void load();
	}, [deviceId]);

	async function run() {
		setError(null);
		setRunning(true);
		try {
			await api.runCommand(deviceId, command);
		} catch (e) {
			setError((e as Error).message);
		} finally {
			setRunning(false);
			await load();
		}
	}

	return (
		<>
			{/* 実行はAdminのみ。Viewerには履歴だけを見せる(#8) */}
			{user.role === "admin" && (
				<Card title="コマンドを実行">
					<div className="toolbar">
						<input
							className="mono"
							value={command}
							onChange={(e) => setCommand(e.target.value)}
							onKeyDown={(e) => {
								if (e.key === "Enter" && !running) void run();
							}}
						/>
						<button
							type="button"
							className="btn btn--primary"
							disabled={running || !command.trim()}
							onClick={() => void run()}
						>
							{running ? "実行中…" : "実行"}
						</button>
					</div>
					<p className="hint">
						参照系のコマンドを想定しています。Agentを止めるコマンドは実行できません。
					</p>
					{error && <Notice tone="error">{error}</Notice>}
				</Card>
			)}

			{jobs.length === 0 ? (
				<Card title="Job履歴">
					<Empty title="Jobはまだありません" />
				</Card>
			) : (
				jobs.map((job) => (
					<Card
						key={job.id}
						title={
							<div className="row">
								<span className="mono cell-strong">{job.request}</span>
								<StatusBadge status={job.status} />
							</div>
						}
						actions={<span className="hint">{formatTime(job.created_at)}</span>}
					>
						{job.output || job.error ? (
							<pre>{job.output ?? job.error}</pre>
						) : (
							<p className="hint">出力はありません。</p>
						)}
					</Card>
				))
			)}
		</>
	);
}
