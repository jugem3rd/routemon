# Topology Design

Status: Proposal for design review (Issue #65)
Scope: Core / Community / Web
Last updated: 2026-09-21

Related:

- `docs/core/device-profile-discovery-design.md`
- `docs/core/data-model.md`
- `docs/core/config-backup-design.md`
- `packages/core/src/configProfile.ts`
- `apps/community/src/config/configSnapshots.ts`

本ドキュメントは、YAMAHA RouterのCONFIGと、Routemonが既に持つDevice情報から、複数Deviceを横断した論理トポロジーを生成・表示するための設計案である。Issue #65のPoCを対象とし、実装はこの設計のレビュー・承認後に開始する。

## 1. PoCの目的と前提

PoCで扱うのは、同一Tenant内のYAMAHA Routerについて次の情報を正規化し、1画面に表示することである。

- LANのinterfaceとIPv4 subnet
- WANの設定方式と、CONFIGから判明する静的endpoint
- default route
- VPN tunnelの番号、種別、endpoint、経路
- 複数Device間のVPN peer候補

CONFIGから物理L2の配線やPC・サーバーを確定することは目的にしない。CONFIGに明示された事実と、複数Deviceの値を突合した推定を別々に扱う。

既存のCONFIG処理には次の制約があるため、その境界を維持する。

- Router AgentはCONFIGを取得・転送するだけで、意味解析を持たない。
- raw CONFIGは暗号化されたBackupに保存され、Topology APIやTopology Modelには渡さない。
- Device ProfileはServer側のCore Parserで作り、`device_profiles`に保存する。
- Parserが知らないcommandは無視し、1つの未知commandで他の既知factsを失わない。

## 2. 現状調査と設計判断

### 2.1 既存のDevice Profile

`packages/core/src/configProfile.ts`の`parseConfig()`は、既に次のCONFIG factsを抽出している。

- `ip lanN address` / `ip wanN address`のinterface address
- `pp select`と`pppoe use`によるIPv4接続方式
- DHCP、IPv6、DHCPv6-PD、MAP-E / DS-Lite
- `ip route default gateway`
- `tunnel select`と`tunnel encapsulation`

`apps/community/src/config/configSnapshots.ts`は、CONFIG Snapshotを保存したときにこのParserを呼び、`device_profiles`へ1 Device分のProfileを保存する。`GET /api/devices/:deviceId/profile`とDevice DetailのCONFIG tabは、このProfileを読み取る既存の公開面である。

一方、現在のProfileには、IPsecのremote addressやrouteとtunnelの対応がない。また、現在の`lan`配列は既存互換のために`ip lanN` / `ip wanN`の静的addressをまとめて保持しており、Topologyで「LAN」と断定するためのrole情報には使えない。

### 2.2 1つのProfileを正本にする

新しい`topology_profiles`テーブルや、CONFIGをもう一度読むTopology専用Parserは作らない。

```text
YAMAHA CONFIG
      |
      v
parseConfig()  ->  DeviceProfile (1 Device分の正規化facts、既存storageの正本)
      |
      +----> GET /api/devices/:deviceId/profile
      |
      +----> TopologyBuilder(複数DeviceのProfile + Device metadata)
                         |
                         v
                  Topology Model (API用の一時的なグラフ投影)
```

`DeviceProfile`を拡張し、interface・network・route・VPN tunnelの設定factsをそこへ追加する。Topology Modelは、そのProfileを複数Device分集め、参照関係と推定リンクを加えたAPI / UI向けの投影とする。Topology Model自体はPoCでは永続化しない。

既存APIを同時に壊さないため、現在の`internet`、`lan`、`defaultRoute`、`tunnels`は互換フィールドとして残す。新しいTopology実装はcanonicalな新フィールドから読む。互換フィールドはParserがcanonical factsから生成する表示用projectionであり、別々に更新・保存する入力ではない。これにより、既存のDevice Detailを守りながら、同じCONFIGを2つの独立したParserで解釈する二重管理を避ける。

## 3. Topology Model

### 3.1 共通の証拠情報

Topologyの各factとlinkには、値がどこから来たかを示す`evidence`を持たせる。`source`は値の確からしさではなく、生成経路を表す。

```ts
type FactSource = "configured" | "observed" | "inferred";

type Evidence = {
  source: FactSource;
  /** CONFIG取得時刻または観測・推定が作られた時刻。UTC ISO 8601。 */
  at?: string;
  /** configured factの元になったProfileのhash。raw CONFIG本文は持たない。 */
  configHash?: string;
  /** inferredの場合の決定論的なrule名。 */
  rule?: string;
  /** 推定に使ったfactのstable id。 */
  inputs?: string[];
  /** UIに表示してよい短い説明。CONFIGの生行は入れない。 */
  summary?: string;
};
```

意味は次の通りである。

| source | 意味 | PoCでの例 |
| --- | --- | --- |
| `configured` | CONFIGに明示された値 | `ip lan1 address`、`ipsec ike remote address`、static route |
| `observed` | Runtime CollectorまたはGatewayが実際に観測した値 | Agent presence、将来のtunnel UP/DOWN |
| `inferred` | 複数のconfigured / observed factsを規則で突合した値 | remote endpointと別DeviceのWAN addressの完全一致 |

`inferred`は`configured`の別名ではない。たとえ両端のCONFIGが整合していても、Device間の関係そのものは推定として保持する。

### 3.2 トップレベルのスキーマ

APIで返すTopology Modelは、normalized entityの配列とGraph用linkを分ける。IDはレスポンス生成のたびに変わらないよう、Device ID・interface名・tunnel番号等から決定論的に作る。

```ts
type TopologyModel = {
  schemaVersion: 1;
  generatedAt: string;
  devices: TopologyDevice[];
  interfaces: TopologyInterface[];
  networks: TopologyNetwork[];
  routes: TopologyRoute[];
  vpnTunnels: TopologyVpnTunnel[];
  neighbors: TopologyNeighbor[];
  links: TopologyLink[];
  warnings: TopologyWarning[];
};
```

すべての配列は常に返す。情報がない場合は`[]`とし、CONFIGがないDeviceや解析が部分的なDeviceも`devices`には残す。これにより、1台の不完全なCONFIGで他DeviceのTopology全体を表示できなくなることを防ぐ。

### 3.3 Device

```ts
type TopologyDevice = {
  id: string;
  name: string;
  /** PoCでは "yamaha"。Topology Model自体はvendor-neutralにする。 */
  vendor: string;
  model: string | null;
  hostname: string | null;
  lifecycle: string;
  interfaceIds: string[];
  routeIds: string[];
  vpnTunnelIds: string[];
  /** Parserのinternet methodから導出する、動的WANも含む接続方式。 */
  wan: TopologyWanSummary | null;
  profile: {
    capturedAt: string;
    configHash: string;
  } | null;
  presence?: {
    status: "online" | "unstable" | "offline" | "unknown";
    lastSeenAt: string | null;
    evidence: Evidence[];
  };
};

type TopologyWanSummary = {
  ipv4?: {
    method: "pppoe" | "dhcp" | "static";
    interface?: string;
    pp?: number;
    evidence: Evidence[];
  };
  ipv6?: {
    method: "dhcpv6-pd" | "dhcpv6" | "ra" | "static";
    interface?: string;
    evidence: Evidence[];
  };
  ipv4OverIpv6?: {
    method: "map-e" | "ds-lite";
    tunnel?: number;
    evidence: Evidence[];
  };
};
```

`wan`はParserがCONFIGから抽出した`internet.ipv4`、`internet.ipv6`、`internet.ipv4_over_ipv6`の方式をTopology用に正規化したconfigured factである。addressが動的でCONFIGに書かれないPPPoE / DHCP / IPoEも方式を保持する。`presence`はAgent Gatewayの観測であり、WAN addressやVPN UP/DOWNの代用にはしない。`serialNumber`、MAC address、Credential、CONFIG本文はTopology Modelに含めない。

### 3.4 Interface / Network

```ts
type TopologyInterface = {
  id: string;
  deviceId: string;
  name: string;
  role: "lan" | "wan" | "tunnel" | "unknown";
  addresses: TopologyAddress[];
  networkIds: string[];
  evidence: Evidence[];
};

type TopologyAddress = {
  family: "ipv4" | "ipv6";
  /** static addressはCIDR、DHCP/PPPoE等で未確定なら省略する。 */
  address?: string;
  assignment: "static" | "dhcp" | "pppoe" | "unknown";
  evidence: Evidence[];
};

type TopologyNetwork = {
  id: string;
  deviceId: string;
  family: "ipv4" | "ipv6";
  cidr: string;
  kind: "lan" | "wan" | "tunnel" | "unknown";
  interfaceIds: string[];
  evidence: Evidence[];
};
```

Network IDはCIDRだけで決めず、少なくともDevice IDとinterfaceを含める。同じ`192.168.0.0/24`を別拠点で使っている場合に、同一LANだと誤って結合しないためである。Networkを跨ぐ接続を推定する機能はPoCにはない。

YAMAHAの`ip lanN`は物理ポート名だけではLAN側かWAN側かを一意に決められない場合がある。Parserは、`pppoe use`、`ip pp address`、DHCP clientとdefault route等の明示的な関係がある場合だけ`wan`と分類する。判断できない場合は`unknown`とし、Topology UIでLANと断定しない。

既存の`DeviceProfile.lan`は互換表示のため残すが、Topologyの`TopologyInterface.role`や`TopologyNetwork.kind`はcanonical factsから生成する。

### 3.5 Route

```ts
type TopologyRoute = {
  id: string;
  deviceId: string;
  destination: string;
  gateway: {
    kind: "ip" | "dhcp" | "pp" | "tunnel" | "interface" | "unknown";
    value: string;
  };
  interfaceId?: string;
  evidence: Evidence[];
};
```

PoCでは`ip route default gateway ...`をdefault routeとして扱い、可能な場合は`tunnel N`をgatewayとするprefix routeをVPNのremote networkに関連付ける。理解できないrouteは捨てずにTopology全体を失敗させるが、無理に別Deviceのnetworkと結び付けない。

### 3.6 VPN Tunnel

```ts
type TopologyEndpoint = {
  kind: "ipv4" | "ipv6" | "fqdn" | "dynamic" | "unknown";
  value: string;
};

type TopologyVpnTunnel = {
  id: string;
  deviceId: string;
  tunnelNumber: number;
  type: "ipsec" | "l2tp-ipsec" | "l2tpv3" | "gre" | "ipip" | "unknown";
  /** remote endpointがanyのL2TP/IPsec受けはDevice詳細へ出し、linkを作らない。 */
  remoteAccess?: true;
  interfaceId?: string;
  localEndpoint?: TopologyEndpoint;
  remoteEndpoint?: TopologyEndpoint;
  localNetworkIds: string[];
  remoteNetworkIds: string[];
  state?: {
    status: "up" | "down" | "unknown";
    evidence: Evidence[];
  };
  evidence: Evidence[];
};
```

`state`はObserved情報が取得できた場合だけ付ける。CONFIGに`tunnel enable`があることや、Profileが存在することを`up`とは解釈しない。PoCの初期実装ではRuntime Collectorが未実装なので、通常は`state`を省略する。

`localNetworkIds`は同じDeviceのLAN interfaceから決定できる場合だけ、`remoteNetworkIds`は`tunnel N`をgatewayにしたrouteから決定できる場合だけ入れる。不明な値をremote側のCONFIGから逆算して埋めない。

`ipsec ike remote address ... any`を持つL2TP/IPsecはremote access受けとして記録する。相手Deviceが不特定のため外部nodeやVPN linkは作らず、Deviceカードに有効状態を表示し、詳細にtunnel番号・種別・local endpointを出す。

IPsec pre-shared key、PPP認証情報、password等はParserが読み取らず、`evidence`にも入れない。

禁止: Topology ModelおよびTopology APIのレスポンスには、IPsec pre-shared key、PPPoE認証情報、raw CONFIGを含めない。

### 3.7 Link / Neighbor / Warning

```ts
type TopologyNodeRef = {
  type: "device" | "network" | "external";
  id: string;
  label?: string;
};

type TopologyLink = {
  id: string;
  kind: "network-attachment" | "wan" | "vpn";
  source: TopologyNodeRef;
  target: TopologyNodeRef;
  interfaceId?: string;
  vpnTunnelId?: string;
  /** 双方向の設定を1本へ集約した場合に参照する全tunnelのstable id。 */
  vpnTunnelIds?: string[];
  /** 片方向だけなら矢印と注記を出し、双方向なら1本の無矢印linkにする。 */
  vpnDirection?: "single" | "bidirectional";
  match?: {
    status: "matched" | "unmatched" | "ambiguous";
    confidence?: "high" | "medium" | "low";
    candidateDeviceIds?: string[];
  };
  evidence: Evidence[];
};

type TopologyNeighbor = {
  id: string;
  sourceDeviceId: string;
  targetDeviceId?: string;
  targetAddress?: string;
  protocol: "lldp" | "arp" | "route" | "unknown";
  evidence: Evidence[];
};

type TopologyWarning = {
  code:
    | "profile_missing"
    | "partial_profile"
    | "unsupported_feature"
    | "ambiguous_vpn_peer";
  deviceId?: string;
  factId?: string;
  message: string;
};
```

`network-attachment`と`wan`はCONFIGの明示的な関係から作るため、Model上は通常`configured`のfactになる。ただし現在のSVGではこれらの線を描かず、LAN / WANの値をDeviceカードへ表示する。`vpn`のうちDevice間のtargetを突合で決めたものは`inferred`である。remote endpointに相手が見つからない場合もVPNのconfigured factは残し、targetを`external`として表示する。

各Deviceの各`tunnel N`は`TopologyVpnTunnel`として必ず残し、どのCONFIGが根拠かを失わない。両端の`remote endpoint`が相手Deviceの静的WAN IPv4へ一意にmatchedし、同じDevice pairの逆向きlinkも存在する場合だけ、graph用の`TopologyLink`を1本へ集約する。集約linkの`vpnTunnelIds`に両端のtunnel IDを保持し、detailsでは各tunnelの番号・endpoint・networkを表示する。片側にしかmatched linkがない場合は`vpnDirection: "single"`として元の向きを保持し、UIで矢印と「片側のみ」を表示する。

`neighbors`はスキーマ上の拡張点として持つが、PoCでは常に空配列とする。LLDP、ARP、MAC table等がない状態で物理隣接を生成しない。

### 3.8 Topology Modelの例

以下は設計確認用に自分で作った値の例であり、実機から取得したCONFIGではない。IP addressはRFC 5737のdocumentation rangeを使う。

```json
{
  "schemaVersion": 1,
  "generatedAt": "2026-09-21T00:00:00.000Z",
  "devices": [
    {
      "id": "router-hq",
      "name": "HQ",
      "vendor": "yamaha",
      "model": "RTX1300",
      "hostname": "hq-router",
      "lifecycle": "active",
      "interfaceIds": ["router-hq:lan1", "router-hq:wan"],
      "routeIds": ["router-hq:default"],
      "vpnTunnelIds": ["router-hq:tunnel:1"],
      "wan": {
        "ipv4": { "method": "static", "interface": "wan", "evidence": [{ "source": "configured" }] }
      },
      "profile": {
        "capturedAt": "2026-09-20T10:00:00.000Z",
        "configHash": "sha256:example-hash"
      }
    },
    {
      "id": "router-branch",
      "name": "Branch",
      "vendor": "yamaha",
      "model": "RTX1220",
      "hostname": "branch-router",
      "lifecycle": "active",
      "interfaceIds": ["router-branch:lan1", "router-branch:wan"],
      "routeIds": ["router-branch:default"],
      "vpnTunnelIds": [],
      "wan": null,
      "profile": {
        "capturedAt": "2026-09-20T10:01:00.000Z",
        "configHash": "sha256:another-example-hash"
      }
    }
  ],
  "interfaces": [
    {
      "id": "router-hq:lan1",
      "deviceId": "router-hq",
      "name": "lan1",
      "role": "lan",
      "addresses": [
        {
          "family": "ipv4",
          "address": "192.168.10.1/24",
          "assignment": "static",
          "evidence": [{ "source": "configured", "configHash": "sha256:example-hash" }]
        }
      ],
      "networkIds": ["router-hq:network:192.168.10.0/24"],
      "evidence": [{ "source": "configured", "configHash": "sha256:example-hash" }]
    }
  ],
  "networks": [
    {
      "id": "router-hq:network:192.168.10.0/24",
      "deviceId": "router-hq",
      "family": "ipv4",
      "cidr": "192.168.10.0/24",
      "kind": "lan",
      "interfaceIds": ["router-hq:lan1"],
      "evidence": [{ "source": "configured", "configHash": "sha256:example-hash" }]
    }
  ],
  "routes": [],
  "vpnTunnels": [
    {
      "id": "router-hq:tunnel:1",
      "deviceId": "router-hq",
      "tunnelNumber": 1,
      "type": "ipsec",
      "localEndpoint": { "kind": "ipv4", "value": "203.0.113.10" },
      "remoteEndpoint": { "kind": "ipv4", "value": "203.0.113.20" },
      "localNetworkIds": ["router-hq:network:192.168.10.0/24"],
      "remoteNetworkIds": [],
      "evidence": [{ "source": "configured", "configHash": "sha256:example-hash" }]
    }
  ],
  "neighbors": [],
  "links": [
    {
      "id": "router-hq:vpn:1",
      "kind": "vpn",
      "source": { "type": "device", "id": "router-hq" },
      "target": { "type": "device", "id": "router-branch" },
      "vpnTunnelId": "router-hq:tunnel:1",
      "match": { "status": "matched", "confidence": "high" },
      "evidence": [
        {
          "source": "inferred",
          "rule": "vpn-remote-address-equals-wan-address",
          "inputs": ["router-hq:tunnel:1", "router-branch:wan:address:203.0.113.20"],
          "summary": "VPN remote endpoint matches exactly one Device WAN address"
        }
      ]
    }
  ],
  "warnings": []
}
```

実際のレスポンスでは、配列の各要素に必要な`evidence`を付ける。例では読みやすさのため一部の要素を省略している。

## 4. Device Profileとの関係

### 4.1 Profileを拡張する範囲

`DeviceProfile`に次のcanonical factsを追加する案とする。

```ts
type DeviceProfile = {
  // 既存。既存APIとの互換projection。
  internet: ...;
  defaultRoute?: string;
  lan: ...;

  // 既存APIとの互換projection。id / encapsulationだけを返す。
  tunnels: { id: number; encapsulation: string }[];

  // 追加するcanonical facts。
  interfaces: ProfileInterface[];
  networks: ProfileNetwork[];
  routes: ProfileRoute[];
  vpnTunnels: ProfileTunnel[];
  parserVersion: 1;

  model?: string;
  firmwareRevision?: string;
};
```

`ProfileTunnel`はcanonicalな`vpnTunnels`の要素で、`id` / `encapsulation`に加えて種別、読める場合のendpoint、L2TP/IPsecのremote access受けフラグを持つ。Topology側ではこの配列を`TopologyVpnTunnel`へ正規化する。古い保存Profileの`ipsecTunnels`は互換入力として読み、新規Parserは出力しない。既存の`profile.tunnels`はid / encapsulationだけの互換projectionとし、endpointを二重に保存しない。

`internet`、`lan`、`defaultRoute`は既存のDevice Detailと`GET /api/devices/:deviceId/profile`の互換のために維持する。新しいParserでは、canonical factsを先に作り、これらをそこから導出する。既存Consumerがなくなった将来のAPI versionで整理する余地は残すが、Issue #65で既存APIを破壊しない。

既存の`device_profiles`にcanonical fieldsがまだないProfileが残っていても、TopologyBuilderは不足する配列を空として扱い、取得済みのlegacy factsだけでnodeを作る。次回のCONFIG Snapshotで新しいParserがcanonical fieldsを埋める。過去Backupの一括再解析やmigrationでraw CONFIGを読み直すことは、このPoCの責務にしない。

### 4.2 Configured / Observed / Inferredの境界

- `DeviceProfile`に保存するCONFIG由来の値は`configured`である。
- Gateway presenceや将来のRuntime Collectorの結果は`DeviceProfile`へ混ぜず、Topology生成時に別sourceのfactとしてjoinする。
- 複数Profileの突合で作るDevice間`vpn` linkだけを`inferred`とする。
- `inferred`の結果をProfileへ書き戻さない。推定ルールの変更で再生成できる派生値だからである。

この分離により、CONFIGに「tunnelがある」こと、GatewayからAgentが見えていること、VPN peerが一致したことを、それぞれ別の表示として保てる。

## 5. Yamaha CONFIG ParserのPoC範囲

完全なYAMAHA CONFIG interpreterは作らない。既存Parserのline-orientedな方針を拡張し、次の決定論的なcommand familyだけを対象にする。

| CONFIGの情報 | Profileへ正規化する値 | PoCでの扱い |
| --- | --- | --- |
| `ip lanN address <CIDR>` / `ip wanN address <CIDR>` | interface address、network | 静的IPv4 / IPv6のうち確認できるもの。roleを明示的関係から分類 |
| `ip lanN address dhcp`等 | interfaceのassignment | addressは未確定のまま`dhcp`と記録 |
| `pp select N`、`pppoe use ...`、`ip pp address ...` | PPP interface、WAN方式、静的endpoint | 認証情報は読まない。動的なpublic addressを捏造しない |
| `ip route default gateway ...` | default route | 既存`defaultRoute`との互換projectionも作る |
| `ip route <prefix> gateway tunnel N` | route、VPN remote network候補 | tunnelとの対応が明示できた場合だけ関連付ける |
| `tunnel select N`、`tunnel encapsulation ipsec` | IPsec tunnel number / type | `tunnel N`単位で保持 |
| `tunnel encapsulation l2tp`と内側の`ipsec tunnel ...` | L2TP/IPsec type | 内側にIPsec設定がある場合だけ認識 |
| `tunnel encapsulation l2tpv3` / `l2tpv3-raw` | L2TPv3 type | `l2tpv3`として保持 |
| `tunnel encapsulation gre` / `ipip` | GRE / IPIP type | 種別付きで保持 |
| `ipsec tunnel ...`、`ipsec ike local address ...` | IPsec local endpoint | 読めるliteral addressだけ |
| `ipsec ike remote address ...` | remote endpoint | literal IPv4/IPv6は保持、FQDNは表示するがPoCでは突合しない |
| `ipsec ike remote address ... any` | L2TP/IPsec remote access受け | 相手候補やVPN linkを作らず、Device詳細へ表示 |
| `tunnel endpoint address ...`、`tunnel endpoint local/remote address ...`、`ip tunnel remote address ...` | L2TPv3 / GRE / IPIP endpoint | 読める範囲だけconfigured factとして保持 |
| `ip tunnel address ...` | tunnel interface address / network | 読める場合だけconfigured factとして保持 |

次は候補として認識しても、PoCの合格条件には含めない。

- VLAN
- DHCP lease / DHCP serverのclient一覧
- NAT descriptor
- PPTP等の対象外VPN詳細
- LLDP、ARP、MAC table

未対応の項目があっても、対応済みのLAN・WAN・route・VPN factsは返す。Parserのエラー・warningを追加する場合も、raw lineやsecret値ではなく、`unsupported_feature`等の非機密な分類だけを保存する。

## 6. 複数DeviceのVPN peer matching

### 6.1 対象と正規化

初期ルールは意図的に完全一致だけに絞る。

1. 同一Tenantの、最新Profileが存在するDeviceだけを候補にする。
2. 各Deviceから、CONFIGに明示された静的なWAN IPv4 addressだけを候補に集める。`ip pp address dhcp`やGatewayの`observedSourceIp`はWAN address候補にしない。
3. remote access受けを除く各VPN tunnelの`remoteEndpoint`がliteral IPv4の場合、表記を正規化してWAN候補と完全一致させる。VPN種別によって条件を変えない。DNS解決や外部ネットワークへの問い合わせは行わない。
4. 自Device自身は候補から除外する。
5. 一意に1台へ一致した場合だけ、`target.deviceId`を設定した`inferred` linkを作る。

### 6.2 一致しない・複数一致する場合

- 一致しない場合: `TopologyVpnTunnel`を残し、`external` nodeへ`unmatched`のVPN linkを作る。remote endpointと「Device不明」をUIに表示する。
- 複数Deviceに一致する場合: 誤ったDeviceを選ばず、`external` nodeへ`ambiguous` linkを作り、`candidateDeviceIds`をwarning/detailへ残す。
- remote endpointがFQDN、dynamic、未解析の場合: 通常のVPNはendpointをconfigured factとして表示し、peer linkは`unmatched`とする。remote access受けとして認識した`any`は例外としてlinkを作らない。
- 一意の完全一致だけをPoCの`confidence: "high"`とする。medium / low confidenceの推定は作らない。

推定根拠は次のようにstable fact IDを参照する。文字列化したCONFIG本文やsecretは保存しない。

```json
{
  "source": "inferred",
  "rule": "vpn-remote-address-equals-wan-address",
  "inputs": [
    "router-hq:tunnel:1",
    "router-branch:wan:address:203.0.113.20"
  ],
  "summary": "VPN remote endpoint matches exactly one Device WAN address"
}
```

このルールではFQDN、DDNS、動的IP、NAT配下、IKE ID、endpointとWAN addressが異なる構成、hub-and-spokeの役割判定は扱わない。将来ルールを追加する場合も、既存の`rule`名とconfidenceを上書きせず、新しいevidenceとして追加する。

## 7. API

### 7.1 Endpoint

Community版の初期endpointは次の1つとする。

```text
GET /api/topology
```

- ログイン済みのTenant member (`admin` / `viewer`) が読める。
- `tenantId`はログインセッションから決まり、queryやbodyで指定させない。
- Tenantに属する全Deviceを対象にする。ProfileがないDeviceもnodeとして返す。
- 最新の`device_profiles`だけを使う。CONFIG Historyや過去Topologyの比較は対象外。
- `generatedAt`はリクエスト時に作る。Topologyの永続tableやsnapshotは作らない。
- raw CONFIG、CONFIG download用の権限境界、secret値は返さない。
- `Cache-Control: no-store`を付け、Profile更新後に古いTopologyを固定表示しない。

レスポンスは次の形とする。

```json
{
  "topology": {
    "schemaVersion": 1,
    "generatedAt": "2026-09-21T00:00:00.000Z",
    "devices": [],
    "interfaces": [],
    "networks": [],
    "routes": [],
    "vpnTunnels": [],
    "neighbors": [],
    "links": [],
    "warnings": []
  }
}
```

認証エラーは既存APIと同じく401/403とする。個別CONFIGのParserが失敗しても、対象Deviceに`profile_missing`または`partial_profile` warningを付け、可能なfactsを含む200レスポンスを返す。全Tenant分のTopologyを500にしない。

### 7.2 実装の接続点

Topology routeは、既存のDevice routeと同じTenant / authorization境界で構成する。実装時は、次のいずれかの小さなservice interfaceを`ConfigSnapshots`の上に置く。

- Tenant内の最新Profileを列挙する読み取りmethodを`ConfigSnapshots`へ追加する。
- または、Tenantを必ず引数に取る`TopologyService`へProfile読み取りを委譲する。

どちらを選んでも、現在の`profile(deviceId)`のようにIDだけで他Tenantのrowを返せる形を新APIで拡大しない。Topology用の読み取りは必ず`tenant_id`とDevice rowの所属を確認する。

別のclientでも同じ論理レスポンスを使えるよう、APIのfield名はWeb APIに合わせたcamelCaseとする。既存Device Profileの`ipv4_over_ipv6`等は既存API互換のため変更しない。

## 8. 描画方法

依存は追加しない。Graph library、CSS framework、canvas libraryは導入せず、Reactと既存CSS tokenだけでSVGを描く。

### 8.1 画面

既存Sidebarへ`Topology`を追加し、hash route `#/topology`で開く。初期PoCではLogical / VPNを分離せず、1画面に次を表示する。

1. header: `Topology`、生成時刻、再読込
2. legend: `Configured` / `Observed` / `Inferred`
3. SVG graph: Deviceカード、VPN link。LAN / WANはDeviceカード内に表示し、相手不明または候補複数のVPNだけexternal endpointを表示する
4. warning: 未解析、peer不明、ambiguous、Profileなし
5. selection detail: nodeまたはlinkをクリックしたときのdetails

Device DetailのCONFIG tabとは役割を分ける。CONFIG本文・世代・差分は既存のAdmin-only画面に残し、Topologyはnormalized factsだけをViewerにも表示する。

### 8.2 レイアウト

Force simulationは実装しない。ネットワークを独立したnodeにせず、次の決定論的レイアウトにする。

- 描画するnodeはDeviceと、相手不明または候補複数のVPNに対応するexternal endpointだけとする。LAN / WANのsubnetやaddressはDeviceカード内に列挙し、tunnel / unknown networkはgraph上には出さず、Deviceの選択後のdetailsで表示する。
- Deviceの順序は`site name`、`device name`、`device id`の順でsortする。
- VPN linkのincident数が最も多いDeviceをhubとし、上段中央へ置く。同数の場合は上記のDevice順で先に来るものをhubとする。
- hubに直接接続するDeviceとexternal endpointを2段目へ並べ、hubに直接接続しないVPNありのDeviceをその下、VPNを持たないDeviceをさらに別の行へ並べる。各行は固定幅のgridで中央寄せする。
- hubが複数ある構成や相互接続では、選択されたhubを起点に同じ規則で配置し、完全に交差をなくせない場合もDeviceを大きく横断する線を減らす。配置とsortのtie-breakは常に同じ入力から同じ結果になるようにする。
- 線はVPN linkだけとし、Deviceからnetworkへのattachment、WAN / Internetへの接続線は描かない。相手不明または候補複数のVPNだけ、相手を断定しないexternal endpointへ線を引く。
- 両端のmatched linkが揃う同じDevice pairは1本のlinkへ集約し、片側だけのlinkは矢印付きで残す。同じ向きに複数tunnelがある場合も、片側のみであることを隠さず、各tunnelを別linkとして選択できるようにする。

SVGは`viewBox`を持つレスポンシブな`<svg>`とし、横幅が狭い場合は既存の`.table-wrap`と同様に横スクロール可能にする。PoCでズーム・パン・自動衝突回避は行わない。

### 8.3 視覚表現とアクセシビリティ

- `configured`: solid line。確かな設定済みの接続なのでgraph上のbadgeは表示しない
- `observed`: solid line + `観測` text badge。将来のruntime状態は色だけでなく状態文字も表示
- `inferred`: dashed line + `推定` text badge。片側だけのmatched linkは`片側のみ` badgeと矢印を追加し、confidence / ruleはdetailsに表示する
- `unmatched` / `ambiguous`: dashed line + `相手不明` / `候補複数` text badge。相手Deviceを断定しない

色だけでsourceを区別しない。SVGのnode/linkはkeyboardでfocusでき、`aria-label`にDevice名・tunnel番号・推定状態を含める。クリックした要素の詳細はSVG内に詰め込まず、graph下の通常のHTML `Card`に表示する。

VPN linkの詳細には最低限次を表示する。

- local Device / remote Deviceまたはexternal endpoint
- Tunnel number
- VPN type（IPsec、L2TP/IPsec、L2TPv3、GRE、IPIP等）
- local / remote endpoint
- local / remote network
- state（Observed情報がある場合だけ）
- Configured / Observed / Inferred
- confidence、matching rule、evidenceの要約

### 8.4 部分データ

ProfileがないDeviceは、Device名・Model・`CONFIGなし`のnodeとして表示する。LAN / WANの情報が取れたDeviceはカード内へ表示し、VPNがないと推定しない。Topology serviceやSVG rendererの例外は画面全体を壊さず、warning Cardへ落とす。

remote access受けはVPN linkを作らず、Deviceカードに`リモートアクセス受け: 有効(L2TP/IPsec)`相当の要約を表示する。詳細カードには対象tunnelの番号・種別・local endpointを列挙する。

## 9. PoCの合格ライン

次のケースを自作のCONFIG片とVitestで固定する。実機のCONFIG、serial number、MAC address、PPPoE認証情報はテストにも使用しない。

| 合格条件 | 確認方法 |
| --- | --- |
| 1台のCONFIGからLAN subnetとWAN方式を抽出できる | static、DHCP、PPPoEの認証情報を含まない最小fixtureでCore Parserを確認 |
| PPPoE / IPoE / staticが混在してもWAN方式を表示できる | `TopologyDevice.wan`のIPv4、IPv6、IPv4 over IPv6を自作fixtureで確認し、動的addressがないDeviceにも方式行が出ることを確認 |
| VPN tunnel番号、種別、local / remote endpointを抽出できる | IPsec、L2TP/IPsec、L2TPv3、GRE、IPIPの自作fixtureで確認 |
| L2TP/IPsec remote access受けを表示できる | `remote address ... any`のfixtureでDevice詳細の表示とlinkがないことを確認 |
| tunnel gatewayのrouteからremote networkを得られる | `ip route <prefix> gateway tunnel N`のfixtureで確認。曖昧なら空にする |
| 複数Deviceを横断してpeerを突合できる | RFC 5737の静的WAN addressを2台に設定し、一意の完全一致を確認 |
| 不一致・複数一致を外部/ambiguousとして表示できる | FQDN、DHCP、重複addressのfixtureで確認 |
| 推定根拠がModelとUIに残る | `rule`、input fact ID、confidence、summaryをAPIと詳細Cardで確認。種別追加後もstatic IPv4完全一致だけで推定 |
| 双方向VPNを重複表示しない | 両端のstatic WAN IPv4が相互にmatchedするfixtureで、`vpnTunnels`は2件のまま`TopologyLink`が1件、detailsに両端のtunnelを確認 |
| 片側だけのVPNを隠さない | 一方のCONFIGだけにmatched tunnelがあるfixtureで、`single`、矢印、「片側のみ」を確認 |
| Configured / Observed / Inferredが区別される | solid / dashed、文字badge、詳細表示を確認。未取得のObservedを捏造しない |
| Web UIにDevice / network / VPN linkが描画される | `#/topology`を開き、node/link選択と詳細Cardを確認 |
| 解析失敗・Profileなしで全画面が壊れない | 1台の空/不完全Profileを混ぜ、他Deviceのgraphとwarningが表示されることを確認 |
| Topology ModelがYAMAHA固有のCONFIG行に依存しない | API schemaにvendor-neutralなinterface/network/route/tunnel/linkを使い、Yamaha parserは入力adapterに限定することを確認 |

最小fixtureのaddressは`192.0.2.0/24`、`198.51.100.0/24`、`203.0.113.0/24`等のdocumentation rangeを使う。秘密情報や実環境の識別子をfixtureへ持ち込まない。

なお、このpeer matchingの合格条件が成立するのは、両端のDeviceがCONFIGから判明する静的WAN IPv4 addressを持つ構成に限られる。PPPoEの動的address、FQDN / DDNS、NAT配下などでは、このPoCの`inferred` linkは生成されず、VPNは外部または不明peerとして表示される。これはPoCの制限として受け入れ、実環境で何が見えるかを明確にする。

## 10. 今回やらない範囲

次はTopology Modelに拡張余地を残すが、Issue #65のPoCでは実装しない。

- Runtime Collectorによるtunnel/interface UP・DOWN、RTT、packet loss、last change
- FQDN、DDNS、動的IP、NAT配下、IKE IDを使ったpeer matching
- hub-and-spoke / meshの役割判定、冗長回線の自動判定
- VLAN、DHCP lease、NAT descriptorの詳細表示
- LLDP、ARP、MAC address tableによるL2 topology
- PC / server等のendpoint自動検出
- Config diffからのTopology History / before-after表示
- Force-directed layout、zoom / pan、編集可能なgraph
- Yamaha以外のCONFIG parser
- Topologyの永続snapshot、専用DB table、過去時点の再現
- AIや自由形式のconfig解析への依存

peer matchingの次の一手の第一候補は、Gatewayの`observedSourceIp`とIPsecのremote endpointを突合するルールである。ただし今回は、`observedSourceIp`がCONFIGの`configured` factではなくGatewayから見た観測値であること、CGNATやNAT配下ではRouterのWAN addressと異なる値になり得ることから、誤推定を避けるため除外する。将来追加する場合も、Observed由来であることとNATの不確実性をevidence / confidenceに残す。

## 11. 実装順序とレビューで確認したい判断

承認後は次の順序で小さく実装する。

1. Coreの`DeviceProfile`をcanonical factsへ拡張し、互換projectionとParser testを追加する。
2. CoreまたはCommunity側に、Profile列挙・WAN候補作成・exact matchを行うTopologyBuilder / Matcherを追加する。
3. `GET /api/topology`とTenant scope、partial warning、API testを追加する。
4. Web API type、`#/topology`、Sidebar、SVG renderer、selection detailを追加する。
5. 自作fixtureで`npm run lint`、`npm run typecheck`、`npm test`、`npm run build`を実行する。

設計レビューでは特に次を承認対象とする。

- Device Profileを拡張し、Topologyをそのcross-device projectionとすること
- `/api/topology`を追加し、PoCではTopologyを永続化しないこと
- peer matchingを「同一Tenant内の静的WAN IPv4とremote endpointの一意な完全一致」に限定すること
- 推定linkを必ず`inferred` + evidenceとして扱い、UIで確定構成に見せないこと
- 外部依存なしの決定論的SVG layoutでPoCの描画範囲を固定すること
- Observed情報はschemaとUIに受け口だけ用意し、取得できない状態を設定から推定しないこと
