# Device Profile Discovery Design

Status: Current specification (Initial design)  
Scope: Core  
Last updated: 2026-09-13

## 1. Purpose

本ドキュメントは、RoutemonがDeviceの接続方式・構成・実状態をどのように収集し、Routemon独自GUIへ表示するかを定義する。

Routemonでは、Router AgentへYAMAHA CONFIGの意味解析を持たせない。

AgentはCONFIGを取得・転送し、CONFIGの解析・正規化・機能追加はServer側(Core Parser)で行う。Server側の実行環境は、deploymentごとに異なりうる。

---

## 2. Core principle

Deviceの詳細情報は、次の3種類を合成して生成する。

```text
Configuration
  「何が設定されているか」

Runtime Status
  「今どう動いているか」

Gateway Observation
  「Gatewayからどう見えているか」

        ↓

Normalized Device Profile
```

CONFIGだけで現在の接続状態を推定しない。

Runtime情報だけで設定意図を推定しない。

---

## 3. Agent responsibility

AgentはDevice Profileの意味を理解しない。

AgentがCONFIG関連で行う処理は原則以下のみとする。

```text
- CONFIG取得要求を受ける
- rt.command("show config")を実行する
- CONFIG_SNAPSHOTとしてGatewayへ返す
```

Agentでは行わない:

```text
- CONFIG parser
- PPPoE/DHCP/MAP-E等の判定
- CONFIG diff
- CONFIG semantic normalization
- CONFIG hashによる変更判定
```

Agent更新なしでServer側Parserを拡張できることを重視する。

---

## 4. CONFIG snapshot metadata

CONFIG snapshotには最低限以下を含める。

```text
device_id
captured_at
model
firmware_revision
agent_version
config_body
```

必要に応じて以下を追加できる。

```text
source
reason
router_uptime
```

`reason`例:

```text
agent_start
config_changed
manual
periodic_reconcile
```

Model/Firmware情報をCONFIGと同時に保持し、将来のParserで機種・Firmware差異を扱えるようにする。

---

## 5. CONFIG送信タイミング

### 5.1 Agent起動時 / Router再起動時

Agent起動後はCONFIG snapshot送信を必須とする。

目的:

- Server側Device Profileとの再同期
- Router再起動後の状態復旧
- CONFIG変更イベント取りこぼしの補完
- Agent再導入後の初期同期

```text
Agent start
  ↓
Authenticated Gateway sync
  ↓
CONFIG snapshot
```

### 5.2 CONFIG変更検知時

RouterがCONFIG変更を示すSYSLOGを安定して出力できる場合、通常SYSLOG経路で変更EventをServer側へ通知し、Server側からCONFIG取得要求を行う。

```text
Router CONFIG changed
  ↓
SYSLOG
  ↓
Agent -> Gateway
  ↓
Server detects config-change event
  ↓
debounce
  ↓
CONFIG_FETCH_REQUEST
  ↓
CONFIG_SNAPSHOT
```

Agent自身はCONFIG変更イベントの意味解析を極力持たず、通常SYSLOGとして転送することを優先する。

#### RTX830実機の挙動(検証済み: Issue #5、2026-09-20)

**個々の設定commandはSYSLOGへ出ない。`save`が出る。**

```text
2026/09/20 22:03:49: Configuration saved in "CONFIG0" by TELNET
2026/09/09 22:27:08: Configuration saved in "CONFIG0" by HTTPD
```

- 形式: `Configuration saved in "<CONFIG番号>" by <実行元>`。実行元は`TELNET` / `HTTPD`等
- `syslog notice` / `syslog info`の設定に関係なく出力される(両方offでも出た)
- CLIで設定を変更しただけでは1行も出ない。`save`するまで検知できない
- 連続`save`は**抑制されず、実行回数ぶん出力される**(3回連続で3行)
- このsyslog行は通常のSYSLOG経路でServerまで届くことを実機で確認済み

つまりこの経路で検知できるのは「保存された」という事実であり、**未保存の変更は検知できない**。
`show config`は動作中configを返すため、未保存の変更もCONFIG snapshotには現れる。この差を
埋めるには定期取得(`periodic_reconcile`、§5.4)を併用する。

### 5.3 Manual refresh

Authorized UserがDevice画面から手動でCONFIG再取得を要求できるようにする。

### 5.4 Periodic reconciliation

SYSLOGベースの変更検知に取りこぼしの可能性が残る場合、低頻度の定期再取得を追加できる。

Community版では既定値を**24時間に1回**とする。未保存の変更とSYSLOG取りこぼしを遅くとも
1日程度で補完できる一方、`show config`実行によるRouterのCPU負荷と通信量を抑えられる。
内容が同じ場合はServer側のdedupeで世代が増えないため、定期取得で増えるコストは主に
取得時の通信とRouter側の処理になる。常時Pollingや数分単位の取得は行わない。

取得時刻はDevice IDから決めた安定した位相へ分散する。Community版は10分ごとに軽い
スイープを行い、activeかつGatewayから`online`と観測できるDeviceのうち、位相を過ぎた
ものだけへ`periodic_reconcile`を要求する。位相をUnix epoch基準で計算するため、Server
再起動直後に全Deviceへ一斉送信されない。取得時刻にofflineだったDeviceは要求を捨てず、
次回スイープでonlineになった時に1回取得してから次の周期へ進む。
位相を過ぎてofflineだったDeviceの再接続時には、Agent起動時の`agent_start`と
`periodic_reconcile`が重なることがあるが、内容が同じならdedupeで世代は増えないため許容する。

採用値:

```text
1日1回(24時間)
```

これは常時Pollingを目的とせず、Server側状態とのreconciliation用とする。

---

## 6. Server-side processing

CONFIG解析はServer側のCore Parserで行う。

```text
CONFIG_SNAPSHOT
      ↓
Core Config Parser (server-side)
      ├── hash / dedupe
      ├── safe parse
      ├── normalized facts
      ├── Device Profile update
      └── encrypted CONFIG backup
```

GatewayはCONFIGの意味を原則解釈せず、認証・frame validation・size validation・中継を担当する。

---

## 7. Hash / dedupe

Server側でCONFIG本文のcontent hashを生成する。

```text
new_hash == previous_hash
  ↓
CONFIG実質変更なし
```

変更イベントが複数回発生した場合でも、同一CONFIGであれば不要なBackup世代やProfile更新を増やさない。

Hashにはsha-256を使う(#6で確定)。

`show config`の出力は取得のたびに`# Reporting Date:`行が変わるため、同一判定では
この行を除いたhashを使う(RTX830実機で確認、#6)。保存する本文は加工しない
(`docs/core/config-backup-design.md` §4)。

Agent側へhash処理を実装することは必須としない。

---

## 8. Debounce

GUI操作や複数CLI commandによってCONFIG変更SYSLOGが短時間に複数発生する場合、Server側でdebounceする。

初期候補:

```text
最後のCONFIG変更eventから30秒後に1回取得
```

Issue #5の実機結果: RTX830は連続`save`を抑制せず、実行回数ぶんSYSLOGを出す(3回連続で3行)。
GUI操作でも複数回保存すれば同じだけ出るため、**debounceはServer側に必要**。
最後のeventから30秒という初期候補のままで問題ない(1回の保存あたり1行なので、短時間に
大量発生する性質のものではない)。

---

## 9. Parser design

完全なYAMAHA CONFIG interpreterは作らない。

Routemon独自GUIで必要なfactsのみを抽出する。

初期対象候補:

### Internet / WAN

- IPv4 PPPoE
- IPv4 DHCP client
- Static IPv4
- Default route
- IPv6 IPoE
- DHCPv6 client / Prefix Delegation
- MAP-E
- DS-Lite等のIPv4 over IPv6

### LAN

- Interface address
- DHCP Server
- IPv6 RA
- Prefix assignment

### Tunnel / VPN

- Tunnel type
- IPsec
- L2TP
- MAP-E等

### System

- Hostname
- 関連する基本設定

未知commandは無理に解釈せずignoreできる設計とする。

Parserは機種・Firmware Revisionを入力として利用できるようにする。

---

## 10. Example normalized facts

```json
{
  "internet": {
    "ipv4": {
      "method": "pppoe",
      "pp": 1,
      "physical_interface": "lan2"
    },
    "ipv6": {
      "method": "dhcpv6-pd",
      "physical_interface": "lan2"
    },
    "ipv4_over_ipv6": {
      "method": "map-e",
      "provider_type": "ocn",
      "tunnel": 1
    }
  }
}
```

重要:

YAMAHAではIPv4 PPPoEとIPv6 IPoE等が同時に存在し得るため、単一の`connection_type`へ押し込まない。

IPv4 / IPv6 / IPv4-over-IPv6等を分離して表現する。

---

## 11. Runtime status

CONFIG factsとは別に、Runtime Collectorで現在状態を取得する。

例:

```text
show status pp
show status tunnel
show status ipv6 dhcp
show ipv6 address
show status dhcpc
show environment
show status lan*
```

Runtime Collectorは必要なタイミング・画面・監視要件に応じてCommandを実行し、正規化されたRuntime factsへ変換する。

例:

```json
{
  "pp1": {
    "configured": true,
    "enabled": true,
    "runtime_state": "connected"
  }
}
```

CONFIGの`configured`とRuntimeの`runtime_state`を内部的に分離する。

---

## 12. Gateway observation

GatewayはAuthenticated Agent connectionから以下のような外部観測情報を取得できる。

- Observed source IPv4/IPv6
- Current Gateway
- Last authenticated Agent traffic
- Connection timing

Router内部で認識するWAN addressとGateway observed source IPは同一とは限らないため、別フィールドとして保持する。

---

## 13. Device Profile

Routemon独自GUIは、CONFIG Parser / Runtime Collector / Gateway Observationを統合したDevice Profileを利用する。

例:

```text
RTX830 / Fukuoka Site

Agent
  Online

IPv4
  Method: PPPoE
  Status: Connected
  Interface: lan2 / pp1

IPv6
  Method: IPoE / DHCPv6-PD
  Prefix: xxxx::/56

IPv4 over IPv6
  Method: MAP-E
  Service: OCN Virtual Connect
  Tunnel: tunnel1
  Status: Up

External
  Gateway observed IP: xxx.xxx.xxx.xxx
```

---

## 14. Raw CONFIG security

YAMAHA CONFIGにはCredential/Secretが含まれる可能性がある。

例:

- PPP credential
- IPsec pre-shared key
- Password
- SNMP community
- その他Secret

したがってRaw CONFIGは機微情報として扱う。

禁止事項:

```text
- console.log(config_body)
- Error logへraw request bodyを出力
- AnalyticsへCONFIG本文を送信
- Plaintext CONFIGを永続storageへ恒久保存
```

Server側で解析後、Device Profileには必要なnon-secret normalized factsのみ保存する。

CONFIG BackupとしてRaw CONFIGを保存する場合は、`docs/core/config-backup-design.md`のapplication-level encryption方針に従う。

---

## 15. Parser processing budget

初期Parserは以下を優先する。

- 1 CONFIG snapshot単位の軽量処理
- line-oriented parse
- 必要なcommandのみ抽出
- bounded payload
- 複雑な全文解析を避ける

Parserの実行環境やcapacityが変わっても、Router / Agent Gateway間のprotocolは変更せず、Agent更新やアーキテクチャ再設計を要求しない。

---

## 16. Future extension

新しい検出項目は原則Server側Parser追加のみで対応する。

例:

```text
Parser v1
- PPPoE
- DHCP

Parser v2
+ MAP-E
+ DS-Lite

Parser v3
+ Additional VPN facts
```

Raw CONFIG Backupが存在する場合は、将来のParserで過去snapshotを再解析することも可能とする。
