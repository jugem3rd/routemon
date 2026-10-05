# Community Database Design

Status: Current specification  
Scope: Community  
Last updated: 2026-09-16

Related:

- `docs/core/data-model.md`(DB非依存の論理モデル)
- `docs/community/storage-backup-design.md`(永続データ配置、Backup / Restore)
- `docs/core/config-backup-design.md`、`docs/core/syslog-design.md`
- 実際のDDL: `apps/community/src/storage/migrations/*.sql`

## 1. Purpose

本ドキュメントは、Community / Self-HostedのSQLite physical schemaを定義する。論理モデル(entity、関係、invariant)は`docs/core/data-model.md`に従い、ここではSQLite上の表現とmigrationの扱いだけを決める。

各tableの列定義の正本はmigration SQLとし、本ドキュメントは構成と方針を示す。

---

## 2. Conventions

- 主キーは`TEXT`(UUID)
- timestampはUTCのISO 8601 text(`docs/core/data-model.md` §7)
- boolean相当は`INTEGER`(0 / 1)
- 列挙値は`CHECK`制約で縛る(`role`、`lifecycle_status`、`status`、`family`、`source`)
- Tenant境界はauthoritativeな親から導出できる形にする(`docs/core/data-model.md` §2.2)。top-level entityは`tenant_id`を持ち、Device配下のentityは`device_id`経由で辿る
- 外部キーは`ON DELETE CASCADE`(所有関係)または`ON DELETE SET NULL`(参照)
- CONFIG checkpointはmetadataとDeviceごとの取得状態だけをDBに持ち、CONFIG本文は既存のbackup storageで管理する

SQLiteの設定:

```text
journal_mode = WAL
foreign_keys = ON
busy_timeout = 5000
```

---

## 3. Tables

| Table | 内容 | Tenant境界 |
|---|---|---|
| `users` | Routemon User。Local Authの認証情報は#24で別tableへ追加する | - |
| `tenants` | 所有単位。Communityは1 Instance = 1 Tenantで1行だけ持つ | - |
| `memberships` | User × Tenant × Role(`admin` / `viewer`) | `tenant_id` |
| `sites` | 物理設置拠点 | `tenant_id` |
| `groups` | 論理グループ(`parent_group_id`で将来の階層化を許容) | `tenant_id` |
| `tags` | ラベル(Tenant内で名前は一意) | `tenant_id` |
| `devices` | 管理対象Device | `tenant_id` |
| `device_groups` / `device_tags` | Deviceとの多対多 | `device_id`経由 |
| `device_enrollments` | Enrollment Codeのhashと有効期限(#23) | `device_id`経由 |
| `device_credentials` | Device Tokenのhashと状態(`active` / `revoked`) | `device_id`経由 |
| `device_addresses` | IPv4 / IPv6の現在値兼履歴(`observed` / `agent`) | `device_id`経由 |
| `device_events` | Structured Event | `tenant_id` |
| `device_config_backups` | CONFIG Backupのmetadataと保存先key | `tenant_id` |
| `config_checkpoints` | 複数DeviceのCONFIG取得を束ねるcheckpoint | `tenant_id` |
| `config_checkpoint_items` | checkpoint内のDeviceごとの取得結果 | `checkpoint_id`経由 |
| `local_auth_credentials` | Local Authのpassword hashと失敗回数(#24) | `user_id`経由 |
| `sessions` | Session tokenのhashと有効期限(#24) | `user_id`経由 |
| `audit_events` | 監査Event(`docs/core/access-control-design.md` §6) | `tenant_id` |
| `settings` | Instance設定(Setup Wizard等、#12) | - |
| `schema_migrations` | 適用済みmigration | - |

設計の方針:

- Gateway assignmentを持たない。Agent GatewayはRoutemon Server内の1つだけ(`docs/community/architecture.md` §3)
- 外部のIdentityを持たない。Local Authの認証情報は#24で追加する
- CONFIG本文はLocal filesystemへ置き、`device_config_backups.storage_key`で参照する

保存しないもの(`docs/core/data-model.md` §2.3、§2.6):

```text
devices.online / agent_online / agent_offline / realtime_last_seen / current_gateway_id
Raw SYSLOG行
Heartbeatごとの更新
```

---

## 4. Migrations

- `apps/community/src/storage/migrations/NNN_name.sql`をファイル名順に適用する
- 適用済みversionは`schema_migrations`に記録する
- 1つのmigrationは1 transactionで適用し、失敗したらそのmigrationは記録しない
- 起動時に未適用のmigrationがある場合、適用前に`/data/backups/pre-upgrade-<timestamp>.db`へsnapshotを取る(`docs/community/storage-backup-design.md`)
- migrationに失敗した場合は通常起動させない
- down migrationは持たず、pre-upgrade snapshotからのrestoreを標準のrollbackとする

---

## 5. CONFIG Backup

metadataは`device_config_backups`、本文は暗号化fileとして`/data/config-backups/<device-id>/<backup-id>.enc`へ置く。

```text
storage_key         <device-id>/<backup-id>.enc
content_hash        平文のSHA-256
size_bytes          平文のbyte数
encryption_version  1 = AES-256-GCM
nonce               hex
```

- 同じ`content_hash`が直前の世代と一致する場合、新しい世代を作らない(`docs/core/config-backup-design.md` §4)
- **Communityの保持世代数の既定は30世代**とする。Local filesystemへ保存するため、多めに保持できる。Adminが変更できるようにする(#12)
- 世代を削除する際は、metadataと本文fileの両方を削除する
