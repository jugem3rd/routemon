# Routemon Documentation

RoutemonのDocumentation全体の入口。どの文書を正本として読むかを定義する。

> **文書中のIssue / PR番号(`#NNN`)について:** この公開repositoryの前に、開発用の非公開repositoryで開発しており、文書とコードの中の`#NNN`は、その開発用repositoryのIssue / PR番号を指す。この公開repositoryのIssue / PRとは対応しない。

## Scope

設計・Issueは以下のscopeで整理する。

| Scope | 内容 |
|---|---|
| Core | Agent Protocol、Device管理、CONFIG、SYSLOG等、deployment方式に依存しないdomain semantics / protocol / behavior |
| Community | OSS / Self-Hosted固有の実装・deployment |
| Meta | docs整理・license・repository構成等の横断作業(GitHub Issueのみ) |

既存の決定から判断できないものは`未確定`とし、新しく決めずIssueへ判断事項として明示する。

## Directoryと位置付け

| Directory | 内容 | 位置付け |
|---|---|---|
| `docs/product/` | Product policy、機能一覧、Licensing、UX / positioning | 正本 |
| `docs/core/` | Current normative shared specification | 正本 |
| `docs/community/` | Current normative Community-specific specification | 正本 |
| `docs/adr/` | Architecture Decision + rationale | Accepted Decisionは有効だが、current detailed specそのものではない |

実装時は以下を合わせて参照する。

```text
Product policy
+ current normative spec (core / community)
+ applicable ADR
```

## Reading rule

```text
Core task
  -> docs/product/ + docs/core/

Community task
  -> docs/product/ + docs/core/ + docs/community/

Architecture decisionの理由確認
  -> docs/adr/
```

## Dependency rule

Normative specificationの依存方向は以下とする。

```text
Community -> Core
```

禁止するのは以下の状態。

```text
Core仕様を理解・実装するためにCommunity仕様が必須
```

参考リンクや関連ADRへのcross-reference自体は禁止しない。Coreでは以下を必須前提にしない。

```text
SQLite / Caddy / Docker Compose
```

Core仕様をCommunity文書へ複製しない。Community文書はCoreの挙動を参照し、Community固有の実装・設定値だけを記述する。

## Document header

主要な文書は冒頭に以下を置く。

```text
Status: Current specification
Scope: Core | Community
```

ADRは既存の`Status: Accepted`等に加えて`Scope:`を持つ。

## 判断できない場合

Documentation整理の過程で、既存のDecision同士が矛盾する、既存資料から機能の範囲を判断できない、新しいphysical schemaやProtocolの採否を決めないと進めない、といった状況になった場合は、新しい仕様を創作せずIssueへ判断事項として明示する。
