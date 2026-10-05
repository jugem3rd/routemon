import { useState } from "react";
import { api, type SetupCheck, type SetupStatus } from "../api.ts";
import { Badge, Field, Notice } from "../ui.tsx";

type Step = "welcome" | "instance" | "admin" | "network" | "check" | "done";

const STEPS: [Step, string][] = [
	["welcome", "ようこそ"],
	["instance", "Instance"],
	["admin", "管理者"],
	["network", "Public URL"],
	["check", "接続確認"],
	["done", "完了"],
];

const MIN_PASSWORD = 12;

/**
 * Setup Wizard(#12、docs/community/installation-setup-design.md §4)。
 * CLIでのUser作成・Device登録を求めず、ここだけで初期設定を終える。
 */
export function SetupWizard({ onDone }: { onDone: (s: SetupStatus) => void }) {
	const [step, setStep] = useState<Step>("welcome");
	const [instanceName, setInstanceName] = useState("");
	const [timezone, setTimezone] = useState(
		Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
	);
	const [loginId, setLoginId] = useState("");
	const [password, setPassword] = useState("");
	const [confirm, setConfirm] = useState("");
	const [publicBaseUrl, setPublicBaseUrl] = useState("");
	const [checks, setChecks] = useState<SetupCheck[] | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const stepIndex = STEPS.findIndex(([key]) => key === step);

	async function runChecks() {
		setBusy(true);
		setError(null);
		try {
			setChecks((await api.connectivityCheck(publicBaseUrl)).checks);
		} catch (e) {
			setError((e as Error).message);
		} finally {
			setBusy(false);
		}
	}

	async function complete() {
		setBusy(true);
		setError(null);
		try {
			const status = await api.completeSetup({
				instanceName,
				timezone,
				publicBaseUrl,
				admin: { loginId, password },
			});
			setStep("done");
			onDone(status);
		} catch (e) {
			setError((e as Error).message);
		} finally {
			setBusy(false);
		}
	}

	return (
		<main className="centered">
			<div className="panel panel--wide">
				<div className="panel__brand">
					<span className="mark">Y</span>
					Routemon セットアップ
				</div>
				<ol className="steps">
					{STEPS.map(([key, label], index) => (
						<li
							key={key}
							className={
								key === step ? "active" : index < stepIndex ? "done" : ""
							}
						>
							{label}
						</li>
					))}
				</ol>

				{step === "welcome" && (
					<div className="stack">
						<p>
							YAMAHAルーターをまとめて管理するための初期設定を行います。
							この画面が終われば、以降の操作はすべてGUIから行えます。
						</p>
						<ul className="hint-list">
							<li>Instance名とTimezone</li>
							<li>最初の管理者(Public signupはありません)</li>
							<li>ルーターから届くPublic URLと、その接続確認</li>
						</ul>
						<div className="row row--end">
							<button
								type="button"
								className="btn btn--primary"
								onClick={() => setStep("instance")}
							>
								はじめる
							</button>
						</div>
					</div>
				)}

				{step === "instance" && (
					<div className="stack">
						<Field label="Instance名(組織名など)">
							<input
								value={instanceName}
								onChange={(e) => setInstanceName(e.target.value)}
								placeholder="例: 本社ネットワーク"
							/>
						</Field>
						<Field label="Timezone">
							<input
								value={timezone}
								onChange={(e) => setTimezone(e.target.value)}
							/>
						</Field>
						<div className="row row--end">
							<button
								type="button"
								className="btn btn--ghost"
								onClick={() => setStep("welcome")}
							>
								戻る
							</button>
							<button
								type="button"
								className="btn btn--primary"
								disabled={!instanceName.trim()}
								onClick={() => setStep("admin")}
							>
								次へ
							</button>
						</div>
					</div>
				)}

				{step === "admin" && (
					<div className="stack">
						<p className="hint">
							最初のUserはAdminになります。あとからGUIでUserを追加できます。
						</p>
						<Field label="Login ID">
							<input
								value={loginId}
								onChange={(e) => setLoginId(e.target.value)}
								autoComplete="username"
							/>
						</Field>
						<Field label={`Password(${MIN_PASSWORD}文字以上)`}>
							<input
								type="password"
								value={password}
								onChange={(e) => setPassword(e.target.value)}
								autoComplete="new-password"
							/>
						</Field>
						<Field label="Password(確認)">
							<input
								type="password"
								value={confirm}
								onChange={(e) => setConfirm(e.target.value)}
								autoComplete="new-password"
							/>
						</Field>
						{password && confirm && password !== confirm && (
							<Notice tone="error">passwordが一致しません</Notice>
						)}
						<div className="row row--end">
							<button
								type="button"
								className="btn btn--ghost"
								onClick={() => setStep("instance")}
							>
								戻る
							</button>
							<button
								type="button"
								className="btn btn--primary"
								disabled={
									!loginId.trim() ||
									password.length < MIN_PASSWORD ||
									password !== confirm
								}
								onClick={() => setStep("network")}
							>
								次へ
							</button>
						</div>
					</div>
				)}

				{step === "network" && (
					<div className="stack">
						<Field label="Public URL">
							<input
								value={publicBaseUrl}
								onChange={(e) => setPublicBaseUrl(e.target.value)}
								placeholder="https://routemon.example.com"
							/>
						</Field>
						<ul className="hint-list">
							<li>このURLのDNS recordがこのServerを指していること</li>
							<li>外部からTCP/443へ到達できること</li>
							<li>ルーターからこのURLへOutbound HTTPSが通ること</li>
							<li>NAT / Firewallで443を転送・許可していること</li>
						</ul>
						<div className="row row--end">
							<button
								type="button"
								className="btn btn--ghost"
								onClick={() => setStep("admin")}
							>
								戻る
							</button>
							<button
								type="button"
								className="btn btn--primary"
								disabled={!publicBaseUrl.trim()}
								onClick={() => {
									setStep("check");
									void runChecks();
								}}
							>
								接続確認へ
							</button>
						</div>
					</div>
				)}

				{step === "check" && (
					<div className="stack">
						{busy && <p className="hint">確認中…</p>}
						{checks && (
							<div className="table-wrap">
								<table>
									<tbody>
										{checks.map((check) => (
											<tr key={check.name}>
												<td className="cell-strong">{check.name}</td>
												<td>
													<Badge tone={check.status === "ok" ? "ok" : "danger"}>
														{check.status === "ok" ? "OK" : "Error"}
													</Badge>
												</td>
												<td style={{ whiteSpace: "normal" }}>{check.detail}</td>
											</tr>
										))}
									</tbody>
								</table>
							</div>
						)}
						<p className="hint">
							Errorのままでも完了できます(あとで設定から変更できます)。
						</p>
						<div className="row row--end">
							<button
								type="button"
								className="btn btn--ghost"
								onClick={() => setStep("network")}
							>
								URLを直す
							</button>
							<button
								type="button"
								className="btn"
								disabled={busy}
								onClick={() => void runChecks()}
							>
								再確認
							</button>
							<button
								type="button"
								className="btn btn--primary"
								disabled={busy}
								onClick={() => void complete()}
							>
								この内容で完了する
							</button>
						</div>
					</div>
				)}

				{step === "done" && (
					<div className="stack">
						<p>
							セットアップが完了しました。続けて最初のルーターを登録できます。
						</p>
						<div className="row row--end">
							<a className="btn btn--primary" href="#/devices">
								Deviceを登録する
							</a>
						</div>
					</div>
				)}

				{error && <Notice tone="error">{error}</Notice>}
			</div>
		</main>
	);
}
