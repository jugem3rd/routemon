# Architecture Decision Records

Routemonのアーキテクチャ上の重要な意思決定を記録する。

## ルール

ADRには、実装詳細そのものではなく、将来の実装方針を拘束する重要な判断を記録する。

対象例:

- 認証基盤の選定
- Agent transportの選定
- Tenant / RBACモデルの選定
- DB方式・データ分離方式の選定
- GUI Forwarderと通常APIの責務分離

以下は原則としてADRへ移動しない。

- PoCの詳細設計
- 実機試験記録
- API仕様のメモ
- 機能一覧
- 実装手順
- 調査ログ

ADRで採用した方式を後から変更する場合、旧ADRを削除せず、新しいADRで`Supersedes`を明記して上書きする。

## Status

- Proposed
- Accepted
- Deprecated
- Superseded

## Scope

各ADRには`Scope: Core | Community`を付ける。`Scope`はDecisionのprimary scopeを示すもので、ADR本文の全記述がそのscope専用であることまでは意味しない。

ADRはArchitecture Decisionとそのrationaleの記録であり、Accepted Decisionは有効だが、current detailed specificationそのものではない。現行の詳細仕様は`docs/core/`・`docs/community/`側を優先する(`docs/README.md`参照)。

## Naming

```text
NNNN-short-decision-name.md
```

番号は意思決定順に採番する。

## Current ADRs

| ADR | Status | Scope | Decision |
|---|---|---|---|
| [ADR-0001](./0001-https-agent-transport.md) | Accepted | Core | Router ↔ Backendの標準Agent transportにHTTPSを採用する |
| [ADR-0006](./0006-server-implementation-stack.md) | Accepted | Core | Routemon Server(Community Server、Agent Gateway、GUI)をTypeScript(Node.js、Hono、React)で実装する |
| [ADR-0007](./0007-project-rename.md) | Accepted | Meta | プロジェクト名をOpenYNOからRoutemonへ変更する(YAMAHAの製品名YNOとの誤認を避けるため) |
