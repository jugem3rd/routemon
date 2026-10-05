/**
 * CONFIG Backupのlocal storage(docs/community/storage-backup-design.md、
 * docs/core/config-backup-design.md)。
 *
 * metadataはSQLite、本文はAES-256-GCMで暗号化したfileへ置く。
 */
import {
	createCipheriv,
	createDecipheriv,
	createHash,
	randomBytes,
} from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { ConfigBackupStorage, StoredConfigBackup } from "@routemon/core";

export const ENCRYPTION_VERSION = 1; // 1 = AES-256-GCM
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

export class LocalConfigBackupStorage implements ConfigBackupStorage {
	private readonly root: string;
	private readonly masterKey: Buffer;

	constructor(root: string, masterKey: Buffer) {
		this.root = root;
		this.masterKey = masterKey;
	}

	async put(
		deviceId: string,
		backupId: string,
		plaintext: Uint8Array,
	): Promise<StoredConfigBackup> {
		const nonce = randomBytes(NONCE_BYTES);
		const cipher = createCipheriv("aes-256-gcm", this.masterKey, nonce);
		const ciphertext = Buffer.concat([
			cipher.update(plaintext),
			cipher.final(),
			cipher.getAuthTag(),
		]);
		const storageKey = join(deviceId, `${backupId}.enc`);
		const file = join(this.root, storageKey);
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(file, ciphertext, { mode: 0o600 });
		return {
			storageKey,
			contentHash: createHash("sha256").update(plaintext).digest("hex"),
			sizeBytes: plaintext.length,
			encryptionVersion: ENCRYPTION_VERSION,
			nonce: nonce.toString("hex"),
		};
	}

	async get(
		stored: Pick<
			StoredConfigBackup,
			"storageKey" | "nonce" | "encryptionVersion"
		>,
	): Promise<Uint8Array> {
		if (stored.encryptionVersion !== ENCRYPTION_VERSION) {
			throw new Error(
				`unsupported encryption version: ${stored.encryptionVersion}`,
			);
		}
		const body = readFileSync(join(this.root, stored.storageKey));
		const ciphertext = body.subarray(0, body.length - TAG_BYTES);
		const tag = body.subarray(body.length - TAG_BYTES);
		const decipher = createDecipheriv(
			"aes-256-gcm",
			this.masterKey,
			Buffer.from(stored.nonce, "hex"),
		);
		decipher.setAuthTag(tag);
		return new Uint8Array(
			Buffer.concat([decipher.update(ciphertext), decipher.final()]),
		);
	}

	async delete(storageKey: string): Promise<void> {
		rmSync(join(this.root, storageKey), { force: true });
	}

	/** Device削除時はmetadataにない孤児fileも含めて配下を消す。 */
	async deleteDevice(deviceId: string): Promise<void> {
		rmSync(deviceDirectory(this.root, deviceId), {
			recursive: true,
			force: true,
		});
	}
}

function deviceDirectory(root: string, deviceId: string): string {
	const rootPath = resolve(root);
	const devicePath = resolve(rootPath, deviceId);
	const relativePath = relative(rootPath, devicePath);
	if (
		relativePath.length === 0 ||
		relativePath.startsWith("..") ||
		isAbsolute(relativePath)
	) {
		throw new Error("invalid device storage path");
	}
	return devicePath;
}
