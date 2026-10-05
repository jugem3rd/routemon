# Community Installation and Initial Setup Design

Status: Current specification  
Scope: Community  
Last updated: 2026-09-14

## 1. Purpose

Routemon Community / Self-Hosted版のDocker導入と初期セットアップUXを定義する。

主な想定利用者はSoftware Engineerではなく、YAMAHAルーターを扱うNetwork Engineer / Infrastructure Engineerとする。

そのため、CLI操作はRoutemonを起動するための最小限に限定し、可能な限り早い段階でBrowser GUIへ移行する。

基本原則:

```text
CLI = 起動まで
GUI = 初期設定以降の標準操作
```

---

## 2. Target installation experience

標準導入では、利用者に以下を要求しない。

- Python / Node.js環境構築
- PostgreSQL / Redis構築
- systemd unit作成
- nginx/Caddy設定ファイルの手編集
- `.env`への大量の設定記述
- SQL操作
- CLIによるUser作成
- CLIによるDevice登録

利用者がCLIで行う標準作業は、原則としてDocker起動までとする。

目標例:

```bash
docker compose up -d
```

起動後はBrowserでSetup Wizardへ移行する。

---

## 3. Docker topology

Community v0.1の標準構成は以下とする。

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

標準Docker Compose service:

```text
routemon
caddy
```

Community v0.1では以下を標準依存にしない。

- PostgreSQL
- Redis
- external message queue
- external object storage

Routemon Applicationの主要機能は1つの`routemon` containerへまとめる。

---

## 4. Bootstrap mode

初回起動直後はSetup未完了状態としてBootstrap Modeで起動する。

利用者はServerのIP address / hostnameへBrowserアクセスする。

例:

```text
http://192.168.1.10:8080/
```

未初期化Instanceでは通常Dashboardへ入れず、`/setup`へredirectする。

Bootstrap Modeでは初期設定に必要な最低限のHTTP endpointのみを提供する。

Setup完了後は通常運用をHTTPSへ移行する。

初期HTTP accessは、原則として管理LAN等の信頼できるNetworkから行う前提とする。

---

## 5. Setup Wizard

Setup WizardはNetwork Engineerが迷わないことを優先し、可能な限り短くする。

推奨フロー:

```text
Welcome
  ↓
Instance
  ↓
Administrator
  ↓
Network / Public URL
  ↓
TLS / Connectivity Check
  ↓
Complete
  ↓
Add First Device
```

### 5.1 Welcome

以下を簡潔に表示する。

- Routemon Community
- Self-Hosted / Single Tenant
- Setup所要項目の概要

専門的なApplication内部用語は極力表示しない。

### 5.2 Instance

入力:

```text
Instance / Organization Name
Timezone
```

Community内部ではTenant recordを1件作成するが、UI上で`Tenant`という概念を意識させない。

### 5.3 Administrator

最初のLocal Auth AdminをGUIから作成する。

入力:

```text
Email or Login ID
Password
Password confirmation
```

- 最初のUserはAdmin固定
- Passwordは安全なPassword hashで保存
- Public signupは提供しない
- CLIでUserを作成させない

### 5.4 Network / Public URL

Browser / YAMAHA Agentが利用するRoutemon URLを設定する。

例:

```text
https://routemon.example.com
```

GUIでは以下も補助表示する。

- DNS A/AAAA recordの設定例
- 使用するTCP port
- RouterからOutbound HTTPSで到達できる必要があること
- NAT / Firewallで必要な条件

利用者にCaddyfileを直接編集させることを標準手順にしない。

### 5.5 TLS / Connectivity Check

Routemon側から設定内容を検証し、GUIで結果を表示する。

例:

```text
DNS                  OK
HTTPS                OK
Certificate          OK
Hostname             OK
Agent Endpoint       OK
```

失敗時は、単なるError codeではなくNetwork Engineer向けの原因候補を表示する。

例:

```text
DNS recordがこのServerを指していません
TCP/443が外部から到達できません
Certificate chainを確認できません
```

YAMAHA AgentはBrowserよりTLS互換性条件が厳しい可能性があるため、Agent endpointについても別途状態を持つ。

---

## 6. Caddy management

Caddyは標準Reverse Proxy / TLS terminationとして採用するが、利用者にCaddy設定ファイルの手編集を要求しない。

Setup Wizardで設定したPublic URL / hostnameをもとに、Routemonが標準Caddy設定を生成・反映できる構造を目標とする。

Routemon ApplicationへDocker socketをmountしてContainer制御させる設計は避ける。

Caddy連携はDocker internal network内の管理interfaceや共有された限定的な設定領域等を利用し、権限を必要最小限にする。

実装(#12): RoutemonがPublic URLから`/data/caddy/routemon.caddyfile`を生成し、Caddyは
`--watch`でそれを読み直す。Caddyの管理interfaceはDocker internal networkにのみ開く。
Routemon containerへDocker socketはmountしない。

生成するsite:

```text
<hostname>        -> /v1/tunnel/*、/v1/enrollment/*、/v1/agent/* はAgent Gatewayへ、
                     それ以外はGUI / APIへ
<hostname>:8443   -> Native WebGUI relay(専用origin)
```

具体的なCaddy reload方式は実装時に確定するが、以下を満たすこと。

- GUIからhostname変更可能
- Caddyfile手編集を標準手順にしない
- Routemon containerへDocker socketを渡さない
- Caddy管理interfaceをPublic Internetへ公開しない

外部Reverse Proxyを利用するAdvanced Modeも許容する。

---

## 7. Setup completion

Setup完了後はSetup endpointを通常Userから再実行できないようにする。

```text
initialized = true
```

等のInstance状態を保持し、以後はLogin画面へ遷移する。

再設定はAdminログイン後のSettingsから行う。

Setup完了後にAnonymous Userが初期Adminを上書き・再作成できてはならない。

---

## 8. First Device onboarding

Setup完了後は空のDashboardだけを表示するのではなく、First Device onboardingへ誘導する。

```text
Setup Complete

[Add your first YAMAHA router]
```

Device登録はGUIから行う。

Enrollment UX(Code + endpointを埋め込んだ生成済みCLI blockをPrimary UIとし、1-click Copy、Code TTL、進捗 / 失敗理由を表示する)は`docs/core/device-enrollment-design.md`に従う。利用者にCodeの別途転記やLua fileの手動配置を求めない。

Community固有の前提:

- Enrollment endpointは§5.4で設定したPublic URLから生成する
- 生成前に§5.5のAgent Endpoint checkが成功していることを確認する

---

## 9. Normal administration after setup

初期設定後の標準運用はGUIから行えるようにする。

最低限:

```text
Settings
├ General
│  ├ Instance Name
│  ├ Timezone
│  └ Public URL
├ Users
│  ├ Add User
│  └ Admin / Viewer
├ Network / Connectivity
│  ├ DNS
│  ├ HTTPS
│  ├ Certificate
│  └ Agent Endpoint
├ Storage
│  ├ SQLite status
│  ├ SYSLOG usage
│  ├ Retention
│  └ Capacity
├ Backup / Restore
└ System
   ├ Routemon version
   ├ Agent version
   ├ DB schema version
   └ Health
```

Routine administrationでDocker CLIへ戻る必要をできるだけ減らす。

---

## 10. Health check

Docker / monitoring用にmachine-readable endpointを提供する。

```text
GET /healthz
GET /healthz/ready
```

Readinessでは最低限以下を確認する。

- SQLite access
- `/data` writable
- master key readable
- schema migration complete
- required internal service initialized

GUIのSystem Healthにも同じ情報を人間向けに表示する。

---

## 11. Release / Upgrade UX

標準UpgradeにSource checkoutやBuildを要求しない。

基本:

```bash
docker compose pull
docker compose up -d
```

ただしRoutine operationはGUI中心とし、Upgrade時だけCLI利用を許容する。

将来GUIでUpdate availableを表示してもよいが、Community v0.1でServer自身による自動Container updateは必須としない。

Docker imageは最低限以下を対象とする。

```text
linux/amd64
linux/arm64
```

---

## 12. UX principles

Community版では以下を守る。

1. CLIはApplication起動までを原則とする
2. 初回User作成をCLIで行わせない
3. `.env`を大量編集させない
4. Reverse Proxy設定を手作業の標準手順にしない
5. DBやStorageを利用者に直接操作させない
6. Error messageはSWE向けstack traceではなくNetwork Engineerが切り分けられる表現を優先する
7. Device enrollmentはYAMAHA CLI利用者に理解しやすい手順を出す
8. 高度な設定はAdvancedとして分離し、通常導入を複雑化しない

---

## 13. MVP non-goals

Community v0.1では以下を必須としない。

- Kubernetes installer
- Helm chart
- GUIからDocker imageを自動更新
- OIDC / SAML
- PostgreSQL setup
- Redis setup
- Multi-Tenant setup
- RouterへSSH/TelnetでRoutemon Serverから自動ログインしてAgentを投入する機能
