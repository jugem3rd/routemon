/**
 * Routemon GUI(#28)。Dashboard / Device / Settings / Audit Logの画面。
 *
 * routingはhash(`#/devices/<id>`)だけで済むため、routerは入れていない。
 * Viewerには操作UIを出さないが、権限の判定はAPI側でも行う(#8)。
 */
import { useEffect, useState } from "react";
import { ApiError, api, type SetupStatus, type User } from "./api.ts";
import { Account } from "./pages/Account.tsx";
import { AuditLog } from "./pages/AuditLog.tsx";
import { BulkApplies, BulkApplyDetail } from "./pages/BulkApplies.tsx";
import { ConfigCheckpoints } from "./pages/ConfigCheckpoints.tsx";
import { Dashboard } from "./pages/Dashboard.tsx";
import { DeviceDetail } from "./pages/DeviceDetail.tsx";
import { DeviceList } from "./pages/DeviceList.tsx";
import { Login } from "./pages/Login.tsx";
import { Settings } from "./pages/Settings.tsx";
import { SetupWizard } from "./pages/SetupWizard.tsx";
import { Topology } from "./pages/Topology.tsx";
import { Users } from "./pages/Users.tsx";
import { Icon, Loading } from "./ui.tsx";

type Theme = "system" | "light" | "dark";

const THEME_LABEL: Record<Theme, string> = {
	system: "OSに合わせる",
	light: "Light",
	dark: "Dark",
};

/** 表示テーマ。既定はOSの設定に従い、選んだ場合だけこのBrowserへ保存する。 */
function useTheme(): [Theme, () => void] {
	const [theme, setTheme] = useState<Theme>(
		() => (localStorage.getItem("routemon.theme") as Theme) ?? "system",
	);
	useEffect(() => {
		if (theme === "system") {
			document.documentElement.removeAttribute("data-theme");
			localStorage.removeItem("routemon.theme");
		} else {
			document.documentElement.dataset.theme = theme;
			localStorage.setItem("routemon.theme", theme);
		}
	}, [theme]);
	const cycle = () =>
		setTheme((current) =>
			current === "system" ? "light" : current === "light" ? "dark" : "system",
		);
	return [theme, cycle];
}

function useHash(): string {
	const [hash, setHash] = useState(location.hash || "#/");
	useEffect(() => {
		const onChange = () => setHash(location.hash || "#/");
		addEventListener("hashchange", onChange);
		return () => removeEventListener("hashchange", onChange);
	}, []);
	return hash;
}

export function App() {
	const [user, setUser] = useState<User | null>(null);
	const [setup, setSetup] = useState<SetupStatus | null>(null);
	const [loading, setLoading] = useState(true);
	const [theme, cycleTheme] = useTheme();
	const hash = useHash();

	useEffect(() => {
		// 未初期化ならDashboardへ入らずSetup Wizardを出す(#12)
		api
			.setupStatus()
			.then(async (status) => {
				setSetup(status);
				if (!status.initialized) return;
				const me = await api.me().catch((error) => {
					if (!(error instanceof ApiError) || error.status !== 401) throw error;
					return null;
				});
				setUser(me?.user ?? null);
			})
			.finally(() => setLoading(false));
	}, []);

	if (loading) {
		return (
			<main className="centered">
				<div className="panel">
					<Loading />
				</div>
			</main>
		);
	}
	if (setup && !setup.initialized) return <SetupWizard onDone={setSetup} />;
	if (!user) return <Login onLogin={setUser} />;

	const deviceId = hash.startsWith("#/devices/") ? hash.slice(10) : null;
	const onDevices = hash.startsWith("#/devices");
	const onCheckpoints = hash === "#/checkpoints";
	const bulkApplyId = hash.startsWith("#/bulk-applies/")
		? decodeURIComponent(hash.slice("#/bulk-applies/".length))
		: null;
	const onBulkApplies =
		(hash === "#/bulk-applies" || bulkApplyId !== null) &&
		user.role === "admin";
	const onUsers = hash === "#/users" && user.role === "admin";
	const onSettings = hash === "#/settings" && user.role === "admin";
	const onAudit = hash === "#/audit" && user.role === "admin";
	const onAccount = hash === "#/account";
	const onTopology = hash === "#/topology";
	const onDashboard =
		!onDevices &&
		!onCheckpoints &&
		!onBulkApplies &&
		!onUsers &&
		!onSettings &&
		!onAudit &&
		!onAccount &&
		!onTopology;

	return (
		<div className="shell">
			<aside className="sidebar">
				<a className="sidebar__brand" href="#/">
					<span className="mark">Y</span>
					Routemon
				</a>
				<p className="sidebar__section">管理</p>
				<a
					className="nav-item"
					href="#/"
					aria-current={onDashboard ? "page" : undefined}
				>
					<Icon.dashboard />
					Dashboard
				</a>
				<a
					className="nav-item"
					href="#/devices"
					aria-current={onDevices ? "page" : undefined}
				>
					<Icon.devices />
					Devices
				</a>
				<a
					className="nav-item"
					href="#/checkpoints"
					aria-current={onCheckpoints ? "page" : undefined}
				>
					<Icon.checkpoint />
					CONFIG Checkpoints
				</a>
				{user.role === "admin" && (
					<a
						className="nav-item"
						href="#/bulk-applies"
						aria-current={onBulkApplies ? "page" : undefined}
					>
						<Icon.checkpoint />
						一括適用
					</a>
				)}
				<a
					className="nav-item"
					href="#/topology"
					aria-current={onTopology ? "page" : undefined}
				>
					<Icon.topology />
					Topology
				</a>
				{user.role === "admin" && (
					<>
						<a
							className="nav-item"
							href="#/users"
							aria-current={onUsers ? "page" : undefined}
						>
							<Icon.users />
							Users
						</a>
						<a
							className="nav-item"
							href="#/settings"
							aria-current={onSettings ? "page" : undefined}
						>
							<Icon.settings />
							Settings
						</a>
						<a
							className="nav-item"
							href="#/audit"
							aria-current={onAudit ? "page" : undefined}
						>
							<Icon.audit />
							Audit Log
						</a>
					</>
				)}
				<a
					className="nav-item"
					href="#/account"
					aria-current={onAccount ? "page" : undefined}
				>
					<Icon.account />
					Account
				</a>
				<div className="sidebar__footer">
					<button
						type="button"
						className="btn btn--sidebar"
						onClick={cycleTheme}
					>
						<Icon.theme />
						{THEME_LABEL[theme]}
					</button>
					<div className="sidebar__user">
						<span className="avatar">{user.loginId.slice(0, 1)}</span>
						<div>
							{user.loginId}
							<br />
							<span className="muted">
								{user.role === "admin" ? "Administrator" : "Viewer"}
							</span>
						</div>
					</div>
					<button
						type="button"
						className="btn btn--sidebar"
						onClick={() => api.logout().then(() => setUser(null))}
					>
						<Icon.logout />
						Logout
					</button>
				</div>
			</aside>

			<div className="main">
				{deviceId ? (
					<DeviceDetail deviceId={deviceId} user={user} />
				) : onDevices ? (
					<DeviceList user={user} instanceName={setup?.instanceName ?? null} />
				) : onCheckpoints ? (
					<ConfigCheckpoints
						user={user}
						instanceName={setup?.instanceName ?? null}
					/>
				) : onBulkApplies && bulkApplyId ? (
					<BulkApplyDetail
						batchId={bulkApplyId}
						instanceName={setup?.instanceName ?? null}
					/>
				) : onBulkApplies ? (
					<BulkApplies user={user} instanceName={setup?.instanceName ?? null} />
				) : onUsers ? (
					<Users
						currentUser={user}
						instanceName={setup?.instanceName ?? null}
						onUserChanged={setUser}
						onLoggedOut={() => setUser(null)}
					/>
				) : onSettings ? (
					<Settings setup={setup} onSetupChanged={setSetup} />
				) : onAudit ? (
					<AuditLog instanceName={setup?.instanceName ?? null} />
				) : onTopology ? (
					<Topology />
				) : onAccount ? (
					<Account
						user={user}
						instanceName={setup?.instanceName ?? null}
						onLoggedOut={() => setUser(null)}
					/>
				) : (
					<Dashboard instanceName={setup?.instanceName ?? null} />
				)}
			</div>
		</div>
	);
}
