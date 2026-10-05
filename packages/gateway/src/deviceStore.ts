/**
 * Device credentialの検証(docs/core/agent-gateway-design.md §4)。
 *
 * credentialは平文で保存しない(docs/core/data-model.md §2.5)。ここではhashだけを
 * 保持し、発行・永続化はEnrollment(#23)とServerのstorage(#11)が行う。
 */
import { createHash } from "node:crypto";
import type { DeviceStore } from "./gateway.ts";

export function hashCredential(credential: string): string {
	return createHash("sha256").update(credential, "utf8").digest("hex");
}

type Record = { deviceId: string; revoked: boolean };

export class MemoryDeviceStore implements DeviceStore {
	private readonly byHash = new Map<string, Record>();

	/** credential平文はここでhash化し、保持しない。 */
	add(deviceId: string, credential: string): void {
		this.addHashed(deviceId, hashCredential(credential));
	}

	addHashed(deviceId: string, credentialHash: string): void {
		this.byHash.set(credentialHash, { deviceId, revoked: false });
	}

	revoke(deviceId: string): void {
		for (const record of this.byHash.values()) {
			if (record.deviceId === deviceId) record.revoked = true;
		}
	}

	async resolveCredential(credential: string): Promise<string | null> {
		const record = this.byHash.get(hashCredential(credential));
		if (!record || record.revoked) return null;
		return record.deviceId;
	}
}
