# ADR-0007: プロジェクト名をOpenYNOからRoutemonへ変更する

Status: Accepted
Date: 2026-09-18

## Context

プロジェクトは当初`OpenYNO`という名前で開発していた。

`YNO`はYAMAHAの製品名であり、`Open` + 他社製品名という形は、公式製品の派生物・関連製品であると
誤認させやすい。実際にはYAMAHA公式YNOとは無関係の独立実装であり(`docs/product/licensing-policy.md`)、
OSS公開(#10)を控えた段階で名前を変える判断をした。

## Decision

プロジェクト名を**Routemon**(route + monitor)へ変更する。

- 表示名: `Routemon`
- packageとpath上の識別子: `routemon`(`@routemon/core`等)
- 環境変数: `ROUTEMON_DATA_DIR`等
- Router上のfile: `/routemon_agent_a.lua`、`/routemon_bootstrap.lua`等
- Repository: `jugem3rd/Routemon`

名前にYAMAHAの商標を含めない。ただし、対応機種や互換性を説明するための事実としての言及
(「YAMAHA RTXシリーズに対応する」「公式YNOとは無関係」等)はそのまま残す。

## Consequences

- OSS公開前に実施するため、移行対象は開発用の実機1台のみで済む
- Router上のfile名が変わるため、既存の導入があればBootstrapからの再導入が必要になる
- `schedule at`で`/routemon_bootstrap.lua`を起動するよう設定し直す必要がある
- 過去の記録には旧名が残る場合がある

## Alternatives considered

### RouterManager等の記述的な名前

機能はすぐ伝わるが、記述的すぎて商標として保護できず、同名のプロジェクトが多数存在するため
検索で埋もれる。

### 固有名(Sakimori、Kanmonなど)

固有性は高いが、ルーター・ネットワーク管理という用途が名前から伝わらない。
