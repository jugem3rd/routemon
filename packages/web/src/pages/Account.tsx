import { type FormEvent, useState } from "react";
import { ApiError, api, type User } from "../api.ts";
import { Badge, Card, Field, Notice, Spinner } from "../ui.tsx";

const MIN_PASSWORD = 12;

export function Account({
	user,
	instanceName,
	onLoggedOut,
}: {
	user: User;
	instanceName: string | null;
	onLoggedOut: () => void;
}) {
	const [password, setPassword] = useState("");
	const [confirm, setConfirm] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);

	async function submit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		if (password.length < MIN_PASSWORD || password !== confirm) return;
		setError(null);
		setBusy(true);
		try {
			await api.changePassword(user.id, password);
			await api.logout().catch(() => undefined);
			onLoggedOut();
		} catch (error) {
			setError(apiMessage(error));
		} finally {
			setBusy(false);
		}
	}

	return (
		<>
			<header className="topbar">
				<h1>Account</h1>
				{instanceName && <span className="topbar__meta">{instanceName}</span>}
			</header>

			<div className="content">
				<Card title="アカウント">
					<dl className="kv">
						<dt>Login ID</dt>
						<dd>{user.loginId}</dd>
						<dt>Role</dt>
						<dd>
							<Badge tone={user.role === "admin" ? "accent" : "neutral"}>
								{user.role === "admin" ? "Admin" : "Viewer"}
							</Badge>
						</dd>
					</dl>
				</Card>

				<Card title="Passwordを変更">
					<form className="stack" onSubmit={submit}>
						<p className="hint">
							変更すると、現在のSessionを含む既存Sessionはすべて無効になります。
						</p>
						<Field label={`新しいpassword（${MIN_PASSWORD}文字以上）`}>
							<input
								type="password"
								value={password}
								onChange={(event) => setPassword(event.target.value)}
								autoComplete="new-password"
							/>
						</Field>
						<Field label="新しいpassword（確認）">
							<input
								type="password"
								value={confirm}
								onChange={(event) => setConfirm(event.target.value)}
								autoComplete="new-password"
							/>
						</Field>
						{password && confirm && password !== confirm && (
							<Notice tone="error">passwordが一致しません</Notice>
						)}
						{error && <Notice tone="error">{error}</Notice>}
						<div className="row row--end">
							<button
								type="submit"
								className="btn btn--primary"
								disabled={
									busy || password.length < MIN_PASSWORD || password !== confirm
								}
							>
								{busy && <Spinner />}
								{busy ? "変更中…" : "Passwordを変更"}
							</button>
						</div>
					</form>
				</Card>
			</div>
		</>
	);
}

function apiMessage(error: unknown): string {
	if (!(error instanceof ApiError)) return "Passwordを変更できませんでした。";
	if (error.status === 401)
		return "Sessionの有効期限が切れています。もう一度Loginしてください。";
	if (error.status === 400 && error.message.includes("password")) {
		return `passwordは${MIN_PASSWORD}文字以上で入力してください。`;
	}
	return "Passwordを変更できませんでした。";
}
