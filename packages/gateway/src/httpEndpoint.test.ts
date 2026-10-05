import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { MemoryDeviceStore } from "./deviceStore.ts";
import { AgentGateway } from "./gateway.ts";
import { createAgentEndpoint } from "./httpEndpoint.ts";

let root: string;
let baseUrl: string;
let server: ReturnType<typeof createAgentEndpoint>;

beforeEach(async () => {
	root = mkdtempSync(join(tmpdir(), "routemon-releases-"));
	const artifact = "local VERSION = '1.2.3'\n-- agent";
	writeFileSync(join(root, "stable.lua"), artifact);
	writeFileSync(join(root, "1.2.3.lua"), artifact);
	const store = new MemoryDeviceStore();
	store.add("device-1", "test-token");
	server = createAgentEndpoint({
		gateway: new AgentGateway({ store }),
		releases: {
			dir: root,
			resolveCredential: async (credential) =>
				credential === "test-token" ? "device-1" : null,
		},
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address() as AddressInfo;
	baseUrl = `http://127.0.0.1:${address.port}`;
});

afterEach(async () => {
	await new Promise<void>((resolve, reject) =>
		server.close((error) => (error ? reject(error) : resolve())),
	);
	rmSync(root, { recursive: true, force: true });
});

test("stable manifestはAgent artifactの実versionを返す", async () => {
	const artifactResponse = await fetch(`${baseUrl}/v1/agent/releases/stable`, {
		headers: { authorization: "Bearer test-token" },
	});
	const artifact = await artifactResponse.text();
	expect(artifactResponse.status).toBe(200);

	const manifestResponse = await fetch(
		`${baseUrl}/v1/agent/releases/stable/manifest`,
		{ headers: { authorization: "Bearer test-token" } },
	);
	const manifest = (await manifestResponse.json()) as {
		version: string;
		size: number;
		content_hash: string;
	};
	expect(manifestResponse.status).toBe(200);
	expect(manifest).toEqual({
		version: "1.2.3",
		size: Buffer.byteLength(artifact),
		content_hash: createHash("sha256").update(artifact).digest("hex"),
	});
});

test("stable aliasはAdminのversion release一覧に出す実versionへ解決できる", async () => {
	const response = await fetch(`${baseUrl}/v1/agent/releases/1.2.3/manifest`, {
		headers: { authorization: "Bearer test-token" },
	});
	expect(response.status).toBe(200);
	expect(await response.json()).toMatchObject({ version: "1.2.3" });
});

test("stable artifactにAgent versionが無ければ配布を拒否する", async () => {
	writeFileSync(join(root, "stable.lua"), "-- version missing");
	const response = await fetch(`${baseUrl}/v1/agent/releases/stable/manifest`, {
		headers: { authorization: "Bearer test-token" },
	});
	expect(response.status).toBe(500);
});
