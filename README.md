# Routemon

YAMAHAルーターをクラウド(または自分で立てたServer)から管理するためのOSSです。
YAMAHA公式のYNOとは無関係の独自実装で、公開されている仕様とルーター機能だけを使います。

Community版は1つのcontainerで動きます。PostgreSQLやRedisは要りません。

## 動かす

```sh
docker compose up -d
```

起動したらBrowserで `http://<server-ip>:8080/` を開きます。未設定のInstanceは
Setup Wizardへ誘導されるので、以下をGUIで設定します。

1. Instance名とTimezone
2. 最初の管理者(Local Auth、Public signupはありません)
3. Public URL(RouterからOutbound HTTPSで届くURL)
4. 接続確認(DNS / HTTPS / 証明書 / Agent endpoint)

Setup完了後はCaddyがTLSを終端します。Caddyfileを手で書く必要はありません。

## ルーターを登録する

GUIの`Devices`から`Deviceを追加`を押すと、Enrollment Codeを埋め込んだ2行のCLI blockが
表示されます。これをルーターのコンソールへ貼り付けるとAgentが動き始めます。

```text
lua -e "..."   <- Bootstrapを取得する
lua /routemon_enroll.lua
```

以降はGUIから、状態確認・コマンド実行・SYSLOG(Live Logs)・CONFIG世代・
YAMAHA Native WebGUI(Adminのみ)が使えます。

## 開発

Node.js 24以上が必要です(型はNode.jsのtype strippingで直接実行します)。

```sh
npm install
npm start                  # Community Server(既定: 8080 / 8081 / 8082)
npm run dev -w @routemon/web  # GUIのdev server(/apiは8080へproxy)
npm test
npm run lint
npm run typecheck
```

設計ドキュメントは`docs/`にあります。

- `docs/architecture.md` 全体構成
- `docs/core/` Agent Protocol、Enrollment、CONFIG、WebGUI relay等
- `docs/community/` Community版の導入・保存・認証
- `docs/adr/` 決定記録

## License

MIT License(`LICENSE`)。Copyright (c) 2026 jugem3rd。

同梱するThird party softwareのlicenseは`THIRD_PARTY_NOTICES.md`にあります。
Contributionも同じMIT Licenseで受け入れます(`CONTRIBUTING.md`)。

RoutemonはYAMAHA公式YNOとは無関係の独自実装です。非公開仕様やfirmwareの
reverse engineeringには依存しません。
