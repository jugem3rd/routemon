# Contributing

RoutemonへのContributionを歓迎します。

## License

このrepositoryへのContributionは、repositoryと同じ**MIT License**(`LICENSE`)で
提供されるものとします。Pull Requestを送ることで、その条件に同意したものとみなします。

現時点でCLAの署名は求めません。必要になった場合はDCO(`Signed-off-by`)の導入を検討します。

## 開発の始め方

Node.js 24以上が必要です。

```sh
npm install
npm start                     # Community Server(既定: 8080 / 8081 / 8082)
npm run dev -w @routemon/web  # GUIのdev server(/apiは8080へproxy)
```

提出前に、次の3つを通してください(CIも同じものを実行します)。

```sh
npm run lint
npm run typecheck
npm test
```

Agent(`agent/*.lua`)を変えるときは、`luajit`で`agent/https_tunnel_agent_test.lua`と`agent/update/sha256_test.lua`も通してください。

Docker imageをsource checkoutからbuildして試すには、次を使います。

```sh
docker compose -f compose.yaml -f compose.dev.yaml up -d --build
```

## 進め方

- 変更はIssueを基準にし、1 Issueにつき1ブランチを作る
- `main`へ直接pushしない。Pull Requestを経由する(CIの`node`と`agent`の成功が必要)
- Pull Requestは、squash mergeで取り込む。Pull Requestのタイトルが、`main`のコミットメッセージになる
- コミットメッセージ、Pull Requestのタイトルは、Conventional Commits(`fix:`、`feat:`、`docs:`等)を基本とする
- 変更には自動テストを付ける。設計や使い方が変わるときは、`docs/`とREADMEも更新する
- 秘密情報(Token、パスワード、CONFIG本文、個人のドメインやIP)をIssue、PR、コミットへ含めない
- 実機で確認した場合は、機種とfirmwareを書く(例: `RTX830 Rev.15.02.30`)

## 設計の変更

以下はPull Requestの前にIssueで提案してください。

- システム構成、ルーターとServer間の通信方式、データモデル、認証・認可の変更
- 新しい依存関係の追加

## 脆弱性の報告

公開のIssueには書かず、`SECURITY.md`の手順で報告してください。

## YAMAHA YNOとの関係

Routemonは公式YNOの独自実装をコピーしません。非公開仕様や内部実装に依存せず、
公開されている仕様・ドキュメント・API・ルーター機能だけを基に実装します。
Firmwareのreverse engineeringを伴うContributionは受け付けられません。
