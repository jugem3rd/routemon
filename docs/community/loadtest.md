# Gateway負荷試験の記録

Status: Measurement record  
Last updated: 2026-10-06

Agent Gatewayに、擬似Agentで負荷を掛けた測定の記録。試験用のserver・load generator・手順は、
`scripts/loadtest/`(`README.md`)にあり、**同じ測定を再現できる**。

目安の台数は、数台〜数十台、多くても数百台(`docs/product/service-policy.md`)。

## 1. 測定の環境と方法(2026-10-06)

| 項目 | 内容 |
| --- | --- |
| Server | VPS 1台。2 vCPU / 約2GB memory / Ubuntu 24.04 / Docker 29.8.2 / Node.js 24.21.0 |
| 試験用server | `scripts/loadtest/server.ts`をcontainerで実行(`--network host`)。`AgentGateway` + `MemoryDeviceStore` + Agent endpoint、**Gateway自身がTLSを終端**(自己署名のEC証明書)。SYSLOGは実経路(`SyslogService`、Raw SYSLOGのfile保存、Event抽出)を通す |
| 試験元 | 同じVPSの別container(`scripts/loadtest/agents.ts`)。**loopbackで接続する** |
| 擬似Agent | 実Agentと同じ形で`POST /v1/tunnel/sync/<wait>`を繰り返す(既定は待機20秒のlong-poll)。**syncごとに新しいTCP / TLS接続**を張る。失敗時は1秒から倍々のbackoff(最大30秒)。開始は`--ramp`の秒数に散らす |
| 測るもの | serverが5秒ごとに出す、CPU(コア1つに対する%)・RSS・FD数・同時接続数。generatorが出す、syncの成功・失敗、待機時間を過ぎてからの遅れ |

**この環境の限界(数値を読むときに必ず考慮する):**

- 試験元と試験先が同じ2 vCPUを共有する。serverのCPU値は、server processだけのもの(試験元は含まない)だが、CPUを取り合う
- loopbackのため、**往復時間とネットワークの揺れを含まない**。表の「遅れ」は、Gatewayの処理とTLS handshakeが主
- 前段のCaddyを通していない(Community標準構成は、Caddyが TLSを終端する)。TLSの負荷が、Gatewayの代わりにCaddyへ移る分、Gateway単体のCPUは、ここより小さくなる見込み(未測定)
- 擬似Agentは、RTX830の実測ではない。sync間隔の下限は、250ms(`--min-sync-interval-ms`)と仮定した
- 各phaseは90〜120秒。長時間(soak)の傾向は見ていない

## 2. 結果

### 2.1 空のsync(待機20秒のlong-poll)

| 台数(ramp) | sync | 頻度(平均) | CPU(平均 / 最大) | RSS(最大) | FD(最大) | 待機を過ぎてからの遅れ p50 / p95 / p99 |
| --- | --- | --- | --- | --- | --- | --- |
| 300(20秒) | 成功1,032、失敗0 | 毎秒11.5(定常は約15) | 6.7% / 9.7% | 135MB | 324 | 8.8 / 13.8 / 19.7 ms |
| 600(60秒) | 成功2,426、失敗0 | 毎秒20.2(定常は約30) | 9.7% / 11.2% | 162MB | 624 | 7.3 / 13.2 / 17.3 ms |
| 1,500(60秒、FDの項を参照) | 成功6,014、失敗0 | 毎秒50.1 | 約20% | 275MB | 1,524 | 6.8 / 16.1 / 34.9 ms |

- 同時接続1本につき、FDは1つ。**FD = 同時接続 + 約24**
- 2026-10-04の、インターネット越しの測定(Mac → VPS、下の§4)と、同じ水準(300台で約5%・約131MB、600台で10〜14%・約155〜160MB)

### 2.2 SYSLOG batch(実データを含むsync)

各syncに、50行(1行あたり約96 byte)のSYSLOG batchを載せる。10行に1行は、Event抽出の対象(`IP Tunnel[1] Up` / `Down`)。
serverは、実際の`SyslogService`で、Raw SYSLOGをfileへ保存し、Eventを抽出する。

| 条件 | 受信した行 | CPU(平均 / 最大) | RSS(最大) | 遅れ p50 / p95 / p99 | 失敗 |
| --- | --- | --- | --- | --- | --- |
| 300台、待機20秒(約750行/秒) | 64,250行 / 6.2MB(90秒) | 8.1% / 10.5% | 185MB | 9.5 / 18.9 / 32.2 ms | 0 |
| 600台、**待機5秒**(約4,400行/秒) | 523,250行 / 50.2MB(120秒) | 37.4% / 39.0% | 268MB | 8.6 / 31.0 / 64.3 ms | 0 |

- 1行目は、実運用に近い量。2行目は、実運用よりはるかに多い量(全台が5秒ごとに50行を出し続ける)で、**それでも失敗は0**
- 送信した行と、受信した行の差(送信67,200行に対して受信64,250行など)は、試験の終了時に処理中だった分
- 2行目の保存量は、約0.4MB/秒(約1.5GB/時間)。この量では、CPUよりdiskの保持期間が先に問題になる(`docs/community/storage-backup-design.md`の保持設定)

### 2.3 WebGUI relay

Device `dev-1`を、Native WebGUIの転送先にする(擬似Agentが、STREAM_OPENに、指定のbyte数のHTTP応答を、8KBのSTREAM_DATAで返す)。
擬似Browserが、WebGUI relayへ、cookieつきのrequestを、完了のたびに繰り返す。ほかの299台は、空のsyncを続ける。

| 条件 | 成功 / 失敗 | Browserから見た1ページの時間 p50 / p95 / 最大 | CPU(平均 / 最大) | RSS(最大) | 他のDeviceのsync遅れ p99 |
| --- | --- | --- | --- | --- | --- |
| 同時5 stream、64KBのページ | 666 / 0 | 407 / 416 / 493 ms | 10.0% / 12.3% | 150MB | 19.6 ms |
| 同時10 stream、64KBのページ | 1,046 / 0 | 437 / 679 / 717 ms | 12.2% / 13.9% | 152MB | 25.4 ms |
| 同時10 stream、**1MB**のページ | 66 / 0 | **10,146 / 10,174 / 10,183 ms** | 11.6% / 14.4% | 147MB | 25.6 ms |

- Server側の負荷は小さく、**ほかのDeviceのsyncに影響しない**
- 時間は、**Agentの上りが律速**する。Agentは、1回のsyncで、最大256KB(擬似Agentの設定。RTX830の送信上限は640KB)を送り、次のsyncまで、最小250msを空ける。そのため、1台のDeviceのGUIの転送は、約1MB/秒が上限になり、1MBのページを10 streamで同時に取ると、1ページあたり約10秒になる
- 実機での転送速度は、RTX830のTLS handshakeとCPUで決まる。この表の時間は、実機の見込みではなく、**Server側が律速でないことの確認**として読む

### 2.4 FD(file descriptor)の上限

`docker run --ulimit nofile=1024:1024`(soft・hardとも1,024)で、1,500台(ramp 60秒、待機20秒)を接続した。

| 時点 | 同時接続 | FD | 状況 |
| --- | --- | --- | --- |
| 開始から約30〜40秒 | 約900 | 約930 | 正常(最初の失敗が出始める) |
| 約40秒以降 | 約1,000で頭打ち | 1,024 | **新しいsyncが、`ECONNRESET`で失敗し始める**。serverは、acceptした直後に閉じる(libuvのEMFILEの退避)。serverのprocessは**落ちず**、動き続けた。serverの統計の取得も、`EMFILE`で失敗した |
| 50〜120秒 | 約1,000 | 1,024 | 1,500台のうち、毎10秒で約500のsyncが成功し、約150〜1,200が失敗。120秒間で、成功4,501、失敗4,226(すべて`ECONNRESET`)。擬似Agentは、backoffで再接続を続ける |

- 同じ条件で**`--ulimit`を指定しない**(Dockerの既定、soft 1,024 / hard 524,288)と、**1,500台が失敗0で接続できた**(FD 1,524、CPU約20%、RSS 275MB、§2.1の3行目)。Node.jsが起動時にsoft limitをhard limitまで引き上げるため。**詰まるのは、hard limit自体が低い環境(`--ulimit nofile=1024:1024`、systemdのservice、古いhost等)に限る**
- FDが尽きている間は、sync以外でもFDが要る処理(Raw SYSLOGのfile保存、CONFIGのfile保存、統計の取得等)が失敗するはずである。**この試験では、確かめていない**(空のsyncだけを流したため)
- そのため、`compose.yaml`に、`ulimits.nofile`を明示した(65,536)。環境のhard limitに左右されない

### 2.5 Gatewayの再起動直後

300台(待機5秒、ramp 20秒)が定常になった約50秒後に、`docker stop`し、5秒待って、`docker start`した。

| 時間(5秒窓) | 成功 | 早く返った | 失敗 | 状況 |
| --- | --- | --- | --- | --- |
| 〜45秒 | 約300 | 0 | 0 | 定常 |
| 50秒 | 312 | 266 | 300 | stop。待機中の266本は、停止を受けて**早く返った**(graceful shutdown) |
| 55秒 | 0 | 0 | 600 | server停止中。全台が`ECONNREFUSED` |
| 60秒 | 0 | 0 | 0 | 全台が、backoff(1、2、4秒)で待機中。server起動 |
| **65秒** | **300** | 0 | 0 | **全台が復帰** |

- 失敗は、全体で900(300台 × 3回、すべて`ECONNREFUSED`)。**起動後、1窓(5秒)以内に全台が復帰した**
- 復帰直後も、serverのCPUは14〜17%で、スパイクは見られなかった(300台が、数秒の間に同時に再接続しても、問題はなかった)。1,000台以上の再接続は、測っていない

## 3. 結論と、測っていない範囲

**結論(この環境で):**

- 数百台(〜600台)の空のsyncは、Gateway 1 processで、CPUはコア1つの約10%、memoryは約160MB。2 vCPU / 2GBのVPSに十分収まる。1,500台でも、約20% / 275MB
- SYSLOGを、実運用の数倍の量で載せても、失敗は出ず、CPUは約40%まで
- WebGUI relayは、同時10 streamでも、Server側の負荷は小さく、ほかのDeviceに影響しない
- FDは、Dockerの既定なら問題にならない。hard limitが低い環境では、約1,000台で詰まる。→ `compose.yaml`で明示した
- 再起動後の復帰は、数秒で、全台が戻る

**測っていない範囲:**

- **複数拠点(複数のIPアドレス)からの接続**。試験元は、1か所(loopback)だった。実際は、拠点ごとの回線で、RTT・パケットロス・再接続のタイミングが違う
- **前段のCaddyを通した構成**(Community標準構成)。TLSの負荷とconnection数が、Caddyを通すと変わる
- **Live Logs**(`SYSLOG_LIVE`の購読者がいるときの、短い送信周期)。API・認証が要るため、このscriptの範囲外
- COMMAND、CONFIG(取得・Apply)を含むsync
- FDが尽きたときの、SYSLOG・CONFIGの保存の失敗
- 1,500台を超える規模、数時間以上の連続運転(memoryの増加、FDの漏れ)
- **実機のAgentの挙動**(sync間隔の下限、WebGUIの転送速度)。擬似Agentの値は、想定

## 4. 参考: 2026-10-04の測定(インターネット越し)

使い捨てのscriptで測った(試験用のserverとload generatorは、repositoryに無い)。上の§2.1は、この結果を、再現できる形で測り直したもの。

条件: 2 vCPU / 2GB memoryのVPS(約38GBのdisk、Ubuntu 24.04、Docker 29)。擬似Agent(Node.js)は、別の場所のMacから、インターネット経由で接続した。`AgentGateway` + `MemoryDeviceStore` + `createAgentEndpoint`だけを起動した試験用serverで、Gateway自身がTLSを終端した。containerは`--ulimit nofile=65536:65536`。

| 台数(ramp) | sync | 頻度 | CPU(コア1つに対して) | memory(RSS) | FD | 応答の遅れ(p50 / p95 / p99) |
| --- | --- | --- | --- | --- | --- | --- |
| 300(20秒) | 成功2,689、失敗0 | 毎秒約15 | 約5% | 約131MB | 約320 | 91 / 111 / 128 ms |
| 600(60秒) | 成功3,870、失敗0 | 毎秒約30 | 約10〜14% | 約155〜160MB | 約620 | 93 / 約115 / 約205 ms |

(応答の遅れは、Macからの往復とTLS handshakeが主で、サーバー側の処理遅延ではない。conntrackは最大2,297 / 上限65,536)

**2,000台(ramp 20秒)で、通信が途絶した。** 開始の約30〜40秒後に、試験元のMacからVPSへのすべての通信(SSH、ping、Agent endpoint)が届かなくなった。VPSは稼働を続けていた(統計は出力され続け、RSS最大約217MB、OOM / conntrack満杯のkernel logなし)。試験を止めた後も約10分以上復旧せず、VPSの再起動で復旧した。原因は未確定(事業者側の大量接続の検知による遮断、または試験元のネットワークの問題が疑われる)。ramp 60秒、600台では再現しなかった。1つのIPから、短時間に約1,400本の同時TLS接続を張った。

→ このため、**負荷試験は、段階的に台数を増やし、rampを数十秒以上に散らす**(`scripts/loadtest/README.md`の注意)。
