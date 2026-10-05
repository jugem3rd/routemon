/** Routemon APIの薄いwrapper。認証はhttpOnly cookieなので、credentialsだけ渡す。 */

export type PresenceStatus = "online" | "unstable" | "offline" | "unknown";

export type Site = {
	id: string;
	name: string;
	description: string | null;
	createdAt: string;
	updatedAt: string;
};

export type Tag = {
	id: string;
	name: string;
	createdAt: string;
};

export type Device = {
	id: string;
	name: string;
	siteId: string | null;
	siteName: string | null;
	tags: Tag[];
	description: string | null;
	notes: string | null;
	model: string | null;
	firmwareRevision: string | null;
	agentVersion: string | null;
	configState: "saved" | "unsaved";
	lifecycle: string;
	presence: {
		status: PresenceStatus;
		lastSeenAt: string | null;
		observedSourceIp: string | null;
	};
	serialNumber?: string | null;
	hostname?: string | null;
	registeredAt?: string | null;
	bootedAt?: string | null;
};

/** Jobs APIはDBのrowをそのまま返す(apps/community/src/jobs/jobs.ts)。 */
export type Job = {
	id: string;
	device_id: string;
	type: string;
	status: string;
	request: string | null;
	output: string | null;
	error: string | null;
	created_at: string;
	finished_at: string | null;
	/** 予約実行の時刻(#54)。即時実行ならnull */
	scheduled_at: string | null;
	/** Dashboardのみ(一覧の表示用) */
	deviceName?: string;
};

/** CONFIGから抽出したfacts(#6)。CONFIG本文はAPIから返らない。 */
export type DeviceProfile = {
	internet: {
		ipv4?: { method: string; interface?: string; pp?: number };
		ipv6?: { method: string; interface?: string };
		ipv4_over_ipv6?: { method: string; tunnel?: number };
	};
	defaultRoute?: string;
	lan: { interface: string; address: string }[];
	tunnels: { id: number; encapsulation: string }[];
	routes: ProfileRoute[];
	ipsecTunnels: ProfileTunnel[];
	model?: string;
	firmwareRevision?: string;
	capturedAt: string;
};

export type ProfileRoute = {
	destination: string;
	gateway: {
		kind: "ip" | "dhcp" | "pp" | "tunnel" | "interface" | "unknown";
		value: string;
	};
	interface?: string;
	tunnel?: number;
};

export type ProfileTunnel = {
	id: number;
	encapsulation: string;
	ipsecTunnelIds?: number[];
	localEndpoint?: { kind: string; value: string };
	remoteEndpoint?: { kind: string; value: string };
};

/**
 * 経路表Observed (#134)。項目名は`packages/core`の`parseRouteTable`の
 * `ObservedRoute`に合わせる。webはcoreに依存しないため型はここに書く。
 */
export type ObservedRoute = {
	family: "ipv4" | "ipv6";
	destination: string;
	gateway: string | null;
	interface: string | null;
	rawType: string;
	category: "static" | "dynamic" | "implicit" | "temporary" | "unknown";
	protocol?: string;
	metric?: number;
	cost?: number;
	rawDetails?: string;
};

export type DeviceRouteAttemptStatus = "complete" | "partial" | "failed";

/** familyごとのObserved snapshot。attempt未実施のfamilyはnull (#105設計7章)。 */
export type DeviceRouteSnapshot = {
	capturedAt: string | null;
	changedAt: string | null;
	lastAttemptAt: string | null;
	lastAttemptStatus: DeviceRouteAttemptStatus | null;
	routes: ObservedRoute[];
	unparsedLines: string[];
};

export type DeviceRoutes = {
	ipv4: DeviceRouteSnapshot | null;
	ipv6: DeviceRouteSnapshot | null;
};

export type TopologySource = "configured" | "observed" | "inferred";

export type TopologyEvidence = {
	source: TopologySource;
	at?: string;
	configHash?: string;
	rule?: string;
	inputs?: string[];
	summary?: string;
};

export type TopologyDevice = {
	id: string;
	name: string;
	vendor: string;
	model: string | null;
	hostname: string | null;
	lifecycle: string;
	interfaceIds: string[];
	routeIds: string[];
	vpnTunnelIds: string[];
	wan: TopologyWanSummary | null;
	profile: { capturedAt: string; configHash: string } | null;
};

export type TopologyWanSummary = {
	ipv4?: {
		method: "pppoe" | "dhcp" | "static";
		interface?: string;
		pp?: number;
		evidence: TopologyEvidence[];
	};
	ipv6?: {
		method: "dhcpv6-pd" | "dhcpv6" | "ra" | "static";
		interface?: string;
		evidence: TopologyEvidence[];
	};
	ipv4OverIpv6?: {
		method: "map-e" | "ds-lite";
		tunnel?: number;
		evidence: TopologyEvidence[];
	};
};

export type TopologyAddress = {
	family: "ipv4" | "ipv6";
	address?: string;
	assignment: "static" | "dhcp" | "pppoe" | "unknown";
	evidence: TopologyEvidence[];
};

export type TopologyInterface = {
	id: string;
	deviceId: string;
	name: string;
	role: "lan" | "wan" | "tunnel" | "unknown";
	addresses: TopologyAddress[];
	networkIds: string[];
	evidence: TopologyEvidence[];
};

export type TopologyNetwork = {
	id: string;
	deviceId: string;
	family: "ipv4" | "ipv6";
	cidr: string;
	kind: "lan" | "wan" | "tunnel" | "unknown";
	interfaceIds: string[];
	evidence: TopologyEvidence[];
};

export type TopologyRoute = {
	id: string;
	deviceId: string;
	destination: string;
	gateway: {
		kind: "ip" | "dhcp" | "pp" | "tunnel" | "interface" | "unknown";
		value: string;
	};
	interfaceId?: string;
	evidence: TopologyEvidence[];
};

export type TopologyEndpoint = {
	kind: "ipv4" | "ipv6" | "fqdn" | "dynamic" | "unknown";
	value: string;
};

export type TopologyVpnTunnel = {
	id: string;
	deviceId: string;
	tunnelNumber: number;
	type: "ipsec" | "l2tp-ipsec" | "l2tpv3" | "gre" | "ipip" | "unknown";
	remoteAccess?: true;
	interfaceId?: string;
	localEndpoint?: TopologyEndpoint;
	remoteEndpoint?: TopologyEndpoint;
	localNetworkIds: string[];
	remoteNetworkIds: string[];
	state?: {
		status: "up" | "down" | "unknown";
		evidence: TopologyEvidence[];
	};
	evidence: TopologyEvidence[];
};

export type TopologyNodeRef = {
	type: "device" | "network" | "external";
	id: string;
	label?: string;
};

export type TopologyLinkMatch = {
	status: "matched" | "unmatched" | "ambiguous";
	confidence?: "high" | "medium" | "low";
	candidateDeviceIds?: string[];
};

export type TopologyLink = {
	id: string;
	kind: "network-attachment" | "wan" | "vpn";
	source: TopologyNodeRef;
	target: TopologyNodeRef;
	interfaceId?: string;
	vpnTunnelId?: string;
	vpnTunnelIds?: string[];
	vpnDirection?: "single" | "bidirectional";
	match?: TopologyLinkMatch;
	evidence: TopologyEvidence[];
};

export type TopologyNeighbor = {
	id: string;
	sourceDeviceId: string;
	targetDeviceId?: string;
	targetAddress?: string;
	protocol: "lldp" | "arp" | "route" | "unknown";
	evidence: TopologyEvidence[];
};

export type TopologyWarning = {
	code:
		| "profile_missing"
		| "partial_profile"
		| "unsupported_feature"
		| "ambiguous_vpn_peer";
	deviceId?: string;
	factId?: string;
	candidateDeviceIds?: string[];
	message: string;
};

export type TopologyModel = {
	schemaVersion: 1;
	generatedAt: string;
	devices: TopologyDevice[];
	interfaces: TopologyInterface[];
	networks: TopologyNetwork[];
	routes: TopologyRoute[];
	vpnTunnels: TopologyVpnTunnel[];
	neighbors: TopologyNeighbor[];
	links: TopologyLink[];
	warnings: TopologyWarning[];
};

export type ConfigBackup = {
	id: string;
	capturedAt: string;
	sizeBytes: number;
	contentHash: string;
};

export type ConfigCheckpointItem = {
	id: string;
	deviceId: string | null;
	deviceName: string;
	backupId: string | null;
	backupAvailable: boolean;
	status: "pending" | "captured" | "failed";
	failureCode: string | null;
	requestedAt: string;
	capturedAt: string | null;
};

export type ConfigCheckpoint = {
	id: string;
	name: string;
	memo: string | null;
	createdAt: string;
	status: "pending" | "partial" | "captured" | "failed";
	capturedCount: number;
	pendingCount: number;
	failedCount: number;
	items: ConfigCheckpointItem[];
};

export type ConfigDiffLine = {
	type: "context" | "added" | "removed";
	text: string;
};

export type ConfigDiff = {
	backup: ConfigBackup;
	against: ConfigBackup | null;
	changed: boolean;
	lines: ConfigDiffLine[];
	diff: string;
};

export type ConfigApplyPhase =
	| "prepare"
	| "confirm"
	| "transfer"
	| "activate"
	| "verify"
	| "complete"
	| "failed";

export type ConfigApplyResult =
	| "matched"
	| "mismatch"
	| "unavailable"
	| "failed"
	| null;

export type ConfigApply = {
	id: string;
	deviceId: string;
	targetBackupId: string | null;
	preApplyBackupId: string | null;
	targetBackupAvailable: boolean;
	preApplyBackupAvailable: boolean;
	saveAfterApply: boolean;
	phase: ConfigApplyPhase;
	result: ConfigApplyResult;
	errorCode: string | null;
	saveJobId: string | null;
	discardRebootJobId: string | null;
	preparedAt: string;
	confirmedAt: string | null;
	activatedAt: string | null;
	verifiedAt: string | null;
	finishedAt: string | null;
	savedAt: string | null;
	discardedAt: string | null;
};

export type ConfigApplyDetails = {
	apply: ConfigApply;
	diff: ConfigDiff | null;
	diffUnavailable: boolean;
	/** 差分があるときだけ分類の配列。差分を返せないときはnull(#126)。 */
	risks: ConfigApplyBatchRisk[] | null;
};

/** 一括適用(Batch)の状態。Serverの値をそのまま使う(#94)。 */
export type ConfigApplyBatchStatus =
	| "preparing"
	| "awaiting_confirmation"
	| "running"
	| "stopping"
	| "stopped"
	| "complete";

export type ConfigApplyBatchItemStatus =
	| "preparing"
	| "prepared"
	| "no_change"
	| "excluded"
	| "queued"
	| "guarding"
	| "awaiting_confirmation"
	| "applying"
	| "applied"
	| "failed"
	| "skipped";

/** load開始後に検証不能だったか、のServer判定。表示の3群分けに使う。 */
export type ConfigApplyEffect = "confirmed" | "not_applied" | "unknown";

export type ConfigApplyBatchSaveResult =
	| "not_requested"
	| "pending"
	| "confirmed"
	| "failed"
	| "unconfirmed";

export type ConfigApplyBatchRisk =
	| "wan"
	| "pppoe"
	| "filter"
	| "supervisor_autostart";

export type ConfigApplyBatchPlan = {
	changed: boolean;
	addedLines: number;
	removedLines: number;
	risks: ConfigApplyBatchRisk[];
	validation: {
		valid: boolean;
		code: string | null;
		model: {
			expected: string | null;
			actual: string | null;
			valid: boolean | null;
		};
		firmware: {
			expected: string | null;
			actual: string | null;
			valid: boolean | null;
		};
		lineCount: { actual: number; maximum: number; valid: boolean };
		sizeBytes: { actual: number; maximum: number; valid: boolean };
		supervisorAutostart: { present: boolean; valid: boolean };
	};
};

export type ConfigApplyBatchItem = {
	id: string;
	sequence: number;
	deviceId: string | null;
	deviceName: string;
	targetBackupId: string;
	preparedBackupId: string | null;
	executionCheckBackupId: string | null;
	selectedForExecution: boolean;
	plan: ConfigApplyBatchPlan | null;
	status: ConfigApplyBatchItemStatus;
	failureCode: string | null;
	applyId: string | null;
	applyEffect: ConfigApplyEffect | null;
	saveResult: ConfigApplyBatchSaveResult | null;
	requestedAt: string;
	confirmedAt: string | null;
	finishedAt: string | null;
};

export type ConfigApplyBatch = {
	id: string;
	source: "checkpoint" | "devices";
	sourceCheckpointId: string | null;
	sourceCheckpointName: string | null;
	confirmationMode: "batch" | "per_device";
	saveAfterApply: boolean;
	status: ConfigApplyBatchStatus;
	currentItemId: string | null;
	stopReason: string | null;
	planCompletedAt: string | null;
	confirmedAt: string | null;
	createdAt: string;
	updatedAt: string;
	finishedAt: string | null;
	items: ConfigApplyBatchItem[];
};

export type ConfigApplyBatchSource =
	| { type: "checkpoint"; checkpointId: string }
	| { type: "devices"; items: { deviceId: string; backupId: string }[] };

export type AgentState = {
	agentVersion: string | null;
	desiredAgentVersion: string | null;
	agentSlot: string | null;
	lastAgentReason?: string;
	lastAgentReasonType?: "rollback" | "recovery";
};

export type SetupStatus = {
	initialized: boolean;
	instanceName: string | null;
	timezone: string | null;
	publicBaseUrl: string | null;
};

export type SetupCheck = {
	name: string;
	status: "ok" | "error";
	detail: string;
};

export type SyslogStorageStatus = {
	usedBytes: number;
	maxBytes: number;
	retentionDays: number;
	lowWatermark: number;
	oldestAt?: string;
};

export type SyslogLine = {
	ts: string;
	message: string;
};

export type SyslogFilters = {
	keyword?: string;
	exclude?: string;
};

const MAX_SYSLOG_RESULT_LINES = "10000";

export type Backup = {
	id: string;
	sizeBytes: number;
	createdAt: string;
	downloadUrl: string;
	includesSyslog?: boolean;
};

export type AuditEvent = {
	id: string;
	actor_user_id: string | null;
	actor_name: string | null;
	type: string;
	target_type: string | null;
	target_id: string | null;
	created_at: string;
	detail?: Record<string, unknown>;
};

export type AuditEventFilters = {
	from?: string;
	to?: string;
	actorUserId?: string;
	type?: string;
	target?: string;
	targetType?: string;
	targetId?: string;
};

export type AuditExportResult = {
	blob: Blob;
	filename: string;
	truncated: boolean;
	count: number;
	limit: number;
};

/** 一覧と同じquery組み立て。画面の絞り込み条件をそのまま引き継ぐ。 */
export function auditEventsQuery(filters: AuditEventFilters = {}): string {
	const query = new URLSearchParams();
	if (filters.from) query.set("from", new Date(filters.from).toISOString());
	if (filters.to) query.set("to", new Date(filters.to).toISOString());
	if (filters.actorUserId) query.set("actorUserId", filters.actorUserId);
	if (filters.type?.trim()) query.set("type", filters.type.trim());
	if (filters.target?.trim()) query.set("target", filters.target.trim());
	if (filters.targetType?.trim())
		query.set("targetType", filters.targetType.trim());
	if (filters.targetId?.trim()) query.set("targetId", filters.targetId.trim());
	return query.toString();
}

export type Role = "admin" | "viewer";
export type User = {
	id: string;
	loginId: string;
	role: Role;
	displayName?: string | null;
	email?: string | null;
};
export type UserListItem = User & {
	createdAt: string;
	lastLoginAt: string | null;
};

export class ApiError extends Error {
	readonly status: number;
	/** Serverが返すcode (例: config_apply_batch_active)。無い場合はnull */
	readonly code: string | null;
	/** Batch競合の原因Batch ID (409 + code=config_apply_batch_activeのとき)。 */
	readonly batchId: string | null;
	constructor(
		status: number,
		message: string,
		code: string | null = null,
		batchId: string | null = null,
	) {
		super(message);
		this.status = status;
		this.code = code;
		this.batchId = batchId;
	}
}

/** 一括適用が実行中で単体Applyが拒否された409か。Batch詳細への導線用。 */
export function isBatchActiveError(cause: unknown): cause is ApiError {
	return (
		cause instanceof ApiError &&
		cause.status === 409 &&
		cause.code === "config_apply_batch_active" &&
		cause.batchId !== null
	);
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
	const res = await fetch(`/api${path}`, {
		credentials: "same-origin",
		headers: init?.body ? { "content-type": "application/json" } : undefined,
		...init,
	});
	if (!res.ok) {
		const body = (await res.json().catch(() => ({}))) as {
			error?: string;
			code?: string;
			batch_id?: string;
		};
		throw new ApiError(
			res.status,
			body.error ?? res.statusText,
			typeof body.code === "string" ? body.code : null,
			typeof body.batch_id === "string" ? body.batch_id : null,
		);
	}
	return (await res.json()) as T;
}

const post = <T>(path: string, body?: unknown) =>
	request<T>(path, {
		method: "POST",
		body: body === undefined ? undefined : JSON.stringify(body),
	});

export const api = {
	setupStatus: () => request<SetupStatus>("/setup/status"),
	completeSetup: (input: {
		instanceName: string;
		timezone: string;
		publicBaseUrl: string;
		admin: { loginId: string; password: string };
	}) => post<SetupStatus>("/setup", input),
	connectivityCheck: (publicBaseUrl: string) =>
		post<{ checks: SetupCheck[] }>("/setup/connectivity", { publicBaseUrl }),
	updateInstanceName: (instanceName: string) =>
		post<SetupStatus>("/settings/instance-name", { instanceName }),
	updateTimezone: (timezone: string) =>
		post<SetupStatus>("/settings/timezone", { timezone }),
	updatePublicUrl: (publicBaseUrl: string) =>
		post<SetupStatus>("/settings/public-url", { publicBaseUrl }),
	backups: () => request<{ backups: Backup[] }>("/backups"),
	createBackup: (includeSyslog: boolean) =>
		post<{ backup: Backup }>("/backups", { includeSyslog }),
	deleteBackup: (backupId: string) =>
		request<{ ok: true }>(`/backups/${encodeURIComponent(backupId)}`, {
			method: "DELETE",
		}),
	backupDownloadUrl: (backupId: string) =>
		`/api/backups/${encodeURIComponent(backupId)}/download`,
	me: () => request<{ user: User }>("/auth/me"),
	login: (identifier: string, password: string) =>
		post<{ user: User }>("/auth/login", { identifier, password }),
	logout: () => post<unknown>("/auth/logout"),
	users: () => request<{ users: UserListItem[] }>("/users"),
	createUser: (input: { loginId: string; password: string; role: Role }) =>
		post<{ user: User }>("/users", input),
	changeUserRole: (id: string, role: Role) =>
		request<{ user: User }>(`/users/${id}`, {
			method: "PATCH",
			body: JSON.stringify({ role }),
		}),
	deleteUser: (id: string) =>
		request<{ ok: true }>(`/users/${id}`, { method: "DELETE" }),
	changePassword: (id: string, password: string) =>
		post<{ ok: true }>(`/users/${id}/password`, { password }),
	dashboard: () =>
		request<{
			deviceCount: number;
			presence: Record<PresenceStatus, number>;
			recentJobs: Job[];
		}>("/dashboard"),
	devices: (filters: { siteId?: string; tagId?: string } = {}) => {
		const query = new URLSearchParams();
		if (filters.siteId) query.set("siteId", filters.siteId);
		if (filters.tagId) query.set("tagId", filters.tagId);
		const suffix = query.toString();
		return request<{ devices: Device[] }>(
			`/devices${suffix ? `?${suffix}` : ""}`,
		);
	},
	topology: () => request<{ topology: TopologyModel }>("/topology"),
	sites: () => request<{ sites: Site[] }>("/sites"),
	createSite: (input: { name: string; description?: string | null }) =>
		post<{ site: Site }>("/sites", input),
	updateSite: (
		id: string,
		input: { name?: string; description?: string | null },
	) =>
		request<{ site: Site }>(`/sites/${id}`, {
			method: "PATCH",
			body: JSON.stringify(input),
		}),
	deleteSite: (id: string) =>
		request<{ ok: true }>(`/sites/${id}`, { method: "DELETE" }),
	tags: () => request<{ tags: Tag[] }>("/tags"),
	createTag: (name: string) => post<{ tag: Tag }>("/tags", { name }),
	deleteTag: (id: string) =>
		request<{ ok: true }>(`/tags/${id}`, { method: "DELETE" }),
	syslogStorage: (deviceId: string) =>
		request<SyslogStorageStatus>(`/devices/${deviceId}/syslog/storage`),
	auditEvents: (filters: AuditEventFilters = {}) => {
		const suffix = auditEventsQuery(filters);
		return request<{ events: AuditEvent[] }>(
			`/audit-events${suffix ? `?${suffix}` : ""}`,
		);
	},
	/** 現在の絞り込み条件のままCSVを落とす。上限超過はtruncatedで返す。 */
	downloadAuditEvents: async (
		filters: AuditEventFilters = {},
	): Promise<AuditExportResult> => {
		const suffix = auditEventsQuery(filters);
		const res = await fetch(
			`/api/audit-events/export${suffix ? `?${suffix}` : ""}`,
			{ credentials: "same-origin" },
		);
		if (!res.ok) {
			const body = (await res.json().catch(() => ({}))) as {
				error?: string;
			};
			throw new ApiError(res.status, body.error ?? res.statusText);
		}
		const filename =
			res.headers
				.get("content-disposition")
				?.match(/filename="([^"]+)"/)?.[1] ?? "audit-events.csv";
		return {
			blob: await res.blob(),
			filename,
			truncated: res.headers.get("x-audit-export-truncated") === "true",
			count: Number(res.headers.get("x-audit-export-count") ?? 0),
			limit: Number(res.headers.get("x-audit-export-limit") ?? 0),
		};
	},
	device: (id: string) => request<{ device: Device }>(`/devices/${id}`),
	updateDevice: (
		id: string,
		input: {
			name?: string;
			siteId?: string | null;
			tagIds?: string[];
			description?: string | null;
			notes?: string | null;
		},
	) =>
		request<{ device: Device }>(`/devices/${id}`, {
			method: "PATCH",
			body: JSON.stringify(input),
		}),
	disableDevice: (id: string) =>
		post<{ device: Device }>(`/devices/${id}/disable`),
	enableDevice: (id: string) =>
		post<{ device: Device }>(`/devices/${id}/enable`),
	deleteDevice: (id: string) =>
		request<{ ok: true }>(`/devices/${id}`, { method: "DELETE" }),
	jobs: (deviceId: string) =>
		request<{ jobs: Job[] }>(`/jobs?deviceId=${encodeURIComponent(deviceId)}`),
	runCommand: (deviceId: string, command: string) =>
		post<{ job: Job }>(`/devices/${deviceId}/commands`, { command }),
	syslog: (
		deviceId: string,
		from: Date,
		to: Date,
		filters: SyslogFilters = {},
	) => {
		const query = new URLSearchParams({
			from: from.toISOString(),
			to: to.toISOString(),
			limit: MAX_SYSLOG_RESULT_LINES,
		});
		if (filters.keyword?.trim()) query.set("keyword", filters.keyword.trim());
		if (filters.exclude?.trim()) query.set("exclude", filters.exclude.trim());
		return request<{ lines: SyslogLine[]; truncated: boolean }>(
			`/devices/${encodeURIComponent(deviceId)}/syslog?${query.toString()}`,
		);
	},
	syslogDownloadUrl: (
		deviceId: string,
		from: Date,
		to: Date,
		filters: SyslogFilters = {},
	) => {
		const query = new URLSearchParams({
			from: from.toISOString(),
			to: to.toISOString(),
			limit: MAX_SYSLOG_RESULT_LINES,
		});
		if (filters.keyword?.trim()) query.set("keyword", filters.keyword.trim());
		if (filters.exclude?.trim()) query.set("exclude", filters.exclude.trim());
		return `/api/devices/${encodeURIComponent(deviceId)}/syslog/download?${query.toString()}`;
	},
	createDevice: (name: string) =>
		post<{
			device: { id: string };
			enrollment: { code: string; expiresAt: string; cliBlock: string };
		}>("/devices", { name }),
	profile: (deviceId: string) =>
		request<{ profile: DeviceProfile | null }>(`/devices/${deviceId}/profile`),
	/** Observed snapshotだけを返す。Routerへ接続しない (#134)。 */
	deviceRoutes: (deviceId: string) =>
		request<DeviceRoutes>(`/devices/${deviceId}/routes`),
	/** Adminのみ。IPv4/IPv6を順番に再取得し、Observed形式で返す (#134)。 */
	refreshDeviceRoutes: (deviceId: string) =>
		post<DeviceRoutes>(`/devices/${deviceId}/routes/refresh`),
	configBackups: (deviceId: string) =>
		request<{ backups: ConfigBackup[] }>(`/devices/${deviceId}/config-backups`),
	configCheckpoints: () =>
		request<{ checkpoints: ConfigCheckpoint[] }>("/config-checkpoints"),
	createConfigCheckpoint: (input: {
		name: string;
		memo?: string;
		deviceIds: string[];
	}) => post<{ checkpoint: ConfigCheckpoint }>("/config-checkpoints", input),
	deleteConfigCheckpoint: (checkpointId: string) =>
		request<{ ok: true }>(
			`/config-checkpoints/${encodeURIComponent(checkpointId)}`,
			{ method: "DELETE" },
		),
	configDiff: (deviceId: string, backupId: string, againstId?: string) => {
		const query = againstId ? `?against=${encodeURIComponent(againstId)}` : "";
		return request<ConfigDiff>(
			`/devices/${encodeURIComponent(deviceId)}/config-backups/${encodeURIComponent(backupId)}/diff${query}`,
		);
	},
	configApplies: (deviceId: string) =>
		request<{ applies: ConfigApply[] }>(
			`/devices/${encodeURIComponent(deviceId)}/config-applies`,
		),
	prepareConfigApply: (deviceId: string, backupId: string) =>
		post<{ apply: ConfigApply }>(
			`/devices/${encodeURIComponent(deviceId)}/config-applies/prepare`,
			{ backupId },
		),
	configApplyDetails: (deviceId: string, applyId: string) =>
		request<ConfigApplyDetails>(
			`/devices/${encodeURIComponent(deviceId)}/config-applies/${encodeURIComponent(applyId)}`,
		),
	confirmConfigApply: (
		deviceId: string,
		applyId: string,
		input: { saveAfterApply: boolean; acknowledged: true },
	) =>
		post<{ apply: ConfigApply }>(
			`/devices/${encodeURIComponent(deviceId)}/config-applies/${encodeURIComponent(applyId)}/confirm`,
			input,
		),
	saveConfig: (deviceId: string) =>
		post<{ job: Job }>(`/devices/${encodeURIComponent(deviceId)}/config-save`),
	discardConfigApply: (deviceId: string, applyId: string) =>
		post<{ apply: ConfigApply; job: Job }>(
			`/devices/${encodeURIComponent(deviceId)}/config-applies/${encodeURIComponent(applyId)}/discard`,
		),
	configApplyBatches: () =>
		request<{ batches: ConfigApplyBatch[] }>("/config-apply-batches"),
	configApplyBatch: (batchId: string) =>
		request<{ batch: ConfigApplyBatch }>(
			`/config-apply-batches/${encodeURIComponent(batchId)}`,
		),
	createConfigApplyBatch: (input: {
		source: ConfigApplyBatchSource;
		confirmationMode: "batch" | "per_device";
		saveAfterApply: boolean;
	}) => post<{ batch: ConfigApplyBatch }>("/config-apply-batches", input),
	updateConfigApplyBatchPlan: (
		batchId: string,
		items: { itemId: string; selected: boolean }[],
	) =>
		request<{ batch: ConfigApplyBatch }>(
			`/config-apply-batches/${encodeURIComponent(batchId)}/plan`,
			{ method: "PATCH", body: JSON.stringify({ items }) },
		),
	confirmConfigApplyBatch: (batchId: string) =>
		post<{ batch: ConfigApplyBatch }>(
			`/config-apply-batches/${encodeURIComponent(batchId)}/confirm`,
			{ acknowledged: true },
		),
	confirmConfigApplyBatchItem: (batchId: string, itemId: string) =>
		post<{ batch: ConfigApplyBatch }>(
			`/config-apply-batches/${encodeURIComponent(batchId)}/items/${encodeURIComponent(itemId)}/confirm`,
			{ acknowledged: true },
		),
	stopConfigApplyBatch: (batchId: string) =>
		post<{ batch: ConfigApplyBatch }>(
			`/config-apply-batches/${encodeURIComponent(batchId)}/stop`,
		),
	configBackupDownloadUrl: (deviceId: string, backupId: string) =>
		`/api/devices/${encodeURIComponent(deviceId)}/config-backups/${encodeURIComponent(backupId)}/download`,
	requestConfig: (deviceId: string) =>
		post<{ requested: boolean }>(`/devices/${deviceId}/config-snapshots`),
	agent: (deviceId: string) =>
		request<{ agent: AgentState; releases: string[] }>(
			`/devices/${deviceId}/agent`,
		),
	setAgentVersion: (deviceId: string, version: string) =>
		post<{ desiredVersion: string }>(`/devices/${deviceId}/agent-version`, {
			version,
		}),
	reboot: (deviceId: string, save: boolean, at?: string) =>
		post<{ job: Job }>(`/devices/${deviceId}/reboot`, { save, at }),
	scheduledJobs: (deviceId: string) =>
		request<{ jobs: Job[] }>(
			`/scheduled-jobs?deviceId=${encodeURIComponent(deviceId)}`,
		),
	cancelJob: (jobId: string) => post<{ job: Job }>(`/jobs/${jobId}/cancel`),
	webguiSession: (deviceId: string) =>
		post<{ session: { id: string; url: string } }>(
			`/devices/${deviceId}/webgui-sessions`,
		),
};

/** Live Logs(SSE)。戻り値を呼ぶと購読を解除する。 */
export function subscribeSyslog(
	deviceId: string,
	onLine: (line: { ts: string; message: string }) => void,
): () => void {
	const source = new EventSource(`/api/devices/${deviceId}/syslog/live`, {
		withCredentials: true,
	});
	source.addEventListener("syslog", (event) => {
		onLine(JSON.parse((event as MessageEvent).data));
	});
	return () => source.close();
}
