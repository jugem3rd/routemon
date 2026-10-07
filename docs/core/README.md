# Core

deployment方式に依存しないdomain semantics / protocol / behaviorを定義する。Communityは、Coreに従うSelf-Hosted版の実装である。

## 置くもの / 置かないもの

置くもの:

- Agent Gateway / Agent Protocol / Device Enrollment / Agent Update
- Device Profile / CONFIG Parser、WebGUI relay
- CONFIG Backup・SYSLOGの共通の挙動
- Admin / Viewerの基本Authorization
- DB非依存の論理データモデル
- YAMAHA Lua APIの確認済み事実と制約

置かないもの:

- SQLite / Caddy / Docker ComposeなどCommunity固有の実装値
- Community固有のcapacity・quota・retention既定値

## 文書

| 文書 | 内容 | 状態 |
|---|---|---|
| `lua-api-notes.md` | YAMAHA Lua APIの確認済み事実と制約 | Current |
| `supported-devices.md` | Luaスクリプト機能の対応表から推測した対応機種(確認済みと未確認の区別) | Current |
| `agent-update-design.md` | Bootstrap / Supervisor、A/B Agent update・rollback・recovery | Current |
| `device-enrollment-design.md` | copy-paste方式のDevice Enrollment | Current |
| `agent-gateway-design.md` | Agent Gatewayの共通責務 | Current |
| `webgui-relay-design.md` | WebGUI relayの現行仕様 | Current |
| `data-model.md` | DB非依存のlogical entity / relationship / invariant | Current |
| `access-control-design.md` | Admin / Viewer authorization、Native WebGUI制御 | Current |
| `config-backup-design.md` | CONFIG Backupの共通mechanism | Current |
| `config-bulk-rollback-design.md` | 複数DeviceへのCONFIG順次Apply設計案 (#94) | Design proposal |
| `syslog-design.md` | SYSLOGの共通behavior | Current |
| `device-profile-discovery-design.md` | Device Profile / CONFIG Parser | Current |
| `architecture.md` | Core architecture | Current |
| `agent-protocol.md` | Agent Protocol(HTTPS sync、frame format、body encoding) | Current |

## 読む順番

1. `docs/README.md`(reading rule / dependency rule)
2. `docs/architecture.md`(全体像)と`architecture.md`(Core architecture)
3. Agent Protocol(`agent-protocol.md`)とAgent Gateway
4. 作業対象の機能の文書

## Dependency rule

Core仕様は、Communityの文書を読まなければ理解・実装できない形にしない。Community固有の実装値はCommunity側の文書へ置き、Coreからは参考リンクとしてのみ参照する。

## Agent Gateway

Core文書中の`Gateway`は、YAMAHA AgentのHTTPS syncを終端し、Agent Protocol・ephemeral stream・Presence等を扱う論理コンポーネントを指す(`agent-gateway-design.md`)。

## Agent Protocol

Agent Protocolの正本は`agent-protocol.md`である。PoCで決まっていない事項は同文書§14に挙げており、各Issueで決める。
