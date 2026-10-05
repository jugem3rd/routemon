# Access Control Design

Status: Current specification  
Scope: Core  
Last updated: 2026-09-21

Related:

- `docs/product/service-policy.md`(§6 Tenant RBAC、§7 Product UX Boundary)
- `docs/core/webgui-relay-design.md`
- `docs/community/local-auth-design.md`(Community固有: Local Auth)

## 1. Purpose

本ドキュメントは、deployment方式に依存しないAuthorization semantics(Role、server-side authorization、Native WebGUI access、Audit)を定義する。

MVPでは権限モデルを複雑化せず、UserのRoleは**Admin / Viewerの2種類だけ**とする。

Routemon独自GUIをPrimary UX、YAMAHA Native WebGUIをAdvanced accessとするProduct上の位置付けは`docs/product/service-policy.md` §7を正本とする。

Authentication方式はdeploymentごとに異なりうる(Communityは、Local Auth)。本ドキュメントはAuthentication後のAuthorizationだけを扱う。

---

## 2. Membership and roles

Userは所属先(Membership)ごとにRoleを持つ。

```text
Authenticated User
  -> Membership
  -> Role = Admin or Viewer
```

- Communityは1 Instance = 1 Tenantであり、Tenant切替UIは持たない(`docs/product/service-policy.md` §4)

最低1名のAdminを常に維持する。最後のAdminを削除またはViewerへ変更できない。

---

## 3. RBAC

### Admin

Routemonの全機能を利用できる管理者。

主な権限:

- Tenant設定(CommunityではInstance設定)
- User招待 / 追加 / 削除 / Role変更
- AdminはUserを削除できるが、自分自身は削除できない。削除時に監査Eventの実行者を有効な参照として残し、誤操作で自分のSessionが無効になるのを防ぐ。
- Device登録 / 削除 / 管理
- Device状態閲覧
- SYSLOG / Live Logs
- Event閲覧
- CONFIG Backup / Diff / Apply
- Diagnostics
- 定型Action
- Device reboot
- 任意CLI command
- YAMAHA Native WebGUI access

Admin間で機能差は設けない。

### Viewer

**読み取り専用User**。

利用可能:

- Dashboard閲覧
- Device一覧 / Device詳細閲覧
- WAN / PPP / IPv6 / Tunnel / Interface状態閲覧
- Agent Presence閲覧
- SYSLOG閲覧
- Event閲覧
- CONFIG Backup / Diff等の読み取り
- Job履歴閲覧

利用不可:

- Device設定変更
- User / Tenant管理
- Diagnostics実行
- PPP / Tunnel再接続
- Device reboot
- CONFIG取得要求 / Apply等の操作
- 任意CLI command
- YAMAHA Native WebGUI

---

## 4. Authorization model

MVPでは細粒度Permission editorや多段Roleを実装しない。

Server-side Authorizationは基本的に以下で判定する。

```text
Authenticated User
  ↓
Membership
  ↓
Role = Admin or Viewer
  ↓
Requested operation
```

原則:

```text
Admin  -> 全操作を許可
Viewer -> 読み取りAPIのみ許可
```

FrontendでButtonを非表示にするだけではなく、Server-side API側で必ずRoleを検証する。

Routemon独自GUIで操作Buttonが押された場合、Server-side APIがAdmin Roleを確認した後に対象Deviceへ必要なCommand / Jobを送信する。Viewerには操作Buttonを表示せず、API側でも実行を拒否する。

将来、顧客要望が明確になった場合のみDevice Scopeや細粒度Permissionを追加検討する。MVPでは複雑な権限階層を持ち込まない。

---

## 5. Native WebGUI Access

YAMAHA Native WebGUI Forwarderは、Routemon側でGUI内部の操作権限を細かく制御しない。

Native WebGUIへ入れる時点でRouter上の強い管理操作が可能になるため、**Adminだけが利用可能**とする。

```text
Admin  -> Native WebGUI allowed
Viewer -> Native WebGUI denied
```

Native GUI内部のURL / POST / HTML / JavaScriptをProxy側でfilterして擬似的な読み取り専用GUIを作らない。

Device詳細ではAdvanced領域へ配置する。

```text
Advanced
└── YAMAHA Native WebGUI   # Admin only
```

ViewerにはNative WebGUI entry point自体を表示せず、session作成APIでも必ず拒否する。WebGUI relayの仕様は`docs/core/webgui-relay-design.md`を参照する。

### CONFIG閲覧との関係

CONFIG本文にはNative WebGUIで見えるものと同種のsecret(`pp auth myname`のpassword等)が含まれる。
そのためCONFIG世代一覧・差分・downloadもAdminのみとする(#57)。

ルーターへ実行するcommandにはadministrator passwordや`pp auth myname`のpasswordなどの
認証情報が含まれ得る。そのため監査ログの`COMMAND_EXECUTED` detailで公開するcommand文字列も、
Native WebGUI・CONFIG閲覧と同じくAdminのみを前提とする。

この3つは同じ前提に立っている。**Native WebGUI、CONFIG閲覧、監査ログの
`COMMAND_EXECUTED` detailをViewerへ開放する判断をする場合は、3つの権限をまとめて見直す**こと。
いずれか1つだけ緩めると、残りの制限が意味を失う。

Device Profile(`GET /api/devices/:id/profile`)はCONFIGから抽出した構造情報だけでsecretを
含まないため、Viewerも閲覧できる。

Topology API(`GET /api/topology`)も、全DeviceのLAN subnet・WAN方式・VPN対向関係を返すが、同じ前提でsecretを含まないためViewerも閲覧できる。Device Profileの公開範囲を見直す場合は、Topology APIの公開範囲も同時に見直す。

---

## 6. Audit

強い操作は監査Eventを残す。

最低限:

```text
NATIVE_GUI_SESSION_STARTED
NATIVE_GUI_SESSION_ENDED
COMMAND_EXECUTED
CONFIG_APPLIED
DEVICE_REBOOT_REQUESTED
USER_ROLE_CHANGED
```

Native GUI session eventには以下を記録する。

- tenant_id
- user_id
- device_id
- started_at
- ended_at / duration

Native WebGUIで転送したHTTP bodyそのものを監査目的で保存しない。

監査Eventには、実行者(`actor_user_id`)、対象(`target_type` / `target_id`)、種別、日時を記録する。CommunityではSQLiteの`audit_events`へ保存する(`docs/community/database-design.md`)。password、token、CONFIG本文、転送したHTTP bodyは記録しない。

---

## 7. Security rules

- RoleはAdmin / Viewerの2種類のみ
- Adminは全操作可能
- Viewerは読み取り専用
- ViewerはNative WebGUIを利用不可
- Viewerからwrite/action endpointを呼ばれてもserver-sideで拒否する
- 最低1名のAdminを維持する
- MVPではUser単位のPermission overrideを実装しない
- MVPでは複雑なDevice Scope / ABAC / Role Builderを実装しない
