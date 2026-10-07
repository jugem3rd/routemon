# 対応機種(Luaスクリプト機能からの推測)

Status: Current(推測。実機で確認したのはRTX830だけ)  
Scope: Core  
Last updated: 2026-10-07

Routemon Agentは、Routerの**Luaスクリプト機能**の上で動く。そのため、対応機種は、YAMAHA公式資料の、Luaスクリプト機能の対応表から推測できる。この文書は、その推測をまとめる。

**確認の度合いを、必ず区別して読むこと。**

| 記号 | 意味 |
| --- | --- |
| ◎ 確認済み | 実機で、Enrollment・同期・CONFIG・SYSLOG・WebGUI relay等を確認した |
| ○ 対応と推測 | 公式資料の上で、Agentが必要とするLuaの機能がそろっている。**実機では未確認** |
| △ 一部に制限 | Agentは動くと推測されるが、使えない機能がある |
| × 非対応 | 必要なLuaの機能が無い |

参照元(いずれもYAMAHA公式):
- [Lua スクリプト機能](https://www.rtpro.yamaha.co.jp/RT/docs/lua/)(機種・firmwareと、Luaスクリプト機能のバージョン`_RT_LUA_VERSION`の対応表)
- [Lua 向けヤマハルーター専用 API](https://www.rtpro.yamaha.co.jp/RT/docs/lua/rt_api.html)(各関数の仕様と、機種ごとの上限)

## 1. Agentが必要とするLuaの機能

`agent/`と、Enrollmentのscript(`apps/community/src/enrollment/bootstrap.ts`)が使う`rt.*`から整理した。

| 使っているもの | 用途 | 必要な`_RT_LUA_VERSION` |
| --- | --- | --- |
| `rt.command`(`show config`、`show environment`、`save`、`schedule at ... lua`、`terminate lua`、`show status lua running`等) | コマンド実行、CONFIG取得、Agentの起動 | 1.0 |
| `rt.syslogwatch` | SYSLOGの収集 | 1.0(正規表現オブジェクトは1.03) |
| `rt.socket.tcp` / `rt.socket.select` | Native WebGUI relay(Routerのlocalhostのpageへ中継) | 1.06 |
| `rt.command(cmd, 'off')` | ログを出さないコマンド実行 | 1.07 |
| `rt.httprequest`の`https://`とBearer認証 | ServerへのHTTPSの接続、Device Tokenでの認証 | **1.08** |

**結論: Agentが動くには、`_RT_LUA_VERSION`が1.08以上のfirmwareが必要**(HTTPSでServerへ接続するため)。Native WebGUI relayには、さらにLuaSocket(1.06)が要る。

## 2. 機種ごとの対応

「Lua 1.08の最小firmware」は、公式の対応表のうち、Lua 1.08(HTTPS・Bearer認証)に対応する最初のfirmware。「初回から」は、その機種の最初のfirmwareから対応している。

### 2.1 対応と推測される機種(Lua 1.08)

| 機種 | 区分 | Lua 1.08の最小firmware | メモ |
| --- | --- | --- | --- |
| **RTX830** | ◎ 確認済み | Rev.15.02.03以降 | **Rev.15.02.30で確認済み**(2026-10) |
| RTX1210 | ○ | Rev.14.01.26以降 | |
| RTX1220 | ○ | Rev.15.04.01以降(初回から) | |
| RTX1300 | ○ | Rev.23.00.03以降(初回から) | |
| RTX840 | ○ | Rev.23.02.02以降(初回から) | `rt.httprequest`の受信bodyの上限が、公式の一覧に載っていない |
| RTX3510 | ○ | Rev.23.01.01以降(初回から) | |
| RTX3500 | ○ | Rev.14.00.26以降 | |
| RTX5000 | ○ | Rev.14.00.26以降 | |
| NVR510 | ○ | Rev.15.01.09以降 | |
| NVR700W | ○ | Rev.15.00.10以降 | |
| vRX(さくらのクラウド版) | ○ | Rev.19.02.10以降(初回から) | |
| vRX(VMware ESXi版) | △ | Rev.19.01.06以降(初回から) | **LuaSocket(`rt.socket`)に非対応**。Native WebGUI relayが使えない可能性が高い。`rt.httprequest`のURL長の上限が255文字 |
| vRX(Amazon EC2版) | △ | Rev.19.00.01以降(初回から) | 同上(LuaSocketに非対応、URL長255文字) |

### 2.2 非対応の機種(Lua 1.08が無い)

HTTPSで接続できないため、Agentは動かない。

| 機種 | Luaの最新のバージョン | 備考 |
| --- | --- | --- |
| YSL-V810 | 1.07まで | |
| FWX120 | 1.07まで(Rev.11.03.13以降) | |
| RTX810 | 1.07まで(Rev.11.01.25以降) | |
| NVR500 | 1.07まで(Rev.11.00.28以降) | |
| RTX1200 | 1.07まで(Rev.10.01.65以降) | |
| SRT100 | 1.06まで | |

(NVR500は、`save_file`の`configN`がN=0のみ等、機能の差も大きい。)

## 3. 機種で差がある、Agentに関係する上限

公式のAPI資料より。`rt.httprequest`の上限は、Agentの設計(CONFIGの送信、SYSLOG batchの大きさ)に関係する。

| 項目 | RTX830 / RTX840 / NVR510 / NVR700W | RTX1210 / RTX1220 / RTX1300 / RTX3510 | RTX3500 / RTX5000 |
| --- | --- | --- | --- |
| 送信本文(`post_text`)の上限 | 640KB | 3MB | 8,000KB |
| 受信`body`の上限 | 1MB(RTX840は記載なし) | 1MB | 2MB |

- Agentの設計は、RTX830の上限(送信640KB、受信1MB)に収まるようにしてある。ほかの機種は、余裕がある
- `rt.socket`のlocal portは、vRX(Amazon EC2版Rev.19.00.01を除く)以外は、`1024〜5000`
- **URL長**: 公式では既定2,048文字。**255文字なのは、次の古いfirmwareと機種**: RTX5000 / RTX3500 Rev.14.00.33以前、RTX3510 Rev.23.01.01以前、RTX1300 Rev.23.00.04以前、RTX1220 Rev.15.04.04以前、RTX1210 Rev.14.01.41以前、RTX830 Rev.15.02.28以前、NVR700W Rev.15.00.23以前、NVR510 Rev.15.01.24以前、vRX(VMware ESXi版とAmazon EC2版)。Public URLやrelease URLが長いと、これらでは届かない可能性がある(Agentが使うURLは短い)
- Lua taskは、1台で最大8つ。`io.popen`、`os.execute`、`package.loadlib`等は、全機種で使えない

## 4. 確認できていないこと

公式資料では分からず、実機で確認が要ること。

- 機種ごとの**memory**(Agentは、RTX830の256MBで動く設計。ほかの機種は未確認)
- `show config`、`show environment`、`show status ...`の**出力形式の機種差**(Device ProfileとCONFIG Parserは、RTX830の出力で作った。`lan1`・`pp`・`tunnel`の番号の付き方、`show environment`の「起動時刻」の行は、機種で違う可能性がある)
- `rt.command`で実行できるコマンドの機種差(`schedule at`、`show status lua running`、`terminate lua`)
- `io.open`の挙動、RTFS(flash)の書き込み特性
- Native WebGUIのURLとport(Agentの`WEBGUI_IP`の既定は`192.168.100.1`)、機種ごとのWebGUIの違い(NVR / RTXの世代差)
- SYSLOGの文言の機種差(`PP[nn]`、`IP Tunnel[n] Up`等のEvent抽出、`docs/core/syslog-design.md` §3.2.1)
- 新しいfirmwareへの更新が必要な機種(RTX1210は`Rev.14.01.26`以降、NVR510は`Rev.15.01.09`以降など)での動作

## 5. 実機で確認するときの手順(提案)

新しい機種で試すときは、次を順に確認し、結果を、Issue #9に、機種とfirmwareつきで記録する。

1. Luaのバージョン: Routerで`lua -e "print(_RT_LUA_VERSION)"`のように、Lua 1.08以上であることを確認する(Luaスクリプト機能の有効化が要る場合は、公式の手順に従う)
2. Enrollment: 2行のCLI blockを貼り、DeviceがOnlineになる
3. 状態確認とコマンド実行(`show environment`、`show config`の取得)
4. CONFIGの取得と、Device Profileの解析(`lan`・`pp`・`tunnel`が正しく出るか)
5. SYSLOGの収集と、Live Logs
6. Native WebGUIの中継
7. Agent / Supervisorの更新と、復帰

最小の確認(手順1〜3)でも、「動く」の根拠になる。確認できた機種は、§2の区分を「◎ 確認済み」へ更新する。

## 6. 今後の改善案

- Enrollment時に、`_RT_LUA_VERSION`を確認し、1.08未満の機種へ、分かりやすいエラーを出す(今は、`rt.httprequest`がHTTPSで失敗するだけで、原因が分かりにくい可能性がある)
- Enrollment時に、`rt.socket`の有無を確認し、無い機種(vRXの一部)では、Native WebGUI relayを無効にして、理由を表示する
- 利用者の実機の動作報告を、Issue templateで受ける
