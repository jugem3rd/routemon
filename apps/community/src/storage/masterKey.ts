/**
 * Instance固有のmaster key(docs/community/storage-backup-design.md)。
 *
 * - 初回起動時に生成し、`/data/secrets/master.key`へ保存する
 * - source / imageへ固定keyを含めない
 * - logへ出さない
 */

import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";

export const MASTER_KEY_BYTES = 32; // AES-256

export function loadOrCreateMasterKey(file: string): Buffer {
	if (!existsSync(file)) {
		const key = randomBytes(MASTER_KEY_BYTES);
		writeFileSync(file, key, { mode: 0o600 });
		return key;
	}
	chmodSync(file, 0o600);
	const key = readFileSync(file);
	if (key.length !== MASTER_KEY_BYTES) {
		throw new Error(`master key must be ${MASTER_KEY_BYTES} bytes: ${file}`);
	}
	return key;
}
