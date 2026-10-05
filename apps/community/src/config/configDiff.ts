/**
 * CONFIG本文の行単位diff。依存を増やさず、unified diff相当の形式を作る。
 *
 * CONFIG本文はsecretを含むため、このmoduleはdiffの生成だけを行い、logへ出力しない。
 */

export type ConfigDiffLine = {
	type: "context" | "added" | "removed";
	text: string;
};

export type ConfigDiff = {
	changed: boolean;
	lines: ConfigDiffLine[];
	diff: string;
};

type Edit = ConfigDiffLine;

function splitLines(text: string): string[] {
	const normalized = text.replace(/\r\n?/g, "\n");
	if (normalized === "") return [];
	// 改行そのものは行の内容ではないため、末尾の空要素は取り除く。
	// 本文中の空行は、末尾以外の空要素としてそのまま残る。
	return (
		normalized.endsWith("\n") ? normalized.slice(0, -1) : normalized
	).split("\n");
}

/** Myers法でLCSを求め、行ごとの編集列へ戻す。 */
function diffLines(before: string[], after: string[]): Edit[] {
	const max = before.length + after.length;
	const trace: Map<number, number>[] = [];
	const vector = new Map<number, number>([[1, 0]]);
	let distance = 0;

	outer: for (let d = 0; d <= max; d++) {
		trace.push(new Map(vector));
		for (let k = -d; k <= d; k += 2) {
			const down = vector.get(k + 1) ?? Number.NEGATIVE_INFINITY;
			const right = vector.get(k - 1) ?? Number.NEGATIVE_INFINITY;
			let x: number;
			if (k === -d || (k !== d && right < down)) {
				x = down;
			} else {
				x = right + 1;
			}
			let y = x - k;
			while (x < before.length && y < after.length && before[x] === after[y]) {
				x += 1;
				y += 1;
			}
			vector.set(k, x);
			if (x >= before.length && y >= after.length) {
				distance = d;
				break outer;
			}
		}
	}

	const edits: Edit[] = [];
	let x = before.length;
	let y = after.length;
	for (let d = distance; d > 0; d--) {
		const previous = trace[d];
		const k = x - y;
		const down = previous?.get(k + 1) ?? Number.NEGATIVE_INFINITY;
		const right = previous?.get(k - 1) ?? Number.NEGATIVE_INFINITY;
		const previousK = k === -d || (k !== d && right < down) ? k + 1 : k - 1;
		const previousX = previous?.get(previousK) ?? 0;
		const previousY = previousX - previousK;

		while (x > previousX && y > previousY) {
			edits.unshift({ type: "context", text: before[x - 1] as string });
			x -= 1;
			y -= 1;
		}
		if (x === previousX) {
			edits.unshift({ type: "added", text: after[y - 1] as string });
			y -= 1;
		} else {
			edits.unshift({ type: "removed", text: before[x - 1] as string });
			x -= 1;
		}
	}
	while (x > 0 && y > 0) {
		edits.unshift({ type: "context", text: before[x - 1] as string });
		x -= 1;
		y -= 1;
	}
	while (x > 0) {
		edits.unshift({ type: "removed", text: before[x - 1] as string });
		x -= 1;
	}
	while (y > 0) {
		edits.unshift({ type: "added", text: after[y - 1] as string });
		y -= 1;
	}
	return edits;
}

function range(start: number, count: number): string {
	if (count === 0) return "0";
	return count === 1 ? `${start}` : `${start},${count}`;
}

/**
 * 2つのCONFIG文字列を比較する。入力は既にShift_JISからdecode済みであること。
 * `diff`は標準的な2行のfile headerと1つのhunkを持つunified diff相当の文字列。
 */
export function createConfigDiff(
	before: string,
	after: string,
	labels: { before: string; after: string },
): ConfigDiff {
	const beforeLines = splitLines(before);
	const afterLines = splitLines(after);
	const lines = diffLines(beforeLines, afterLines);
	const changed = lines.some((line) => line.type !== "context");
	if (!changed) return { changed: false, lines, diff: "" };

	const diff = [
		`--- ${labels.before}`,
		`+++ ${labels.after}`,
		`@@ -${range(1, beforeLines.length)} +${range(1, afterLines.length)} @@`,
		...lines.map((line) => {
			const prefix =
				line.type === "added" ? "+" : line.type === "removed" ? "-" : " ";
			return `${prefix}${line.text}`;
		}),
	].join("\n");
	return { changed: true, lines, diff };
}
