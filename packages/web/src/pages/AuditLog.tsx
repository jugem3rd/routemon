import { type FormEvent, useEffect, useState } from "react";
import { ApiError, type AuditEvent, api, type UserListItem } from "../api.ts";
import {
	Badge,
	Card,
	Empty,
	Field,
	formatTime,
	Loading,
	Notice,
} from "../ui.tsx";

type AuditLogProps = {
	instanceName: string | null;
};

type AuditFilters = {
	from: string;
	to: string;
	actorUserId: string;
	type: string;
	target: string;
};

const EMPTY_FILTERS: AuditFilters = {
	from: "",
	to: "",
	actorUserId: "",
	type: "",
	target: "",
};

export function AuditLog({ instanceName }: AuditLogProps) {
	const [filters, setFilters] = useState<AuditFilters>(EMPTY_FILTERS);
	const [events, setEvents] = useState<AuditEvent[] | null>(null);
	const [users, setUsers] = useState<UserListItem[]>([]);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [exporting, setExporting] = useState(false);
	const [exportNotice, setExportNotice] = useState<string | null>(null);

	async function load(nextFilters: AuditFilters, includeUsers = false) {
		setLoading(true);
		setError(null);
		try {
			const eventRequest = api.auditEvents({
				from: nextFilters.from,
				to: nextFilters.to,
				actorUserId: nextFilters.actorUserId,
				type: nextFilters.type,
				target: nextFilters.target,
			});
			if (includeUsers) {
				const [eventResult, userResult] = await Promise.all([
					eventRequest,
					api.users(),
				]);
				setEvents(eventResult.events);
				setUsers(userResult.users);
			} else {
				setEvents((await eventRequest).events);
			}
		} catch (requestError) {
			setError(apiMessage(requestError));
		} finally {
			setLoading(false);
		}
	}

	// 監査ログと実行者の候補は画面表示時に一度取得する。
	// biome-ignore lint/correctness/useExhaustiveDependencies: 画面表示時に1回だけ読み込む
	useEffect(() => {
		void load(EMPTY_FILTERS, true);
	}, []);

	function changeFilter<K extends keyof AuditFilters>(
		key: K,
		value: AuditFilters[K],
	) {
		setFilters((current) => ({ ...current, [key]: value }));
	}

	function submit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		void load(filters);
	}

	function clear() {
		setFilters(EMPTY_FILTERS);
		void load(EMPTY_FILTERS);
	}

	/** 現在の絞り込み条件のままCSVをダウンロードする。 */
	async function download() {
		setExporting(true);
		setExportNotice(null);
		try {
			const result = await api.downloadAuditEvents({
				from: filters.from,
				to: filters.to,
				actorUserId: filters.actorUserId,
				type: filters.type,
				target: filters.target,
			});
			const url = URL.createObjectURL(result.blob);
			const anchor = document.createElement("a");
			anchor.href = url;
			anchor.download = result.filename;
			document.body.appendChild(anchor);
			anchor.click();
			anchor.remove();
			setTimeout(() => URL.revokeObjectURL(url), 1000);
			if (result.truncated) {
				setExportNotice(
					`上限(${result.limit}件)を超えたため、先頭${result.limit}件だけ出力しました。条件を絞ってください。`,
				);
			}
		} catch (requestError) {
			setExportNotice(apiMessage(requestError));
		} finally {
			setExporting(false);
		}
	}

	return (
		<>
			<header className="topbar">
				<h1>Audit Log</h1>
				{instanceName && <span className="topbar__meta">{instanceName}</span>}
			</header>

			<div className="content">
				<Notice>
					監査画面ではpassword・token・CONFIG本文などの機密値を表示しません。
				</Notice>
				<Card title="絞り込み">
					<form className="toolbar audit-filters" onSubmit={submit}>
						<Field label="日時(From)">
							<input
								type="datetime-local"
								value={filters.from}
								onChange={(event) => changeFilter("from", event.target.value)}
							/>
						</Field>
						<Field label="日時(To)">
							<input
								type="datetime-local"
								value={filters.to}
								onChange={(event) => changeFilter("to", event.target.value)}
							/>
						</Field>
						<Field label="実行者">
							<select
								value={filters.actorUserId}
								onChange={(event) =>
									changeFilter("actorUserId", event.target.value)
								}
							>
								<option value="">すべて</option>
								{users.map((user) => (
									<option key={user.id} value={user.id}>
										{displayName(user)}
									</option>
								))}
							</select>
						</Field>
						<Field label="種別">
							<input
								value={filters.type}
								onChange={(event) => changeFilter("type", event.target.value)}
								placeholder="例: USER_CREATED"
							/>
						</Field>
						<Field label="対象">
							<input
								value={filters.target}
								onChange={(event) => changeFilter("target", event.target.value)}
								placeholder="種別またはID"
							/>
						</Field>
						<div className="row audit-filters__actions">
							<button
								type="submit"
								className="btn btn--primary"
								disabled={loading}
							>
								絞り込む
							</button>
							<button
								type="button"
								className="btn"
								disabled={loading}
								onClick={clear}
							>
								クリア
							</button>
						</div>
					</form>
				</Card>

				{error && <Notice tone="error">{error}</Notice>}
				{exportNotice && <Notice tone="accent">{exportNotice}</Notice>}
				<Card
					title={events ? `${events.length}件` : "監査Event"}
					actions={
						<button
							type="button"
							className="btn"
							disabled={loading || exporting || !events}
							onClick={() => void download()}
						>
							{exporting ? "出力中…" : "CSVをダウンロード"}
						</button>
					}
					flush
				>
					{loading && !events ? (
						<div className="card__body">
							<Loading />
						</div>
					) : events?.length === 0 ? (
						<Empty title="監査Eventがありません">
							条件を変えて再検索してください。
						</Empty>
					) : events ? (
						<div className="table-wrap">
							<table>
								<thead>
									<tr>
										<th>日時</th>
										<th>実行者</th>
										<th>種別</th>
										<th>対象</th>
										<th>詳細</th>
									</tr>
								</thead>
								<tbody>
									{events.map((event) => (
										<tr key={event.id}>
											<td>{formatTime(event.created_at)}</td>
											<td>{event.actor_name ?? "System"}</td>
											<td>
												<Badge plain>{event.type}</Badge>
											</td>
											<td>
												{event.target_type || event.target_id
													? [event.target_type, event.target_id]
															.filter(Boolean)
															.join(" / ")
													: "—"}
											</td>
											<td>
												{event.detail ? (
													<div className="audit-detail">
														{Object.entries(event.detail).map(
															([key, value]) => (
																<span className="audit-detail__item" key={key}>
																	<span className="audit-detail__key">
																		{formatDetailKey(key)}:
																	</span>
																	<span className="audit-detail__value">
																		{formatDetailValue(value)}
																	</span>
																</span>
															),
														)}
													</div>
												) : (
													"—"
												)}
											</td>
										</tr>
									))}
								</tbody>
							</table>
						</div>
					) : null}
				</Card>
			</div>
		</>
	);
}

function formatDetailKey(key: string): string {
	return key.replaceAll("_", " ");
}

function formatDetailValue(value: unknown): string {
	if (value === null) return "—";
	if (Array.isArray(value)) return value.map(formatDetailValue).join(", ");
	if (typeof value === "boolean") return value ? "true" : "false";
	if (typeof value === "object") return JSON.stringify(value) ?? "—";
	return String(value);
}

function displayName(user: UserListItem): string {
	return user.displayName ?? user.loginId ?? user.email ?? "(unknown)";
}

function apiMessage(error: unknown): string {
	if (error instanceof ApiError && error.status === 401)
		return "Sessionの有効期限が切れています。もう一度Loginしてください。";
	if (error instanceof ApiError && error.status === 403)
		return "監査ログはAdminだけが閲覧できます。";
	return error instanceof ApiError
		? error.message
		: "監査ログを読み込めませんでした。";
}
