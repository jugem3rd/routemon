# Routemon Community Architecture

Status: Current specification  
Scope: Community  
Last updated: 2026-09-14

Related:

- `docs/architecture.md`(全体概要)
- `docs/core/architecture.md`(deployment方式に依存しないarchitecture)
- `docs/product/service-policy.md`(§2 Product、§4 Tenant model、§5 Community Authentication)
- `docs/product/licensing-policy.md`(§5 Architecture boundary)

## 1. Purpose

本ドキュメントは、Routemon Community / Self-Hosted固有のarchitectureを定義する。Router Agent、Agent transport、Agent Gateway、Device Profile、WebGUI relay等の共通部分は`docs/core/architecture.md`に従う。

---

## 2. Premises

- 1 Instance = 1 Tenant(Tenant切替等のMulti-Tenant UIは提供しない)
- 複数Device / 複数User、RoleはAdmin / Viewer
- AuthenticationはRoutemon内蔵のLocal Authのみ
- Infrastructureは利用者自身が管理する
- Multi-Tenant機能は持たない
- Community codeはMIT License

Community v0.1では、PostgreSQL、Redis、external message queue、external object storage、特定のcloud serviceを標準依存にしない。

---

## 3. Topology

標準Docker Compose serviceは`routemon`と`caddy`の2つで、Routemon Applicationの主要機能は1つの`routemon` containerへまとめる。

```text
Browser / YAMAHA Agent
          |
       HTTPS
          |
       Caddy
          |
       Routemon
       ├ Web UI
       ├ API
       ├ Local Auth
       ├ Agent Gateway
       ├ WebGUI Relay
       ├ CONFIG Parser
       ├ Device Profile
       ├ SYSLOG
       └ SQLite
          |
        /data
```

- CaddyがBrowserとYAMAHA AgentのHTTPSを終端する(Reverse Proxy / TLS termination)。利用者にCaddy設定ファイルの手編集を要求しない
- Agent Gateway(`docs/core/agent-gateway-design.md`)はRoutemon Server内のcomponentとして動作する
- YAMAHA AgentはBrowserよりTLS互換性条件が厳しい可能性があるため、Setup時にAgent endpointの接続性を別途確認する

詳細は`docs/community/installation-setup-design.md`を参照する。

---

## 4. Persistent data

永続データは`/data`以下へ集約し、Docker persistent volumeとしてmountする。

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

| データ | 保存先 |
|---|---|
| User / Tenant / Device等のrelational data | SQLite(`routemon.db`) |
| Encrypted CONFIG body | Local filesystem(`config-backups/`) |
| Raw SYSLOG | Local filesystem(`syslog/`) |
| CONFIG暗号化のmaster key | `secrets/master.key` |

論理モデルは`docs/core/data-model.md`、SQLite physical schemaは`docs/community/database-design.md`(#11で確定)、保存方式・Backup / Restore・Upgrade時のmigrationは`docs/community/storage-backup-design.md`を参照する。

---

## 5. Authentication

Local Authのみを提供する。最初のAdminはSetup WizardのGUIで作成し、以後のUser追加はAdminがGUIから行う。Public signup、OIDC、SAML、Social Loginは提供しない。

詳細は`docs/community/local-auth-design.md`を参照する。

---

## 6. Setup and operation

- 利用者がCLIで行う標準作業は、原則としてDocker起動(`docker compose up -d`)までとする
- 起動後はBrowserのSetup Wizardへ移行する(GUI-first setup)
- Instance / Administrator / Public URL / TLS・Connectivity Checkを順に設定する

詳細は`docs/community/installation-setup-design.md`を参照する。
