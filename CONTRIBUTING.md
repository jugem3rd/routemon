# Contributing

RoutemonへのContributionを歓迎します。

## License

このrepositoryへのContributionは、repositoryと同じ**MIT License**(`LICENSE`)で
提供されるものとします。Pull Requestを送ることで、その条件に同意したものとみなします。

現時点でCLAの署名は求めません。必要になった場合はDCO(`Signed-off-by`)の導入を検討します。

## 進め方

- 変更はIssueを基準にし、1 Issueにつき1ブランチを作る
- `main`へ直接pushしない。Pull Requestを経由する
- コミットメッセージはConventional Commitsを基本とする
- 提出前に`npm run lint`、`npm run typecheck`、`npm test`を通す

## 設計の変更

以下はPull Requestの前にIssueで提案してください。

- システム構成、ルーターとServer間の通信方式、データモデル、認証・認可の変更
- 新しい依存関係の追加

## YAMAHA YNOとの関係

Routemonは公式YNOの独自実装をコピーしません。非公開仕様や内部実装に依存せず、
公開されている仕様・ドキュメント・API・ルーター機能だけを基に実装します。
Firmwareのreverse engineeringを伴うContributionは受け付けられません。
