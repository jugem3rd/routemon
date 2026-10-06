import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import type {
	DeviceProfile,
	DeviceRouteSnapshot,
	DeviceRoutes,
	ObservedRoute,
} from "../api.ts";
import { formatTime } from "../ui.tsx";
import {
	formatEventDetail,
	OBSERVED_STALE_MS,
	ObservedFamilySection,
	RoutesView,
} from "./DeviceDetail.tsx";

const noop = () => {};

function profile(overrides: Partial<DeviceProfile> = {}): DeviceProfile {
	return {
		internet: {},
		lan: [],
		tunnels: [],
		routes: [
			{
				destination: "198.51.100.0/24",
				gateway: { kind: "tunnel", value: "tunnel 1" },
				tunnel: 1,
			},
		],
		ipsecTunnels: [],
		capturedAt: "2026-09-25T10:00:00.000Z",
		...overrides,
	};
}

function observedRoute(overrides: Partial<ObservedRoute> = {}): ObservedRoute {
	return {
		family: "ipv4",
		destination: "192.0.2.0/24",
		gateway: "192.0.2.1",
		interface: "LAN1",
		rawType: "static",
		category: "static",
		...overrides,
	};
}

function snapshot(
	overrides: Partial<DeviceRouteSnapshot> = {},
): DeviceRouteSnapshot {
	return {
		capturedAt: new Date().toISOString(),
		changedAt: new Date().toISOString(),
		lastAttemptAt: new Date().toISOString(),
		lastAttemptStatus: "complete",
		routes: [],
		unparsedLines: [],
		...overrides,
	};
}

function routesViewProps(
	overrides: Partial<Parameters<typeof RoutesView>[0]> = {},
) {
	return {
		profile: profile(),
		profileLoading: false,
		profileError: null,
		routes: { ipv4: null, ipv6: null } as DeviceRoutes,
		routesLoading: false,
		routesError: null,
		role: "admin" as const,
		refreshing: false,
		refreshError: null,
		onRefresh: noop,
		...overrides,
	};
}

describe("Observed familyの状態表示", () => {
	test("未取得はfamilyごとに「未取得」になる", () => {
		const html = renderToStaticMarkup(
			ObservedFamilySection({ family: "ipv4", snapshot: null }),
		);
		expect(html).toContain("未取得");
		expect(html).not.toContain("経路なし");
	});

	test("取得済みで空なら「経路なし」になる", () => {
		const html = renderToStaticMarkup(
			ObservedFamilySection({ family: "ipv6", snapshot: snapshot() }),
		);
		expect(html).toContain("経路なし");
		expect(html).not.toContain("未取得");
	});

	test("通常は行と分類badgeと取得日時が出る", () => {
		const html = renderToStaticMarkup(
			ObservedFamilySection({
				family: "ipv4",
				snapshot: snapshot({
					routes: [
						observedRoute({ destination: "default" }),
						observedRoute({
							destination: "203.0.113.0/24",
							gateway: "203.0.113.1",
							interface: "TUNNEL[1]",
							rawType: "OSPF",
							category: "dynamic",
							protocol: "OSPF",
							cost: 10,
							rawDetails: "cost=10",
						}),
					],
				}),
			}),
		);
		expect(html).toContain("default");
		expect(html).toContain("203.0.113.0/24");
		expect(html).toContain("static");
		expect(html).toContain("OSPF");
		expect(html).toContain("cost=10");
		expect(html).toContain("最終取得:");
	});

	test("partialは警告と未解析行が出る", () => {
		const html = renderToStaticMarkup(
			ObservedFamilySection({
				family: "ipv4",
				snapshot: snapshot({
					lastAttemptStatus: "partial",
					routes: [observedRoute()],
					unparsedLines: ["192.0.2.0/24 ??? broken-row"],
				}),
			}),
		);
		expect(html).toContain("一部の行を解析できません");
		expect(html).toContain("192.0.2.0/24 ??? broken-row");
		// 解析できた行も残る
		expect(html).toContain("192.0.2.0/24");
	});

	test("前回取得失敗は前回内容と警告が出る", () => {
		const html = renderToStaticMarkup(
			ObservedFamilySection({
				family: "ipv4",
				snapshot: snapshot({
					lastAttemptStatus: "failed",
					routes: [observedRoute({ destination: "198.51.100.0/24" })],
				}),
			}),
		);
		expect(html).toContain("前回取得に失敗しました");
		expect(html).toContain("198.51.100.0/24");
	});

	test("成功snapshotが無い失敗は取得なしと失敗が出る", () => {
		const html = renderToStaticMarkup(
			ObservedFamilySection({
				family: "ipv4",
				snapshot: snapshot({
					capturedAt: null,
					changedAt: null,
					lastAttemptStatus: "failed",
					routes: [],
				}),
			}),
		);
		expect(html).toContain("前回取得に失敗しました");
		expect(html).not.toContain("経路なし");
	});

	test("24時間より古い観測は「古い観測」になる", () => {
		const old = new Date(Date.now() - OBSERVED_STALE_MS - 1000).toISOString();
		const html = renderToStaticMarkup(
			ObservedFamilySection({
				family: "ipv4",
				snapshot: snapshot({
					capturedAt: old,
					lastAttemptAt: old,
					routes: [observedRoute()],
				}),
			}),
		);
		expect(html).toContain("古い観測");
	});

	test("24時間以内は「古い観測」にならない", () => {
		const html = renderToStaticMarkup(
			ObservedFamilySection({
				family: "ipv4",
				snapshot: snapshot({ routes: [observedRoute()] }),
			}),
		);
		expect(html).not.toContain("古い観測");
	});
});

describe("経路タブ全体", () => {
	test("Adminには「再取得」が出てViewerには出ない", () => {
		const adminHtml = renderToStaticMarkup(
			RoutesView(routesViewProps({ role: "admin" })),
		);
		expect(adminHtml).toContain("再取得");

		const viewerHtml = renderToStaticMarkup(
			RoutesView(routesViewProps({ role: "viewer" })),
		);
		expect(viewerHtml).not.toContain("再取得");
	});

	test("再取得中はボタンが変わる", () => {
		const html = renderToStaticMarkup(
			RoutesView(routesViewProps({ refreshing: true })),
		);
		expect(html).toContain("再取得中");
	});

	test("IPv4とIPv6は別々に状態と取得日時を持つ", () => {
		const ipv4At = new Date().toISOString();
		const html = renderToStaticMarkup(
			RoutesView(
				routesViewProps({
					routes: {
						ipv4: snapshot({
							capturedAt: ipv4At,
							lastAttemptAt: ipv4At,
							routes: [observedRoute({ destination: "192.0.2.0/24" })],
						}),
						ipv6: snapshot({
							capturedAt: null,
							changedAt: null,
							lastAttemptStatus: "failed",
							routes: [],
						}),
					},
				}),
			),
		);
		// IPv4は表、IPv6は失敗表示
		expect(html).toContain("192.0.2.0/24");
		expect(html).toContain("前回取得に失敗しました");
		const ipv4Section = html.indexOf('aria-label="Observed IPv4"');
		const ipv6Section = html.indexOf('aria-label="Observed IPv6"');
		expect(ipv4Section).toBeGreaterThan(-1);
		expect(ipv6Section).toBeGreaterThan(ipv4Section);
		expect(html.slice(ipv4Section, ipv6Section)).toContain("192.0.2.0/24");
		expect(html.slice(ipv6Section)).toContain("前回取得に失敗しました");
	});

	test("ConfiguredとObservedは別の表で、一致判定をしない", () => {
		const html = renderToStaticMarkup(
			RoutesView(
				routesViewProps({
					routes: {
						ipv4: snapshot({ routes: [observedRoute()] }),
						ipv6: snapshot(),
					},
				}),
			),
		);
		expect(html).toContain("Configured");
		expect(html).toContain("Observed");
		// Configuredの説明は設定値、Observedは取得日時点の経路表
		expect(html).toContain("CONFIGに書かれた設定値");
		expect(html).toContain("一致・不一致の判定はしません");
		expect(html).not.toContain("実際の経路表ではなく");
	});

	test("Profile未取得は「CONFIG未取得」になる", () => {
		const html = renderToStaticMarkup(
			RoutesView(routesViewProps({ profile: null })),
		);
		expect(html).toContain("CONFIG未取得");
	});

	test("ProfileがあるときConfiguredに「CONFIG取得:」が出る", () => {
		const configured = profile();
		const html = renderToStaticMarkup(
			RoutesView(routesViewProps({ profile: configured })),
		);
		expect(html).toContain("CONFIG取得:");
		expect(html).toContain(formatTime(configured.capturedAt));
	});

	test("静的経路が0件でもProfileがあれば「CONFIG取得:」が出る", () => {
		const configured = profile({ routes: [] });
		const html = renderToStaticMarkup(
			RoutesView(routesViewProps({ profile: configured })),
		);
		expect(html).toContain("設定された静的経路はありません");
		expect(html).toContain("CONFIG取得:");
		expect(html).toContain(formatTime(configured.capturedAt));
	});

	test("Profileが無いときは「CONFIG取得:」が出ない", () => {
		const html = renderToStaticMarkup(
			RoutesView(routesViewProps({ profile: null })),
		);
		expect(html).not.toContain("CONFIG取得:");
	});

	test("IPv6の経路も表に出る", () => {
		const html = renderToStaticMarkup(
			RoutesView(
				routesViewProps({
					routes: {
						ipv4: snapshot(),
						ipv6: snapshot({
							routes: [
								observedRoute({
									family: "ipv6",
									destination: "2001:db8::/32",
									gateway: null,
									interface: "LAN1",
									rawType: "implicit",
									category: "implicit",
								}),
							],
						}),
					},
				}),
			),
		);
		expect(html).toContain("2001:db8::/32");
		expect(html).toContain("implicit");
	});
});

describe("イベントの内容の表示", () => {
	test("PPPの切断は、PP番号と理由を出す", () => {
		expect(
			formatEventDetail("ppp.down", {
				pp: 1,
				cause: "PPP: Authentication failed",
			}),
		).toBe("PP 1 / PPP: Authentication failed");
		expect(formatEventDetail("ppp.up", { pp: 2 })).toBe("PP 2");
	});

	test("Tunnelは番号、IPアドレスの変更は前後の値を出す", () => {
		expect(formatEventDetail("tunnel.down", { tunnel: 3 })).toBe("Tunnel 3");
		expect(
			formatEventDetail("ip.changed", {
				pp: 1,
				from: "203.0.113.1",
				to: "203.0.113.99",
			}),
		).toBe("PP 1 / 203.0.113.1 → 203.0.113.99");
	});

	test("フラッピングは、対象と回数・時間を出す", () => {
		expect(
			formatEventDetail("event.flapping", {
				target: "ppp:1",
				transitions: 5,
				window_seconds: 600,
			}),
		).toBe("ppp:1 / 600秒に5回以上");
	});

	test("detailが無い、または未知の種別でも壊れない", () => {
		expect(formatEventDetail("ppp.up", null)).toBe("");
		expect(formatEventDetail("something.new", { a: 1, b: "x" })).toBe(
			"a: 1, b: x",
		);
	});
});
