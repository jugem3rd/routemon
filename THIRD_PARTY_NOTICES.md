# Third Party Notices

RoutemonはMIT Licenseで配布します(`LICENSE`)。以下は同梱・利用するThird party softwareの
license表記です。各packageのlicense本文は`node_modules/<package>/LICENSE`に含まれます。

## Docker imageへ入るもの(runtime dependency)

| Package | License |
| --- | --- |
| hono | MIT |
| @hono/node-server | MIT |
| better-sqlite3 | MIT |
| react / react-dom(GUIのbuild成果物に含まれる) | MIT |

better-sqlite3はSQLiteを同梱します。SQLite本体はPublic Domainです。

## 開発・buildにのみ使うもの(Docker imageへは入らない)

| Package | License |
| --- | --- |
| typescript | Apache-2.0 |
| vite / @vitejs/plugin-react | MIT |
| vitest | MIT |
| @biomejs/biome | MIT OR Apache-2.0 |
| @types/* | MIT |
| lightningcss(viteの依存) | MPL-2.0 |
| caniuse-lite(viteの依存) | CC-BY-4.0 |
| source-map-js | BSD-3-Clause |

## 監査方法

direct dependencyとinstall済みpackageのlicenseは以下で確認できます。

```sh
npm ls --all --omit=dev          # runtimeへ入る依存
npm run audit:licenses           # licenseの一覧
```
