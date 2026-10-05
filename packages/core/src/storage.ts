/**
 * Storage abstraction(docs/core/config-backup-design.md、docs/core/syslog-design.md)。
 *
 * 保存先(Community: Local filesystem)を差し替えられるよう、
 * Core側はinterfaceだけを持つ。
 */

export type StoredConfigBackup = {
	/** 保存先を特定するkey(Community: fileのrelative path) */
	storageKey: string;
	contentHash: string;
	sizeBytes: number;
	encryptionVersion: number;
	/** AEADのnonce(hex) */
	nonce: string;
};

export interface ConfigBackupStorage {
	/** CONFIG本文を暗号化して保存する。平文のまま保存しない。 */
	put(
		deviceId: string,
		backupId: string,
		plaintext: Uint8Array,
	): Promise<StoredConfigBackup>;
	get(
		stored: Pick<
			StoredConfigBackup,
			"storageKey" | "nonce" | "encryptionVersion"
		>,
	): Promise<Uint8Array>;
	delete(storageKey: string): Promise<void>;
}

export type SyslogLine = {
	/** UTCのISO 8601 */
	ts: string;
	message: string;
};

export type SyslogUsage = {
	usedBytes: number;
	oldestAt?: string;
};

export type SyslogRetentionPolicy = {
	retentionDays: number;
	maxBytes: number;
	/** 上限に達したとき、この割合まで削除する(0-1) */
	lowWatermark: number;
};

export interface SyslogStorage {
	/** Raw SYSLOGを追記する。 */
	append(deviceId: string, lines: SyslogLine[], at?: Date): Promise<void>;
	/** Device 1台 + time rangeで読み出す(docs/core/syslog-design.md §9)。 */
	read(
		deviceId: string,
		range: {
			from: Date;
			to: Date;
			limit: number;
			/** メッセージに含まれる文字列。検索対象をstorage側で絞る。 */
			keyword?: string;
			/** メッセージに含まれる行を除外する文字列。 */
			exclude?: string;
		},
	): Promise<SyslogLine[]>;
	usage(deviceId?: string): Promise<SyslogUsage>;
	/** retention / 容量上限を超えた分を古いものから削除する。 */
	cleanup(
		policy: SyslogRetentionPolicy,
		now?: Date,
	): Promise<{ removedBytes: number }>;
}

export interface AgentArtifactStorage {
	put(version: string, artifact: Uint8Array): Promise<void>;
	get(version: string): Promise<Uint8Array | null>;
	list(): Promise<string[]>;
}
