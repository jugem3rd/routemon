import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { afterEach, expect, test, vi } from "vitest";
import {
	type HealthReport,
	HealthReporter,
	type HealthSink,
	HttpHealthSink,
} from "./healthReporter.ts";

class MemorySink implements HealthSink {
	reports: HealthReport[] = [];
	failing = false;
	delayMs = 0;
	async send(report: HealthReport): Promise<void> {
		if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));
		if (this.failing) throw new Error("sink down");
		this.reports.push(report);
	}
}

afterEach(() => {
	vi.useRealTimers();
});

test("報告にgatewayIdと、process、systemの状態を含める", async () => {
	const sink = new MemorySink();
	const reporter = new HealthReporter({
		gatewayId: "gw-01",
		version: "1.2.3",
		sink,
		now: () => Date.parse("2026-10-04T12:00:00Z"),
		startedAt: Date.parse("2026-10-04T11:59:00Z"),
	});
	expect(await reporter.report()).toBe(true);

	const report = sink.reports[0] as HealthReport;
	expect(report.gatewayId).toBe("gw-01");
	expect(report.version).toBe("1.2.3");
	expect(report.at).toBe("2026-10-04T12:00:00.000Z");
	expect(report.uptimeSeconds).toBe(60);
	expect(report.process.rssMB).toBeGreaterThan(0);
	expect(report.system.memoryTotalMB).toBeGreaterThan(0);
	expect(report.system.loadAverage1m).toBeGreaterThanOrEqual(0);
});

test("credentialキャッシュの更新の失敗が、報告から分かる", async () => {
	const sink = new MemorySink();
	const reporter = new HealthReporter({
		gatewayId: "gw-01",
		sink,
		providers: {
			credentialCache: () => ({
				entries: 12,
				version: "5",
				lastSuccessAt: Date.parse("2026-10-04T11:00:00Z"),
				lastError: "source down",
				consecutiveFailures: 7,
			}),
		},
	});
	await reporter.report();
	expect(sink.reports[0]?.credentialCache).toEqual({
		entries: 12,
		lastSuccessAt: "2026-10-04T11:00:00.000Z",
		consecutiveFailures: 7,
		lastError: "source down",
	});
});

test("providerの項目を含め、一度も成功していないキャッシュはlastSuccessAtがnull", async () => {
	const sink = new MemorySink();
	const reporter = new HealthReporter({
		gatewayId: "gw-01",
		sink,
		providers: {
			agentListening: () => true,
			devices: () => ({ online: 3, unstable: 1, offline: 0 }),
			spool: () => ({ bytes: 4096, droppedSegments: 2 }),
			credentialCache: () => ({
				entries: 0,
				version: null,
				lastSuccessAt: null,
				lastError: null,
				consecutiveFailures: 0,
			}),
			diskPath: tmpdir(),
		},
	});
	await reporter.report();
	const report = sink.reports[0] as HealthReport;
	expect(report.agentListener).toEqual({ listening: true });
	expect(report.devices).toEqual({ online: 3, unstable: 1, offline: 0 });
	expect(report.spool).toEqual({ bytes: 4096, droppedSegments: 2 });
	expect(report.credentialCache?.lastSuccessAt).toBeNull();
	expect(report.system.diskTotalMB).toBeGreaterThan(0);
	expect(report.system.diskFreeMB).toBeGreaterThanOrEqual(0);
});

test("取得できないproviderの項目は省略し、報告そのものは送る", async () => {
	const sink = new MemorySink();
	const reporter = new HealthReporter({
		gatewayId: "gw-01",
		sink,
		providers: {
			spool: () => {
				throw new Error("spool unavailable");
			},
			diskPath: "/nonexistent/path/for/test",
		},
	});
	expect(await reporter.report()).toBe(true);
	const report = sink.reports[0] as HealthReport;
	expect(report.spool).toBeUndefined();
	expect(report.system.diskTotalMB).toBeUndefined();
});

test("送信が失敗しても投げず、falseを返し、復旧したらtrueに戻る", async () => {
	const sink = new MemorySink();
	const warnings: string[] = [];
	const infos: string[] = [];
	const reporter = new HealthReporter({
		gatewayId: "gw-01",
		sink,
		logger: { info: (m) => infos.push(m), warn: (m) => warnings.push(m) },
	});
	sink.failing = true;
	expect(await reporter.report()).toBe(false);
	expect(await reporter.report()).toBe(false);
	expect(warnings).toHaveLength(2);

	sink.failing = false;
	expect(await reporter.report()).toBe(true);
	expect(infos[0]).toContain("recovered after 2 failures");
});

test("前回の送信が終わっていなければ、重ねて送らない", async () => {
	const sink = new MemorySink();
	sink.delayMs = 50;
	const reporter = new HealthReporter({ gatewayId: "gw-01", sink });
	const results = await Promise.all([reporter.report(), reporter.report()]);
	expect(results.filter(Boolean)).toHaveLength(1);
	expect(sink.reports).toHaveLength(1);
});

test("start()はすぐに1回送り、以降は一定間隔で送り、stop()で止まる", async () => {
	vi.useFakeTimers();
	const sink = new MemorySink();
	const reporter = new HealthReporter({
		gatewayId: "gw-01",
		sink,
		intervalMs: 60_000,
	});
	reporter.start();
	await vi.advanceTimersByTimeAsync(0);
	expect(sink.reports).toHaveLength(1);

	await vi.advanceTimersByTimeAsync(60_000);
	expect(sink.reports).toHaveLength(2);
	await vi.advanceTimersByTimeAsync(60_000);
	expect(sink.reports).toHaveLength(3);

	reporter.stop();
	await vi.advanceTimersByTimeAsync(180_000);
	expect(sink.reports).toHaveLength(3);
});

test("HttpHealthSinkは、Bearerのcredentialを付けてJSONをPOSTする", async () => {
	const received: { auth?: string; body: string; type?: string }[] = [];
	const server = createServer((req, res) => {
		let body = "";
		req.on("data", (chunk) => {
			body += chunk;
		});
		req.on("end", () => {
			received.push({
				auth: req.headers.authorization,
				type: req.headers["content-type"],
				body,
			});
			res.writeHead(req.url === "/reject" ? 401 : 204).end();
		});
	});
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	try {
		const reporter = new HealthReporter({
			gatewayId: "gw-01",
			sink: new HttpHealthSink({
				url: `${base}/health`,
				credential: "gw-secret",
			}),
		});
		expect(await reporter.report()).toBe(true);
		expect(received[0]?.auth).toBe("Bearer gw-secret");
		expect(received[0]?.type).toBe("application/json");
		expect(JSON.parse(received[0]?.body ?? "{}").gatewayId).toBe("gw-01");

		// 送信先が拒否したら、失敗として扱う
		const rejected = new HealthReporter({
			gatewayId: "gw-01",
			sink: new HttpHealthSink({ url: `${base}/reject`, credential: "wrong" }),
		});
		expect(await rejected.report()).toBe(false);
	} finally {
		await new Promise<void>((r) => server.close(() => r()));
	}
});

test("HttpHealthSinkは、届かない送信先を失敗として扱う", async () => {
	const reporter = new HealthReporter({
		gatewayId: "gw-01",
		sink: new HttpHealthSink({
			url: "http://127.0.0.1:1/health",
			credential: "x",
			timeoutMs: 500,
		}),
	});
	expect(await reporter.report()).toBe(false);
});
