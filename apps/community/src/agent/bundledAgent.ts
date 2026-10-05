/**
 * imageへ同梱したAgentを、release directoryへ配置する(docs/core/agent-update-design.md §4)。
 *
 * - `<version>.lua`: 無ければ置く。有れば触らない(管理者が置いたartifactを守る)
 * - `stable.lua`: 無い、または同梱の版が置いてある版より新しいときだけ置き換える
 * - 同梱のAgentからversion宣言が読めないときは例外にする(壊れたimageを検知する)
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Gatewayが`stable.lua`のversionを解決するときと同じ宣言を読む */
const VERSION_DECLARATION =
	/^\s*local\s+VERSION\s*=\s*'([0-9A-Za-z._-]+)'\s*$/m;

export type BundledAgentResult = {
	version: string;
	/** `<version>.lua`を新しく置いたか */
	releaseWritten: boolean;
	/** `stable.lua`を新しく置いた、または置き換えたか */
	stableWritten: boolean;
	/** 置き換え前のstableの版(無い、または読めないときはnull) */
	previousStable: string | null;
};

export function readAgentVersion(source: string): string | null {
	return source.match(VERSION_DECLARATION)?.[1] ?? null;
}

/** 数字の区切りごとに比べる。数字でない部分は文字列として比べる(`0.10.0` > `0.9.0`) */
export function compareVersions(a: string, b: string): number {
	const pa = a.split(/[.+-]/);
	const pb = b.split(/[.+-]/);
	for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
		const x = pa[i] ?? "0";
		const y = pb[i] ?? "0";
		const bothNumeric = /^\d+$/.test(x) && /^\d+$/.test(y);
		if (bothNumeric) {
			const diff = Number(x) - Number(y);
			if (diff !== 0) return diff < 0 ? -1 : 1;
		} else if (x !== y) {
			return x < y ? -1 : 1;
		}
	}
	return 0;
}

function writeAtomic(path: string, content: Buffer): void {
	const tmp = `${path}.tmp-${process.pid}`;
	writeFileSync(tmp, content, { mode: 0o644 });
	renameSync(tmp, path);
}

export function installBundledAgent(options: {
	/** 同梱のAgent本体(`agent/https_tunnel_agent.lua`) */
	sourcePath: string;
	releaseDir: string;
}): BundledAgentResult {
	if (!existsSync(options.sourcePath)) {
		throw new Error(`bundled agent not found: ${options.sourcePath}`);
	}
	const artifact = readFileSync(options.sourcePath);
	const version = readAgentVersion(artifact.toString("utf8"));
	if (!version) {
		throw new Error(
			`bundled agent has no version declaration: ${options.sourcePath}`,
		);
	}

	const releasePath = join(options.releaseDir, `${version}.lua`);
	const releaseWritten = !existsSync(releasePath);
	if (releaseWritten) writeAtomic(releasePath, artifact);

	const stablePath = join(options.releaseDir, "stable.lua");
	let previousStable: string | null = null;
	let stableWritten = true;
	if (existsSync(stablePath)) {
		previousStable = readAgentVersion(readFileSync(stablePath, "utf8"));
		// 版が読めないstableは壊れているとみなして置き換える
		stableWritten =
			previousStable === null || compareVersions(version, previousStable) > 0;
	}
	if (stableWritten) writeAtomic(stablePath, artifact);

	return { version, releaseWritten, stableWritten, previousStable };
}
