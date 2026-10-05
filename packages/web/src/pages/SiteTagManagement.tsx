import { useEffect, useState } from "react";
import { ApiError, api, type Site, type Tag } from "../api.ts";
import {
	Card,
	Empty,
	Field,
	formatValue,
	Loading,
	Modal,
	Notice,
	Spinner,
} from "../ui.tsx";

type ModalState =
	| { type: "site"; site?: Site }
	| { type: "delete-site"; site: Site }
	| { type: "tag" }
	| { type: "delete-tag"; tag: Tag }
	| null;

export function SiteTagManagement() {
	const [sites, setSites] = useState<Site[] | null>(null);
	const [tags, setTags] = useState<Tag[] | null>(null);
	const [modal, setModal] = useState<ModalState>(null);
	const [busyId, setBusyId] = useState<string | null>(null);
	const [message, setMessage] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);

	async function load() {
		setError(null);
		try {
			const [siteResponse, tagResponse] = await Promise.all([
				api.sites(),
				api.tags(),
			]);
			setSites(siteResponse.sites);
			setTags(tagResponse.tags);
		} catch (cause) {
			setError(apiMessage(cause, "Site / Tagを読み込めませんでした。"));
		}
	}

	// Settingsを開いたときにSite / Tagを1回だけ読み込む。
	// biome-ignore lint/correctness/useExhaustiveDependencies: 画面表示時に1回だけ読み込む
	useEffect(() => {
		void load();
	}, []);

	function clearStatus() {
		setMessage(null);
		setError(null);
	}

	async function deleteSite(site: Site) {
		setBusyId(site.id);
		clearStatus();
		try {
			await api.deleteSite(site.id);
			setSites((current) =>
				current ? current.filter((item) => item.id !== site.id) : current,
			);
			setModal(null);
			setMessage(
				`Site「${site.name}」を削除しました。Deviceの割り当ても解除されました。`,
			);
		} catch (cause) {
			setError(apiMessage(cause, "Siteを削除できませんでした。"));
		} finally {
			setBusyId(null);
		}
	}

	async function deleteTag(tag: Tag) {
		setBusyId(tag.id);
		clearStatus();
		try {
			await api.deleteTag(tag.id);
			setTags((current) =>
				current ? current.filter((item) => item.id !== tag.id) : current,
			);
			setModal(null);
			setMessage(
				`Tag「${tag.name}」を削除しました。Deviceの割り当ても解除されました。`,
			);
		} catch (cause) {
			setError(apiMessage(cause, "Tagを削除できませんでした。"));
		} finally {
			setBusyId(null);
		}
	}

	return (
		<div className="stack">
			{message && <Notice tone="accent">{message}</Notice>}
			{error && <Notice tone="error">{error}</Notice>}

			<Card
				title="Sites"
				actions={
					<button
						type="button"
						className="btn btn--primary"
						onClick={() => {
							clearStatus();
							setModal({ type: "site" });
						}}
					>
						Siteを追加
					</button>
				}
				flush
			>
				{!sites ? (
					<div className="card__body">
						<Loading />
					</div>
				) : sites.length === 0 ? (
					<Empty title="Siteがありません">
						Deviceを分類するSiteを追加してください。
					</Empty>
				) : (
					<div className="table-wrap">
						<table>
							<thead>
								<tr>
									<th>名前</th>
									<th>説明</th>
									<th>操作</th>
								</tr>
							</thead>
							<tbody>
								{sites.map((site) => (
									<tr key={site.id}>
										<td className="cell-strong">{site.name}</td>
										<td>{formatValue(site.description)}</td>
										<td>
											<div className="user-actions">
												<button
													type="button"
													className="btn"
													onClick={() => {
														clearStatus();
														setModal({ type: "site", site });
													}}
												>
													編集
												</button>
												<button
													type="button"
													className="btn btn--danger"
													disabled={busyId === site.id}
													onClick={() => {
														clearStatus();
														setModal({ type: "delete-site", site });
													}}
												>
													削除
												</button>
											</div>
										</td>
									</tr>
								))}
							</tbody>
						</table>
					</div>
				)}
			</Card>

			<Card
				title="Tags"
				actions={
					<button
						type="button"
						className="btn btn--primary"
						onClick={() => {
							clearStatus();
							setModal({ type: "tag" });
						}}
					>
						Tagを追加
					</button>
				}
				flush
			>
				{!tags ? (
					<div className="card__body">
						<Loading />
					</div>
				) : tags.length === 0 ? (
					<Empty title="Tagがありません">
						Deviceを検索しやすくするTagを追加してください。
					</Empty>
				) : (
					<div className="table-wrap">
						<table>
							<thead>
								<tr>
									<th>名前</th>
									<th>操作</th>
								</tr>
							</thead>
							<tbody>
								{tags.map((tag) => (
									<tr key={tag.id}>
										<td className="cell-strong">{tag.name}</td>
										<td>
											<button
												type="button"
												className="btn btn--danger"
												disabled={busyId === tag.id}
												onClick={() => {
													clearStatus();
													setModal({ type: "delete-tag", tag });
												}}
											>
												削除
											</button>
										</td>
									</tr>
								))}
							</tbody>
						</table>
					</div>
				)}
			</Card>

			{modal?.type === "site" && (
				<SiteModal
					site={modal.site}
					onClose={() => setModal(null)}
					onSaved={(site) => {
						setSites((current) =>
							current
								? modal.site
									? current.map((item) => (item.id === site.id ? site : item))
									: [...current, site]
								: [site],
						);
						setModal(null);
						setMessage(
							`Site「${site.name}」を${modal.site ? "更新" : "追加"}しました。`,
						);
					}}
				/>
			)}
			{modal?.type === "tag" && (
				<TagModal
					onClose={() => setModal(null)}
					onSaved={(tag) => {
						setTags((current) => (current ? [...current, tag] : [tag]));
						setModal(null);
						setMessage(`Tag「${tag.name}」を追加しました。`);
					}}
				/>
			)}
			{modal?.type === "delete-site" && (
				<DeleteModal
					title="Siteを削除しますか?"
					name={modal.site.name}
					description="DeviceのSite割り当ては解除されます。"
					busy={busyId === modal.site.id}
					onClose={() => setModal(null)}
					onConfirm={() => void deleteSite(modal.site)}
				/>
			)}
			{modal?.type === "delete-tag" && (
				<DeleteModal
					title="Tagを削除しますか?"
					name={modal.tag.name}
					description="DeviceへのTag割り当ても解除されます。"
					busy={busyId === modal.tag.id}
					onClose={() => setModal(null)}
					onConfirm={() => void deleteTag(modal.tag)}
				/>
			)}
		</div>
	);
}

function SiteModal({
	site,
	onClose,
	onSaved,
}: {
	site?: Site;
	onClose: () => void;
	onSaved: (site: Site) => void;
}) {
	const [name, setName] = useState(site?.name ?? "");
	const [description, setDescription] = useState(site?.description ?? "");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	async function save() {
		if (!name.trim()) return;
		setBusy(true);
		setError(null);
		try {
			const result = site
				? await api.updateSite(site.id, {
						name: name.trim(),
						description: description.trim() || null,
					})
				: await api.createSite({
						name: name.trim(),
						description: description.trim() || null,
					});
			onSaved(result.site);
		} catch (cause) {
			setError(apiMessage(cause, "Siteを保存できませんでした。"));
		} finally {
			setBusy(false);
		}
	}

	return (
		<Modal
			title={site ? "Siteを編集" : "Siteを追加"}
			onClose={onClose}
			footer={
				<>
					<button type="button" className="btn btn--ghost" onClick={onClose}>
						キャンセル
					</button>
					<button
						type="button"
						className="btn btn--primary"
						disabled={busy || !name.trim()}
						onClick={() => void save()}
					>
						{busy && <Spinner />}
						{busy ? "保存中…" : "保存"}
					</button>
				</>
			}
		>
			<Field label="Site名">
				<input value={name} onChange={(event) => setName(event.target.value)} />
			</Field>
			<Field label="説明">
				<textarea
					rows={3}
					value={description}
					onChange={(event) => setDescription(event.target.value)}
				/>
			</Field>
			{error && <Notice tone="error">{error}</Notice>}
		</Modal>
	);
}

function TagModal({
	onClose,
	onSaved,
}: {
	onClose: () => void;
	onSaved: (tag: Tag) => void;
}) {
	const [name, setName] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	async function save() {
		if (!name.trim()) return;
		setBusy(true);
		setError(null);
		try {
			onSaved((await api.createTag(name.trim())).tag);
		} catch (cause) {
			setError(apiMessage(cause, "Tagを追加できませんでした。"));
		} finally {
			setBusy(false);
		}
	}

	return (
		<Modal
			title="Tagを追加"
			onClose={onClose}
			footer={
				<>
					<button type="button" className="btn btn--ghost" onClick={onClose}>
						キャンセル
					</button>
					<button
						type="button"
						className="btn btn--primary"
						disabled={busy || !name.trim()}
						onClick={() => void save()}
					>
						{busy && <Spinner />}
						{busy ? "追加中…" : "追加する"}
					</button>
				</>
			}
		>
			<Field label="Tag名">
				<input value={name} onChange={(event) => setName(event.target.value)} />
			</Field>
			{error && <Notice tone="error">{error}</Notice>}
		</Modal>
	);
}

function DeleteModal({
	title,
	name,
	description,
	busy,
	onClose,
	onConfirm,
}: {
	title: string;
	name: string;
	description: string;
	busy: boolean;
	onClose: () => void;
	onConfirm: () => void;
}) {
	return (
		<Modal
			title={title}
			onClose={onClose}
			footer={
				<>
					<button
						type="button"
						className="btn btn--ghost"
						disabled={busy}
						onClick={onClose}
					>
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
				<strong>{name}</strong> を削除します。{description}
			</p>
		</Modal>
	);
}

function apiMessage(error: unknown, fallback: string): string {
	if (error instanceof ApiError && error.status === 403)
		return "この操作はAdminだけが実行できます。";
	return error instanceof ApiError ? error.message : fallback;
}
