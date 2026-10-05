# ADR-0006: Routemon ServerをTypeScript(Node.js)で実装する

- Status: Accepted
- Scope: Core
- Date: 2026-09-15
- Decision Owners: Routemon
- Related: Issue #21, `docs/product/licensing-policy.md` §3, `docs/community/architecture.md`

## Context

Community v0.1を先行して完成させる方針とした(#20)。

当時の実装は、PoC(Python asyncio)のAgent Gatewayだけで、Web UI / API / Local Auth / SQLite等を持つRoutemon Server本体は存在しない。Community v0.1の実装Issueは、実装技術が決まらないと着手できない。

実装技術は以下の既存決定を満たす必要がある。

- Communityは`routemon` container 1つにWeb UI / API / Local Auth / Agent Gateway / WebGUI Relay / CONFIG Parser / Device Profile / SYSLOG / SQLiteをまとめる(`docs/community/architecture.md` §3)
- Community v0.1はPostgreSQL / Redis / external message queue等を必須依存にしない
- Coreは、特定のdeployment方式(特定のcloud service、外部の認証サービス等)へ直接依存しない(`docs/product/licensing-policy.md` §3)
- Routemon GUIはBrowser-side SYSLOG filtering(Web Worker、virtualized list)を行う(`docs/core/syslog-design.md` §9)

## Decision

Routemon Server(Community Server、Agent Gateway、Routemon GUI)を**TypeScript**で実装する。

| 項目 | 採用 |
|---|---|
| 言語 | TypeScript |
| Runtime | Node.js 24 LTS(Community Server、Agent Gateway) |
| Web framework / API | Hono |
| Frontend | React + Vite(SPA) |
| SQLite driver | better-sqlite3 |
| Test / Lint / 型 | Vitest / Biome / `tsc` |
| Package管理 | npm workspaces |

Router側のLua Agentは対象外とする。

### Directory

```text
packages/
  core/       Core logic(Agent Protocol codec、CONFIG Parser、Device Profile、Authorization、API handler)
  gateway/    Agent Gateway(Node.js)。Communityは同一process内で動く
  web/        Routemon GUI(React SPA)
apps/
  community/  Community Server(Hono on Node.js、SQLite / Local filesystem / Local Auth adapter、webの配信、Gatewayの組み込み)
agent/       Router側のAgent / Supervisor / loader(Lua)
```

各packageは必要になった時点で作成する。

### Core packageの制約

`packages/core`は、Web標準APIだけを提供するruntime(例: Cloudflare Workers)でも動かせるよう、Web標準API(Request / Response、WebCrypto、TextEncoder等)だけを使い、Node.js固有API(`fs`、`net`等)を使わない。Node.js固有の処理はadapter(`apps/*`、`packages/gateway`)側に置く。

### GUIのbuildと配信

`packages/web`はViteでbuildし、`packages/web/dist`をCommunity Serverが静的配信する
(`WEB_DIR`で上書き可能)。distが無い場合はAPIだけを提供する。

開発時はVite dev server(`npm run dev -w @routemon/web`)を使い、`/api`はCommunity Serverへproxyする。
GUIはhash routing(`#/devices/<id>`)のみを使うため、server側のSPA fallbackは最小で済む。

Node.jsのtype strippingはJSXを扱えないため、`packages/web`だけはbuild工程を持つ。
型チェックも別の`tsconfig.json`(DOM lib / `jsx: react-jsx`)で行う。

### TypeScriptの実行

開発時はNode.jsのtype strippingで`.ts`を直接実行し、build工程を必須にしない。そのためTypeScriptはerasable syntaxに限定する(`tsconfig.json`の`erasableSyntaxOnly`)。

## Alternatives considered

### Python(PoC継続)

PoCのAgent Gatewayをそのまま使え、SQLiteも標準ライブラリで扱える。

しかしCONFIG ParserなどのCore logicを、Web標準APIだけのruntimeでも動かせる形にしたい場合、Pythonでは別実装になりやすい。GUIにはTypeScriptが必要なので、言語も2つになる。

### Go

単一binaryで配布でき、Agent Gatewayの性能面では最も有利。

しかしWeb標準APIだけのruntime(例: Cloudflare Workers)ではWasm経由になり、Core logicの共有が難しい。GUIにはTypeScriptが必要なので、言語も2つになる。

### Frontend: Hono JSX + htmx(SSR)

依存が少なく、HonoのJSXは複数のruntimeで動く。

しかしSYSLOG履歴のBrowser-side filtering(Web Worker、virtualized list)には結局client-side JavaScriptが必要になるため採用しない。

## Consequences

### Positive

- CONFIG Parser、Authorization、API handler等のCore logicを、Node.jsと、Web標準APIだけのruntimeで、同じコードとして使える
- Server、Gateway、GUIを1言語・1 toolchainで扱える
- 開発時にbuild工程が不要

### Negative

- 当時のPoCのAgent Gateway(Python、約450行)を移植する必要があった(移植済み)
- Agent Gatewayの性能はGoより劣る可能性がある
- better-sqlite3はnative addonのため、multi-arch Docker imageのbuildで考慮が必要
- 同期SQLite APIはevent loopを塞ぐため、重いqueryを避ける必要がある

## Follow-up

- #16 / #22: wire formatを#16で固定し、PoC / Lua testと同じtest vectorでTypeScript実装を検証する。PoC同等の性能を#22の合格条件とする
- #11: better-sqlite3でWAL / Online backupを実装する。ORM / query builderの要否を判断する
- #12: better-sqlite3を含む`linux/amd64` / `linux/arm64` imageのbuildを確認する
- `packages/core`作成時: Node.jsの型定義を読み込まない設定にし、Node.js固有APIの混入を型チェックで防ぐ

## Revisit conditions

- 対象規模でAgent Gatewayの性能が不足する場合、`packages/gateway`だけを別言語で実装することを検討する(wire formatは#16の仕様で固定されているため、Agent側に影響しない)
- Core logicを、Web標準APIだけのruntimeで共有できない制約が判明した場合
