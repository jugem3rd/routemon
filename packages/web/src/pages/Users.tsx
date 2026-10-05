import { type FormEvent, useEffect, useId, useState } from "react";
import {
	ApiError,
	api,
	type Role,
	type User,
	type UserListItem,
} from "../api.ts";
import {
	Badge,
	Card,
	Empty,
	Field,
	formatTime,
	Loading,
	Modal,
	Notice,
	Spinner,
} from "../ui.tsx";

const MIN_PASSWORD = 12;

type UsersProps = {
	currentUser: User;
	instanceName: string | null;
	onUserChanged: (user: User) => void;
	onLoggedOut: () => void;
};

type ModalState =
	| { type: "add" }
	| { type: "password"; user: UserListItem }
	| { type: "delete"; user: UserListItem }
	| null;

export function Users({
	currentUser,
	instanceName,
	onUserChanged,
	onLoggedOut,
}: UsersProps) {
	const [users, setUsers] = useState<UserListItem[] | null>(null);
	const [loadError, setLoadError] = useState<string | null>(null);
	const [message, setMessage] = useState<string | null>(null);
	const [modal, setModal] = useState<ModalState>(null);
	const [busyUserId, setBusyUserId] = useState<string | null>(null);

	async function load() {
		setLoadError(null);
		try {
			setUsers((await api.users()).users);
		} catch (error) {
			setLoadError(apiMessage(error, "User一覧を読み込めませんでした。"));
		}
	}

	// biome-ignore lint/correctness/useExhaustiveDependencies: 画面表示時に1回だけ読み込む
	useEffect(() => {
		void load();
	}, []);

	const adminCount = users?.filter((user) => user.role === "admin").length ?? 0;

	async function changeRole(user: UserListItem, role: Role) {
		if (role === user.role) return;
		setMessage(null);
		setBusyUserId(user.id);
		try {
			const result = await api.changeUserRole(user.id, role);
			setUsers((current) =>
				current
					? current.map((item) =>
							item.id === user.id ? { ...item, role: result.user.role } : item,
						)
					: null,
			);
			if (user.id === currentUser.id) onUserChanged(result.user);
			setMessage(`${displayName(user)} のroleを変更しました。`);
		} catch (error) {
			setMessage(apiMessage(error, "roleを変更できませんでした。"));
			await load();
		} finally {
			setBusyUserId(null);
		}
	}

	async function deleteUser(user: UserListItem) {
		setMessage(null);
		setBusyUserId(user.id);
		try {
			await api.deleteUser(user.id);
			setModal(null);
			if (user.id === currentUser.id) {
				onLoggedOut();
				return;
			}
			setUsers((current) =>
				current ? current.filter((item) => item.id !== user.id) : null,
			);
			setMessage(`${displayName(user)} を削除しました。`);
		} catch (error) {
			setMessage(apiMessage(error, "Userを削除できませんでした。"));
			await load();
		} finally {
			setBusyUserId(null);
		}
	}

	async function resetPassword(user: UserListItem, password: string) {
		setMessage(null);
		setBusyUserId(user.id);
		try {
			await api.changePassword(user.id, password);
			setModal(null);
			if (user.id === currentUser.id) {
				onLoggedOut();
				return;
			}
			setMessage(`${displayName(user)} のpasswordを再設定しました。`);
		} catch (error) {
			setMessage(apiMessage(error, "passwordを変更できませんでした。"));
			throw error;
		} finally {
			setBusyUserId(null);
		}
	}

	return (
		<>
			<header className="topbar">
				<h1>Users</h1>
				{instanceName && <span className="topbar__meta">{instanceName}</span>}
			</header>

			<div className="content">
				{message && <Notice tone="accent">{message}</Notice>}
				{loadError && (
					<div className="row">
						<Notice tone="error">{loadError}</Notice>
						<button type="button" className="btn" onClick={() => void load()}>
							再試行
						</button>
					</div>
				)}

				{!users ? (
					!loadError && <Loading />
				) : (
					<Card
						title={`${users.length} 人`}
						actions={
							<button
								type="button"
								className="btn btn--primary"
								onClick={() => {
									setMessage(null);
									setModal({ type: "add" });
								}}
							>
								Userを追加
							</button>
						}
						flush
					>
						{users.length === 0 ? (
							<Empty title="Userがいません">Userを追加してください。</Empty>
						) : (
							<div className="table-wrap">
								<table>
									<thead>
										<tr>
											<th>ログインID</th>
											<th>権限</th>
											<th>作成日時</th>
											<th>最終ログイン</th>
											<th>操作</th>
										</tr>
									</thead>
									<tbody>
										{users.map((user) => {
											const soleAdmin =
												user.role === "admin" && adminCount === 1;
											const self = user.id === currentUser.id;
											const busy = busyUserId === user.id;
											return (
												<tr key={user.id}>
													<td className="cell-strong">
														{displayName(user)}
														{self && (
															<span className="user-row__self">
																{" "}
																<Badge tone="neutral" plain>
																	自分
																</Badge>
															</span>
														)}
													</td>
													<td>
														<Badge
															tone={
																user.role === "admin" ? "accent" : "neutral"
															}
														>
															{user.role === "admin" ? "Admin" : "Viewer"}
														</Badge>
													</td>
													<td>{formatTime(user.createdAt)}</td>
													<td>{formatTime(user.lastLoginAt)}</td>
													<td>
														<div className="user-actions">
															<select
																className="role-select"
																value={user.role}
																disabled={soleAdmin || busy}
																aria-label={`${displayName(user)}のrole`}
																onChange={(event) =>
																	void changeRole(
																		user,
																		event.target.value as Role,
																	)
																}
															>
																<option value="admin">Admin</option>
																<option value="viewer">Viewer</option>
															</select>
															<button
																type="button"
																className="btn"
																disabled={busy}
																onClick={() =>
																	setModal({ type: "password", user })
																}
															>
																password変更
															</button>
															{!self && (
																<button
																	type="button"
																	className="btn btn--danger"
																	disabled={soleAdmin || busy}
																	onClick={() =>
																		setModal({ type: "delete", user })
																	}
																>
																	削除
																</button>
															)}
														</div>
														{self && (
															<span className="hint user-row__constraint">
																自分自身のアカウントは削除できません
															</span>
														)}
														{soleAdmin && (
															<span className="hint user-row__constraint">
																最後のAdminのためrole変更・削除できません
															</span>
														)}
													</td>
												</tr>
											);
										})}
									</tbody>
								</table>
							</div>
						)}
					</Card>
				)}
			</div>

			{modal?.type === "add" && (
				<AddUserModal
					onClose={() => setModal(null)}
					onCreated={async () => {
						setModal(null);
						setMessage("Userを追加しました。");
						await load();
					}}
				/>
			)}
			{modal?.type === "password" && (
				<PasswordModal
					user={modal.user}
					busy={busyUserId === modal.user.id}
					onClose={() => setModal(null)}
					onSubmit={(password) => resetPassword(modal.user, password)}
				/>
			)}
			{modal?.type === "delete" && (
				<DeleteModal
					user={modal.user}
					busy={busyUserId === modal.user.id}
					onClose={() => setModal(null)}
					onConfirm={() => void deleteUser(modal.user)}
				/>
			)}
		</>
	);
}

function AddUserModal({
	onClose,
	onCreated,
}: {
	onClose: () => void;
	onCreated: () => Promise<void>;
}) {
	const formId = useId();
	const [loginId, setLoginId] = useState("");
	const [role, setRole] = useState<Role>("viewer");
	const [password, setPassword] = useState("");
	const [confirm, setConfirm] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);

	async function submit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		if (
			!loginId.trim() ||
			password.length < MIN_PASSWORD ||
			password !== confirm
		) {
			return;
		}
		setBusy(true);
		setError(null);
		try {
			await api.createUser({ loginId: loginId.trim(), password, role });
			await onCreated();
		} catch (error) {
			setError(apiMessage(error, "Userを追加できませんでした。"));
		} finally {
			setBusy(false);
		}
	}

	return (
		<Modal
			title="Userを追加"
			onClose={onClose}
			footer={
				<>
					<button type="button" className="btn btn--ghost" onClick={onClose}>
						キャンセル
					</button>
					<button
						type="submit"
						form={formId}
						className="btn btn--primary"
						disabled={
							busy ||
							!loginId.trim() ||
							password.length < MIN_PASSWORD ||
							password !== confirm
						}
					>
						{busy && <Spinner />}
						{busy ? "追加中…" : "追加する"}
					</button>
				</>
			}
		>
			<form id={formId} className="stack" onSubmit={submit}>
				<Field label="Login ID">
					<input
						value={loginId}
						onChange={(event) => setLoginId(event.target.value)}
						autoComplete="username"
					/>
				</Field>
				<Field label="Role">
					<select
						value={role}
						onChange={(event) => setRole(event.target.value as Role)}
					>
						<option value="viewer">Viewer</option>
						<option value="admin">Admin</option>
					</select>
				</Field>
				<Field label={`初期password（${MIN_PASSWORD}文字以上）`}>
					<input
						type="password"
						value={password}
						onChange={(event) => setPassword(event.target.value)}
						autoComplete="new-password"
					/>
				</Field>
				<Field label="初期password（確認）">
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
			</form>
		</Modal>
	);
}

function PasswordModal({
	user,
	busy,
	onClose,
	onSubmit,
}: {
	user: UserListItem;
	busy: boolean;
	onClose: () => void;
	onSubmit: (password: string) => Promise<void>;
}) {
	const formId = useId();
	const [password, setPassword] = useState("");
	const [confirm, setConfirm] = useState("");
	const [error, setError] = useState<string | null>(null);

	async function submit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		if (password.length < MIN_PASSWORD || password !== confirm) return;
		setError(null);
		try {
			await onSubmit(password);
		} catch (error) {
			setError(apiMessage(error, "passwordを変更できませんでした。"));
		}
	}

	return (
		<Modal
			title={`${displayName(user)} のpasswordを再設定`}
			onClose={onClose}
			footer={
				<>
					<button type="button" className="btn btn--ghost" onClick={onClose}>
						キャンセル
					</button>
					<button
						type="submit"
						form={formId}
						className="btn btn--primary"
						disabled={
							busy || password.length < MIN_PASSWORD || password !== confirm
						}
					>
						{busy && <Spinner />}
						{busy ? "変更中…" : "再設定する"}
					</button>
				</>
			}
		>
			<form id={formId} className="stack" onSubmit={submit}>
				<p className="hint">このUserの既存Sessionはすべて無効になります。</p>
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
			</form>
		</Modal>
	);
}

function DeleteModal({
	user,
	busy,
	onClose,
	onConfirm,
}: {
	user: UserListItem;
	busy: boolean;
	onClose: () => void;
	onConfirm: () => void;
}) {
	return (
		<Modal
			title="Userを削除しますか?"
			onClose={onClose}
			footer={
				<>
					<button type="button" className="btn btn--ghost" onClick={onClose}>
						キャンセル
					</button>
					<button
						type="button"
						className="btn btn--danger"
						disabled={busy}
						onClick={onConfirm}
					>
						{busy && <Spinner />}
						{busy ? "削除中…" : "削除する"}
					</button>
				</>
			}
		>
			<p>
				<strong>{displayName(user)}</strong>{" "}
				を削除します。この操作は取り消せません。
			</p>
		</Modal>
	);
}

function displayName(user: UserListItem): string {
	return user.loginId || "(login IDなし)";
}

function apiMessage(error: unknown, fallback: string): string {
	if (!(error instanceof ApiError)) return fallback;
	if (error.status === 409) return "最後のAdminはrole変更・削除できません。";
	if (error.status === 403) return "この操作はAdminだけが実行できます。";
	if (error.status === 400 && error.message.includes("password")) {
		return `passwordは${MIN_PASSWORD}文字以上で入力してください。`;
	}
	if (error.status >= 500) return fallback;
	return error.message;
}
