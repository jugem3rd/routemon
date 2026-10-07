# Routemon

YAMAHAルーターをクラウド(または自分で立てたServer)から管理するためのOSSです。
YAMAHA公式のYNOとは無関係の独自実装で、公開されている仕様とルーター機能だけを使います。

Community版は1つのcontainerで動きます。PostgreSQLやRedisは要りません。

## 動かす

DockerとDocker Composeが入ったLinux(VPS等)で、`compose.yaml`を置いて起動します。
imageはGitHub Container Registryの`ghcr.io/jugem3rd/routemon`から取得されます
(`linux/amd64`と`linux/arm64`)。

```sh
curl -fsSLO https://raw.githubusercontent.com/jugem3rd/routemon/main/compose.yaml
docker compose up -d
```

`ROUTEMON_VERSION`でimageの版を固定できます(例: `ROUTEMON_VERSION=0.1.0 docker compose up -d`)。
版を指定しないときは、`0.1`系の最新です。

更新するときは次の通りです。データ(`/data`)とDeviceの接続は維持されます。

```sh
docker compose pull
docker compose up -d
```

起動したらBrowserで `http://<server-ip>:8080/` を開きます。未設定のInstanceは
Setup Wizardへ誘導されるので、以下をGUIで設定します。

1. Instance名とTimezone
2. 最初の管理者(Local Auth、Public signupはありません)
3. Public URL(RouterからOutbound HTTPSで届くURL)
4. 接続確認(DNS / HTTPS / 証明書 / Agent endpoint)

Setup完了後はCaddyがTLSを終端します。Caddyfileを手で書く必要はありません。

## 対応機種

Agentは、ルーターのLuaスクリプト機能(HTTPSに対応する`_RT_LUA_VERSION` 1.08以上)の上で動きます。

| 区分 | 機種 |
| --- | --- |
| ◎ 動作確認済み | **RTX830**(Rev.15.02.30) |
| ○ 対応と推測(公式資料の上でLua 1.08に対応、実機は未確認) | RTX1210、RTX1220、RTX1300、RTX840、RTX3510、RTX3500、RTX5000、NVR510、NVR700W、vRX(さくらのクラウド版) |
| △ 一部に制限 | vRX(VMware ESXi版、Amazon EC2版): LuaSocketに非対応のため、Native WebGUIの中継が使えない可能性が高い |
| × 非対応(Lua 1.08が無い) | RTX1200、RTX810、NVR500、FWX120、SRT100、YSL-V810 |

確認できていない機種の報告は歓迎します(機種とfirmwareを添えて、Issueへ)。必要なfirmware、機種ごとの上限、確認の手順は`docs/core/supported-devices.md`にあります。

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

> `git clone`して`npm ci`で動かす方法は、開発者向けで、利用者向けのサポート外です
> (`better-sqlite3`のnative moduleをbuildできる環境が要ります)。通常は上のDocker imageを使ってください。
> source checkoutからimageをbuildするときは、
> `docker compose -f compose.yaml -f compose.dev.yaml up -d --build`を使います。

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
