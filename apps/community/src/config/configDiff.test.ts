import { describe, expect, test } from "vitest";
import { createConfigDiff } from "./configDiff.ts";

describe("createConfigDiff", () => {
	test("行単位で追加・削除をunified diff相当にする", () => {
		const result = createConfigDiff(
			"same\nold\nkeep\n",
			"same\nnew\nkeep\nadded\n",
			{ before: "backup/old", after: "backup/new" },
		);

		expect(result.changed).toBe(true);
		expect(result.lines).toEqual([
			{ type: "context", text: "same" },
			{ type: "removed", text: "old" },
			{ type: "added", text: "new" },
			{ type: "context", text: "keep" },
			{ type: "added", text: "added" },
		]);
		expect(result.diff).toContain("--- backup/old");
		expect(result.diff).toContain("+++ backup/new");
		expect(result.diff).toContain("-old");
		expect(result.diff).toContain("+new");
	});

	test("CRLFと同一内容は差分なしにする", () => {
		const result = createConfigDiff(
			"ip lan1 address 192.0.2.1/24\r\n",
			"ip lan1 address 192.0.2.1/24\n",
			{ before: "backup/old", after: "backup/new" },
		);

		expect(result.changed).toBe(false);
		expect(result.diff).toBe("");
	});

	test("空の比較元からの初回差分を扱える", () => {
		const result = createConfigDiff("", "first\nsecond\n", {
			before: "/dev/null",
			after: "backup/new",
		});

		expect(result.lines).toEqual([
			{ type: "added", text: "first" },
			{ type: "added", text: "second" },
		]);
		expect(result.diff).toContain("@@ -0 +1,2 @@");
	});
});
