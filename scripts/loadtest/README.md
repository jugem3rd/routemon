# Gatewayの負荷試験

Agent Gatewayに、擬似Agentで負荷を掛けて、CPU・memory・FD・応答の遅れを測る。測定の記録は
`docs/community/loadtest.md`。

- `server.ts`: 試験用server。Community Serverと同じ`AgentGateway`とAgent endpointを、認証に`MemoryDeviceStore`を
  使って起動する。SYSLOGは、実経路(`SyslogService`のfile保存と、Event抽出)を通す。WebGUI relayも載せる。
  数秒ごとにCPU・memory・FD・接続数を、1行のJSONで出力する
- `agents.ts`: 擬似Agent(load generator)。実際のAgentと同じ形で`POST /v1/tunnel/sync/<wait>`を繰り返す
- `gen-cert.sh`: 自己署名の証明書を作る(TLSを試すとき)

## 注意(先に読む)

- **段階的に台数を増やし、`--ramp`で開始を数十秒以上に散らす。** 1つのIPから短時間に大量の同時TLS接続を張ると、
  VPS事業者側の遮断を招くことがある(約1,400本を短時間に張って、約10分、VPSへ届かなくなった例がある)
- **試験元と試験先を、同じhostに置くと、interfaceを通らないので安全**。ただし、CPUを取り合うため、
  CPUの値は、実際より大きく出る(特に2 vCPUでは)
- 公開しているServerや、他人のServerへは向けない

## 使い方

```sh
# 1. 試験用server(別のterminalで)。Device dev-1..dev-1000のcredentialは tok-1..tok-1000
node scripts/loadtest/server.ts --devices 1000 --port 18081

# 2. 擬似Agent: 300台を20秒に散らして開始し、60秒間続ける(待機20秒のlong-poll)
node scripts/loadtest/agents.ts --url http://127.0.0.1:18081 --agents 300 --ramp 20 --duration 60
```

TLSで試すとき(Gateway自身がTLSを終端):

```sh
sh scripts/loadtest/gen-cert.sh /tmp/loadtest-cert
node scripts/loadtest/server.ts --devices 1000 --tls-cert /tmp/loadtest-cert/cert.pem --tls-key /tmp/loadtest-cert/key.pem
node scripts/loadtest/agents.ts --url https://127.0.0.1:18081 --insecure --agents 300 --ramp 20 --duration 60
```

### シナリオ

| 試したいこと | generatorの引数 |
| --- | --- |
| 空bodyのsyncだけ(既定) | `--agents N --ramp S --duration S` |
| SYSLOG batch | `--syslog-lines 50`(各syncで50行を送る)、`--syslog-event-every 10`(10行に1行を、Event抽出の対象の行にする)、`--wait 5`(syncの間隔を縮める) |
| WebGUI relay | `--gui-clients 10 --gui-bytes 1048576`(Device `dev-1`を転送先にして、10個の擬似Browserが1MBのページを繰り返し取る) |
| 複数の試験元 | 複数のhostで、`--id-offset`を変えて実行する(`--id-offset 1000 --agents 500`は、`tok-1001`〜`tok-1500`を使う。serverの`--devices`をそれ以上にする) |

### FD上限(containerの既定は1,024)

Gatewayは、同時接続1本につきFDを1つ使う。containerの上限を下げて、何台で詰まるかを見る。

```sh
docker run --rm --network host --ulimit nofile=1024:1024 -v "$PWD/scripts:/app/scripts:ro" \
  ghcr.io/jugem3rd/routemon:latest node scripts/loadtest/server.ts --devices 2000
# generator側は、上限を上げておく(試験元が詰まらないように)
docker run --rm --network host --ulimit nofile=65536:65536 -v "$PWD/scripts:/app/scripts:ro" \
  ghcr.io/jugem3rd/routemon:latest node scripts/loadtest/agents.ts --url http://127.0.0.1:18081 --agents 1500 --ramp 60 --duration 120
```

### Gatewayの再起動直後

generatorを動かしたまま、serverを止めて、数秒後に起こす。generatorの出力(`--report-interval`ごとの`syncFailed`と
`syncPerSec`)で、失敗と回復の速さが分かる。擬似Agentは、1秒から倍々(最大30秒)のbackoffで再接続する。

## 出力の読み方

generatorは、`--report-interval`秒ごとと最後に、JSONを1行ずつ出す。

| 項目 | 意味 |
| --- | --- |
| `syncOk` | 待機時間(`--wait`)いっぱいまで待って、正常に返ったsync |
| `syncEarly` | 待機時間より早く返ったsync(Serverからのframeを受け取った) |
| `syncFailed` | 失敗したsync(接続の失敗、HTTPのerror、timeout) |
| `lateMsP50/95/99` | `syncOk`が、待機時間を過ぎてから返るまでの遅れ(ms)。**往復とTLS handshakeを含み、サーバーの処理遅延だけではない** |
| `guiOk` / `guiMsP50/95` | 擬似Browserのrequestの成功数と、要した時間 |
| `errors` | 失敗の内訳(`ECONNREFUSED`、`ECONNRESET`、`EMFILE`等) |

serverは、1行ごとに`cpuPct`(コア1つに対する%)、`rssMb`、`fds`、`agentConns`(同時の接続数)、`syslogLines`(受け取った行数)を出す。
