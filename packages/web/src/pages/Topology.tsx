import {
	type KeyboardEvent as ReactKeyboardEvent,
	useEffect,
	useState,
} from "react";
import {
	api,
	type TopologyEvidence,
	type TopologyLink,
	type TopologyModel,
	type TopologyNetwork,
	type TopologyNodeRef,
	type TopologySource,
	type TopologyVpnTunnel,
	type TopologyWarning,
} from "../api.ts";
import {
	Badge,
	Card,
	Empty,
	formatTime,
	formatValue,
	Loading,
	Notice,
} from "../ui.tsx";

const NODE_WIDTH = 250;
const DEVICE_BASE_HEIGHT = 104;
const EXTERNAL_HEIGHT = 82;
const COLUMN_GAP = 300;
const ROW_GAP = 92;
const GRAPH_LEFT = 40;
const GRAPH_TOP = 28;
const GRAPH_BOTTOM = 40;
const MAX_DEVICE_NETWORK_LINES = 4;
const NODE_DETAIL_LINE_HEIGHT = 18;
const LINK_BADGE_HEIGHT = 22;
const LINK_BADGE_GAP = 6;
const LINK_BADGE_STEP = LINK_BADGE_HEIGHT + LINK_BADGE_GAP + 2;

const WARNING_LABELS: Record<TopologyWarning["code"], string> = {
	profile_missing: "Device Profileがありません",
	partial_profile: "Device Profileの解析が一部です",
	unsupported_feature: "未対応の機能があります",
	ambiguous_vpn_peer: "VPN remote endpointに一致するWAN候補が複数あります",
};

const EVIDENCE_RULE_LABELS: Record<string, string> = {
	"vpn-remote-address-equals-wan-address":
		"VPN remote endpointとWANアドレスの完全一致ルール",
};

const EVIDENCE_SUMMARY_LABELS: Record<string, string> = {
	"configured interface fact": "設定から抽出したインターフェース情報",
	"configured interface address": "設定から抽出したインターフェースアドレス",
	"configured network fact": "設定から抽出したネットワーク情報",
	"configured route fact": "設定から抽出したルート情報",
	"configured VPN tunnel": "設定されたVPNトンネル",
	"configured IPv4 WAN method": "設定されたIPv4 WAN方式",
	"configured IPv6 WAN method": "設定されたIPv6 WAN方式",
	"configured IPv4-over-IPv6 method": "設定されたIPv4 over IPv6方式",
	"configured VPN tunnel has multiple WAN peer candidates":
		"VPNトンネルのremote endpointに複数のWAN候補があります",
	"configured VPN tunnel has no unique WAN peer match":
		"VPNトンネルのremote endpointに一意のWAN一致がありません",
	"configured WAN interface": "設定されたWANインターフェース",
	"configured network attachment": "設定されたネットワーク接続",
	"VPN remote endpoint matches exactly one Device WAN address":
		"VPNのremote endpointが1台のDeviceのWANアドレスと完全一致しました",
};

type Selection =
	| { kind: "node"; nodeKey: string }
	| { kind: "link"; linkId: string };

type GraphNode = {
	key: string;
	type: "device" | "network" | "external";
	id: string;
	x: number;
	y: number;
	width: number;
	height: number;
	title: string;
	subtitle: string;
	detailLines: string[];
	ariaLabel: string;
	missingProfile?: boolean;
};

type GraphLink = {
	link: TopologyLink;
	source: GraphNode;
	target: GraphNode;
	path: string;
	badgeX: number;
	badgeY: number;
	badgeLabel: string;
	badgeVisible: boolean;
	ariaLabel: string;
	style: "configured" | "observed" | "inferred" | "warning";
	direction?: "single" | "bidirectional";
};

type GraphLayout = {
	width: number;
	height: number;
	nodes: GraphNode[];
	links: GraphLink[];
	skippedLinks: number;
};

type NormalizedTopology = {
	model: TopologyModel;
	warnings: string[];
};

export function Topology() {
	const [model, setModel] = useState<TopologyModel | null>(null);
	const [siteNames, setSiteNames] = useState<Map<string, string>>(new Map());
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [loadWarnings, setLoadWarnings] = useState<string[]>([]);
	const [selection, setSelection] = useState<Selection | null>(null);
	const [reloadKey, setReloadKey] = useState(0);

	// biome-ignore lint/correctness/useExhaustiveDependencies: reloadKeyで明示的に再取得する
	useEffect(() => {
		let active = true;
		setLoading(true);
		setError(null);
		setLoadWarnings([]);
		setSelection(null);

		void Promise.allSettled([api.topology(), api.devices()]).then(
			([topologyResult, devicesResult]) => {
				if (!active) return;

				if (topologyResult.status === "rejected") {
					setModel(null);
					setError("Topologyを読み込めませんでした。");
					setLoading(false);
					return;
				}

				try {
					const normalized = normalizeTopology(topologyResult.value.topology);
					setModel(normalized.model);
					setLoadWarnings(normalized.warnings);
				} catch {
					setModel(null);
					setError("Topologyのレスポンス形式を解釈できませんでした。");
				}

				if (devicesResult.status === "fulfilled") {
					const devicePayload: unknown = devicesResult.value;
					if (isRecord(devicePayload) && Array.isArray(devicePayload.devices)) {
						const names = new Map<string, string>();
						for (const device of devicePayload.devices) {
							if (
								isRecord(device) &&
								typeof device.id === "string" &&
								typeof device.siteName === "string"
							) {
								names.set(device.id, device.siteName);
							}
						}
						setSiteNames(names);
					} else {
						setSiteNames(new Map());
						setLoadWarnings((current) => [
							...current,
							"Site情報の形式を解釈できないため、Device名とIDで並べています。",
						]);
					}
				} else {
					setSiteNames(new Map());
					setLoadWarnings((current) => [
						...current,
						"Site情報を取得できないため、Device名とIDで並べています。",
					]);
				}
				setLoading(false);
			},
		);

		return () => {
			active = false;
		};
	}, [reloadKey]);

	let layout: GraphLayout | null = null;
	let layoutError: string | null = null;
	if (model) {
		try {
			layout = buildTopologyLayout(model, siteNames);
		} catch {
			layoutError = "Topologyの描画データを解釈できませんでした。";
		}
	}

	const displayWarnings = [
		...loadWarnings.map((message) => ({ message })),
		...(model?.warnings ?? []),
	];
	if (layout && layout.skippedLinks > 0) {
		displayWarnings.push({
			message: `${layout.skippedLinks}件のlinkは接続先が不明なため表示していません。`,
		});
	}
	if (layoutError) displayWarnings.push({ message: layoutError });

	return (
		<>
			<header className="topbar">
				<h1>Topology</h1>
				{model && (
					<span className="topbar__meta">
						生成: {formatTopologyTime(model.generatedAt)}
					</span>
				)}
				<button
					type="button"
					className="btn"
					disabled={loading}
					onClick={() => setReloadKey((current) => current + 1)}
				>
					{loading ? "読込中…" : "再読込"}
				</button>
			</header>

			<div className="content topology-content">
				{error && (
					<Card title="Warnings (1)">
						<Notice tone="error">{error}</Notice>
					</Card>
				)}

				{loading && !model ? (
					<Loading />
				) : model && layout ? (
					<>
						<Legend />
						<Card title="Network graph" flush>
							<div className="topology-graph-scroll">
								<Graph
									layout={layout}
									model={model}
									selection={selection}
									onSelect={setSelection}
								/>
							</div>
						</Card>
						<WarningCard warnings={displayWarnings} model={model} />
						<SelectionDetails
							selection={selection}
							model={model}
							siteNames={siteNames}
						/>
					</>
				) : (
					<Card title="Topology">
						<Empty title="Topologyデータがありません">
							再読込しても表示できない場合は、ServerのTopology
							APIを確認してください。
						</Empty>
					</Card>
				)}
			</div>
		</>
	);
}

function Legend() {
	return (
		<Card title="凡例">
			<div className="topology-legend">
				<LegendItem
					source="configured"
					label="確定"
					description="CONFIGに記載"
				/>
				<LegendItem source="observed" label="観測" description="実行時に観測" />
				<LegendItem
					source="inferred"
					label="推定"
					description="Device間の突き合わせ"
				/>
			</div>
		</Card>
	);
}

function LegendItem({
	source,
	label,
	description,
}: {
	source: TopologySource;
	label: string;
	description: string;
}) {
	return (
		<div className="topology-legend__item">
			<span
				className={`topology-legend__line topology-legend__line--${source}`}
				aria-hidden="true"
			/>
			<Badge tone={sourceTone(source)}>{label}</Badge>
			<span className="hint">{description}</span>
		</div>
	);
}

function Graph({
	layout,
	model,
	selection,
	onSelect,
}: {
	layout: GraphLayout;
	model: TopologyModel;
	selection: Selection | null;
	onSelect: (selection: Selection) => void;
}) {
	return (
		<svg
			className="topology-graph"
			viewBox={`0 0 ${layout.width} ${layout.height}`}
			width={layout.width}
			height={layout.height}
			aria-label="Device network topology"
		>
			<title>Device network topology</title>
			<defs>
				<marker
					id="topology-arrow"
					markerWidth="8"
					markerHeight="8"
					refX="6"
					refY="3"
					orient="auto"
					markerUnits="strokeWidth"
				>
					<path d="M 0 0 L 6 3 L 0 6 z" fill="context-stroke" />
				</marker>
			</defs>
			<rect
				className="topology-graph__background"
				x="0"
				y="0"
				width={layout.width}
				height={layout.height}
				rx="8"
			/>
			<g className="topology-links">
				{layout.links.map((graphLink) => (
					<GraphLink
						key={graphLink.link.id}
						graphLink={graphLink}
						selected={
							selection?.kind === "link" &&
							selection.linkId === graphLink.link.id
						}
						onSelect={onSelect}
					/>
				))}
			</g>
			<g className="topology-nodes">
				{layout.nodes.map((node) => (
					<GraphNode
						key={node.key}
						node={node}
						selected={
							selection?.kind === "node" && selection.nodeKey === node.key
						}
						onSelect={onSelect}
					/>
				))}
			</g>
			{model.devices.length === 0 && (
				<text
					className="topology-graph__empty"
					x={layout.width / 2}
					y={layout.height / 2}
					textAnchor="middle"
				>
					Deviceがありません
				</text>
			)}
		</svg>
	);
}

function GraphNode({
	node,
	selected,
	onSelect,
}: {
	node: GraphNode;
	selected: boolean;
	onSelect: (selection: Selection) => void;
}) {
	return (
		// biome-ignore lint/a11y/useSemanticElements: SVGのgをbutton相当としてkeyboard操作する
		<g
			className={`topology-node topology-node--${node.type}${
				node.missingProfile ? " topology-node--missing" : ""
			}${selected ? " topology-node--selected" : ""}`}
			tabIndex={0}
			role="button"
			aria-label={node.ariaLabel}
			aria-pressed={selected}
			onClick={() => onSelect({ kind: "node", nodeKey: node.key })}
			onKeyDown={(event) =>
				activateWithKeyboard(event, () =>
					onSelect({ kind: "node", nodeKey: node.key }),
				)
			}
		>
			<title>{node.ariaLabel}</title>
			<rect
				x={node.x}
				y={node.y}
				width={node.width}
				height={node.height}
				rx="8"
			/>
			<text className="topology-node__title" x={node.x + 14} y={node.y + 25}>
				{truncate(node.title, 25)}
			</text>
			<text className="topology-node__subtitle" x={node.x + 14} y={node.y + 46}>
				{truncate(node.subtitle, 30)}
			</text>
			{node.detailLines.map((line, index) => (
				<text
					key={`${node.key}:detail:${line}`}
					className="topology-node__detail"
					x={node.x + 14}
					y={node.y + 64 + index * NODE_DETAIL_LINE_HEIGHT}
				>
					{truncate(line, 32)}
				</text>
			))}
			{node.missingProfile && (
				<text
					className="topology-node__warning"
					x={node.x + 14}
					y={node.y + node.height - 12}
				>
					CONFIGなし
				</text>
			)}
		</g>
	);
}

function GraphLink({
	graphLink,
	selected,
	onSelect,
}: {
	graphLink: GraphLink;
	selected: boolean;
	onSelect: (selection: Selection) => void;
}) {
	const { link } = graphLink;
	return (
		// biome-ignore lint/a11y/useSemanticElements: SVGのgをbutton相当としてkeyboard操作する
		<g
			className={`topology-link topology-link--${graphLink.style}${
				selected ? " topology-link--selected" : ""
			}`}
			tabIndex={0}
			role="button"
			aria-label={graphLink.ariaLabel}
			aria-pressed={selected}
			onClick={() => onSelect({ kind: "link", linkId: link.id })}
			onKeyDown={(event) =>
				activateWithKeyboard(event, () =>
					onSelect({ kind: "link", linkId: link.id }),
				)
			}
		>
			<title>{graphLink.ariaLabel}</title>
			<path
				className="topology-link__path"
				d={graphLink.path}
				markerEnd={
					graphLink.direction === "single" ? "url(#topology-arrow)" : undefined
				}
			/>
			{graphLink.badgeVisible && (
				<g
					className={`topology-link__badge topology-link__badge--${graphLink.style}`}
					transform={`translate(${graphLink.badgeX} ${graphLink.badgeY})`}
				>
					<rect
						x={-badgeWidth(graphLink.badgeLabel) / 2}
						y="-11"
						width={badgeWidth(graphLink.badgeLabel)}
						height={LINK_BADGE_HEIGHT}
						rx="5"
					/>
					<text textAnchor="middle" y="4">
						{graphLink.badgeLabel}
					</text>
				</g>
			)}
		</g>
	);
}

function SelectionDetails({
	selection,
	model,
	siteNames,
}: {
	selection: Selection | null;
	model: TopologyModel;
	siteNames: Map<string, string>;
}) {
	if (!selection) {
		return (
			<Card title="Details">
				<Empty title="ノードまたはlinkを選択してください">
					キーボードのTabでも選択できます。
				</Empty>
			</Card>
		);
	}

	if (selection.kind === "link") {
		const link = model.links.find((item) => item.id === selection.linkId);
		if (!link)
			return (
				<Card title="Details">
					<Notice>選択したlinkは見つかりません。</Notice>
				</Card>
			);
		return <LinkDetails link={link} model={model} />;
	}

	// Network IDはDevice IDとkindを含むため、最初の区切りより後をIDとして扱う。
	const separator = selection.nodeKey.indexOf(":");
	const type = selection.nodeKey.slice(0, separator);
	const id = selection.nodeKey.slice(separator + 1);
	if (type === "device") {
		const device = model.devices.find((item) => item.id === id);
		if (!device)
			return (
				<Card title="Details">
					<Notice>選択したDeviceは見つかりません。</Notice>
				</Card>
			);
		return (
			<DeviceDetails
				device={device}
				siteName={siteNames.get(device.id)}
				model={model}
			/>
		);
	}
	if (type === "network") {
		const network = model.networks.find((item) => item.id === id);
		if (!network)
			return (
				<Card title="Details">
					<Notice>選択したnetworkは見つかりません。</Notice>
				</Card>
			);
		const device = model.devices.find((item) => item.id === network.deviceId);
		return <NetworkDetails network={network} deviceName={device?.name} />;
	}

	const external = model.links
		.flatMap((link) => [link.source, link.target])
		.find((ref) => ref.type === "external" && ref.id === id);
	return (
		<Card title="External endpoint">
			<dl className="kv">
				<dt>Label</dt>
				<dd>{formatValue(external?.label ?? id)}</dd>
				<dt>ID</dt>
				<dd className="mono">{id}</dd>
			</dl>
		</Card>
	);
}

function DeviceDetails({
	device,
	siteName,
	model,
}: {
	device: TopologyModel["devices"][number];
	siteName?: string;
	model: TopologyModel;
}) {
	const networks = networksForDevice(model, device.id);
	const wanDetails = deviceWanDetailLines(device, model);
	const remoteAccessTunnels = remoteAccessTunnelsForDevice(model, device.id);
	const remoteAccessSummary = remoteAccessTypeSummary(remoteAccessTunnels);
	return (
		<Card title={`Device: ${device.name}`}>
			<dl className="kv">
				<dt>Site</dt>
				<dd>{formatValue(siteName)}</dd>
				<dt>Model</dt>
				<dd>{formatValue(device.model)}</dd>
				<dt>Hostname</dt>
				<dd>{formatValue(device.hostname)}</dd>
				<dt>Lifecycle</dt>
				<dd>
					<Badge tone="neutral" plain>
						{device.lifecycle}
					</Badge>
				</dd>
				<dt>CONFIG</dt>
				<dd>
					{device.profile ? (
						<>
							取得: {formatTopologyTime(device.profile.capturedAt)}
							<span className="hint mono"> ({device.profile.configHash})</span>
						</>
					) : (
						<Badge tone="warn">CONFIGなし</Badge>
					)}
				</dd>
				<dt>Interfaces</dt>
				<dd>{device.interfaceIds.length}</dd>
				<dt>Routes</dt>
				<dd>{device.routeIds.length}</dd>
				<dt>VPN tunnels</dt>
				<dd>{device.vpnTunnelIds.length}</dd>
				<dt>WAN</dt>
				<dd>
					{wanDetails.length > 0 ? (
						<ul className="topology-device-networks">
							{wanDetails.map((line) => (
								<li key={line}>{line}</li>
							))}
						</ul>
					) : (
						"—"
					)}
				</dd>
				<dt>リモートアクセス受け</dt>
				<dd>{remoteAccessSummary || "—"}</dd>
				{remoteAccessTunnels.length > 0 && (
					<>
						<dt>リモートアクセスTunnel</dt>
						<dd>
							<ul className="topology-device-networks">
								{remoteAccessTunnels.map((tunnel) => (
									<li key={tunnel.id}>
										Tunnel {tunnel.tunnelNumber} · {vpnTypeLabel(tunnel.type)} ·
										local endpoint: {endpointLabel(tunnel.localEndpoint)} ·
										remote endpoint: {endpointLabel(tunnel.remoteEndpoint)}
									</li>
								))}
							</ul>
						</dd>
					</>
				)}
				<dt>Networks</dt>
				<dd>
					{networks.length > 0 ? (
						<ul className="topology-device-networks">
							{networks.map((network) => (
								<li key={network.id}>{networkDetailLabel(network, model)}</li>
							))}
						</ul>
					) : (
						"—"
					)}
				</dd>
			</dl>
		</Card>
	);
}

function NetworkDetails({
	network,
	deviceName,
}: {
	network: TopologyNetwork;
	deviceName?: string;
}) {
	return (
		<Card title={`Network: ${network.cidr}`}>
			<dl className="kv">
				<dt>Device</dt>
				<dd>{formatValue(deviceName ?? network.deviceId)}</dd>
				<dt>Kind</dt>
				<dd>
					<Badge tone="neutral" plain>
						{network.kind}
					</Badge>
				</dd>
				<dt>Family</dt>
				<dd>{network.family}</dd>
				<dt>Interface IDs</dt>
				<dd className="mono">{network.interfaceIds.join(", ") || "—"}</dd>
			</dl>
			<EvidenceList evidence={network.evidence} />
		</Card>
	);
}

function LinkDetails({
	link,
	model,
}: {
	link: TopologyLink;
	model: TopologyModel;
}) {
	const deviceName = new Map(
		model.devices.map((device) => [device.id, device.name]),
	);
	const tunnels = topologyLinkTunnelIds(link)
		.map((id) => model.vpnTunnels.find((item) => item.id === id))
		.filter((tunnel): tunnel is TopologyVpnTunnel => tunnel !== undefined);
	const source = refLabel(link.source, deviceName);
	const target = refLabel(link.target, deviceName);

	if (tunnels.length === 0) {
		return (
			<Card title="Link details">
				<dl className="kv">
					<dt>Kind</dt>
					<dd>{link.kind}</dd>
					<dt>Source</dt>
					<dd>{source}</dd>
					<dt>Target</dt>
					<dd>{target}</dd>
				</dl>
				<EvidenceList evidence={link.evidence} />
			</Card>
		);
	}

	const networkLabel = (id: string) => {
		const network = model.networks.find((item) => item.id === id);
		return network ? `${network.cidr} (${network.kind})` : id;
	};
	const status = link.match?.status ?? "unmatched";
	const statusLabel =
		status === "matched"
			? `matched${link.match?.confidence ? ` / ${link.match.confidence}` : ""}`
			: status === "ambiguous"
				? "ambiguous — 相手Deviceは未確定"
				: "unmatched — 相手Deviceは未確定";
	const directionLabel =
		link.vpnDirection === "bidirectional" ? "双方向" : "片側のみ";

	return (
		<Card
			title={
				tunnels.length === 1
					? `VPN Tunnel ${tunnels[0]?.tunnelNumber ?? ""}`
					: `VPN Tunnels (${tunnels.length})`
			}
		>
			<dl className="kv">
				<dt>Relation</dt>
				<dd>
					{source} {link.vpnDirection === "bidirectional" ? "↔" : "→"} {target}
				</dd>
				<dt>Direction</dt>
				<dd>{directionLabel}</dd>
				<dt>Match</dt>
				<dd>
					<Badge tone={status === "matched" ? "accent" : "warn"} plain>
						{statusLabel}
					</Badge>
				</dd>
				{link.match?.candidateDeviceIds && (
					<>
						<dt>Candidate Devices</dt>
						<dd>
							{link.match.candidateDeviceIds
								.map((id) => deviceName.get(id) ?? id)
								.join(", ")}
						</dd>
					</>
				)}
			</dl>
			<div className="topology-tunnel-details">
				{tunnels.map((tunnel) => (
					<TunnelFactDetails
						key={tunnel.id}
						tunnel={tunnel}
						localDevice={deviceName.get(tunnel.deviceId) ?? tunnel.deviceId}
						remote={remoteForTunnel(tunnel, link, deviceName)}
						networkLabel={networkLabel}
					/>
				))}
			</div>
			<EvidenceList evidence={link.evidence} />
		</Card>
	);
}

function TunnelFactDetails({
	tunnel,
	localDevice,
	remote,
	networkLabel,
}: {
	tunnel: TopologyVpnTunnel;
	localDevice: string;
	remote: string;
	networkLabel: (id: string) => string;
}) {
	return (
		<section className="topology-tunnel-details__item">
			<strong>
				{localDevice} · Tunnel {tunnel.tunnelNumber}
			</strong>
			<dl className="kv">
				<dt>Local Device</dt>
				<dd>{localDevice}</dd>
				<dt>Remote</dt>
				<dd>{remote}</dd>
				<dt>Type</dt>
				<dd>{vpnTypeLabel(tunnel.type)}</dd>
				<dt>Local endpoint</dt>
				<dd className="mono">{endpointLabel(tunnel.localEndpoint)}</dd>
				<dt>Remote endpoint</dt>
				<dd className="mono">{endpointLabel(tunnel.remoteEndpoint)}</dd>
				<dt>Local network</dt>
				<dd>{tunnel.localNetworkIds.map(networkLabel).join(", ") || "—"}</dd>
				<dt>Remote network</dt>
				<dd>{tunnel.remoteNetworkIds.map(networkLabel).join(", ") || "—"}</dd>
				{tunnel.state && (
					<>
						<dt>State</dt>
						<dd>{tunnel.state.status}</dd>
					</>
				)}
			</dl>
			<EvidenceList evidence={tunnel.evidence} />
		</section>
	);
}

function WarningCard({
	warnings,
	model,
}: {
	warnings: Array<{ message: string } | TopologyModel["warnings"][number]>;
	model: TopologyModel;
}) {
	if (warnings.length === 0) return null;
	const names = new Map(
		model.devices.map((device) => [device.id, device.name]),
	);
	return (
		<Card title={`Warnings (${warnings.length})`}>
			<ul className="topology-warning-list">
				{warnings.map((warning) => (
					<li key={warningKey(warning)}>
						<span>{warningLabel(warning)}</span>
						{"deviceId" in warning && warning.deviceId && (
							<Badge tone="warn" plain>
								{names.get(warning.deviceId) ?? warning.deviceId}
							</Badge>
						)}
						{"candidateDeviceIds" in warning && warning.candidateDeviceIds && (
							<span className="hint">
								候補:{" "}
								{warning.candidateDeviceIds
									.map((id) => names.get(id) ?? id)
									.join(", ")}
							</span>
						)}
					</li>
				))}
			</ul>
		</Card>
	);
}

function EvidenceList({ evidence }: { evidence: TopologyEvidence[] }) {
	if (!evidence || evidence.length === 0) return null;
	return (
		<div className="topology-evidence">
			<strong>Evidence</strong>
			<ul>
				{evidence.map((item) => (
					<li
						key={`${item.source}-${item.rule ?? ""}-${item.summary ?? ""}-${item.inputs?.join(",") ?? ""}`}
					>
						<Badge tone={sourceTone(item.source)} plain>
							{sourceLabel(item.source)}
						</Badge>
						{item.summary && <span>{evidenceSummary(item)}</span>}
						{item.rule && (
							<span className="mono">rule: {evidenceRule(item.rule)}</span>
						)}
						{item.inputs && item.inputs.length > 0 && (
							<span className="hint mono">
								inputs: {item.inputs.join(", ")}
							</span>
						)}
					</li>
				))}
			</ul>
		</div>
	);
}

type LayoutItem =
	| { kind: "device"; value: TopologyModel["devices"][number] }
	| { kind: "external"; value: TopologyNodeRef };

export function buildTopologyLayout(
	model: TopologyModel,
	siteNames: Map<string, string>,
): GraphLayout {
	const devices = [...model.devices].sort((left, right) =>
		compareDevices(left, right, siteNames),
	);
	const vpnLinks = [...model.links]
		.filter((link) => link.kind === "vpn")
		.sort((left, right) => compareText(left.id, right.id));
	const deviceIds = new Set(devices.map((device) => device.id));
	const vpnDegree = new Map(devices.map((device) => [device.id, 0]));
	for (const link of vpnLinks) {
		for (const ref of [link.source, link.target]) {
			if (ref.type !== "device" || !deviceIds.has(ref.id)) continue;
			vpnDegree.set(ref.id, (vpnDegree.get(ref.id) ?? 0) + 1);
		}
	}

	// 最多のVPNを持つDeviceを上段のハブに固定し、同数なら既存のDevice順で決める。
	const hub = [...devices]
		.filter((device) => (vpnDegree.get(device.id) ?? 0) > 0)
		.sort(
			(left, right) =>
				(vpnDegree.get(right.id) ?? 0) - (vpnDegree.get(left.id) ?? 0) ||
				compareDevices(left, right, siteNames),
		)[0];
	const externalRefs = collectExternalRefs(vpnLinks);
	const rows: LayoutItem[][] = [];

	if (hub) {
		const peerIds = new Set<string>();
		for (const link of vpnLinks) {
			if (link.source.type === "device" && link.source.id === hub.id) {
				if (link.target.type === "device") peerIds.add(link.target.id);
			}
			if (link.target.type === "device" && link.target.id === hub.id) {
				if (link.source.type === "device") peerIds.add(link.source.id);
			}
		}
		const peerDevices = devices.filter((device) => peerIds.has(device.id));
		const remainingDevices = devices.filter(
			(device) => device.id !== hub.id && !peerIds.has(device.id),
		);
		const connectedDevices = remainingDevices.filter(
			(device) => (vpnDegree.get(device.id) ?? 0) > 0,
		);
		const vpnlessDevices = remainingDevices.filter(
			(device) => (vpnDegree.get(device.id) ?? 0) === 0,
		);

		rows.push([{ kind: "device", value: hub }]);
		const peerRow: LayoutItem[] = peerDevices.map((device) => ({
			kind: "device",
			value: device,
		}));
		peerRow.push(
			...externalRefs.map((ref) => ({ kind: "external" as const, value: ref })),
		);
		if (peerRow.length > 0) rows.push(peerRow);
		if (connectedDevices.length > 0) {
			rows.push(
				connectedDevices.map((device) => ({
					kind: "device",
					value: device,
				})),
			);
		}
		if (vpnlessDevices.length > 0) {
			rows.push(
				vpnlessDevices.map((device) => ({
					kind: "device",
					value: device,
				})),
			);
		}
	} else {
		if (devices.length > 0) {
			rows.push(
				devices.map((device) => ({
					kind: "device",
					value: device,
				})),
			);
		}
		if (externalRefs.length > 0) {
			rows.push(
				externalRefs.map((ref) => ({
					kind: "external",
					value: ref,
				})),
			);
		}
	}

	const maxColumns = Math.max(...rows.map((row) => row.length), 1);
	const width = Math.max(800, GRAPH_LEFT * 2 + maxColumns * COLUMN_GAP);
	const rowHeights = rows.map((row) =>
		Math.max(...row.map((item) => layoutItemHeight(item, model)), 0),
	);
	const rowY: number[] = [];
	let nextY = GRAPH_TOP;
	for (const rowHeight of rowHeights) {
		rowY.push(nextY);
		nextY += rowHeight + ROW_GAP;
	}

	const nodes: GraphNode[] = [];
	const nodesByKey = new Map<string, GraphNode>();
	for (const [rowIndex, row] of rows.entries()) {
		const firstColumn = Math.floor((maxColumns - row.length) / 2);
		for (const [columnIndex, item] of row.entries()) {
			const x = GRAPH_LEFT + (firstColumn + columnIndex) * COLUMN_GAP;
			const y = rowY[rowIndex] ?? GRAPH_TOP;
			const node =
				item.kind === "device"
					? createDeviceNode(item.value, model, siteNames, x, y)
					: createExternalNode(item.value, x, y);
			nodes.push(node);
			nodesByKey.set(node.key, node);
		}
	}

	const pairCounts = new Map<string, number>();
	for (const link of vpnLinks) {
		const key = pairKey(link);
		pairCounts.set(key, (pairCounts.get(key) ?? 0) + 1);
	}
	const pairSeen = new Map<string, number>();
	const links: GraphLink[] = [];
	let skippedLinks = 0;
	for (const link of vpnLinks) {
		const source = nodesByKey.get(nodeKey(link.source));
		const target = nodesByKey.get(nodeKey(link.target));
		if (!source || !target) {
			skippedLinks += 1;
			continue;
		}
		const pair = pairKey(link);
		const pairIndex = pairSeen.get(pair) ?? 0;
		pairSeen.set(pair, pairIndex + 1);
		const pairCount = pairCounts.get(pair) ?? 1;
		const offset = (pairIndex - (pairCount - 1) / 2) * 18;
		const geometry = linkGeometry(source, target, offset);
		const sourceType = linkSource(link);
		const warning = link.match?.status !== "matched";
		const badgeLabel = linkBadgeLabel(link, sourceType);
		links.push({
			link,
			source,
			target,
			path: geometry.path,
			badgeX: geometry.badgeX,
			badgeY: geometry.badgeY,
			badgeLabel,
			badgeVisible: Boolean(badgeLabel),
			ariaLabel: linkAriaLabel(link, model),
			style: warning ? "warning" : sourceType,
			direction: link.vpnDirection,
		});
	}

	const height = Math.max(
		360,
		(rows.length > 0 ? nextY - ROW_GAP : GRAPH_TOP) + GRAPH_BOTTOM,
	);
	return {
		width,
		height,
		nodes,
		links: placeLinkBadges(links, nodes, width, height),
		skippedLinks,
	};
}

function layoutItemHeight(item: LayoutItem, model: TopologyModel): number {
	if (item.kind === "external") return EXTERNAL_HEIGHT;
	const missingProfile = !item.value.profile;
	return deviceNodeHeight(
		deviceCardLines(item.value.id, model),
		missingProfile,
	);
}

function deviceNodeHeight(
	detailLines: string[],
	missingProfile: boolean,
): number {
	const detailHeight = detailLines.length * NODE_DETAIL_LINE_HEIGHT;
	const warningHeight = missingProfile ? NODE_DETAIL_LINE_HEIGHT : 0;
	return Math.max(DEVICE_BASE_HEIGHT, 64 + detailHeight + warningHeight + 12);
}

function deviceCardLines(deviceId: string, model: TopologyModel): string[] {
	const device = model.devices.find((item) => item.id === deviceId);
	if (!device?.profile) return [];
	const remoteAccessLines = remoteAccessTypeSummary(
		remoteAccessTunnelsForDevice(model, deviceId),
	)
		.split(" / ")
		.filter(Boolean);
	const lanLines = networksForDevice(model, deviceId)
		.filter((network) => network.kind === "lan")
		.map((network) => networkCardLabel(network, model));
	const wanLines = deviceWanCardLines(device, model);
	const networkLineLimit = Math.max(
		0,
		MAX_DEVICE_NETWORK_LINES - remoteAccessLines.length,
	);
	const visibleWanLines = wanLines.slice(0, networkLineLimit);
	const visibleLanLines = lanLines.slice(
		0,
		Math.max(0, networkLineLimit - visibleWanLines.length),
	);
	const visible = [
		...remoteAccessLines,
		...visibleLanLines,
		...visibleWanLines,
	];
	const remaining =
		lanLines.length -
		visibleLanLines.length +
		wanLines.length -
		visibleWanLines.length;
	if (remaining > 0) visible.push(`ほか ${remaining}件`);
	return visible.length > 0 ? visible : ["LAN/WAN情報なし"];
}

function deviceWanCardLines(
	device: TopologyModel["devices"][number],
	model: TopologyModel,
): string[] {
	const wan = device.wan;
	if (!wan) {
		return networksForDevice(model, device.id)
			.filter((network) => network.kind === "wan")
			.map((network) => {
				const address = primaryNetworkAddress(network, model) ?? network.cidr;
				return `WAN ${address} (静的)`;
			});
	}
	const lines: string[] = [];
	if (wan.ipv4) {
		if (wan.ipv4.method === "static") {
			const staticNetworks = networksForDevice(model, device.id).filter(
				(network) => network.kind === "wan" && network.family === "ipv4",
			);
			if (staticNetworks.length > 0) {
				for (const network of staticNetworks) {
					const address = primaryNetworkAddress(network, model) ?? network.cidr;
					lines.push(`WAN ${address} (静的)`);
				}
			} else {
				lines.push("WAN 静的");
			}
		} else {
			lines.push(`WAN ${wanIpv4MethodLabel(wan.ipv4.method)}`);
		}
	}
	if (wan.ipv4OverIpv6) {
		lines.push(`WAN IPoE (${wanIpv4OverIpv6Label(wan.ipv4OverIpv6.method)})`);
	}
	if (wan.ipv6) {
		lines.push(`WAN IPv6 ${wanIpv6MethodLabel(wan.ipv6.method)}`);
	}
	return lines;
}

function remoteAccessTunnelsForDevice(
	model: TopologyModel,
	deviceId: string,
): TopologyVpnTunnel[] {
	return model.vpnTunnels
		.filter((tunnel) => tunnel.deviceId === deviceId && tunnel.remoteAccess)
		.sort((left, right) => left.tunnelNumber - right.tunnelNumber);
}

function remoteAccessTypeSummary(
	tunnels: readonly TopologyVpnTunnel[],
): string {
	const counts = new Map<TopologyVpnTunnel["type"], number>();
	for (const tunnel of tunnels) {
		counts.set(tunnel.type, (counts.get(tunnel.type) ?? 0) + 1);
	}
	return [...counts]
		.sort(([left], [right]) => left.localeCompare(right))
		.map(
			([type, count]) =>
				`リモートアクセス受け: 有効 (${vpnTypeLabel(type)}${count > 1 ? ` ×${count}` : ""})`,
		)
		.join(" / ");
}

function vpnTypeLabel(type: TopologyVpnTunnel["type"]): string {
	switch (type) {
		case "ipsec":
			return "IPsec";
		case "l2tp-ipsec":
			return "L2TP/IPsec";
		case "l2tpv3":
			return "L2TPv3";
		case "gre":
			return "GRE";
		case "ipip":
			return "IPIP";
		default:
			return "種別不明";
	}
}

function deviceWanDetailLines(
	device: TopologyModel["devices"][number],
	model: TopologyModel,
): string[] {
	const wan = device.wan;
	if (!wan) return deviceWanCardLines(device, model);
	const lines = deviceWanCardLines(device, model);
	if (wan.ipv4?.interface) {
		lines.push(`IPv4 interface: ${wan.ipv4.interface}`);
	}
	if (wan.ipv4?.pp !== undefined) lines.push(`IPv4 PP: ${wan.ipv4.pp}`);
	if (wan.ipv6?.interface) {
		lines.push(`IPv6 interface: ${wan.ipv6.interface}`);
	}
	if (wan.ipv4OverIpv6?.tunnel !== undefined) {
		lines.push(`IPv4 over IPv6 tunnel: ${wan.ipv4OverIpv6.tunnel}`);
	}
	return lines;
}

function wanIpv4MethodLabel(method: "pppoe" | "dhcp" | "static"): string {
	return method === "pppoe" ? "PPPoE" : method === "dhcp" ? "DHCP" : "静的";
}

function wanIpv6MethodLabel(
	method: "dhcpv6-pd" | "dhcpv6" | "ra" | "static",
): string {
	return method === "dhcpv6-pd"
		? "DHCPv6-PD"
		: method === "dhcpv6"
			? "DHCPv6"
			: method === "ra"
				? "RA"
				: "静的";
}

function wanIpv4OverIpv6Label(method: "map-e" | "ds-lite"): string {
	return method === "map-e" ? "MAP-E" : "DS-Lite";
}

function networksForDevice(
	model: TopologyModel,
	deviceId: string,
): TopologyNetwork[] {
	return model.networks
		.filter((network) => network.deviceId === deviceId)
		.sort(compareNetworksForDevice);
}

function compareNetworksForDevice(
	left: TopologyNetwork,
	right: TopologyNetwork,
): number {
	return (
		networkKindOrder(left.kind) - networkKindOrder(right.kind) ||
		compareText(left.cidr, right.cidr) ||
		compareText(left.id, right.id)
	);
}

function networkKindOrder(kind: TopologyNetwork["kind"]): number {
	return kind === "lan" ? 0 : kind === "wan" ? 1 : kind === "tunnel" ? 2 : 3;
}

function networkKindLabel(kind: TopologyNetwork["kind"]): string {
	return kind === "lan"
		? "LAN"
		: kind === "wan"
			? "WAN"
			: kind === "tunnel"
				? "Tunnel"
				: "Network";
}

function primaryNetworkAddress(
	network: TopologyNetwork,
	model: TopologyModel,
): string | undefined {
	for (const interfaceId of network.interfaceIds) {
		const interfaceFact = model.interfaces.find(
			(item) => item.id === interfaceId,
		);
		const address = interfaceFact?.addresses.find(
			(item) => item.family === network.family && item.address,
		);
		if (address?.address) return address.address;
	}
	return undefined;
}

function networkCardLabel(
	network: TopologyNetwork,
	model: TopologyModel,
): string {
	const address = primaryNetworkAddress(network, model);
	const value =
		network.kind === "wan" ? (address ?? network.cidr) : network.cidr;
	return `${networkKindLabel(network.kind)} ${value}`;
}

function networkDetailLabel(
	network: TopologyNetwork,
	model: TopologyModel,
): string {
	const address = primaryNetworkAddress(network, model);
	return `${networkKindLabel(network.kind)} ${network.cidr}${address ? ` · ${address}` : ""}`;
}

function createDeviceNode(
	device: TopologyModel["devices"][number],
	model: TopologyModel,
	siteNames: Map<string, string>,
	x: number,
	y: number,
): GraphNode {
	const title = device.name || device.id;
	const detailLines = deviceCardLines(device.id, model);
	const missingProfile = !device.profile;
	const detailsForAria = detailLines.length
		? `、${detailLines.join("、")}`
		: "";
	return {
		key: nodeKey({ type: "device", id: device.id }),
		type: "device",
		id: device.id,
		x,
		y,
		width: NODE_WIDTH,
		height: deviceNodeHeight(detailLines, missingProfile),
		title,
		subtitle: [siteNames.get(device.id), device.model ?? "Model不明"]
			.filter(Boolean)
			.join(" · "),
		detailLines,
		ariaLabel: `${title} Device${missingProfile ? "、CONFIGなし" : ""}${detailsForAria}`,
		missingProfile,
	};
}

function createExternalNode(
	ref: TopologyNodeRef,
	x: number,
	y: number,
): GraphNode {
	const title = ref.label ?? ref.id;
	return {
		key: nodeKey(ref),
		type: "external",
		id: ref.id,
		x,
		y,
		width: NODE_WIDTH,
		height: EXTERNAL_HEIGHT,
		title,
		subtitle: "VPN endpoint",
		detailLines: ["相手Deviceは未確定"],
		ariaLabel: `${title} external VPN endpoint、相手Deviceは未確定`,
	};
}

function placeLinkBadges(
	links: GraphLink[],
	nodes: GraphNode[],
	graphWidth: number,
	graphHeight: number,
): GraphLink[] {
	const placed: Array<{ x: number; y: number; width: number }> = [];
	const yOffsets = [0];
	for (
		let index = 1;
		index <= Math.ceil(graphHeight / LINK_BADGE_STEP);
		index += 1
	) {
		yOffsets.push(-index * LINK_BADGE_STEP, index * LINK_BADGE_STEP);
	}

	return links.map((link) => {
		if (!link.badgeLabel) {
			return { ...link, badgeVisible: false };
		}
		const width = badgeWidth(link.badgeLabel);
		const y = yOffsets.find((offset) => {
			const candidateY = link.badgeY + offset;
			if (
				link.badgeX - width / 2 < LINK_BADGE_GAP ||
				link.badgeX + width / 2 > graphWidth - LINK_BADGE_GAP ||
				candidateY - LINK_BADGE_HEIGHT / 2 < LINK_BADGE_GAP ||
				candidateY + LINK_BADGE_HEIGHT / 2 > graphHeight - LINK_BADGE_GAP
			) {
				return false;
			}
			if (
				nodes.some((node) =>
					badgeOverlapsNode(link.badgeX, candidateY, width, node),
				)
			) {
				return false;
			}
			return !placed.some(
				(existing) =>
					Math.abs(link.badgeX - existing.x) <
						(width + existing.width) / 2 + LINK_BADGE_GAP &&
					Math.abs(candidateY - existing.y) <
						LINK_BADGE_HEIGHT + LINK_BADGE_GAP,
			);
		});

		if (y === undefined) {
			// ラベルを置く場所がない場合も、link自体とaria-labelは残す。
			return { ...link, badgeVisible: false };
		}
		const badgeY = link.badgeY + y;
		placed.push({ x: link.badgeX, y: badgeY, width });
		return { ...link, badgeY, badgeVisible: true };
	});
}

function badgeOverlapsNode(
	centerX: number,
	centerY: number,
	badgeWidthValue: number,
	node: GraphNode,
): boolean {
	const halfWidth = badgeWidthValue / 2;
	const halfHeight = LINK_BADGE_HEIGHT / 2;
	return (
		centerX - halfWidth < node.x + node.width &&
		centerX + halfWidth > node.x &&
		centerY - halfHeight < node.y + node.height &&
		centerY + halfHeight > node.y
	);
}

function linkGeometry(
	source: GraphNode,
	target: GraphNode,
	offset: number,
): { path: string; badgeX: number; badgeY: number } {
	const sourceCenterX = source.x + source.width / 2;
	const sourceCenterY = source.y + source.height / 2;
	const targetCenterX = target.x + target.width / 2;
	const targetCenterY = target.y + target.height / 2;
	if (source.key === target.key) {
		const badgeX = sourceCenterX + source.width / 2 + 36;
		const badgeY = source.y - 18;
		return {
			path: `M ${sourceCenterX} ${source.y} Q ${badgeX} ${badgeY - 30} ${source.x + source.width} ${sourceCenterY}`,
			badgeX,
			badgeY,
		};
	}

	const sourceIsAbove = source.y + source.height <= target.y;
	const targetIsAbove = target.y + target.height <= source.y;
	if (sourceIsAbove || targetIsAbove) {
		const sourceIsTop = sourceIsAbove;
		const sx = sourceCenterX;
		const sy = sourceIsTop ? source.y + source.height : source.y;
		const tx = targetCenterX;
		const ty = sourceIsTop ? target.y : target.y + target.height;
		const badgeX = (sx + tx) / 2 + offset;
		const badgeY = (sy + ty) / 2 - 18;
		return {
			path: `M ${sx} ${sy} Q ${badgeX} ${(sy + ty) / 2} ${tx} ${ty}`,
			badgeX,
			badgeY,
		};
	}

	const sourceIsLeft = source.x + source.width <= target.x;
	const sx = sourceIsLeft ? source.x + source.width : source.x;
	const sy = sourceCenterY;
	const tx = sourceIsLeft ? target.x : target.x + target.width;
	const ty = targetCenterY;
	const controlX = (sx + tx) / 2;
	const controlY = (sy + ty) / 2 - 36 + offset;
	const badgeX = controlX;
	const badgeY = controlY - 12;
	return {
		path: `M ${sx} ${sy} Q ${controlX} ${controlY} ${tx} ${ty}`,
		badgeX,
		badgeY,
	};
}

function normalizeTopology(value: unknown): NormalizedTopology {
	if (!isRecord(value)) throw new Error("topology must be an object");
	const warnings: string[] = [];
	const array = <T,>(key: string): T[] => {
		if (!Array.isArray(value[key])) {
			warnings.push(`Topologyの${key}が配列ではありません。`);
			return [];
		}
		const items = value[key].filter(isRecord) as unknown as T[];
		if (items.length !== value[key].length) {
			warnings.push(`Topologyの${key}に解釈できない項目があります。`);
		}
		return items;
	};
	return {
		model: {
			schemaVersion: 1,
			generatedAt:
				typeof value.generatedAt === "string" ? value.generatedAt : "",
			devices: array("devices"),
			interfaces: array("interfaces"),
			networks: array("networks"),
			routes: array("routes"),
			vpnTunnels: array("vpnTunnels"),
			neighbors: array("neighbors"),
			links: array("links"),
			warnings: array("warnings"),
		} as TopologyModel,
		warnings,
	};
}

function collectExternalRefs(links: TopologyLink[]): TopologyNodeRef[] {
	const refs = new Map<string, TopologyNodeRef>();
	for (const link of links) {
		for (const ref of [link.source, link.target]) {
			if (ref.type === "external") refs.set(ref.id, ref);
		}
	}
	return [...refs.values()].sort((left, right) =>
		compareText(left.id, right.id),
	);
}

function compareDevices(
	left: TopologyModel["devices"][number],
	right: TopologyModel["devices"][number],
	siteNames: Map<string, string>,
): number {
	return (
		compareText(siteNames.get(left.id) ?? "", siteNames.get(right.id) ?? "") ||
		compareText(left.name ?? "", right.name ?? "") ||
		compareText(left.id, right.id)
	);
}

function compareText(left: string, right: string): number {
	return left === right ? 0 : left < right ? -1 : 1;
}

function nodeKey(ref: TopologyNodeRef): string {
	return `${ref.type}:${ref.id}`;
}

function pairKey(link: TopologyLink): string {
	return [nodeKey(link.source), nodeKey(link.target)]
		.sort(compareText)
		.join("|");
}

function linkSource(
	link: TopologyLink,
): "configured" | "observed" | "inferred" {
	if (link.evidence?.some((item) => item.source === "inferred"))
		return "inferred";
	if (link.evidence?.some((item) => item.source === "observed"))
		return "observed";
	return "configured";
}

function linkBadgeLabel(
	link: TopologyLink,
	source: "configured" | "observed" | "inferred",
): string {
	if (link.match?.status === "ambiguous") return "候補複数";
	if (link.match?.status === "unmatched") return "相手不明";
	if (source === "inferred") {
		return link.vpnDirection === "single" ? "推定・片側のみ" : "推定";
	}
	if (source === "observed") {
		return link.vpnDirection === "single" ? "観測・片側のみ" : "観測";
	}
	if (link.vpnDirection === "single") return "片側のみ";
	return "";
}

function topologyLinkTunnelIds(link: TopologyLink): string[] {
	if (link.vpnTunnelIds && link.vpnTunnelIds.length > 0) {
		return link.vpnTunnelIds;
	}
	return link.vpnTunnelId ? [link.vpnTunnelId] : [];
}

function remoteForTunnel(
	tunnel: TopologyVpnTunnel,
	link: TopologyLink,
	names: Map<string, string>,
): string {
	if (link.source.type === "device" && tunnel.deviceId === link.source.id) {
		return refLabel(link.target, names);
	}
	if (link.target.type === "device" && tunnel.deviceId === link.target.id) {
		return refLabel(link.source, names);
	}
	return refLabel(link.target, names);
}

function linkAriaLabel(link: TopologyLink, model: TopologyModel): string {
	const names = new Map(
		model.devices.map((device) => [device.id, device.name]),
	);
	const source = refLabel(link.source, names);
	const target = refLabel(link.target, names);
	if (link.kind !== "vpn") {
		return `${source} ${linkKindLabel(link.kind)} ${sourceLabel(linkSource(link))}、接続先 ${target}`;
	}
	const tunnels = topologyLinkTunnelIds(link)
		.map((id) => model.vpnTunnels.find((item) => item.id === id))
		.filter((tunnel): tunnel is TopologyVpnTunnel => tunnel !== undefined);
	const status = link.match?.status ?? "unmatched";
	const inference =
		status === "matched" && link.vpnDirection === "bidirectional"
			? "推定、双方向"
			: status === "matched" && link.vpnDirection === "single"
				? "片側のみ、推定"
				: status === "matched"
					? "推定"
					: status === "ambiguous"
						? "候補複数、相手Deviceは未確定"
						: "相手不明、相手Deviceは未確定";
	const tunnelLabel = tunnels.length
		? tunnels
				.map(
					(tunnel) =>
						`Tunnel ${tunnel.tunnelNumber} (${vpnTypeLabel(tunnel.type)})`,
				)
				.join(" / ")
		: "Tunnel 不明";
	return `${source} ${tunnelLabel} ${inference}、接続先 ${target}`;
}

function linkKindLabel(linkKind: TopologyLink["kind"]): string {
	return linkKind === "network-attachment"
		? "ネットワーク接続"
		: linkKind === "wan"
			? "WAN接続"
			: "VPN接続";
}

function refLabel(ref: TopologyNodeRef, names: Map<string, string>): string {
	if (ref.type === "device") return names.get(ref.id) ?? ref.id;
	return ref.label ?? ref.id;
}

function endpointLabel(
	endpoint: TopologyVpnTunnel["localEndpoint"] | undefined,
): string {
	return endpoint ? `${endpoint.kind}: ${endpoint.value}` : "—";
}

function sourceLabel(source: TopologySource): string {
	return source === "configured"
		? "確定"
		: source === "observed"
			? "観測"
			: "推定";
}

function warningLabel(
	warning: { message: string } | TopologyModel["warnings"][number],
): string {
	if ("code" in warning) {
		return WARNING_LABELS[warning.code] ?? warning.message;
	}
	return warning.message;
}

function evidenceRule(rule: string): string {
	return EVIDENCE_RULE_LABELS[rule] ?? rule;
}

function evidenceSummary(evidence: TopologyEvidence): string {
	if (evidence.rule) {
		if (EVIDENCE_RULE_LABELS[evidence.rule]) {
			return (
				EVIDENCE_SUMMARY_LABELS[evidence.summary ?? ""] ??
				evidence.summary ??
				EVIDENCE_RULE_LABELS[evidence.rule]
			);
		}
		return evidence.summary ?? evidence.rule;
	}
	return (
		EVIDENCE_SUMMARY_LABELS[evidence.summary ?? ""] ?? evidence.summary ?? ""
	);
}

function sourceTone(
	source: TopologySource,
): "ok" | "warn" | "neutral" | "accent" {
	return source === "configured"
		? "neutral"
		: source === "observed"
			? "ok"
			: "accent";
}

function badgeWidth(label: string): number {
	return Math.max(62, label.length * 7 + 18);
}

function truncate(value: string, length: number): string {
	return value.length > length ? `${value.slice(0, length - 1)}…` : value;
}

function formatTopologyTime(value: string): string {
	return value && !Number.isNaN(Date.parse(value)) ? formatTime(value) : "—";
}

function warningKey(
	warning: { message: string } | TopologyModel["warnings"][number],
): string {
	if ("code" in warning) {
		return `${warning.code}:${warning.deviceId ?? ""}:${warning.factId ?? ""}:${warning.message}`;
	}
	return `ui:${warning.message}`;
}

function activateWithKeyboard(
	event: ReactKeyboardEvent<SVGGElement>,
	activate: () => void,
): void {
	if (event.key !== "Enter" && event.key !== " ") return;
	event.preventDefault();
	activate();
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
