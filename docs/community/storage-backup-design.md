# Community Storage / Backup / Restore Design

Status: Current specification  
Scope: Community  
Last updated: 2026-09-20

## 1. Purpose

Routemon Community / Self-Hosted版の永続データ配置、SQLite運用、CONFIG Backup、SYSLOG保存、暗号化Key、Backup / Restore、Upgrade時のmigration方針を定義する。

対象はCommunity版とし、1 Instance = 1 Tenant、Docker / Docker ComposeによるSelf-Hosted運用を前提とする。

---

## 2. Design goals

以下を優先する。

- PostgreSQL等の外部DBを必須にしない
- 永続データを`/data`へ集約する
- Docker volume単位でOffline Backupできる
- 稼働中のOnline BackupはRoutemon公式機能で安全に取得する
- Raw SYSLOGやCONFIG本文でSQLiteを不必要に肥大化させない
- CONFIG内のCredential等を平文保存しない
- CoreのStorage abstractionを使い、保存先を差し替えられる
- Docker image更新時のDB schema migrationを自動化する
- Self-Hosted利用者が復旧手順を理解しやすい構成にする

---

## 3. Persistent data layout

Community版の永続データは原則として`/data`以下へ集約する。

```text
/data/
├ routemon.db
├ secrets/
│  └ master.key
├ config-backups/
│  └ <device-id>/
├ syslog/
│  └ <device-id>/<yyyy>/<mm>/<dd>/<hh>/
├ agent/
│  └ releases/
├ backups/
└ tmp/
```

`/data`はDocker persistent volumeとしてmountする。

コンテナを作り直しても`/data`が維持されれば、Routemon Communityの永続状態を維持できることを基本とする。

`tmp/`は永続性を保証しない一時データ領域として扱い、Backup必須対象には含めない。

---

## 4. SQLite

Community版の標準DatabaseはSQLiteとする。

推奨設定:

```text
journal_mode = WAL
foreign_keys = ON
busy_timeout = 数秒
```

SQLiteには主に以下を保存する。

```text
Tenant
Users / Local Auth
Sessions
Devices
Sites / Groups / Tags
Enrollment metadata
Device credentials metadata
Device Profile
Events
Jobs
CONFIG Backup metadata
Application settings
Schema / migration metadata
```

以下は原則としてSQLiteへ大量保存しない。

```text
Raw SYSLOG body
CONFIG Backup body
Agent heartbeatごとのPresence write
大容量artifact本体
```

Agent Presenceは可能な限りruntime memoryで保持し、状態遷移等の意味のあるEventのみSQLiteへ永続化する。

---

## 5. CONFIG Backup storage

CONFIG Backupは以下の分離を基本とする。

```text
Metadata
  -> SQLite

Encrypted CONFIG body
  -> Local filesystem
```

保存例:

```text
/data/config-backups/<device-id>/<backup-id>.enc
```

SQLite metadata例:

```text
device_config_backups
- id
- device_id
- captured_at
- content_hash
- size_bytes
- firmware_revision
- hostname
- source
- storage_path
- encryption_version
- encryption_nonce
- created_by_user_id
- created_at
```

同じStorage interfaceの別のimplementationへ置換できるようにする。

```text
ConfigBackupStorage
└ Community -> LocalFileStorage
```

---

## 6. CONFIG encryption

YAMAHA CONFIGにはPPP認証情報、IPsec PSK、Password、SNMP community等の機微情報が含まれる可能性があるため、CONFIG本文を平文のまま永続保存しない。

Community版ではAEADによるapplication-level encryptionを行う。

初期推奨:

```text
AES-256-GCM
```

暗号化方式はversionを持たせ、将来algorithm / key rotationを変更できるようにする。

### Master key

Instance固有のmaster keyを初回初期化時に生成する。

```text
/data/secrets/master.key
```

方針:

- Source repository / Docker imageへ固定Keyを含めない
- 初回生成後は`/data`へ永続化する
- Container内部で必要最小限の権限でreadする
- Host側file permissionも可能な限り制限する
- Application logへ出力しない
- Backup対象へ含める

Community版では運用簡易性を優先し、master keyをBackup対象から分離しない。

`master.key`を失うと暗号化済みCONFIGを復号できなくなるため、Backup / RestoreではDB・CONFIG・master keyを同一Instance backup setとして扱う。

---

## 7. SYSLOG storage

Raw SYSLOGはSQLiteではなくLocal filesystemへ保存する。

object storageへも置換しやすいpath構造を使用する。

```text
/data/syslog/{device_id}/{yyyy}/{mm}/{dd}/{hh}/{chunk_id}.ndjson.gz
```

Payloadはgzip圧縮したNDJSONを基本とする。

例:

```jsonl
{"ts":"2026-09-13T14:00:00Z","message":"...raw syslog..."}
```

### Default retention / quota

Community版初期値:

```text
retention_days       = 30
max_syslog_storage   = 5 GB
quota_low_watermark  = 90%
```

どちらか早い条件で古いSYSLOGを削除する。

容量上限到達時は古いSYSLOGから削除し、概ね90%以下へ戻す。

Admin UIでは少なくとも以下を表示する。

```text
SYSLOG Storage: current / limit
Retention days
Oldest retained timestamp
```

Adminは将来容量上限・retentionを変更可能にする。

`Unlimited`を提供する場合はdisk full riskを明確に警告する。

---

## 8. Offline Backup

Routemonを停止した状態では、`/data`全体を一貫したBackup単位として扱えることを保証する。

概念例:

```text
docker compose down
backup /data volume
docker compose up -d
```

Offline Backupでは以下を含む。

```text
routemon.db
secrets/master.key
config-backups/
syslog/
agent/releases/
application settings
```

`tmp/`は必須ではない。

---

## 9. Online Backup

Routemon稼働中に`routemon.db`を単純なfile copyだけでBackupしない。

公式Backup機能ではSQLite Backup API等、一貫性を保証できる方式を使用する。

CLIの目標形:

```text
routemon backup
routemon backup --include-syslog
```

Docker利用例:

```text
docker compose exec routemon routemon backup
```

Default Backupには以下を含む。

```text
Database snapshot
Master key / secrets
CONFIG Backup body
Application settings
Manifest
```

Raw SYSLOGは容量が大きくなるためDefaultでは含めず、`--include-syslog`等で明示的に追加する。

Backup archive例:

```text
routemon-backup-20260913T230000Z.tar.gz
```

### 9.1. Instance Backup retention

Instance BackupはGUIまたはCLIで作成するたびに、古いarchiveを自動整理する。保持条件は件数と
合計容量の両方で、どちらか一方を超えた時点で古いものから削除する。

Community版の既定値は以下とする。

```text
Instance Backup generations = 10
Instance Backup capacity    = 1 GiB
```

1つのarchiveが数十MB以上になり得るため、件数だけではSYSLOGを含むBackupで容量が膨らむ。
一方で容量だけでは小さなarchiveを無制限に残し得るため、10世代と1 GiBを併用する。10世代は
直近の運用変更を追えるrollback pointとして十分な範囲を確保し、1 GiBはSelf-Hostedの永続volumeを
Backupだけで圧迫しないための上限とする。

保持処理は、Backup作成直後とApplication起動時に実行する。最も新しいarchiveは、単体で1 GiBを
超えていても最低1件として残す。作成直後に唯一の復旧点を自動削除しないためである。Settingsの
Backup一覧には利用者が作成した`.tar.gz`だけを表示し、削除はAdminが確認Modalから行う。明示的な
削除はAudit Logへ`BACKUP_DELETED`として記録する。

### 9.2. Pre-upgrade snapshot retention

Migration前に作る`pre-upgrade-*.db`はrollback用の内部snapshotであり、Instance Backup一覧やGUIの
手動削除対象には含めない。Application起動時に以下の既定値で自動整理する。

```text
Pre-upgrade snapshot generations = 3
Pre-upgrade snapshot capacity    = 256 MiB
```

Migrationは頻繁ではないため、直近3回分があれば直前のschemaへ戻す判断材料として十分とする。
snapshotもSQLite DB全体のコピーで容量が増え得るので256 MiBの上限を併用し、古いものから削除する。
archiveと同様、単体で上限を超える場合も最新の1件は残す。これにより、migrationが長期間行われない
場合もsnapshotが無制限に蓄積しない。

---

## 10. Backup manifest

公式Backup archiveにはmanifestを含める。

最低限:

```json
{
  "routemon_version": "0.5.0",
  "schema_version": 12,
  "created_at": "2026-09-13T14:00:00Z",
  "includes_syslog": false
}
```

将来必要に応じて以下を追加できる。

```text
backup_format_version
instance_id
checksum
minimum_restore_version
```

---

## 11. Restore

Restoreは停止状態または専用one-shot containerで実行する。

目標例:

```text
docker compose down
docker compose run --rm -v "$PWD:/backup:ro" routemon routemon restore /backup/routemon-backup.tar.gz
docker compose up -d
```

Restore flow:

```text
Backup manifest検証
↓
Backup format確認
↓
Routemon / schema compatibility確認
↓
既存dataの安全確認
↓
DB / secrets / files展開
↓
必要ならDB migration
↓
整合性check
↓
起動
```

Restore時にmaster keyと暗号化CONFIGの対応が崩れないことを必須とする。

---

## 12. Upgrade / DB migration

Community版の標準UpgradeはDocker image更新とする。

目標手順:

```text
docker compose pull
docker compose up -d
```

Application起動時に現在のDB schema versionを確認し、対応するmigrationを順番に適用する。

```text
Current schema
↓
Required schema
↓
Pre-upgrade DB snapshot
↓
Migration
↓
Validation
↓
Application start
```

Migration直前に最低限SQLiteのpre-upgrade snapshotを自動取得する。

保存例:

```text
/data/backups/pre-upgrade-<timestamp>.db
```

Migration failure時はApplicationを不完全な状態で通常起動させず、明示的にfailureを通知する。

DB migrationのdown migrationは必須要件にはしない。Rollbackが必要な場合はpre-upgrade backupからのRestoreを基本とする。

---

## 13. Storage abstraction

Business Logicを、保存先ごとに分岐させすぎない。

最低限以下をinterfaceとして分離可能にする。

```text
Database / Repository layer
ConfigBackupStorage
SyslogStorage
AgentArtifactStorage
```

実装例:

```text
Community
├ SQLite
├ LocalConfigBackupStorage
├ LocalSyslogStorage
└ LocalAgentArtifactStorage
```

Core Parser / Device Profile / Agent Protocol等はStorage implementationへ直接依存させない。

---

## 14. Security rules

- CONFIG本文は平文永続保存しない
- master keyをApplication logへ出さない
- Backup archiveは機微情報を含むものとして扱う
- Backupにmaster keyが含まれるため、Backup file自体の保護責任を明示する
- SYSLOG / CONFIGをAnalyticsや外部サービスへ自動送信しない
- file pathはDevice ID等のserver-side identifierから生成し、User入力pathを直接使わない
- Backup / Restore操作はAdminのみ実行可能とする

---

## 15. Initial fixed values

Community v0.1の初期方針として以下を採用する。

```text
Database              = SQLite
SQLite journal         = WAL
Persistent root        = /data
CONFIG body            = encrypted local file
CONFIG metadata        = SQLite
CONFIG encryption      = AES-256-GCM (initial recommendation)
Master key             = /data/secrets/master.key
Raw SYSLOG             = gzip NDJSON local file
SYSLOG retention       = 30 days
SYSLOG capacity        = 5 GB
SYSLOG low watermark   = 90%
Online backup          = official Routemon backup command
Default backup SYSLOG  = excluded
Offline backup         = /data volume whole backup
Upgrade                = Docker image + automatic DB migration
Pre-upgrade snapshot   = enabled
```

これらは実装・実機運用で問題が判明した場合にdesign revisionするが、Community v0.1実装の基準値とする。
