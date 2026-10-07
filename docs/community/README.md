# Community

Routemon Community / Self-Hosted固有の実装・deploymentを定義する。Community共通の挙動は`docs/core/`に従い、ここにはCommunityでの実装方法と設定値だけを置く。

## 前提

- 1 Instance = 1 Tenant(Single Tenant)
- Local Authのみ(Public signup・OIDC・SAMLなし)
- SQLite、Local filesystem(`/data`)
- Docker Compose、Caddy
- GUI-first setup
- license上のUser数上限なし

特定の外部サービスを前提にしない。

## 文書

| 文書 | 内容 | 状態 |
|---|---|---|
| `installation-setup-design.md` | Docker導入 / GUI-first初期Setup / TLS / First Device onboarding | Current |
| `storage-backup-design.md` | 永続データ配置、CONFIG / SYSLOG保存、暗号化Key、Backup / Restore、Upgrade | Current |
| `local-auth-design.md` | Local Auth / 初回Admin作成 / User追加 | Current |
| `database-design.md` | SQLite physical schema / migration | Current |
| `architecture.md` | Community architecture | Current |
| `loadtest.md` | Agent Gatewayの負荷試験の記録(台数、SYSLOG、WebGUI relay、FD上限、再起動)。再現手順は`scripts/loadtest/` | Measurement record |

## 読む順番

1. `docs/README.md`
2. `docs/core/README.md`とCoreの該当文書
3. 本ディレクトリの該当文書

## Dependency rule

Community仕様はCoreに依存してよい。Coreの挙動をここへ複製せず、Community固有の実装・設定値だけを記述する。
