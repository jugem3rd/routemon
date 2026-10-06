import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	AgentGateway,
	createAgentEndpoint,
	MemoryDeviceStore,
} from "@routemon/gateway";
import { afterEach, beforeEach, expect, test } from "vitest";
import {
	compareVersions,
	installBundledAgent,
	readAgentVersion,
} from "./bundledAgent.ts";

let dir: string;
let releaseDir: string;
let sourcePath: string;

function agentSource(version: string, body = "") {
	return `-- agent\nlocal VERSION = '${version}'\n${body}\n`;
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "routemon-bundled-"));
	releaseDir = join(dir, "releases");
	mkdirSync(releaseDir, { recursive: true });
	sourcePath = join(dir, "https_tunnel_agent.lua");
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

test("空のrelease directoryへ、stable.luaと<version>.luaを置く", () => {
	writeFileSync(sourcePath, agentSource("0.3.0"));
	const result = installBundledAgent({ sourcePath, releaseDir });
	expect(result).toMatchObject({
		version: "0.3.0",
		releaseWritten: true,
		stableWritten: true,
		previousStable: null,
	});
	expect(readFileSync(join(releaseDir, "stable.lua"), "utf8")).toBe(
		agentSource("0.3.0"),
	);
	expect(readFileSync(join(releaseDir, "0.3.0.lua"), "utf8")).toBe(
		agentSource("0.3.0"),
	);
	// 一時fileを残さない
	expect(readdirSync(releaseDir).sort()).toEqual(["0.3.0.lua", "stable.lua"]);
});

test("再起動しても、配置済みのartifactを変えない", () => {
	writeFileSync(sourcePath, agentSource("0.3.0"));
	installBundledAgent({ sourcePath, releaseDir });
	const result = installBundledAgent({ sourcePath, releaseDir });
	expect(result.releaseWritten).toBe(false);
	expect(result.stableWritten).toBe(false);
});

test("同梱のAgentが新しいときだけstableを更新し、他のversionには触らない", () => {
	const admin = agentSource("0.2.5", "-- admin");
	writeFileSync(join(releaseDir, "0.2.5.lua"), admin);
	writeFileSync(join(releaseDir, "stable.lua"), admin);

	writeFileSync(sourcePath, agentSource("0.3.0"));
	const result = installBundledAgent({ sourcePath, releaseDir });
	expect(result).toMatchObject({
		stableWritten: true,
		previousStable: "0.2.5",
	});
	expect(
		readAgentVersion(readFileSync(join(releaseDir, "stable.lua"), "utf8")),
	).toBe("0.3.0");
	expect(readFileSync(join(releaseDir, "0.2.5.lua"), "utf8")).toBe(admin);
});

test("置いてあるstableが同じか新しいときは、stableを変えない", () => {
	const newer = agentSource("0.10.0", "-- admin");
	writeFileSync(join(releaseDir, "stable.lua"), newer);
	writeFileSync(sourcePath, agentSource("0.9.0"));
	const result = installBundledAgent({ sourcePath, releaseDir });
	expect(result.stableWritten).toBe(false);
	expect(result.releaseWritten).toBe(true);
	expect(readFileSync(join(releaseDir, "stable.lua"), "utf8")).toBe(newer);
});

test("同じversionの<version>.luaが有れば、上書きしない", () => {
	const admin = agentSource("0.3.0", "-- customized");
	writeFileSync(join(releaseDir, "0.3.0.lua"), admin);
	writeFileSync(sourcePath, agentSource("0.3.0"));
	const result = installBundledAgent({ sourcePath, releaseDir });
	expect(result.releaseWritten).toBe(false);
	expect(readFileSync(join(releaseDir, "0.3.0.lua"), "utf8")).toBe(admin);
});

test("versionが読めないstableは、置き換える", () => {
	writeFileSync(join(releaseDir, "stable.lua"), "broken");
	writeFileSync(sourcePath, agentSource("0.3.0"));
	const result = installBundledAgent({ sourcePath, releaseDir });
	expect(result).toMatchObject({ stableWritten: true, previousStable: null });
	expect(
		readAgentVersion(readFileSync(join(releaseDir, "stable.lua"), "utf8")),
	).toBe("0.3.0");
});

test("同梱のAgentが無い、またはversion宣言が読めないときは失敗する", () => {
	expect(() => installBundledAgent({ sourcePath, releaseDir })).toThrow(
		/not found/,
	);
	writeFileSync(sourcePath, "print('no version')");
	expect(() => installBundledAgent({ sourcePath, releaseDir })).toThrow(
		/no version declaration/,
	);
	expect(existsSync(join(releaseDir, "stable.lua"))).toBe(false);
});

test("versionは数字ごとに比べる", () => {
	expect(compareVersions("0.10.0", "0.9.0")).toBe(1);
	expect(compareVersions("0.3.0", "0.3.0")).toBe(0);
	expect(compareVersions("0.3", "0.3.1")).toBe(-1);
});

test("リポジトリのAgentを空のdirへ置くと、Gatewayがstableのmanifestとartifactを返す(#2)", async () => {
	const realAgent = join(
		import.meta.dirname,
		"../../../../agent/https_tunnel_agent.lua",
	);
	const { version } = installBundledAgent({
		sourcePath: realAgent,
		releaseDir,
	});
	const store = new MemoryDeviceStore();
	store.add("device-1", "test-token");
	const server = createAgentEndpoint({
		gateway: new AgentGateway({ store }),
		releases: {
			dir: releaseDir,
			resolveCredential: async (credential) =>
				credential === "test-token" ? "device-1" : null,
		},
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	try {
		const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
		const headers = { authorization: "Bearer test-token" };
		const manifest = await fetch(
			`${baseUrl}/v1/agent/releases/stable/manifest`,
			{ headers },
		);
		expect(manifest.status).toBe(200);
		expect(((await manifest.json()) as { version: string }).version).toBe(
			version,
		);
		const artifact = await fetch(`${baseUrl}/v1/agent/releases/stable`, {
			headers,
		});
		expect(artifact.status).toBe(200);
		expect(await artifact.text()).toBe(readFileSync(realAgent, "utf8"));
	} finally {
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
});
