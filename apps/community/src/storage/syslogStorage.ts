/**
 * Raw SYSLOGのlocal storage(docs/community/storage-backup-design.md、
 * docs/core/syslog-design.md §7)。
 *
 * /data/syslog/{device_id}/{yyyy}/{mm}/{dd}/{hh}/{chunk_id}.ndjson.gz
 * 保持は「期間」と「容量」の二重上限で、容量超過時はlow watermarkまで
 * 古いchunkから削除する。
 */
import { randomBytes } from "node:crypto";
import {
	type Dirent,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import type {
	SyslogLine,
	SyslogRetentionPolicy,
	SyslogStorage,
	SyslogUsage,
} from "@routemon/core";

export const DEFAULT_SYSLOG_POLICY: SyslogRetentionPolicy = {
	retentionDays: 30,
	maxBytes: 5 * 1024 * 1024 * 1024,
	lowWatermark: 0.9,
};

type Chunk = { file: string; size: number; time: number };

export class LocalSyslogStorage implements SyslogStorage {
	private readonly root: string;

	constructor(root: string) {
		this.root = root;
	}

	async append(
		deviceId: string,
		lines: SyslogLine[],
		at: Date = new Date(),
	): Promise<void> {
		if (lines.length === 0) return;
		const dir = join(this.root, deviceId, ...hourParts(at));
		mkdirSync(dir, { recursive: true });
		const chunkId = `${at.toISOString().replace(/[:.]/g, "-")}-${randomBytes(4).toString("hex")}`;
		const ndjson = `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`;
		writeFileSync(
			join(dir, `${chunkId}.ndjson.gz`),
			gzipSync(Buffer.from(ndjson, "utf8")),
		);
	}

	/** Device削除時はmetadataを持たないRaw SYSLOGも含めて配下を消す。 */
	async deleteDevice(deviceId: string): Promise<void> {
		rmSync(deviceDirectory(this.root, deviceId), {
			recursive: true,
			force: true,
		});
	}

	/** Device 1台 + time rangeで読み出す(docs/core/syslog-design.md §9)。 */
	async read(
		deviceId: string,
		range: {
			from: Date;
			to: Date;
			limit: number;
			keyword?: string;
			exclude?: string;
		},
	): Promise<SyslogLine[]> {
		const out: SyslogLine[] = [];
		const from = range.from.toISOString();
		const to = range.to.toISOString();
		const keyword = range.keyword?.toLowerCase();
		const exclude = range.exclude?.toLowerCase();
		for (const chunk of this.chunks(deviceId)) {
			// chunkのhour directoryが範囲外なら読まない
			if (!inRange(chunk.file, range.from, range.to)) continue;
			const text = gunzipSync(readFileSync(chunk.file)).toString("utf8");
			for (const line of text.split("\n")) {
				if (!line) continue;
				const parsed = JSON.parse(line) as SyslogLine;
				if (parsed.ts < from || parsed.ts > to) continue;
				const message = parsed.message.toLowerCase();
				if (keyword && !message.includes(keyword)) continue;
				if (exclude && message.includes(exclude)) continue;
				out.push(parsed);
				if (out.length >= range.limit) return out;
			}
		}
		return out;
	}

	async usage(deviceId?: string): Promise<SyslogUsage> {
		const chunks = this.chunks(deviceId);
		const usedBytes = chunks.reduce((sum, c) => sum + c.size, 0);
		const oldest = chunks.at(0);
		return oldest
			? { usedBytes, oldestAt: new Date(oldest.time).toISOString() }
			: { usedBytes };
	}

	async cleanup(
		policy: SyslogRetentionPolicy,
		now: Date = new Date(),
	): Promise<{ removedBytes: number }> {
		const chunks = this.chunks();
		let total = chunks.reduce((sum, c) => sum + c.size, 0);
		let removed = 0;
		const expiredBefore =
			now.getTime() - policy.retentionDays * 24 * 60 * 60 * 1000;
		const target = policy.maxBytes * policy.lowWatermark;
		for (const chunk of chunks) {
			const expired = chunk.time < expiredBefore;
			if (!expired && total <= policy.maxBytes) break;
			rmSync(chunk.file, { force: true });
			total -= chunk.size;
			removed += chunk.size;
			if (!expired && total <= target) break;
		}
		return { removedBytes: removed };
	}

	/** 古い順のchunk一覧。ponytail: 全走査。台数・件数が増えたらindexを持たせる。 */
	private chunks(deviceId?: string): Chunk[] {
		const out: Chunk[] = [];
		const walk = (dir: string) => {
			let entries: Dirent[];
			try {
				entries = readdirSync(dir, { withFileTypes: true });
			} catch {
				return;
			}
			for (const entry of entries) {
				const path = join(dir, entry.name);
				if (entry.isDirectory()) {
					walk(path);
				} else if (entry.name.endsWith(".ndjson.gz")) {
					const stat = statSync(path);
					out.push({ file: path, size: stat.size, time: stat.mtimeMs });
				}
			}
		};
		walk(deviceId ? join(this.root, deviceId) : this.root);
		return out.sort((a, b) => a.time - b.time || a.file.localeCompare(b.file));
	}
}

function deviceDirectory(root: string, deviceId: string): string {
	const rootPath = resolve(root);
	const devicePath = resolve(rootPath, deviceId);
	const relativePath = relative(rootPath, devicePath);
	if (
		relativePath.length === 0 ||
		relativePath.startsWith("..") ||
		isAbsolute(relativePath)
	) {
		throw new Error("invalid device storage path");
	}
	return devicePath;
}

function hourParts(at: Date): string[] {
	const iso = at.toISOString();
	return [
		iso.slice(0, 4),
		iso.slice(5, 7),
		iso.slice(8, 10),
		iso.slice(11, 13),
	];
}

/** chunkのpath(.../yyyy/mm/dd/hh/)が範囲内の時間帯かどうか。 */
function inRange(file: string, from: Date, to: Date): boolean {
	const parts = file.split("/").slice(-5, -1);
	if (parts.length !== 4) return true;
	const [yyyy, mm, dd, hh] = parts;
	const hour = Date.parse(`${yyyy}-${mm}-${dd}T${hh}:00:00.000Z`);
	if (Number.isNaN(hour)) return true;
	return hour + 60 * 60 * 1000 > from.getTime() && hour <= to.getTime();
}
