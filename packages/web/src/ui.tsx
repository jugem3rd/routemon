/**
 * 画面をまたいで使う小さな部品(#28)。
 *
 * componentライブラリは入れず、必要になったものだけをここへ置く。
 */
import {
	cloneElement,
	isValidElement,
	type ReactNode,
	useEffect,
	useId,
} from "react";
import type { ConfigApplyBatchRisk, PresenceStatus } from "./api.ts";

export type Tone = "ok" | "warn" | "danger" | "neutral" | "accent";

/**
 * Serverが返す高リスク分類の表示名(#126)。判定はServerのconfigRisk.tsが
 * 行い、単体Applyと一括適用のGUIはこの表で表示するだけにする。
 */
export const RISK_LABEL: Record<ConfigApplyBatchRisk, string> = {
	wan: "WAN",
	pppoe: "PPPoE",
	filter: "フィルタ",
	supervisor_autostart: "Supervisor自動起動",
};

const PRESENCE_TONE: Record<PresenceStatus, Tone> = {
	online: "ok",
	unstable: "warn",
	offline: "danger",
	unknown: "neutral",
};

const PRESENCE_LABEL: Record<PresenceStatus, string> = {
	online: "Online",
	unstable: "Unstable",
	offline: "Offline",
	unknown: "Unknown",
};

/** Jobやupdateの状態を色に対応させる。 */
const STATUS_TONE: Record<string, Tone> = {
	success: "ok",
	running: "warn",
	queued: "neutral",
	failed: "danger",
	timeout: "danger",
	cancelled: "neutral",
};

export function Badge({
	tone = "neutral",
	plain,
	children,
}: {
	tone?: Tone;
	plain?: boolean;
	children: ReactNode;
}) {
	return (
		<span className={`badge badge--${tone}${plain ? " badge--plain" : ""}`}>
			{children}
		</span>
	);
}

export function PresenceBadge({ status }: { status: PresenceStatus }) {
	return <Badge tone={PRESENCE_TONE[status]}>{PRESENCE_LABEL[status]}</Badge>;
}

export function StatusBadge({ status }: { status: string }) {
	return <Badge tone={STATUS_TONE[status] ?? "neutral"}>{status}</Badge>;
}

export function Card({
	title,
	actions,
	flush,
	children,
}: {
	title?: ReactNode;
	actions?: ReactNode;
	/** tableのように、中身が自前でpaddingを持つ場合 */
	flush?: boolean;
	children: ReactNode;
}) {
	return (
		<section className="card">
			{(title || actions) && (
				<header className="card__head">
					{typeof title === "string" ? <h2>{title}</h2> : title}
					{actions && <div className="card__actions">{actions}</div>}
				</header>
			)}
			<div className={`card__body${flush ? " card__body--flush" : ""}`}>
				{children}
			</div>
		</section>
	);
}

export function Empty({
	title,
	children,
}: {
	title: string;
	children?: ReactNode;
}) {
	return (
		<div className="empty">
			<strong>{title}</strong>
			{children}
		</div>
	);
}

export function Notice({
	tone,
	children,
}: {
	tone?: "error" | "accent";
	children: ReactNode;
}) {
	return (
		<p className={`notice${tone ? ` notice--${tone}` : ""}`}>{children}</p>
	);
}

/** labelと入力を結びつける。呼び出し側でidを書かなくて済むよう、ここで付ける。 */
export function Field({
	label,
	children,
}: {
	label: string;
	children: ReactNode;
}) {
	const id = useId();
	return (
		<div className="field">
			<label htmlFor={id}>{label}</label>
			{isValidElement<{ id?: string }>(children)
				? cloneElement(children, { id })
				: children}
		</div>
	);
}

/** 確認用のmodal。Escとbackdropで閉じる。 */
export function Modal({
	title,
	onClose,
	children,
	footer,
}: {
	title: string;
	onClose: () => void;
	children: ReactNode;
	footer?: ReactNode;
}) {
	useEffect(() => {
		const onKey = (event: KeyboardEvent) => {
			if (event.key === "Escape") onClose();
		};
		addEventListener("keydown", onKey);
		document.body.style.overflow = "hidden";
		return () => {
			removeEventListener("keydown", onKey);
			document.body.style.overflow = "";
		};
	}, [onClose]);

	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: backdropを押して閉じる
		// biome-ignore lint/a11y/useKeyWithClickEvents: Escで閉じる処理をuseEffectで入れている
		<div className="modal-backdrop" onClick={onClose}>
			{/* biome-ignore lint/a11y/useKeyWithClickEvents: clickの伝播を止めるだけで、操作は持たない */}
			<div
				className="modal"
				role="dialog"
				aria-modal="true"
				aria-label={title}
				onClick={(event) => event.stopPropagation()}
			>
				<header className="modal__head">
					<h2>{title}</h2>
					<button
						type="button"
						className="btn btn--ghost"
						aria-label="閉じる"
						onClick={onClose}
					>
						✕
					</button>
				</header>
				<div className="modal__body">{children}</div>
				{footer && <footer className="modal__foot">{footer}</footer>}
			</div>
		</div>
	);
}

export function Spinner() {
	return <span className="spinner" aria-hidden="true" />;
}

export function Loading() {
	return (
		<div className="stack">
			<div className="skeleton" />
			<div className="skeleton" />
		</div>
	);
}

/** 日時はlocaleに任せる。値が無い場合はダッシュを返す。 */
export function formatTime(value: string | null | undefined): string {
	return value ? new Date(value).toLocaleString() : "—";
}

/** 起動時刻からの経過を「3日 4時間」のように短く出す。 */
export function formatUptime(bootedAt: string | null | undefined): string {
	if (!bootedAt) return "";
	const seconds = Math.floor((Date.now() - Date.parse(bootedAt)) / 1000);
	if (!Number.isFinite(seconds) || seconds < 0) return "";
	const days = Math.floor(seconds / 86400);
	const hours = Math.floor((seconds % 86400) / 3600);
	const minutes = Math.floor((seconds % 3600) / 60);
	if (days > 0) return `${days}日 ${hours}時間`;
	if (hours > 0) return `${hours}時間 ${minutes}分`;
	return `${minutes}分`;
}

export function formatValue(value: string | null | undefined): string {
	return value && value.length > 0 ? value : "—";
}

export const Icon = {
	dashboard: () => (
		<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
			<title>Dashboard</title>
			<path d="M2 2h5v5H2V2Zm7 0h5v3H9V2ZM2 9h5v5H2V9Zm7-2h5v7H9V7Z" />
		</svg>
	),
	devices: () => (
		<svg
			width="16"
			height="16"
			viewBox="0 0 16 16"
			fill="none"
			stroke="currentColor"
			strokeWidth="1.5"
		>
			<title>Devices</title>
			<rect x="1.75" y="3.75" width="12.5" height="4" rx="1" />
			<rect x="1.75" y="9.75" width="12.5" height="4" rx="1" />
			<path d="M4.25 5.75h.01M4.25 11.75h.01" strokeLinecap="round" />
		</svg>
	),
	topology: () => (
		<svg
			width="16"
			height="16"
			viewBox="0 0 16 16"
			fill="none"
			stroke="currentColor"
			strokeWidth="1.5"
		>
			<title>Topology</title>
			<circle cx="3" cy="8" r="1.75" />
			<circle cx="13" cy="3" r="1.75" />
			<circle cx="13" cy="13" r="1.75" />
			<path d="m4.6 7.2 6.8-3.4M4.6 8.8l6.8 3.4" />
		</svg>
	),
	users: () => (
		<svg
			width="16"
			height="16"
			viewBox="0 0 16 16"
			fill="none"
			stroke="currentColor"
			strokeWidth="1.5"
		>
			<title>Users</title>
			<circle cx="6" cy="5.25" r="2.25" />
			<path d="M1.75 13.5c.32-2.25 1.7-3.5 4.25-3.5s3.93 1.25 4.25 3.5" />
			<path d="M10.75 3.5a2.25 2.25 0 0 1 0 4.25M11.25 10.1c1.75.35 2.7 1.45 3 3.4" />
		</svg>
	),
	settings: () => (
		<svg
			width="16"
			height="16"
			viewBox="0 0 16 16"
			fill="none"
			stroke="currentColor"
			strokeWidth="1.5"
		>
			<title>Settings</title>
			<path d="m6.6 1.8.3 1.2a5.5 5.5 0 0 1 2.2 0l.3-1.2 1.6.7-.5 1.1a5.5 5.5 0 0 1 1.55 1.55l1.1-.5.7 1.6-1.2.3a5.5 5.5 0 0 1 0 2.2l1.2.3-.7 1.6-1.1-.5a5.5 5.5 0 0 1-1.55 1.55l.5 1.1-1.6.7-.3-1.2a5.5 5.5 0 0 1-2.2 0l-.3 1.2-1.6-.7.5-1.1a5.5 5.5 0 0 1-1.55-1.55l-1.1.5-.7-1.6 1.2-.3a5.5 5.5 0 0 1 0-2.2l-1.2-.3.7-1.6 1.1.5A5.5 5.5 0 0 1 5.3 3.6l-.5-1.1 1.8-.7Z" />
			<circle cx="8" cy="8" r="2.1" />
		</svg>
	),
	audit: () => (
		<svg
			width="16"
			height="16"
			viewBox="0 0 16 16"
			fill="none"
			stroke="currentColor"
			strokeWidth="1.5"
		>
			<title>Audit Log</title>
			<path d="M4 1.75h6l2 2v10.5H4V1.75Z" />
			<path d="M10 1.75v2h2M6 7h4M6 9.5h4M6 12h2" strokeLinecap="round" />
		</svg>
	),
	checkpoint: () => (
		<svg
			width="16"
			height="16"
			viewBox="0 0 16 16"
			fill="none"
			stroke="currentColor"
			strokeWidth="1.5"
		>
			<title>CONFIG Checkpoints</title>
			<path d="M3 2.25h10v11.5l-5-2.8-5 2.8V2.25Z" />
			<path
				d="m5.5 6.5 1.5 1.5 3.5-3.5"
				strokeLinecap="round"
				strokeLinejoin="round"
			/>
		</svg>
	),
	account: () => (
		<svg
			width="16"
			height="16"
			viewBox="0 0 16 16"
			fill="none"
			stroke="currentColor"
			strokeWidth="1.5"
		>
			<title>Account</title>
			<circle cx="8" cy="8" r="6.25" />
			<circle cx="8" cy="6.25" r="2" />
			<path d="M4.75 12.75c.5-1.7 1.58-2.5 3.25-2.5s2.75.8 3.25 2.5" />
		</svg>
	),
	theme: () => (
		<svg
			width="16"
			height="16"
			viewBox="0 0 16 16"
			fill="none"
			stroke="currentColor"
			strokeWidth="1.5"
		>
			<title>Theme</title>
			<circle cx="8" cy="8" r="3.25" />
			<path
				d="M8 1.5v1.2M8 13.3v1.2M1.5 8h1.2M13.3 8h1.2M3.4 3.4l.85.85M11.75 11.75l.85.85M12.6 3.4l-.85.85M4.25 11.75l-.85.85"
				strokeLinecap="round"
			/>
		</svg>
	),
	logout: () => (
		<svg
			width="16"
			height="16"
			viewBox="0 0 16 16"
			fill="none"
			stroke="currentColor"
			strokeWidth="1.5"
		>
			<title>Logout</title>
			<path d="M6 14H3.5A1.5 1.5 0 0 1 2 12.5v-9A1.5 1.5 0 0 1 3.5 2H6" />
			<path d="M10.5 11 14 8l-3.5-3M14 8H6" strokeLinecap="round" />
		</svg>
	),
};
