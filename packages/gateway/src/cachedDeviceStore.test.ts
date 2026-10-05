import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import {
	CachedDeviceStore,
	type CredentialChanges,
	type CredentialEntry,
	type CredentialSource,
} from "./cachedDeviceStore.ts";
import { hashCredential } from "./deviceStore.ts";

function entry(
	deviceId: string,
	token: string,
	revoked = false,
): CredentialEntry {
	return { credentialHash: hashCredential(token), deviceId, revoked };
}

/** 制御できる取得元 */
class FakeSource implements CredentialSource {
	entries = new Map<string, CredentialEntry>();
	version = 1;
	down = false;
	fetches: (string | null)[] = [];
	lookups: string[] = [];
	/** 次のfetchChangesが返す内容。無ければ全件 */
	next?: Partial<CredentialChanges>;
	lookupDelayMs = 0;

	add(e: CredentialEntry) {
		this.entries.set(e.credentialHash, e);
		this.version++;
	}

	async fetchChanges(since: string | null): Promise<CredentialChanges> {
		this.fetches.push(since);
		if (this.down) throw new Error("source down");
		const result: CredentialChanges = {
			version: String(this.version),
			full: true,
			entries: [...this.entries.values()],
			...this.next,
		};
		this.next = undefined;
		return result;
	}

	async lookup(credentialHash: string): Promise<CredentialEntry | null> {
		this.lookups.push(credentialHash);
		if (this.lookupDelayMs) {
			await new Promise((resolve) => setTimeout(resolve, this.lookupDelayMs));
		}
		if (this.down) throw new Error("source down");
		return this.entries.get(credentialHash) ?? null;
	}
}

let dir: string;
let source: FakeSource;
let now: number;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "routemon-credcache-"));
	source = new FakeSource();
	now = 1_000_000;
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

function makeStore(options: { persist?: boolean } = {}) {
	return new CachedDeviceStore({
		source,
		persistPath: options.persist ? join(dir, "credentials.json") : undefined,
		now: () => now,
	});
}

test("取得したcredentialは、取得元へ問い合わせずに確認できる", async () => {
	source.add(entry("dev-1", "tok-1"));
	const store = makeStore();
	expect(await store.refresh()).toBe(true);

	expect(await store.resolveCredential("tok-1")).toBe("dev-1");
	expect(source.lookups).toHaveLength(0);
});

test("取得元が止まっても、キャッシュにあるcredentialを確認し続ける", async () => {
	source.add(entry("dev-1", "tok-1"));
	const store = makeStore();
	await store.refresh();

	source.down = true;
	expect(await store.refresh()).toBe(false);
	now += 7 * 24 * 3600_000; // 時間では打ち切らない
	expect(await store.resolveCredential("tok-1")).toBe("dev-1");

	const status = store.status();
	expect(status.consecutiveFailures).toBe(1);
	expect(status.lastError).toBe("source down");
	expect(status.entries).toBe(1);
});

test("復旧後の差分で、失効したcredentialが拒否される", async () => {
	source.add(entry("dev-1", "tok-1"));
	const store = makeStore();
	await store.refresh();
	expect(await store.resolveCredential("tok-1")).toBe("dev-1");

	source.next = {
		version: "9",
		full: false,
		entries: [entry("dev-1", "tok-1", true)],
	};
	expect(await store.refresh()).toBe(true);
	expect(await store.resolveCredential("tok-1")).toBeNull();
	// 失効済みは、取得元へ問い合わせない
	expect(source.lookups).toHaveLength(0);
	expect(store.status().consecutiveFailures).toBe(0);
});

test("差分の取得には、前回のversionを渡す", async () => {
	source.add(entry("dev-1", "tok-1"));
	const store = makeStore();
	await store.refresh();
	await store.refresh();
	expect(source.fetches).toEqual([null, String(source.version)]);
});

test("全件の応答は、キャッシュを置き換える", async () => {
	source.add(entry("dev-1", "tok-1"));
	source.add(entry("dev-2", "tok-2"));
	const store = makeStore();
	await store.refresh();

	source.entries.delete(hashCredential("tok-2"));
	await store.refresh();
	expect(await store.resolveCredential("tok-1")).toBe("dev-1");
	expect(store.status().entries).toBe(1);
});

test("未知のTokenは、その場で取得元へ問い合わせ、以降はキャッシュから確認する", async () => {
	const store = makeStore();
	await store.refresh();
	source.add(entry("dev-9", "tok-new"));

	expect(await store.resolveCredential("tok-new")).toBe("dev-9");
	expect(await store.resolveCredential("tok-new")).toBe("dev-9");
	expect(source.lookups).toHaveLength(1);
});

test("無かったTokenは、30秒は再度問い合わせない", async () => {
	const store = makeStore();
	expect(await store.resolveCredential("tok-unknown")).toBeNull();
	expect(await store.resolveCredential("tok-unknown")).toBeNull();
	expect(source.lookups).toHaveLength(1);

	now += 31_000;
	source.add(entry("dev-9", "tok-unknown"));
	expect(await store.resolveCredential("tok-unknown")).toBe("dev-9");
	expect(source.lookups).toHaveLength(2);
});

test("同じTokenへの同時の問い合わせは、1回にまとめる", async () => {
	source.lookupDelayMs = 20;
	source.add(entry("dev-9", "tok-new"));
	const store = makeStore();
	const results = await Promise.all(
		Array.from({ length: 10 }, () => store.resolveCredential("tok-new")),
	);
	expect(results.every((r) => r === "dev-9")).toBe(true);
	expect(source.lookups).toHaveLength(1);
});

test("取得元に届かないときの問い合わせは拒否するが、すぐに再度問い合わせられる", async () => {
	source.add(entry("dev-9", "tok-new"));
	const store = makeStore();
	source.down = true;
	expect(await store.resolveCredential("tok-new")).toBeNull();

	source.down = false;
	expect(await store.resolveCredential("tok-new")).toBe("dev-9");
	expect(source.lookups).toHaveLength(2);
});

test("同時の取得は、1回にまとめる", async () => {
	source.add(entry("dev-1", "tok-1"));
	const store = makeStore();
	await Promise.all([store.refresh(), store.refresh(), store.refresh()]);
	expect(source.fetches).toHaveLength(1);
});

test("diskへ保存し、再起動後は取得元が止まっていても確認できる", async () => {
	source.add(entry("dev-1", "tok-1"));
	const first = makeStore({ persist: true });
	await first.refresh();

	source.down = true;
	const second = makeStore({ persist: true });
	expect(await second.resolveCredential("tok-1")).toBe("dev-1");
	expect(second.status().version).toBe(first.status().version);
	expect(source.lookups).toHaveLength(0);
});

test("再起動後の取得は、保存したversionからの差分を求める", async () => {
	source.add(entry("dev-1", "tok-1"));
	const first = makeStore({ persist: true });
	await first.refresh();
	const version = first.status().version;

	const second = makeStore({ persist: true });
	source.fetches = [];
	await second.refresh();
	expect(source.fetches).toEqual([version]);
});

test("保存するのはhashだけで、Token平文は含まない", async () => {
	source.add(entry("dev-1", "super-secret-token"));
	await makeStore({ persist: true }).refresh();
	const body = readFileSync(join(dir, "credentials.json"), "utf8");
	expect(body).not.toContain("super-secret-token");
	expect(body).toContain(hashCredential("super-secret-token"));
});

test("壊れた保存fileは無視して、取得元から全件を取得する", async () => {
	writeFileSync(join(dir, "credentials.json"), "{not json");
	source.add(entry("dev-1", "tok-1"));
	const store = makeStore({ persist: true });
	expect(store.status().entries).toBe(0);
	await store.refresh();
	expect(source.fetches[0]).toBeNull();
	expect(await store.resolveCredential("tok-1")).toBe("dev-1");
});
