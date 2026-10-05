import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import {
	ApiError,
	type ConfigApplyBatch,
	type ConfigApplyBatchItem,
	type ConfigApplyBatchPlan,
	isBatchActiveError,
} from "../api.ts";
import {
	classifyBatchItem,
	ExecutionView,
	failureLabel,
	isBatchActive,
	notAppliedReason,
	PlanView,
	planBlockers,
	ResultView,
	summarizeBatch,
} from "./BulkApplies.tsx";

function item(
	overrides: Partial<ConfigApplyBatchItem> = {},
): ConfigApplyBatchItem {
	return {
		id: "item-1",
		sequence: 0,
		deviceId: "device-1",
		deviceName: "rtx1",
		targetBackupId: "backup-1",
		preparedBackupId: null,
		executionCheckBackupId: null,
		selectedForExecution: true,
		plan: null,
		status: "queued",
		failureCode: null,
		applyId: null,
		applyEffect: null,
		saveResult: null,
		requestedAt: "2026-09-25T00:00:00.000Z",
		confirmedAt: null,
		finishedAt: null,
		...overrides,
	};
}

function batch(
	items: ConfigApplyBatchItem[],
	status: ConfigApplyBatch["status"] = "stopped",
	saveAfterApply = false,
): ConfigApplyBatch {
	return {
		id: "batch-1",
		source: "devices",
		sourceCheckpointId: null,
		sourceCheckpointName: null,
		confirmationMode: "batch",
		saveAfterApply,
		status,
		currentItemId: null,
		stopReason: "apply_failed",
		planCompletedAt: null,
		confirmedAt: null,
		createdAt: "2026-09-25T00:00:00.000Z",
		updatedAt: "2026-09-25T00:01:00.000Z",
		finishedAt: "2026-09-25T00:02:00.000Z",
		items,
	};
}

describe("一括適用の3群分け", () => {
	test("apply_verify一致だけが適用確認済みになる", () => {
		expect(
			classifyBatchItem(item({ status: "applied", applyEffect: "confirmed" })),
		).toBe("applied");
	});

	test("load開始後の失敗は適用結果未確認になり、未適用と混ざらない", () => {
		expect(
			classifyBatchItem(item({ status: "failed", applyEffect: "unknown" })),
		).toBe("unconfirmed");
		// 未開始・対象外・load前停止はすべて未適用
		expect(
			classifyBatchItem(
				item({ status: "skipped", applyEffect: "not_applied" }),
			),
		).toBe("notApplied");
		expect(
			classifyBatchItem(item({ status: "excluded", applyEffect: null })),
		).toBe("notApplied");
		expect(
			classifyBatchItem(
				item({
					status: "failed",
					applyEffect: "not_applied",
					failureCode: "prepared_config_changed",
				}),
			),
		).toBe("notApplied");
	});

	test("停止後の集計で3群が同時に数えられる", () => {
		const summary = summarizeBatch(
			batch([
				item({ id: "a", status: "applied", applyEffect: "confirmed" }),
				item({
					id: "b",
					status: "failed",
					applyEffect: "unknown",
					failureCode: "verify_timeout",
				}),
				item({
					id: "c",
					status: "skipped",
					applyEffect: "not_applied",
					failureCode: "batch_stopped",
				}),
			]),
		);
		expect(summary).toMatchObject({
			done: 3,
			total: 3,
			applied: 1,
			notApplied: 1,
			unconfirmed: 1,
		});
	});

	test("未適用の内訳はload前停止と未開始・対象外を区別する", () => {
		expect(notAppliedReason(item({ status: "skipped" }))).toBe("未開始");
		expect(notAppliedReason(item({ status: "excluded" }))).toBe("計画で対象外");
		expect(notAppliedReason(item({ status: "no_change" }))).toBe(
			"差分なしのため未実行",
		);
		expect(
			notAppliedReason(
				item({ status: "failed", failureCode: "prepared_config_changed" }),
			),
		).toContain("load前に停止");
	});
});

describe("計画確認の可否", () => {
	test("検証NGが1件でもあれば実行に進めない", () => {
		const blocked = batch(
			[
				item({
					id: "a",
					status: "prepared",
					plan: {
						changed: true,
						addedLines: 1,
						removedLines: 0,
						risks: [],
						validation: {
							valid: false,
							code: "target_invalid",
							model: { expected: "RTX830", actual: "RTX830", valid: true },
							firmware: { expected: null, actual: null, valid: null },
							lineCount: { actual: 10, maximum: 2000, valid: true },
							sizeBytes: { actual: 100, maximum: 1048576, valid: true },
							supervisorAutostart: { present: false, valid: true },
						},
					},
				}),
			],
			"awaiting_confirmation",
		);
		expect(planBlockers(blocked)).toHaveLength(1);
	});

	test("全台準備済みならblockしない", () => {
		const ok = batch(
			[
				item({
					id: "a",
					status: "prepared",
					plan: {
						changed: false,
						addedLines: 0,
						removedLines: 0,
						risks: [],
						validation: {
							valid: true,
							code: null,
							model: { expected: "RTX830", actual: "RTX830", valid: true },
							firmware: { expected: null, actual: null, valid: null },
							lineCount: { actual: 10, maximum: 2000, valid: true },
							sizeBytes: { actual: 100, maximum: 1048576, valid: true },
							supervisorAutostart: { present: false, valid: true },
						},
					},
				}),
			],
			"awaiting_confirmation",
		);
		expect(planBlockers(ok)).toEqual([]);
	});
});

describe("Batch状態の判定", () => {
	test("進行中の4状態だけpoll対象になる", () => {
		for (const status of [
			"preparing",
			"awaiting_confirmation",
			"running",
			"stopping",
		] as const) {
			expect(isBatchActive(batch([], status))).toBe(true);
		}
		expect(isBatchActive(batch([], "stopped"))).toBe(false);
		expect(isBatchActive(batch([], "complete"))).toBe(false);
	});

	test("未知の失敗コードはraw表示になる", () => {
		expect(failureLabel("admin_stopped")).toBe("Adminが停止");
		expect(failureLabel("mystery_code")).toBe("mystery_code");
		expect(failureLabel(null)).toBe("");
	});
});

function validPlan(
	overrides: Partial<ConfigApplyBatchPlan> = {},
): ConfigApplyBatchPlan {
	return {
		changed: true,
		addedLines: 3,
		removedLines: 1,
		risks: [],
		validation: {
			valid: true,
			code: null,
			model: { expected: "RTX830", actual: "RTX830", valid: true },
			firmware: { expected: null, actual: null, valid: null },
			lineCount: { actual: 10, maximum: 2000, valid: true },
			sizeBytes: { actual: 100, maximum: 1048576, valid: true },
			supervisorAutostart: { present: false, valid: true },
		},
		...overrides,
	};
}

const noop = () => {};

describe("画面の表示内容", () => {
	test("停止後は3群が同時に区別でき、未確認が未適用と混ざらない", () => {
		const stopped = batch(
			[
				item({
					id: "a",
					sequence: 0,
					deviceName: "applied-device",
					status: "applied",
					applyEffect: "confirmed",
					saveResult: "confirmed",
				}),
				item({
					id: "b",
					sequence: 1,
					deviceName: "unconfirmed-device",
					status: "failed",
					applyEffect: "unknown",
					failureCode: "verify_timeout",
				}),
				item({
					id: "c",
					sequence: 2,
					deviceName: "queued-device",
					status: "skipped",
					applyEffect: "not_applied",
					failureCode: "batch_stopped",
				}),
			],
			"stopped",
		);
		const html = renderToStaticMarkup(
			ResultView({ batch: stopped, items: stopped.items, targetAt: {} }),
		);
		expect(html).toContain("適用確認済み (1台)");
		expect(html).toContain("未適用 (1台)");
		expect(html).toContain("適用結果未確認 (1台)");
		// 未確認Deviceは未確認の節に出て、未適用の節には出ない
		const unconfirmedSection = html.indexOf("適用結果未確認 (1台)");
		const notAppliedSection = html.indexOf("未適用 (1台)");
		expect(unconfirmedSection).toBeGreaterThan(-1);
		expect(notAppliedSection).toBeGreaterThan(-1);
		expect(
			html.slice(unconfirmedSection),
			"未確認の節に未確認Deviceが出る",
		).toContain("unconfirmed-device");
		expect(
			html.slice(notAppliedSection, unconfirmedSection),
			"未適用の節に未確認Deviceは出ない",
		).not.toContain("unconfirmed-device");
		// 停止理由と回復範囲が出て、再試行の導線は無い
		expect(html).toContain("apply_verify");
		expect(html).toContain("遠隔から戻せない条件があります");
		expect(html).not.toContain("再試行");
		expect(html).not.toContain("再開");
		expect(html).not.toContain("自動継続");
	});

	test("計画確認は全台・差分・検証・高リスクを1画面に出す", () => {
		const planning = batch(
			[
				item({
					id: "a",
					sequence: 0,
					deviceName: "risky-device",
					status: "prepared",
					plan: validPlan({ risks: ["wan", "pppoe"] }),
					preparedBackupId: "prep-1",
				}),
				item({
					id: "b",
					sequence: 1,
					deviceName: "same-device",
					status: "no_change",
					plan: validPlan({ changed: false, addedLines: 0, removedLines: 0 }),
					preparedBackupId: "prep-2",
				}),
			],
			"awaiting_confirmation",
		);
		const html = renderToStaticMarkup(
			PlanView({
				batch: planning,
				items: planning.items,
				targetAt: {},
				planSelected: { a: true, b: true },
				acting: false,
				acknowledged: false,
				onAcknowledged: noop,
				onMove: noop,
				onToggleSelected: noop,
				onSavePlan: noop,
				onConfirm: noop,
				onConfirmItem: noop,
				onStop: noop,
				onRefresh: noop,
			}),
		);
		expect(html).toContain("risky-device");
		expect(html).toContain("same-device");
		expect(html).toContain("+3行 / -1行");
		expect(html).toContain("差分なし");
		expect(html).toContain("高リスクあり");
		expect(html).toContain("確認は1回です");
		expect(html).toContain("遠隔から戻せない条件があります");
	});

	test("実行中は進捗と件数と保存待ちが出る", () => {
		const running = batch(
			[
				item({
					id: "a",
					sequence: 0,
					deviceName: "done-device",
					status: "applied",
					applyEffect: "confirmed",
					saveResult: "pending",
				}),
				item({
					id: "b",
					sequence: 1,
					deviceName: "busy-device",
					status: "applying",
				}),
				item({
					id: "c",
					sequence: 2,
					deviceName: "wait-device",
					status: "queued",
				}),
			],
			"running",
			true,
		);
		const html = renderToStaticMarkup(
			ExecutionView({
				batch: running,
				items: running.items,
				acting: false,
				onConfirmItem: noop,
				onStop: noop,
				onRefresh: noop,
			}),
		);
		expect(html).toContain("順次実行中");
		expect(html).toContain("適用確認済み");
		expect(html).toContain("適用結果未確認");
		expect(html).toContain("保存待ち");
		expect(html).not.toContain("再試行");
	});
});

describe("単体Apply拒否の判定", () => {
	test("Batch競合の409だけをBatch導線にする", () => {
		expect(
			isBatchActiveError(
				new ApiError(409, "busy", "config_apply_batch_active", "batch-1"),
			),
		).toBe(true);
		expect(isBatchActiveError(new ApiError(409, "busy"))).toBe(false);
		expect(
			isBatchActiveError(
				new ApiError(409, "busy", "config_apply_batch_active", null),
			),
		).toBe(false);
		expect(isBatchActiveError(new Error("nope"))).toBe(false);
	});
});

describe("POレビューの手直し(#125)", () => {
	function planningBatch() {
		return batch(
			[
				item({
					id: "a",
					sequence: 0,
					deviceName: "value-device",
					status: "prepared",
					plan: validPlan({
						validation: {
							valid: true,
							code: null,
							model: { expected: "RTX830", actual: "RTX830", valid: true },
							firmware: {
								expected: "15.02.30",
								actual: "15.02.30",
								valid: true,
							},
							lineCount: { actual: 7, maximum: 1999, valid: true },
							sizeBytes: { actual: 184, maximum: 1048576, valid: true },
							supervisorAutostart: { present: true, valid: true },
						},
					}),
					preparedBackupId: "prep-1",
				}),
				item({
					id: "b",
					sequence: 1,
					deviceName: "ng-device",
					status: "prepared",
					plan: validPlan({
						validation: {
							valid: false,
							code: "target_invalid",
							model: { expected: "RTX830", actual: "RTX820", valid: false },
							firmware: {
								expected: "15.02.30",
								actual: "15.02.30",
								valid: true,
							},
							lineCount: { actual: 7, maximum: 1999, valid: true },
							sizeBytes: { actual: 184, maximum: 1048576, valid: true },
							supervisorAutostart: { present: false, valid: true },
						},
					}),
					preparedBackupId: "prep-2",
				}),
			],
			"awaiting_confirmation",
		);
	}

	function planHtml() {
		const planning = planningBatch();
		return renderToStaticMarkup(
			PlanView({
				batch: planning,
				items: planning.items,
				targetAt: {},
				planSelected: { a: true, b: true },
				acting: false,
				acknowledged: false,
				onAcknowledged: noop,
				onMove: noop,
				onToggleSelected: noop,
				onSavePlan: noop,
				onConfirm: noop,
				onConfirmItem: noop,
				onStop: noop,
				onRefresh: noop,
			}),
		);
	}

	test("計画確認に検証の値(対象と実機・上限)が出てOK/NGバッジも残る", () => {
		const html = planHtml();
		expect(html).toContain("対象 RTX830 / 実機 RTX830");
		expect(html).toContain("対象 15.02.30 / 実機 15.02.30");
		expect(html).toContain("7 / 1999");
		expect(html).toContain("184 B / 1024.0 KiB");
		expect(html).toContain("自動起動 あり");
		expect(html).toContain("自動起動 なし");
		// NGの行は値とNGバッジが並ぶ
		expect(html).toContain("対象 RTX830 / 実機 RTX820");
		expect(html).toContain("NG");
		expect(html).toContain("OK");
	});

	test("未適用の未開始はバッジと文言で二重に出ない", () => {
		const stopped = batch(
			[
				item({
					id: "c",
					sequence: 0,
					deviceName: "queued-device",
					status: "skipped",
					applyEffect: "not_applied",
					failureCode: "batch_stopped",
				}),
			],
			"stopped",
		);
		const html = renderToStaticMarkup(
			ResultView({ batch: stopped, items: stopped.items, targetAt: {} }),
		);
		// 要素文言としての「未開始」はバッジの1回だけ。理由欄の
		// 「Batchの停止により未開始」は別の説明なので数えない。
		expect(html.split(">未開始<")).toHaveLength(2);
	});

	test("適用結果未確認の行に適用した世代(日時とhash)が出る", () => {
		const stopped = batch(
			[
				item({
					id: "b",
					sequence: 0,
					deviceName: "unconfirmed-device",
					status: "failed",
					applyEffect: "unknown",
					failureCode: "verify_timeout",
					targetBackupId: "target-backup-abcdef",
				}),
			],
			"stopped",
		);
		const html = renderToStaticMarkup(
			ResultView({
				batch: stopped,
				items: stopped.items,
				targetAt: { "target-backup-abcdef": "2026-09-25T00:00:00.000Z" },
			}),
		);
		const section = html.slice(html.indexOf("適用結果未確認 (1台)"));
		expect(section).toContain("unconfirmed-device");
		expect(section).toContain("target-b");
		expect(section).not.toContain("取得日時不明");
	});

	test("適用結果未確認は取得日時が引けなくてもhashを出す", () => {
		const stopped = batch(
			[
				item({
					id: "b",
					sequence: 0,
					deviceName: "unconfirmed-device",
					status: "failed",
					applyEffect: "unknown",
					failureCode: "verify_timeout",
					targetBackupId: "target-backup-abcdef",
				}),
			],
			"stopped",
		);
		const html = renderToStaticMarkup(
			ResultView({ batch: stopped, items: stopped.items, targetAt: {} }),
		);
		const section = html.slice(html.indexOf("適用結果未確認 (1台)"));
		expect(section).toContain("target-b");
	});

	test("計画確認と結果にrollback timerと出ない", () => {
		const planning = planningBatch();
		const plan = renderToStaticMarkup(
			PlanView({
				batch: planning,
				items: planning.items,
				targetAt: {},
				planSelected: { a: true, b: true },
				acting: false,
				acknowledged: false,
				onAcknowledged: noop,
				onMove: noop,
				onToggleSelected: noop,
				onSavePlan: noop,
				onConfirm: noop,
				onConfirmItem: noop,
				onStop: noop,
				onRefresh: noop,
			}),
		);
		const stopped = batch(
			[
				item({
					id: "b",
					sequence: 0,
					deviceName: "unconfirmed-device",
					status: "failed",
					applyEffect: "unknown",
					failureCode: "verify_timeout",
				}),
			],
			"stopped",
		);
		const result = renderToStaticMarkup(
			ResultView({ batch: stopped, items: stopped.items, targetAt: {} }),
		);
		expect(plan).not.toContain("rollback timer");
		expect(result).not.toContain("rollback timer");
	});
});
