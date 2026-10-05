/**
 * install済みpackageのlicenseを一覧する(#10のdependency license audit用)。
 * 外部serviceへ送らず、node_modulesのpackage.jsonだけを読む。
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const found = new Map();

function walk(dir) {
	for (const name of readdirSync(dir)) {
		if (name.startsWith(".")) continue;
		const path = join(dir, name);
		if (name.startsWith("@")) {
			walk(path);
			continue;
		}
		try {
			const pkg = JSON.parse(readFileSync(join(path, "package.json"), "utf8"));
			if (pkg.name?.startsWith("@routemon/")) continue;
			const license =
				typeof pkg.license === "string" ? pkg.license : pkg.license?.type;
			found.set(pkg.name, license ?? "UNKNOWN");
		} catch {
			// package.jsonが無いdirectoryは無視する
		}
	}
}

walk("node_modules");
const counts = new Map();
for (const [name, license] of [...found].sort()) {
	console.log(`${license}\t${name}`);
	counts.set(license, (counts.get(license) ?? 0) + 1);
}
console.log(`\n${found.size} packages`);
for (const [license, count] of [...counts].sort((a, b) => b[1] - a[1])) {
	console.log(`${count}\t${license}`);
}
