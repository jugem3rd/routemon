# YAMAHA Lua API 調査メモ（対象: RTX830）

Status: Current specification  
Scope: Core  
Last updated: 2026-09-15

公式ドキュメント・Web調査で確認できた事実のみを記載する。未検証の項目は「未確認」と明記し、憶測では埋めない。

対象機種: **RTX830**（Luaスクリプト機能 Ver1.08 / Lua 5.1.5 実装）

## 参照元

- Lua スクリプト機能: https://www.rtpro.yamaha.co.jp/RT/docs/lua/
- Lua 向けヤマハルーター専用API: https://www.rtpro.yamaha.co.jp/RT/docs/lua/rt_api.html
- HTTPサーバーへアクセスできるホストの設定（httpd host）: https://www.rtpro.yamaha.co.jp/RT/manual/rt-common/http_server/httpd_host.html

## Luaスクリプト機能バージョンと追加API

| バージョン | 追加API・機能 |
|---|---|
| 1.02 | ハードウェアライブラリ基本（buzzer, LED）、HTTP通信ライブラリ |
| 1.03 | `rt.syslogwatch` にパターンマッチング追加 |
| 1.04 | キーボード入力（getc, getchar, gets） |
| 1.05 | `rt.mail` の preface_of_text パラメータ |
| 1.06 | ソケット通信ライブラリ（`rt.socket.*`） |
| 1.07 | `rt.command` の LOG パラメータ |
| 1.08 | Bearer認証、SMTPS対応、`rt.httprequest` のHTTPS対応 |

RTX830はVer1.08のため、上記すべてが利用可能。

## rt.command

- ルーター設定コマンドを実行する。パイプ・リダイレクト使用可。
- 引数: コマンド文字列、ログ出力有無（"on"/"off"）
- 戻り値: 実行結果（true/false）、出力文字列 or エラー
- **制約: コマンド文字列は最大4095文字**
- **制約: `administrator`、`telnet` 等、一部コマンドは実行不可**
- 出力の最大サイズ、`show config` のような長い出力の扱い、並列実行可否は未確認
- **検証済み(2026-09-07)**: `rt.command("show status pp 1")` を実行し、成功(true)と実データを含む出力を取得できることを確認(PoC-2、`agent/command_push_agent.lua`)。
- **出力エンコーディングはShift_JIS**。`説明: (ISP名)`のような日本語部分がUTF-8ではなくShift_JISのバイト列で返る。Backend側でデコードする際はShift_JIS前提にする必要がある。
- **出力にはCR/LF(`\r\n`)が複数箇所埋め込まれる**(1コマンドの結果が複数行)。そのため行区切り(`\n`単位)のテキストプロトコルでCOMMAND_RESPONSEを運ぶのは不可能。Length-prefixedなバイナリフレーミング(`docs/core/agent-protocol.md` §5)が必須という結論を補強する。
- **上記の結論をLength-prefixedフレーミングの実装で裏付け済み**: `agent/framing.lua`(Version/Type/StreamID/Lengthの8バイトヘッダ)を使い、Backend→Agentへ`COMMAND_REQUEST`(type=0x10)をPushし、Agentが`rt.command()`実行後に`COMMAND_RESPONSE`(type=0x11、同じstream_id)で514バイトの実データ(改行・日本語含む)を返せることを確認(`agent/framing_command_agent.lua` + `agent/framing_backend.py`)。

## rt.socket.tcp / rt.socket.select

- `rt.socket.tcp()`: TCPマスターソケットを生成。bind/listenでサーバー、connectでクライアントになる。
- **制約: 使用可能ポート範囲は 1024〜5000**（bind/listen時。connect先ポート（例: WebGUIの80/443）への制約かは未確認 — 通常はローカル待受ポートの制約と考えられる）
- `rt.socket.select()`: 複数ソケットの読み書き可能状態をタイムアウト付きで監視。
- **検証済み(Issue #4)**: `sock:settimeout(0)`にすると`receive()`がブロックせず即座に戻る。`rt.socket.select()`で読めると分かったソケットは`settimeout(0)`で読み、送信時だけtimeoutを設定する。0.2秒等のtimeoutのまま読むと、読めるソケットが複数ある場合に1本ずつ直列に待たされる
- **TLS/SSL対応の記載なし** — Persistent raw TCP上で暗号化通信をしたい場合、ソケットライブラリ単体では不可能とみられる
- 同時接続数、バッファサイズ、長時間接続の制限は未確認

## rt.httprequest

- HTTP/HTTPS通信。GET/HEAD/POST対応。
- 戻り値はテーブル形式（通信成否、ファイル書込成否、code、header、body）
- RTX830での制約: URL最大255文字、body最大640KB、タイムアウト1〜180秒
- Basic認証・Bearer認証（Ver1.08〜）対応
- **`_RT_LUA_VERSION` が "1.08" 以上の場合、`https://` で始まるURLを指定するとSSL通信を行う**（RTX830は対応）
- ただしこれは単発リクエスト/レスポンス用のAPIであり、Persistentな双方向streamには使えない

以下はIssue #4のRTX830実機検証で確認した制約。Agent Protocol(`docs/core/agent-protocol.md`)はこれらを前提に設計している。

- 引数: `url`、`method`、`auth_type` / `auth_name` / `auth_pass`(Basic)、`auth_token`(Bearer)、`timeout`、`post_text` / `post_file`、`content_type`、`save_file`。**任意のrequest headerを追加するfieldは無い**
- 戻り値: `rtn1`(送信成否)、`rtn2`(ファイル出力成否)、`err`、`code`(HTTP status)、`header`、`body`
- **TLS証明書検証をskipするoptionは無い**。自己署名証明書のendpointには接続できない
- 呼び出しはblockingで、応答を受け取るまでスクリプトが止まる。呼び出しごとに接続を閉じるため、毎回TLS handshakeが発生する
- **Cloudflare Workers / Tunnel系edgeへはTLS接続できない**。ClientHelloに対しCloudflare側がTLS Alert `handshake_failure`を返す(packetdumpで確認)。Cloudflareの通常CDN / proxy配下や非Cloudflareのsiteには接続できる
- **`method='POST'`には`content_type`が必須**、`content_type`を指定すると`post_text`か`post_file`のどちらかも必須。bodyの無いPOSTは表現できない
- **`post_text`は以下のbyteを含むと`'post_text' field value of argument #1 is invalid.`のLua errorになる**(0〜255の全値を`pcall`で実測): `0-8, 11, 12, 14-31, 127`。`9`(TAB)、`10`(LF)、`13`(CR)、`32`(space)は送信できる。以前の記録にあった「14-32」は誤り
- **response bodyは`0x00`の位置で切り捨てられる**。`post_file`で送る場合も`0x00`以降は切り捨てられる
- **`post_file`は内蔵フラッシュ(RTFS)への一時ファイル書き込みを伴う**。低速なうえ、書き込み中に`RTFS garbage collecting`が走ることを確認しており、書き込み失敗の原因になりうる。常駐Agentでは使わない
- **401等のHTTP errorでも`rtn1`はtrueになる**(`rtn1`は送信成否で、`code`にHTTP status(数値)が入る)。成否は`code`で判定する(Issue #7で実機確認)
- **`save_file`は受信したbyte列をそのまま保存する**(改行変換なし)。成功時は`rtn2`がtrueで、`body`にも同じ内容が入る(Issue #7で実機確認)

## rt.syslogwatch

- SYSLOGのパターンマッチ監視。N回検出またはSECONDS経過で返却。
- 引数: パターン（Luaパターンマッチ）、検出回数（1〜1000）、タイムアウト秒数
- 戻り値: ヒット件数、マッチ行の配列
- Ver1.03以降で対応（RTX830は対応）
- **検証済み(Issue #26)**: **呼び出している間に出た行だけ**を返す。呼び出し前に出ていた行(log bufferにある行)は返さない。ヒットが無い場合は`0, nil`をtimeout後に返す
- そのため、常時SYSLOGを拾うには監視専用のLua taskを常駐させる必要がある(`docs/core/syslog-design.md` §4.3)
- `rt.syslog(level, message)`(例: `rt.syslog('info', 'message')`)でログ行を書ける。引数が1つだとerrorになる

## 標準ライブラリの制約（検証済み: RTX830, 2026-09-07）

- **`math.floor` は存在しない（`nil`）。`math.huge` も `nil`。`math.abs` は存在する。** `math`テーブル自体はある（縮小版）ので、他の関数も個別に存在確認が必要。
- floor除算が必要な箇所（バイト列のビッグエンディアン変換など）は `math.floor(x/256)` ではなく、`local r = x % 256; local q = (x - r) / 256` のように剰余の引き算で代用する（`agent/framing.lua`のu16/u32参照）。
- この制約はPoC-2（フレーミング版, `agent/framing_command_agent.lua`）の実装中に`attempt to call field 'floor' (a nil value)`というLuaランタイムエラーで発覚した。

## httpd host（WebGUI自己接続の関連仕様）

- YAMAHAルーターのHTTPサーバー（WebGUI）へのアクセス許可ホストを制御するコマンド。
- 設定値: `any`（全ホスト許可）/ `none`（全て禁止）/ LANインターフェース名（例: `lan1`、そのLAN内のみ許可）
- LANインターフェース指定時は、ネットワークアドレスとリミテッドブロードキャストアドレスを除くIPアドレスからのアクセスを許可する。

## 自己WebGUI接続 PoC 結果（2026-09-07、RTX830実機）

`rt.socket.tcp()` で自分自身のLAN IP（`192.168.100.1:80`）へconnectし、`GET / HTTP/1.1`（Host/User-Agent/Accept/Connectionヘッダ付き）を送信 → **`HTTP/1.0 200 OK` + WebGUI本体のHTMLが返った。connect/send/receiveすべて成功。**

追加で分かったこと:

- 素の`GET / HTTP/1.0\r\n\r\n`のような最小リクエスト（Host/User-Agentなし）は`400 Bad request`になる。これはLuaや自己接続固有の問題ではなく、`nc`で同じリクエストを送っても同じ400が返ることを確認済み（YAMAHA組み込みHTTPサーバー側の要求）。Host/User-Agent/Acceptを含めれば200 OKになる。
- **確定: 自己接続はYAMAHA WebGUIのBasic認証を、login user password / administrator passwordの設定有無に関わらず常にバイパスする。** 最初はlogin/administratorパスワード未設定機で確認したが、その後login user password・administrator passwordを設定した状態で再検証しても結果は同じ(`200 OK`、認証プロンプトなし)。同時に、外部LAN端末（Mac）からcurlで同じURLへアクセスすると、パスワード未設定時は`401 Unauthorized`、設定後は正しい認証情報(`-u ":<login password>"`)でのみ`200`になることを確認しており、認証機構自体は正常に機能している。つまりこれはパスワード設定状態に依存しない、自己接続（送信元=宛先=ルーター自身のLAN IP）固有の仕様と考えられる。Luaスクリプトを実行できる時点で管理者相当の権限を持つため、その先の自己接続にBasic認証を課さない設計とみられる。
- ルーターCLIの `lua -e "..."` はバックスラッシュを一般エスケープ文字として消費する（`\"` → `"`、`\r` → `r`、`\n` → `n` になり、バックスラッシュ自体が失われる）。CRLFが必要な場合は`\r\n`と書かず `string.char(13,10)` で組み立てる必要がある。この罠は`gsub`等のLuaパターン文字列内でも同様に発生する（`gsub('[\r\n]+', ...)` と書いたつもりが実際には`gsub('[rn]+', ...)`として実行され、出力中の`r`/`n`の文字を誤って消してしまった実例あり）。**`-e`ワンライナーでCR/LFを扱う処理は必ず`string.char(13)`/`string.char(10)`を使うこと。** ただし実際にファイル(`lua /path/to/file.lua`)として転送・実行する場合はこの制約は関係ない（バックスラッシュはLua自身がそのまま解釈する）。
- **重要な発見(ブラウザ実機テスト、2026-09-07)**: Lua自己接続経由でWebGUIを開くと、ページ内に**「YNOマネージャー経由でアクセスしています」という純正YAMAHAのバナーが表示される**。このルーターの`show status yno`は`XMPP: 未接続 / GFW: 未接続 / LAS: 未接続 / オペレーターID: (空)`であり、**YNOマネージャーへの実接続は一切していない**。にもかかわらずこのバナーが出るということは、WebGUI側はYNOへの実接続状態を見ているのではなく、**「自己ループバック接続(送信元=宛先=ルーター自身)からのHTTPアクセス」を検知した場合に一律でこの固定バナーを表示している**と考えられる。YNO公式の「YNOエージェント機能」には`GFW`(GUI Forwarder、`yno gui-forwarder timeout`コマンドが存在)という、まさに本プロジェクトが再現しようとしているのと同じ「WebGUIをリモートへ転送する」仕組みがある。つまり**我々のLua自己接続は、YAMAHA純正のGUI Forwarderと同じHTTPサーバー内部の判定ロジックを通っている可能性が高い** — 独自の抜け道ではなく、ファームウェアに元々備わっているリモートWebGUI転送用の経路を辿っていると考えられる。

## 未確認のまま残っている項目（実機PoCで確認すべきもの）

- `rt.socket.tcp()` の同時接続数上限、メモリ/CPU制約
- 長時間persistent socketの安定性（NAT timeout、keepalive挙動）
- Lua Scriptの実行時間制限・watchdog・再起動条件
- ファイルI/O・永続ストレージの容量
- `rt.command("show config")` のような大きい出力のサイズ上限

## Lua taskの起動・停止（検証済み: RTX830, Issue #7）

- `rt.command('lua /path.lua')`で別のLua taskを起動できる(戻り値は`true, nil`)
- `rt.command('terminate lua <task id>')`で他のLua taskを止められる
- `rt.command('show status lua running')`で動いているtaskの一覧を取れる。出力はShift_JISだが、task ID行(`<id>  (<状態>)`、状態は`RUNNING` / `COMMUNICATE`等のASCII)とスクリプトファイル行(`:<空白>/path.lua`)はASCIIで解析できる
- `rt.command()`で起動したtaskの`print`出力はtelnet consoleに出ない(telnetから`lua`で起動したtaskの`print`は出る)。常駐taskのlogは`rt.syslog`等で出す必要がある
- `rt.sleep(秒)`がある(`rt.socket.select({}, {}, 秒)`と同様に使える)

### 自分自身をterminateしてはいけない（検証済み: RTX830, Issue #45）

Lua taskの中から`rt.command('terminate lua <自分のtask id>')`を実行すると復旧不能になる。

- `rt.command`はコマンドの完了を待つが、完了には自分の終了が必要なためdeadlockする
- 当該taskは`TERMINATE`状態のまま残り、以後`lua` / `terminate lua` / `restart`が
  すべて「タイムアウトによりコマンドの実行を中止しました」になる
- `show` / `save` / routingは影響を受けないため、気付きにくい
- CLIからは復旧できず、電源の再投入が必要

`show status lua running`のパースでは、task IDとスクリプトファイルを**task単位**で対応付ける。
`lua -e`で起動したtaskにはスクリプトファイル行が無いため、複数行にまたがるパターン
(`(%d+)%s+%(%u+%).-:%s+(/[%w_%.]+%.lua)`のような`.-`)を使うとIDが次のtaskのpathと結び付き、
意図しないtask(しばしば自分自身)をterminateする。

terminate対象は必ず自分のscript pathを除外する
(`agent/update/routemon_bootstrap.lua`の`terminate_all`)。

## rt.syslogwatchの取りこぼし（検証済み: RTX830, Issue #79）

- `rt.syslogwatch(pattern, max, seconds)`は**指定秒数を待ち切ってから**まとめて返す。
  早期には返らないため、窓を長くすると配信遅延がそのまま伸びる
- 窓と窓の切れ目に出た行は落ちる。実測(1秒間隔で20行):

  | watch窓 | 届いた行 | routerのlog時刻からServer受信までの遅延 |
  | --- | --- | --- |
  | 2秒 | 19 / 20 | 1〜3秒 |
  | 10秒 | 20 / 20 | 約16秒 |

- そのためwatcherは、Live Logs中だけ2秒窓、通常は10秒窓へ切り替える。
  AgentがLive modeを`L1` / `L0`の1行でwatcherへ通知する(`agent/routemon_syslog_watcher.lua`)

## CONFIG変更とSYSLOG（検証済み: RTX830, Issue #5）

- 個々の設定commandはSYSLOGへ出ない。`save`したときだけ1行出る
  - `Configuration saved in "CONFIG0" by TELNET`(実行元は`TELNET` / `HTTPD`等)
- `syslog notice` / `syslog info`が両方offでも出力される
- 連続`save`は抑制されず、実行回数ぶん出力される
- `syslog info on`にすると`[INSPECT]`のpacket logが大量に出るため、収集経路へ流すと
  SYSLOG storageを圧迫する。既定のまま(notice / info off)で運用する
- `show config`は動作中configを返すため、未保存の変更もCONFIG snapshotには含まれる
  (SYSLOGでは検知できない)

## `rt.command()`から`load`した場合のrollback timer（実機確認: RTX830 Rev.15.02.30）

YAMAHAの[設定の一括更新とロールバック](https://www.rtpro.yamaha.co.jp/RT/docs/cli/load.html)には、`quit` / `exit`でCLIを抜ける場合はロールバックタイマーが中止され設定が保持されること、またログインタイマーのタイムアウト時も設定が保持されることが記載されている。

RTX830 Rev.15.02.30で、Luaの`rt.command()`から`load file`に`rollback-timer`を指定して実行した。`rt.command()`は1コマンドの実行後に戻ってCLIセッションを保持しないため、300秒経過後もload後の動作中設定は自動復帰せず、設定が保持された。したがって、Luaから`rollback-timer`を指定しても自動復帰を安全網として扱ってはならない。CONFIG Applyでは、`load file ... silent`の後、検証が終わるまで`save`を送らない順序を安全網とする。

## ライブラリの有無（検証済み: RTX830, Issue #7）

- `debug`(`sethook` / `getinfo`含む)、`loadfile`、`loadstring`は使える。`bit32`は無い
- `rt`のkey: `command`、`httprequest`、`hw`、`mail`、`mime`、`sleep`、`socket`、`syslog`、`syslogwatch`。`rt.mime`には`b64` / `unb64`等がある
- `os`のkey: `clock`、`date`、`difftime`、`exit`、`getenv`、`remove`、`rename`、`time`
- `string`には標準関数に加えて`regexp`、`split`がある
- **`bit` library**(LuaBitOpとは別物): `band`、`bor`、`bxor`、`bnot`、`btest`、`bshift`、`brotate`。結果は32bit符号なし(`bit.bnot(0)`は`4294967295`)。`bshift` / `brotate`は第2引数が正で左、負で右(`bshift`の右は論理shift)。`bxor`等は3つ以上の引数を取れる。負数を渡すとerrorになる
- `bit`を使ったpure LuaのSHA-256(`agent/update/sha256.lua`)は正しい値を出し、速度は約0.7 KB/秒(11.9 KBで17〜18秒、60 KBで95秒)

## os.rename（検証済み: RTX830, Issue #7）

- **移動先が存在すると`File exists`で失敗し、上書きしない**。置き換える場合は移動先をremoveしてからrenameする(その間は移動先が存在しない)
- 移動先が存在しなければrenameできる

## io.openの改行変換（検証済み: RTX830, Issue #4）

- **`io.open(path, 'w')`はテキストモード相当の改行変換を行い、`0x0A`の前に`0x0D`を挿入する。** 任意のバイナリデータを書く場合は`'wb'`(読む場合は`'rb'`)を使う。Luaスクリプト自体(テキスト)を書く用途では`'w'`で問題は出ていない

## 常駐スクリプトのデプロイ方法（検証済み: RTX830, 2026-09-07）

TFTP/USBが使えない環境で、telnetだけから複数行の永続スクリプトをルーターへ配置する方法。

1. **`io.open(path, 'w')` + Luaの長文字列`[[...]]`で一括書き込みする。** ソース中の改行を空白/セミコロンに置き換えて1行のLuaソース文字列にし、`[[ ]]`で囲んで`f:write()`に渡せば、ルーターCLIのバックスラッシュ食い問題（`lua-api-notes.md`前述）を一切気にせず書き込める（`[[ ]]`内はエスケープ不要のリテラル文字列のため）。
2. **ソース中の文字列リテラルはすべてシングルクォートに統一すること。** ダブルクォート(`"`)を使うと、ルーターCLI自体の`-e "..."`という外側の引用符と衝突し、コマンドがそこで分断される（構文エラーにすらならず、単に何も実行されない・出力が一切出ないという壊れ方をする）。
3. **`io.open(path, 'a')`（追記モード）は使用不可。** 「Operation not supported」のerrorになる場合と、errorにならずに内容が変わらない場合(`'w'`で書いた`AAAA`へ`'a'`で`BBBB`を書いても`AAAA`のまま、Issue #4)の両方を観測している。 複数チャンクに分けて追記していくアプローチは使えないため、ファイル全体を1回の`'w'`書き込みで済ませる必要がある。今回は2359文字のスクリプト全体を1回の`-e`呼び出し(コマンド全体で約2450文字)で問題なく書き込めた。
4. **小数点を含む数値リテラル(`0.2`など)は`malformed number`という構文エラーになる。** タイムアウト値などは整数(`1`など)を使うこと。文字列内(`"192.168.100.2"`等)の小数点表記は問題ない。
5. **`lua <file>`はバックグラウンドタスクとして非同期実行される。** 実行するとすぐ`#`プロンプトに戻るが、スクリプトは裏で動き続けている（`while true`ループを含む常駐スクリプトでも同様）。実行中かどうか・エラー終了したかは`show status lua`の`[running]`/`[history]`セクションで確認できる。エラー発生時は`show status lua`の履歴にエラーメッセージ(`lua: /path.lua:N: <エラー内容>`)が残るので、常駐スクリプトが動いているように見えて実は即エラー終了していないか、必ずここで確認すること。
