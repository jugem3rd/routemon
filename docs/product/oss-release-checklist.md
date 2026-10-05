# Routemon Community OSS Release Checklist

Status: Decided(#10)  
Last updated: 2026-09-17

## Purpose

Routemon CommunityをMIT Licenseで一般公開する前に必要なRepository・License・依存関係確認を整理する。

この`jugem3rd/Routemon`を、Public / MITのrepositoryとして公開する。rootへMIT `LICENSE`を配置済みで、copyright holderは`jugem3rd`とする。

## Before public release

- [x] rootへ正式なMIT `LICENSE`を配置する
- [x] READMEへMIT Licenseであることを明示する
- [x] Docker image / release artifactにもlicense noticeを含める(`LICENSE`と`THIRD_PARTY_NOTICES.md`をimageへ入れる)
- [x] Third-party dependency licenseを棚卸しする(`npm run audit:licenses`)
- [x] 必要なcopyright / attribution noticeを確認する
- [x] `THIRD_PARTY_NOTICES.md`を作成する
- [x] ContributionもMITで受け入れる方針を明示する(`CONTRIBUTING.md`)
- [x] `SECURITY.md`、Issue / PR template、`CONTRIBUTING.md`の開発手順を整える(#5)
- [x] 必要に応じてDCOを採用する(決定: 初期は採用しない。外部のPRが増えたら再検討)
- [x] Project trademark / nameの利用方針を必要に応じて定義する(決定: 現時点では定義しない)
- [ ] npmの`@routemon`スコープ名の確保を検討する(パッケージは公開しない。名前を他者に取られないため)

## 公開対象(このrepository、MIT)

```text
packages/core      Agent Protocol codec、CONFIG Parser、Device Profile、storage interface
packages/gateway   Agent Gateway(Self-Hosted)
packages/web       Routemon GUI
apps/community     Community Server(Local Auth、RBAC、SQLite / Local Storage、Jobs、SYSLOG、
                   WebGUI relay、Enrollment、Setup)
agent/             Router側のAgent / Supervisor / loader(Lua)
docs/              設計ドキュメント
```

## Dependency license監査結果(2026-09-17)

install済み101 packageはすべて許容的license。

| License | 数 | 備考 |
| --- | --- | --- |
| MIT | 84 | hono、better-sqlite3、react等 |
| ISC | 6 | |
| Apache-2.0 | 5 | typescript等(build時のみ) |
| MIT OR Apache-2.0 | 2 | biome |
| MPL-2.0 | 2 | lightningcss(viteの依存、build時のみ) |
| CC-BY-4.0 | 1 | caniuse-lite(build時のみ) |
| BSD-3-Clause | 1 | source-map-js |

copyleft(MPL-2.0)はbuild時のみでDocker imageへ入らない。SQLite本体はPublic Domain。

MITではAGPLのようなnetwork利用時のsource提供導線やcopyleft対応は不要とする。
