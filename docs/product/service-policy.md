# Routemon Service Policy

Status: Current product policy  
Last updated: 2026-09-14

## 1. Purpose

本ドキュメントは、Routemonの対象ユーザー、製品の範囲、機能境界を定義する。

Routemonは本家YAMAHA Network Organizer（YNO）の完全代替を目指さない。小〜中規模のYAMAHAルーター運用を、シンプルに行うためのOSSとする。

大規模・高度な運用要件を持つユーザーは、本家YNOの利用を推奨する。

---

## 2. Product

Routemonは、Self-Hostedで動くOSSとして提供する。

### Routemon Community / Self-Hosted

- OSSとして提供するSelf-Hosted版
- Docker / Docker Composeを標準導入方式とする
- 1 Instance = 1 Tenant
- 複数Device / 複数Userに対応
- Tenant RoleはAdmin / Viewer
- Authenticationは**Routemon内蔵Local Authのみ**とする
- OIDC / Google / Microsoft等の外部Identity Provider連携はCommunity版では提供しない
- Infrastructureは利用者自身が管理する
- Multi-Tenant UIは持たない
- Community codeはMIT Licenseを採用する

詳細なライセンス方針は`docs/product/licensing-policy.md`を正本とする。

---

## 3. Target

主対象:

- 小〜中規模のYAMAHAルーター管理
- 数台〜数十台程度を中心とするTenant
- 複数拠点の基本監視・CONFIG管理・SYSLOG・定型操作
- 安価なRemote Managementを必要とする中小企業、個人、SIer等

Routemonプラットフォーム全体はGateway水平追加によりスケール可能とするが、単一Tenantの巨大運用を製品要件の中心には置かない。

以下のような要件は本家YNOを推奨する。

- 数百〜数千台級の単一Tenant運用
- 大人数の管理組織
- 複雑な承認ワークフロー
- 高度な全Device横断ログ検索
- SIEM級の分析・相関
- 厳格なSLA
- 大規模組織向けの複雑な権限階層

---

## 4. Tenant model

### Community

Communityは以下とする。

```text
1 Instance = 1 Tenant
```

内部データモデルとしてTenant record / tenant_idを維持してよいが、Tenant切替等のMulti-Tenant UIは提供しない。

---

## 5. Community Authentication

Routemon Community / Self-HostedのUser Authenticationは**Local Authのみ**とする。

```text
Routemon Community
└ Local Auth
```

Community版では以下を実装対象外とする。

- OIDC
- SAML
- Google Social Login
- Microsoft Social Login
- 外部のAuthentication service必須化

複数UserとAdmin / Viewer RBACはLocal Auth上で提供する。

---

## 6. Tenant RBAC

Tenant UserのRoleは2種類だけとする。

### Admin

Tenant内で全機能を利用できる管理者。

- Device管理
- User / Tenant管理
- CONFIG操作
- SYSLOG / Live Logs
- Diagnostics
- 定型Action
- Reboot
- 任意CLI
- YAMAHA Native WebGUI

### Viewer

読み取り専用User。

- Dashboard / Device状態閲覧
- SYSLOG / Event閲覧
- CONFIG Backup / Diff等の読み取り
- Job履歴閲覧

以下は不可:

- 設定変更
- Command / Diagnostics等の能動操作
- User / Tenant管理
- YAMAHA Native WebGUI

MVPではOwner / Operator等の追加Role、Role Builder、User単位の細粒度Permission overrideは実装しない。

---

## 7. Product UX Boundary

RoutemonのPrimary UXは**Routemon独自Web UI**とする。

YAMAHA Native WebGUI Forwarderは、日常運用のPrimary UIではなく、Routemon側で未提供の高度な設定・保守・トラブル対応を行うためのAdvanced Accessとして扱う。

```text
Routemon GUI
= Primary / daily operation

YAMAHA Native WebGUI
= Advanced / privileged / fallback access
= Admin only
```

Routemon独自GUIでは、日常運用で必要な主要機能を優先して提供する。

- Dashboard
- Device一覧 / Device詳細
- Agent Online/Offline
- WAN / PPP / IPv6 / Tunnel / Interface状態
- SYSLOG / Live Logs
- Event
- CONFIG Backup / Diff
- Diagnostics
- 定型操作
- Job履歴
- User / Tenant管理

YAMAHA Native WebGUIの全機能をRoutemon独自GUIへ再実装することは目標としない。

---

## 8. Design Principle

Routemonは以下を優先する。

- Support工数を増やしすぎないこと
- 小〜中規模運用で必要な機能に集中すること
- Router Agentを可能な限り薄く保つこと
- Router Agentを更新せず、Server側の更新だけで機能拡張できる構造にすること
- Core実装を、deployment方式に依存させないこと
- Communityを、特定の外部サービス必須にしないこと
- Community AuthenticationをLocal Authだけに限定し、Self-Hosted設定を複雑化しないこと
- 大規模・高度運用を無理に取り込まないこと
- 権限モデルを必要以上に複雑化しないこと
- OSSライセンス運用を必要以上に複雑化しないこと

機能追加時は、本家YNO相当の巨大機能をそのまま再現するのではなく、Routemonの対象規模に見合うかを判断する。

---

## 9. Release order

最初のrelease targetをCommunity v0.1とする(GitHub Milestone「Community v0.1」)。

機能ごとの順序は`docs/product/feature-list.md`の実装ロードマップを参照する。
