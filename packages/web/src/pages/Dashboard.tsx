import { useEffect, useState } from "react";
import { api, type Job, type PresenceStatus } from "../api.ts";
import {
	Card,
	Empty,
	formatTime,
	Loading,
	StatusBadge,
	type Tone,
} from "../ui.tsx";

const PRESENCE: { key: PresenceStatus; label: string; tone: Tone }[] = [
	{ key: "online", label: "Online", tone: "ok" },
	{ key: "unstable", label: "Unstable", tone: "warn" },
	{ key: "offline", label: "Offline", tone: "danger" },
	{ key: "unknown", label: "Unknown", tone: "neutral" },
];

export function Dashboard({ instanceName }: { instanceName: string | null }) {
	const [data, setData] = useState<{
		deviceCount: number;
		presence: Record<PresenceStatus, number>;
		recentJobs: Job[];
	} | null>(null);

	useEffect(() => {
		let active = true;
		const load = () =>
			api.dashboard().then((d) => {
				if (active) setData(d);
			});
		void load();
		const timer = setInterval(() => void load(), 10_000);
		return () => {
			active = false;
			clearInterval(timer);
		};
	}, []);

	return (
		<>
			<header className="topbar">
				<h1>Dashboard</h1>
				{instanceName && <span className="topbar__meta">{instanceName}</span>}
			</header>

			<div className="content">
				{!data ? (
					<Loading />
				) : (
					<>
						<div className="stat-grid">
							<div className="stat">
								<span className="stat__label">Devices</span>
								<div className="stat__value">{data.deviceCount}</div>
							</div>
							{PRESENCE.map(({ key, label, tone }) => (
								<div
									className={`stat${data.presence[key] === 0 ? " stat--zero" : ""}`}
									key={key}
								>
									<span className="stat__label">
										<span className={`dot dot--${tone}`} />
										{label}
									</span>
									<div className="stat__value">{data.presence[key]}</div>
								</div>
							))}
						</div>

						<Card title="最近のJob" flush>
							{data.recentJobs.length === 0 ? (
								<Empty title="Jobはまだありません">
									Deviceの詳細画面からコマンドを実行すると、ここに履歴が出ます。
								</Empty>
							) : (
								<div className="table-wrap">
									<table>
										<thead>
											<tr>
												<th>実行日時</th>
												<th>Device</th>
												<th>内容</th>
												<th>状態</th>
											</tr>
										</thead>
										<tbody>
											{data.recentJobs.map((job) => (
												<tr key={job.id}>
													<td>{formatTime(job.created_at)}</td>
													<td>
														<a href={`#/devices/${job.device_id}`}>
															{job.deviceName ?? job.device_id}
														</a>
													</td>
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
				)}
			</div>
		</>
	);
}
