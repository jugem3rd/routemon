# Device Enrollment Design

Status: Current specification  
Scope: Core  
Last updated: 2026-09-27

## 1. Purpose

RoutemonへYAMAHA Routerを初回登録するDevice Enrollment方式を定義する。

主な利用者はNetwork Engineer / Infrastructure Engineerを想定するため、Router側でEnrollment Codeを手入力したり、Lua sourceを編集したり、複数fileを手作業で配置する方式は採らない。

基本UXは以下とする。

```text
Routemon GUIでDevice追加
  ↓
Enrollment Code発行
  ↓
CodeとServer URLを埋め込んだYAMAHA CLI blockを自動生成
  ↓
利用者はRouter CLIへblockをそのままcopy-paste
  ↓
Bootstrap取得・Enrollment・Agent導入を自動実行
  ↓
GUI上でRegistered / Online
```

利用者の標準作業は**GUI操作 + Router CLIへのcopy-pasteだけ**とする。

---

## 2. Enrollment UX

GUIで`Add Device`を選択する。

入力例:

```text
Device Name     Kurume-Router-01
Site            Kurume
Group           optional
Tags            optional
```

`Generate enrollment command`を押すと、Routemonは以下を生成する。

- Pending Device
- one-time Enrollment Code
- Enrollment expiration
- Router向けcopy-paste CLI block

GUIではEnrollment Code単体を主入力として見せるのではなく、copy-paste blockをPrimary UIとする。

例:

```text
YAMAHA Routerへ以下をそのまま貼り付けてください

[ Copy ]

<generated CLI block>

有効期限: 15分
```

Codeは詳細情報として表示してもよいが、利用者がCodeを別途転記することを標準フローにしない。

---

## 3. Router-side bootstrap mechanism

RTX830等の対応機種では`lua -e`によるinline Lua実行を利用する。

初期案は2段階とする。

```text
1. inline LuaでEnrollment endpointからBootstrapをHTTPS download
2. 保存したBootstrapを実行
```

概念例:

```text
lua -e '<Enrollment CodeをBearerとしてRoutemonへHTTPS GETし、routemon_enroll.luaへ保存>'
lua routemon_enroll.lua
```

保存先は`/routemon_enroll.lua`とする。`/routemon_bootstrap.lua`はBootstrap / Supervisor
(docs/core/agent-update-design.md §2)が使うpathで、ここへ保存するとSupervisorを上書きし、
次回起動時にAgentが起動しなくなる(RTX830実機で確認、§13)。

GUIはRouterから到達できるAgent API endpoint、Enrollment Code、保存pathを埋め込んだ完成済みcommandを生成する。
Communityでは`AGENT_BASE_URL`を使い、未設定ならPublic URLを使う。

利用者が以下を編集する必要はない。

- Routemon URL
- Enrollment Code
- Lua source
- Device ID
- Device Token
- Agent version
- Gateway endpoint

### Why Bearer

Enrollment CodeをURL queryへ埋め込む方式は、Reverse Proxy / access log等へ残りやすいため標準方式にしない。

対応YAMAHA Luaでは`rt.httprequest()`のBearer認証を利用し、Enrollment CodeをAuthorization headerとして送る方式を優先する。

```text
Authorization: Bearer <one-time enrollment code>
```

---

## 4. Enrollment Code

Enrollment Codeは以下とする。

```text
short-lived
one-time
high entropy
single Pending Device scoped
```

初期推奨:

```text
Display format: 3 groups of 4 uppercase alphanumeric characters
TTL:            15 minutes
Use count:      1
```

SQLiteには可能な限り平文Codeを永続保存せず、verification用hashを保存する。

例:

```text
device_enrollments
- id
- device_id
- code_hash
- expires_at
- used_at
- created_by_user_id
- created_at
```

CodeはDeviceの永続Credentialではない。

---

## 5. Enrollment endpoint

Community例:

```text
GET /v1/enrollment/bootstrap
Authorization: Bearer <enrollment-code>
```

YAMAHAのRouterがCloudflare Edge TLSへ直接接続できない既知制約があるため、信頼された証明書を持つpublic HTTPS endpointでAPIを提供する。Communityでは、Self-Hosted Routemon endpoint自身が提供する。

Server側では以下を検証する。

```text
Code exists
Code not expired
Code unused
Pending Device exists
Enrollment allowed
```

成功時のみBootstrap Luaを返す。

失敗時は401/403/410等を用途に応じて返す。

---

## 6. Personalized Bootstrap

返却するBootstrapは共通ロジックを基本とするが、Enrollmentに必要な最小情報を含めてよい。

Bootstrapの責務:

```text
1. Routemon Enrollment APIへ接続
2. Router identity / capabilityを送信
3. Device ID / Device Tokenを取得
4. Agent Gateway endpoint情報を取得
5. routemon_device.confを書き込む
6. stable Agentを取得し、構文を確認する
7. SYSLOG watcherを配置し、構文を確認する
8. 現行Supervisorを配置し、構文を確認する
9. Agent slotを初期化(`routemon_state.dat`へactive slotとversionを書く)
10. Supervisor自動起動用の`schedule at`がCONFIGにあるか確認する
11. 無ければ未使用の最小番号で1行追加して`save`する
12. Enrollment task自身を除く既存のRoutemon Lua taskを停止する
13. Agentは直接起動せず、Supervisorを起動する
14. Authenticated sync成功を確認
15. Enrollment完了をServerへ通知
```

SYSLOG watcherはAgentのA/B releaseとは別の固定sourceとしてBootstrapに含める。
Agent artifactの更新時にはwatcherを置き換えず、Supervisorが既存fileを監視する。

EnrollmentごとにSupervisorは正本で置き換える。再Enrollment時も同じ`schedule at`を
再利用し、重複行を作らない。新しいscheduleを追加したときはRouterの`save`を実行する。
この操作は利用者がまだ保存していない他の設定変更も一緒に保存するため、GUIで事前に明記する。

Bootstrap成功後、one-time Enrollment Codeは永続保存しない。

永続CredentialはServerが発行したDevice Tokenへ切り替える。

---

## 7. Router identity

Enrollment時に取得可能な範囲で以下を送る。

```text
model
serial_number
firmware_revision
hostname
lua_version
agent/bootstrap version
```

Device名、Site、Group、Tags等の管理metadataはGUI側で作成したPending Deviceを正とし、Router hostnameで上書きしない。

---

## 8. GUI progress

copy-paste block表示後、GUIはEnrollment状態をリアルタイムまたは短周期で更新する。

例:

```text
Waiting for router...
        ↓
Bootstrap connected
        ↓
Router identified: RTX830
        ↓
Agent downloading
        ↓
Agent starting
        ↓
Authenticated
        ↓
Device Online
```

失敗時もNetwork Engineerが切り分けやすい情報を出す。

例:

```text
Enrollment code expired
DNS resolution failed
HTTPS connection failed
Certificate verification failed
Bootstrap download failed
Agent download failed
Agent authentication failed
Unsupported firmware / Lua version
```

Lua stack traceをPrimary messageにしない。

---

## 9. Copy-paste command generation

GUIで生成するCLI blockには以下を直接埋め込む。

```text
Enrollment endpoint URL
one-time Enrollment Code
Bootstrap destination path
```

目標は2〜3行以内とする。

可能なら2行:

```text
<download bootstrap with lua -e>
<run bootstrap>
```

RTX830実機で確定したCLI block(2行):

```text
lua -e "local r = rt.httprequest({url = '<base>/v1/enrollment/bootstrap', method = 'GET', auth_type = 'bearer', auth_token = '<code>', timeout = 30, save_file = '/routemon_enroll.lua'}) print(r.rtn1, r.rtn2, r.code)"
lua /routemon_enroll.lua
```

RTX830のCLIは引数を`"`で囲むため、Lua source側の文字列はすべて`'`にする。
Bootstrap本体にも`"`とバックスラッシュを入れない(`string.char(34)`で生成する)。

長いLua本体をTerminalへ貼り付ける方式は採らない。

GUIには、Supervisor自動起動のscheduleが未設定ならEnrollment時に1行追加して`save`すること、
また未保存の設定変更があれば一緒に保存されることをcopy-paste blockの説明に表示する。

---

## 10. Security

- Enrollment Codeは15分程度の短期one-time
- CodeはDevice Tokenとして再利用しない
- CodeをURL queryへ入れない
- Code / Device TokenをApplication logへ出さない
- Bootstrap endpointはHTTPSのみを通常運用とする
- Bootstrap配布元URLをRouter側から任意指定させない
- Enrollment成功後はCodeを即失効させる
- 同一Codeのrace/replayはServer側で一度だけ成功させる
- Device TokenはBootstrap sourceとは別のdevice configへ保存する
- GUIでCode再発行時は旧Codeを失効させる

---

## 11. Re-enrollment

Deviceを再登録する場合は既存Device TokenをGUIからRevokeし、新しいEnrollment Codeを発行する。

```text
Admin
  ↓
Re-enroll Device
  ↓
Old Device Token revoke
  ↓
New one-time Enrollment Code
  ↓
New copy-paste block
```

通常のAgent UpdateではEnrollmentを再実行しない。

---

## 13. PoC items

RTX830実機で以下を確認する。

- `lua -e`のquote/escapeを含むcopy-paste安定性
- `rt.httprequest()` Bearer認証でEnrollment Codeを送信可能か
- ResponseをRTFS上の`routemon_bootstrap.lua`へ直接保存可能か
- 2行を連続pasteした際の実行順序
- Bootstrap download失敗時の表示
- 既存同名fileがある場合の挙動
- Bootstrapから正式Agentをdownload/save/startする一連動作
- auto-start設定の追加方法
- 再実行時のidempotency
- Enrollment Code replay/race
- firmware/Lua versionによる差異

### 13.1 PoC結果(RTX830、#13)

| 項目 | 結果 |
| --- | --- |
| `lua -e`のcopy-paste安定性 | OK(2行貼り付けで順に実行。`"`外側 / `'`内側で安定) |
| Bearer認証でCode送信 | OK(`auth_type = 'bearer'`、`true true 200`) |
| Bootstrapのfile保存 | OK(`save_file`でRTFSへ直接保存) |
| Bootstrapからidentity送信〜Agent起動 | OK(`enrolling` -> `device config written` -> agent起動) |
| 進捗表示 | OK(`lifecycle: active` / `hasActiveCredential: true` / `pendingCodeExpiresAt: null`) |
| Agent疎通 | OK(presence `online`、`show status pp 1`がGUI経由で成功) |
| Code replay | OK(使用済みCodeは401) |
| 既存同名file | 上書きされる。`/routemon_bootstrap.lua`へ保存するとSupervisorを壊すため、
  Enrollment用は`/routemon_enroll.lua`に分離した |

`show environment`から取得したserial number等はServerのDBにのみ保存し、log / docへ出力しない。

## 14. Production Enrollment procedure (Issue #141)

Enrollment Bootstrapには、`agent/update/routemon_supervisor.lua`を正本とするSupervisor(slot aへ配置)と、`agent/update/routemon_loader.lua`を正本とする固定のloader(`/routemon_bootstrap.lua`へ配置、#159)を
埋め込む。Router上の`/routemon_bootstrap.lua`は毎回現在のsourceに置き換え、
`loadfile`で構文を確認する。Supervisorが配置されていない場合にAgentを直接起動するfallbackは設けない。

GUIのCLI blockとBootstrapはAgent API endpointを使う。GUI/API listenerとAgent API listenerを
別portで公開する場合は、`AGENT_BASE_URL`にRouterから到達可能なURLを設定する。

起動前に`show status lua running`を読み、`/routemon_enroll.lua`以外の
`/routemon_*.lua` taskをCLI経由で停止する。Enrollment用task自身を停止すると`rt.command`が
deadlockするため、停止対象から除外する(Issue #45)。

Supervisorの起動に成功した後、Enrollment用taskは既存の保存先path
`/routemon_enroll.lua`を`os.remove`で削除する。Enrollmentや配置、schedule設定、Supervisor起動の
途中で失敗した場合は、原因調査のためEnrollment fileを残す。fileを削除するだけで、Enrollment用task自身は
terminateしない。

CONFIGにSupervisorを起動する`schedule at`があればその行を再利用する。無い場合は既存の
`schedule at`番号と重ならない最小番号で`schedule at <N> +15 * lua /routemon_bootstrap.lua`
を追加し、`save`する。利用者のschedule行は削除・上書きしない。追加時の`save`では他の
未保存設定も一緒に保存されるため、GUIのCLI block説明にその旨を表示する。
