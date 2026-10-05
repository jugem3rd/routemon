import { type FormEvent, useState } from "react";
import { api, type User } from "../api.ts";
import { Field, Notice } from "../ui.tsx";

export function Login({ onLogin }: { onLogin: (user: User) => void }) {
	const [identifier, setIdentifier] = useState("");
	const [password, setPassword] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);

	async function submit(event: FormEvent) {
		event.preventDefault();
		setError(null);
		setBusy(true);
		try {
			onLogin((await api.login(identifier, password)).user);
		} catch {
			// 理由(未登録 / password誤り / lockout)は返さない(docs/community/local-auth-design.md §7)
			setError("login IDまたはpasswordが正しくありません");
		} finally {
			setBusy(false);
		}
	}

	return (
		<main className="centered">
			<div className="panel">
				<div className="panel__brand">
					<span className="mark">Y</span>
					Routemon
				</div>
				<p className="hint">YAMAHAルーターをまとめて管理します。</p>
				<form onSubmit={submit}>
					<Field label="Login ID">
						<input
							value={identifier}
							onChange={(e) => setIdentifier(e.target.value)}
							autoComplete="username"
						/>
					</Field>
					<Field label="Password">
						<input
							type="password"
							value={password}
							onChange={(e) => setPassword(e.target.value)}
							autoComplete="current-password"
						/>
					</Field>
					{error && <Notice tone="error">{error}</Notice>}
					<button
						type="submit"
						className="btn btn--primary btn--block"
						disabled={busy || !identifier || !password}
					>
						{busy ? "確認中…" : "Login"}
					</button>
				</form>
			</div>
		</main>
	);
}
