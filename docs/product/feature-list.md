# Routemon 実装機能一覧

Status: Current specification  
Scope: Product  
Last updated: 2026-09-14

## 目的

本ドキュメントは、YAMAHA Network Organizer（YNO）の機能を参考にしつつ、Routemon として実装すべき機能を整理する。

Routemon は本家YNOの完全な模倣を目的とせず、YAMAHAルーターをインターネット越しに安全かつ効率的に運用するために必要な機能を優先して実装する。

小〜中規模のYAMAHAルーター管理を主対象とし、数百〜数千台級の単一Tenant運用や大規模組織向けの高度な運用は本家YNOを推奨する(`docs/product/service-policy.md` §3)。

特に、以下を中核機能とする。

- ルーター単体で完結するエージェント方式
- 遠隔からの任意コマンド実行
- CONFIG の取得・履歴管理・投入
- Routemon独自GUI
- Web GUI Forwarder
- 監視・アラーム

## 状態

各機能の扱いを以下で表す。

```text
Availability: Community   提供する
Availability: 未確定      既存の決定から判断できない
```

---

## 優先度S: Routemonの中核機能

### 機器登録・管理

Availability: Community

管理対象ルーターをRoutemonへ登録し、以下の情報を管理する。

- Device ID
- Serial Number
- Model
- Firmware Revision
- Hostname
- Description
- Tags
- Site / Group
- 登録日時
- 最終通信日時

### オンライン / オフライン監視

Availability: Community

Agentの認証済み通信(Heartbeatを含む)をもとに状態を管理する。Routerそのものではなく、Agentの到達性として表現する(`docs/core/data-model.md` §5)。

- Agent Online
- Agent Offline
- Last Seen
- Uptime
- 最終再起動日時

### ダッシュボード

Availability: Community

最低限、以下を一覧表示する。

- 登録機器数
- Online台数
- Offline台数
- Warning / Critical台数
- 最近発生したイベント
- 最近実行されたジョブ

### 機器詳細

Availability: Community

機器単位で以下を確認できるようにする。

- 基本情報
- WAN / PPP 状態
- Tunnel状態
- Interface状態
- CPU使用率
- Memory使用率
- Uptime
- Firmware
- 最新CONFIG
- 最近のログ
- 最近のジョブ

### 任意コマンド実行

Availability: Community

Routemonから対象ルーターへ任意のYAMAHA CLIコマンドを実行できるようにする。

例:

```text
show status pp 1
show status tunnel
show ip route
show arp
show status lan1
show environment
show log
```

必要機能:

- 単一機器への実行
- 実行結果の取得(出力はShift_JIS、`docs/core/lua-api-notes.md`)
- 実行履歴(Job)
- 実行ユーザーの記録
- Timeout管理(応答が無い場合は再送せずtimeoutとして扱う)
- 権限制御(Adminのみ実行、ViewerはJob履歴の閲覧のみ)
- 禁止コマンド: Routemon自身の管理経路を壊すもの(`terminate lua`、`no schedule at`)を既定で拒否し、設定で変更できる。AdminはNative WebGUIから同じ操作ができるため、権限境界ではなく誤操作の防止

### Routemon GUI

Availability: Community

Routemon独自GUIを中核機能とし、日常運用のPrimary UXとする(`docs/product/service-policy.md` §7)。

最低限:

```text
Dashboard
Device List / Detail
WAN / PPP / IPv6 / Tunnel / Interface
Agent Presence
SYSLOG / Live Logs
Event
CONFIG Backup / Diff
Diagnostics
定型Actions
Jobs
User / Tenant管理
```

Viewerにはread-only表示のみとし、操作系UIは表示しない。

### Web GUI Forwarder

Availability: Community

Routemonを経由して、LAN側から直接到達できないYAMAHAルーターのWeb GUIを操作できるようにする。

Native WebGUIは日常運用のPrimary UIではなく、Routemon GUIで未提供の高度な設定・保守・トラブル対応を行うためのAdvanced / privileged / fallback accessとして扱う。

- Adminのみ利用可能
- Viewer向けにGUI内部をProxy側で細分化・読み取り専用化しない

前提:

- ルーター単体で完結する
- Raspberry PiやLAN側補助Agentを必要としない
- インバウンド接続をルーターへ直接開放しない
- ルーター側から開始するアウトバウンド通信を利用する

Web GUI転送の技術詳細は`docs/core/webgui-relay-design.md`で管理する。

### CONFIG取得

Availability: Community

ルーターからCONFIGを取得しRoutemonへ保存する。

- Agentは`show config`の結果をsnapshotとして送る
- CONFIGの解析はServer側のCore Parserで行い、Parser項目はRouter Agentの更新なしでServer側で拡張できる
- Agent起動時のCONFIG snapshot送信を必須とする
- CONFIG変更の検知方式はIssue #5の検証結果で確定する

詳細は`docs/core/device-profile-discovery-design.md`と`docs/core/config-backup-design.md`を参照する。

### CONFIG履歴

Availability: Community

CONFIGを世代管理する。保持世代数の既定は30世代(`docs/community/database-design.md` §5)。

例:

```text
current
history/
  2026-09-08T20:00:00
  2026-09-07T20:00:00
  2026-09-06T20:00:00
```

### CONFIG Diff

Availability: Community

現在CONFIGと過去CONFIG、または任意の2世代間を比較できるようにする。

### CONFIG投入

Availability: Community

Routemonから設定変更をルーターへ反映できるようにする。

必要機能:

- 事前確認
- 実行履歴
- 成否確認
- エラー内容保存
- 必要に応じたRollback設計

### 死活・障害通知

Availability: 未確定(状態遷移のEvent記録は提供する、通知手段は未確定)

最低限以下を検知する。

- Router Offline
- PPPoE Down
- Tunnel Down
- VPN Down
- Interface Down
- Unexpected Reboot

### Agent認証・通信の暗号化

Availability: Community

Agent transportはHTTPS(TLS)を標準とし(ADR-0001)、Agent GatewayでDevice固有credentialにより認証する(`docs/core/agent-gateway-design.md`)。複数の実機・複数拠点を本番でつなぐ前に以下を満たす。

- Pre-shared token / Device証明書 / mTLS等によるAgent認証(接続元がなりすましでないことの保証)
- TLSによる通信の暗号化(独自暗号は実装せず、実績のある方式に乗せる)
- Session Hijack / Replay対策
- 認証失敗・不審な接続の監査ログ記録

### 複数Agent対応(マルチデバイス Tunnel Registry)

Availability: Community

初期のPoC実装は単一Agentのみを前提とした設計だった(現在の`packages/gateway`は、複数Deviceを同時に管理する)。複数ルーターを同時管理するために必要だったこと:

- Agent Gateway上でのDevice ID単位の接続管理(Registry化)
- どのDeviceへのCOMMAND_REQUEST/STREAM_OPENかを正しく振り分けるルーティング
- 同一Device IDからの多重接続時の扱い(古い接続を切る/拒否する等)

### Agentの自動起動・自己復旧

Availability: Community

実機検証(Issue #3)で判明した制約への対応。

- Router再起動後にAgentスクリプトが自動起動する仕組み(YAMAHA CLIの`schedule at`相対タイマーをconfigに仕込むことで実現可能と実機確認済み。Device登録/Provisioningフローへの組み込みが必要)
- Routemonが投入したconfig(auto-start用の`schedule at`等)が`config replace`や初期化で失われた場合の検知・再投入
- Agent自体のバージョン管理・リモート更新。Bootstrap / Supervisor + A/B slot方式とし、current stableを直接上書きしない(`docs/core/agent-update-design.md`)

### Bootstrap / Enrollment / Agent自動Provisioning

Availability: Community

初期導入時に長大なAgent Luaや恒久的なAPIキーを手作業でルーターへ投入する負担を減らすため、最小限のBootstrap Luaと短い登録情報だけで本体Agentを自動導入できる仕組みを実装する。

想定フロー:

```text
1. Routemon Webで「ルーター追加」
2. 短いEnrollment Code / 一時Tokenを発行
3. ルーターへ共通bootstrap.luaとEnrollment Codeのみ投入
4. bootstrap.luaがRoutemonへHTTPS enrollment
5. BackendがDevice ID / Device Tokenを発行
6. bootstrap.luaが正式なRoutemon Agent LuaをHTTPSで取得
7. 一時ファイルへ保存・検証
8. Agentを有効化して自動起動設定
9. Routemon Web上でOnlineを確認
```

必要機能:

- Bootstrap Luaは可能な限り短くし、全機器共通化する
- Enrollment Code / Enrollment Tokenは短時間・原則1回限りで失効させる
- 初回登録後はEnrollment用Secretを破棄し、Device固有Tokenへ切り替える
- Agent本体をHTTPSでダウンロードしてルーター内へ保存する
- Agent version / hash等を確認し、不完全なダウンロードを有効化しない
- 新版Agentの自動取得・更新(Bootstrap / Supervisor + A/B slot方式、`docs/core/agent-update-design.md`)
- 更新時はinactive slotへcandidateを取得し、Agent Gatewayとのauthenticated sync成功後にactive化する
- 起動失敗時に旧版へRollbackできる仕組み
- Device TokenやEnrollment Secretを通常ログへ出力しない
- 将来的にToken rotation / revokeへ対応できる構造にする

最終的な導入UXは、現地作業者が長いLuaコードやAPIキーを編集せず、共通Bootstrapと短いEnrollment Codeのみを投入すれば管理開始できる状態を目標とする。

---

## 優先度A: 運用管理機能

### ジョブシステム

Availability: Community

ルーター操作は同期処理ではなく、ジョブとして管理する。

想定フロー:

```text
Routemon
  ↓
Job作成
  ↓
Router polling
  ↓
Job取得
  ↓
実行
  ↓
結果POST
```

ジョブ種別例:

- command
- config-fetch
- config-apply
- firmware-update
- reboot
- diagnostic
- gui-session

ジョブ状態:

- Queued
- Running
- Success
- Failed
- Timeout
- Cancelled

### 一括操作

Availability: 未確定

複数ルーターを選択して一括操作できるようにする。

例:

- コマンド実行
- CONFIG取得
- CONFIG変更
- 再起動
- 診断

対象指定方法:

- 手動選択
- Tag
- Site
- Model
- Tenant

### 監視・統計

Availability: 未確定

最低限、以下を収集する。

- CPU使用率
- Memory使用率
- Interface RX / TX
- PPP状態
- Tunnel状態
- VPN状態
- Uptime

将来的な候補:

- NAT session数
- FastPath flow数
- Dynamic filter session数
- Packet loss
- Latency

### アラーム

Availability: 未確定

Severityを以下の3段階程度で管理する。

- Critical
- Warning
- Info

対象例:

- Router Offline
- PPPoE Down
- Tunnel Down
- VPN Down
- CPU High
- Memory High
- Interface Down
- Unexpected Reboot
- Firmware Outdated

### 通知

Availability: 未確定

初期実装:

- Email
- Webhook

将来候補:

- Slack
- Microsoft Teams
- Discord
- LINE

---

## 優先度B: 拡張運用機能

### SYSLOG収集

Availability: Community

ルーターのSYSLOGをRoutemonへ収集する。

保存項目例:

- Timestamp
- Device
- Severity
- Facility
- Message

検索条件例:

- Device
- Severity
- Keyword
- Time Range

### ログ分析

Availability: Community

SYSLOGやジョブ結果をもとにイベントを自動分類する。

例:

- PPP接続 / 切断
- VPN切断
- Tunnel異常
- DHCP異常
- 再起動
- Interface Link Down

### Firmware管理

Availability: 未確定

管理対象機器のFirmware Revisionを管理する。

想定機能:

- Current Firmware表示
- Latest Firmware表示
- 更新対象抽出
- 一括更新
- Update Job管理
- 更新結果確認

Firmware更新自体がYAMAHAルーター側のLua/APIのみで安全に実現可能かは別途技術検証する。

### Zero Config

Availability: 未確定

将来的には、事前登録したルーターがインターネット接続後にRoutemonから設定を受け取れるようにする。

想定フロー:

```text
1. Routemonで機器を事前登録
2. Template Configを設定
3. 現地でルーター設置
4. Internet接続
5. Routemonへ接続
6. Config取得
7. Config適用
8. 必要に応じて再起動
9. 運用開始
```

### テナント内の複数ユーザー管理

Availability: Community

1つのTenant配下に複数のユーザーを所属させ、招待・削除・権限割り当てができるようにする。

- ユーザーの招待 / 追加・削除
- Role(Admin / Viewer)の割り当て・変更。最低1名のAdminを維持する

User数上限:

- Community: license上のUser数上限なし

### ユーザー認証

Availability: Community

Routemon自体へのログイン・認証方式。Agent認証とは別に、人間の利用者向けに必要。

- Routemon内蔵のLocal Authのみ。Public signup、OIDC、SAML、Social Loginは提供しない(`docs/community/local-auth-design.md`)

Communityのpassword / session / lockoutの扱いは`docs/community/local-auth-design.md` §5〜§8で定めた(Passwordはscrypt、Sessionは12時間のhttpOnly cookie、連続10回失敗で15分lock、Password再設定はAdminがGUIから行う)。

未確定:

- 外部API向けのPersonal Access Token / API Key発行・失効
- Email経由のパスワードリセットとMFA(Community v0.1では提供しない)
- ログイン試行の監査ログ(#8のAudit Eventで扱う)

### RBAC

Availability: Community

RoleはAdmin / Viewerの2種類だけとする(`docs/product/service-policy.md` §6、`docs/core/access-control-design.md`)。

```text
Admin  -> 全操作 + Native WebGUI
Viewer -> 読み取り専用、Native WebGUI不可
```

MVPではOwner / Operator等の追加Role、細粒度Permission editor、User単位のPermission overrideは実装しない。RoleはFrontendだけでなくServer-side APIでも再検証する。

Web GUI Forwarderや任意コマンド実行は強い権限を持つため、RBACと監査ログは提供前に必須とする。

### Audit Log

Availability: Community

以下を記録する。

- Login
- Device registration / deletion
- Command execution
- CONFIG fetch / apply
- Web GUI session
- Reboot
- Firmware update
- User / Role change
- Tenant setting change

---

## 優先度C: 付加価値機能

### レポート

Availability: 未確定

運用状況を期間単位でレポート化する。

例:

```text
月次レポート

稼働率                99.98 %
通信障害                   2件
Router reboot              0回
PPPoE disconnect           1回
平均CPU                    18 %
最大CPU                    61 %
```

将来的にはPDF出力や定期メール送付を検討する。

### API

Availability: 未確定

外部システムからRoutemonを操作・参照できるAPIを提供する。

対象例:

- Device一覧取得
- Device status取得
- Job作成
- Command実行
- Alarm取得
- Statistics取得
- CONFIG取得

---

## Routemon独自機能

### ネットワーク診断

Availability: Community

複数の診断コマンドをまとめて実行し、ルーター状態を自動判定する。

実行例:

```text
show status pp 1
show status tunnel
show ip route
show arp
show status lan1
show environment
show log
```

表示例:

```text
Internet       OK
PPPoE          OK
IPv6 Tunnel    Warning
DNS            OK
VPN            NG
CPU            OK
Memory         OK
```

利用者がYAMAHA CLIを熟知していなくても一次切り分けできることを目的とする。

### AIトラブルシューティング

Availability: 未確定

収集済みの以下の情報をAIへ入力し、障害原因の推定と推奨アクションを生成する。

- Device status
- Command result
- SYSLOG
- Alarm history
- CONFIG
- Statistics

表示例:

```text
推定原因:
PPPoEセッションが22:14に切断されています。

関連ログ:
22:14:01 PP[01] Disconnected
22:14:03 PP[01] Connecting...
22:14:06 PP[01] Connected

影響時間:
約5秒

推奨:
回線側の瞬断の可能性があります。
直近24時間では同様の切断が4回発生しています。
```

AIによるCONFIG変更は初期段階では自動実行せず、提案までを基本とする。

---

## 実装ロードマップ

進捗はGitHub Milestone「Community v0.1」で管理する(`docs/product/service-policy.md` §9)。

### Community v0.1

- Agent Protocol正式仕様
- Agent Gateway(複数Device、Device credential認証、Presence)
- Device Enrollment(copy-paste方式)
- Agent A/B Update(file配置、A/B切り替え、Rollback)
- CONFIG snapshot / Core Parser / Device Profile、CONFIG履歴 / Diff
- 任意コマンド実行 / Job履歴
- SYSLOG収集 / Live Logs / 履歴検索
- Web GUI Forwarder(Adminのみ)
- Admin / Viewer RBAC、Audit Log
- Routemon GUI(Dashboard、Device List / Detail)
- Local Auth、SQLite / Local Storage / Backup・Restore、Docker導入 / GUI-first Setup
- OSS公開準備(MIT適用範囲、Dependency license audit)

### Community v0.1以降

- CONFIG変更検知(SYSLOG trigger)、CONFIG投入
- Agent Update(Release channel / staged rollout、両slot故障時のrecovery)
- 監視・統計、アラーム、通知
- Structured Eventの抽出・ログ分析
- ネットワーク診断、定型Action、一括操作
- Firmware管理、Zero Config、レポート、外部API
- AIトラブルシューティング

---

## PoCの完了条件

現段階のPoCでは、以下が一通り動作すれば、Routemonの技術的な核心部分を実証できたものとみなす。

1. Heartbeatによる死活監視
2. 任意コマンド実行
3. CONFIG取得
4. CONFIG履歴 / Diff
5. CONFIG投入
6. Web GUI Forwarder

監視・通知・認証・マルチテナントなどは、この中核機能の成立確認後に段階的に追加する。

---

## 設計原則

- ルーター単体で完結すること
- LAN側にRaspberry Pi、Linuxサーバー、補助Agent等を要求しないこと
- 原則としてルーターからRoutemon側へ開始するアウトバウンド通信を利用すること
- 任意コマンド、CONFIG変更、Web GUIアクセスはすべて監査可能にすること
- PoC段階では複雑な抽象化を避け、まずYAMAHAルーターとの通信経路と遠隔操作を成立させること
- Tenant境界・RBAC等を、Coreに持つこと
