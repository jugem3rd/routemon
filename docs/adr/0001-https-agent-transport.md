# ADR-0001: Agent標準TransportにHTTPSを採用する

- Status: Accepted
- Scope: Core
- Date: 2026-09-12
- Decision Owners: Routemon
- Related: Issue #4

## Context

Routemonでは、YAMAHA Router上のLua AgentとBackend間で、WebGUI relay、Command、Telemetry、Event、CONFIG等をやり取りする必要がある。

当初はPersistent raw TCPをPoCの基準方式としていたが、複数の拠点へ導入する場合、独自TCPポートはFirewall / UTMポリシー追加の原因になりやすい。

Issue #4で`rt.httprequest()`を利用したHTTPS transportを実機検証し、初期実装では高負荷時のメモリ不足や大きなlatencyが確認された。その後、sync方式、一時ファイル廃止、buffer上限、socket read改善等を行い、実用範囲まで改善した。

## Decision

Routemonの **Router ↔ Backend間の標準Agent transportはHTTPSとする**。

YAMAHA Lua Agentは`rt.httprequest()`を使用し、Backendとの通信をTCP/443のHTTPS request/responseとして行う。

現行PoCで実装・最適化したHTTPS sync transportを正式Agent実装のベースとする。

```text
YAMAHA Router
  │
  │ HTTPS / TCP 443 (outbound)
  │ rt.httprequest()
  ▼
Routemon HTTPS Gateway
  │
  ├─ tunnel / multiplex
  ├─ command
  ├─ telemetry
  └─ config / event
```

raw TCP transportは削除せず、以下の用途に限定して保持する。

- 開発・診断
- performance baseline
- HTTPS非対応機種・Firmwareが将来判明した場合のfallback候補
- 特殊な閉域環境等でraw TCPを明示的に選ぶ必要がある場合の代替手段

通常のRoutemon導入ではHTTPSを標準とし、利用者にtransport選択を要求しない。

## 旧判断との関係

初期のPoCの記録(2026-09-11時点)では、raw TCP継続を正式判断としていた。

その時点ではHTTPS実装に以下の問題が残っていた。

- 多数stream時のメモリ不足
- `STREAM_CLOSE`未送信による遅延伝播
- poll + pushによるTLS handshake回数増加
- `post_file`による一時ファイルI/O
- COBSエンコード処理コスト
- local WebGUI socketの直列待ち
- 12並列時に10秒前後以上となるlatency

その後Issue #4の継続検証でこれらを修正し、HTTPS transportの性能・安定性が実用範囲まで改善したため、**§15のraw TCP採用判断を本ADRで上書きする**。

PoC詳細設計書の§15は当時の判断経緯として削除せず履歴として残す。

## HTTPS採用理由

### Firewall / UTM環境への導入性

Routemonは複数の顧客拠点・ネットワーク環境への導入を想定する。

raw TCPの独自ポートを使用すると、導入先ごとにoutbound firewall policyの追加や説明が必要になる可能性が高い。

HTTPSを標準とすることで、Router側は原則として以下だけで通信できる。

```text
outbound TCP/443
```

これにより企業Firewall / UTM / NAT配下での導入障壁を下げる。この運用上のメリットをraw TCPに対する速度差より優先する。

### 実機性能が実用範囲まで改善した

RTX830実機で、最適化後のHTTPS transportは以下を確認した。

| 項目 | HTTPS | raw TCP baseline |
|---|---:|---:|
| `/define.js`単発 | 約0.29秒 | 約0.02秒 |
| 4並列 | 最大約0.32秒 | 約0.05秒 |
| 12並列 | 最大約1.96〜2.16秒、12/12成功 | 最大約0.28秒、12/12成功 |
| 持続負荷スループット | 約0.37MB/s | 約1.92MB/s |
| CPU負荷 | 21% | 45% |
| スループットあたりCPU負荷 | raw TCP比 約2.4倍 | baseline |

全リクエストについてraw TCPで直接取得した内容とのバイト完全一致を確認し、最適化後の試験ではAgentエラー0件だった。

HTTPSはraw TCPより遅く、単位転送量あたりのCPUコストも高いが、YAMAHA WebGUIの遠隔管理用途としては実用可能な水準と判断する。

### 通信保護を標準化しやすい

正式Agentでは通信の暗号化が必須である。

HTTPSを標準にすることで独自暗号を実装せず、TLSと公開証明書を利用できる。Device Token等のAgent認証はHTTPS上で別途実装する。

## 採用するHTTPS transport

PoC初期の`poll + push` 2往復方式ではなく、最適化後の **sync方式** を採用する。

```text
Agent                         Backend
  │                              │
  │ POST /v1/tunnel/sync/<wait>  │
  │ body: Agent → Backend frames │
  │----------------------------->│
  │                              │
  │ response: Backend → Agent    │
  │<-----------------------------│
```

1回のHTTP request/responseで双方向のpending frameを交換する。

GUI active時は`wait=0`とし、response後すぐ次のsyncを行う。idle時はBackend側でlong-pollし、現行PoCの`IDLE_WAIT`は約20秒とする。数値は正式Agent実装時に再調整してよい。

## 正式Agentへ引き継ぐ主要最適化

- poll + pushを1回の`POST sync`へ統合する
- `post_file`を使わず`post_text` + `text_escape` / `text_unescape`を利用する
- bufferを無制限に蓄積せず、PoCでは`MAX_BATCH_BYTES = 32KB`を目安にflushする
- `rt.socket.select()`でreadableなlocal WebGUI socketだけを読む
- idle timeout / EOF等すべてのclose pathでBackendへ`STREAM_CLOSE`を通知する
- frame length / body sizeのvalidationを正式実装で追加する

## Cloudflareとの関係

**HTTPS採用 = Cloudflare WorkersへRouterを直接接続する、ではない。**

RTX830の`rt.httprequest()`からCloudflare Workers / Tunnel系エッジへ接続すると、Cloudflare側からTLS `handshake_failure`が返り、TLS sessionを確立できないことを実機packet captureで確認済み。

一方で、Let's Encrypt等の信頼された証明書を持つ一般的なHTTPS endpointとの通信は成立する。

したがって当面は以下とする。

```text
YAMAHA Router
  │ HTTPS :443
  ▼
HTTPS Gateway / VPS
  │
  └─ Routemon tunnel backend
```

Router → Agent Gatewayの直接収容先として、Cloudflare Workers / Tunnelを前提にはしない。

将来YAMAHA側FirmwareまたはCloudflare側TLS compatibilityが変化した場合は再検証する。

## raw TCP fallbackの扱い

raw TCP実装はperformance baselineとして保持するが、正式AgentではHTTPSを標準実装として完成させる。

raw TCP fallbackが実際に必要となった時点でtransport差し替えを検討し、「将来必要かもしれない」という理由だけでtransport切替UIや複雑な抽象化を先行実装しない。

## Consequences

### Positive

- Outbound TCP/443中心となり、Firewall / UTM環境へ導入しやすい
- TLSを標準利用できる
- WebGUI以外のCommand / Telemetry / Event / CONFIGも同一Agent channelへ統合しやすい
- HTTPS PoCの実測・最適化結果をそのまま正式Agentへ引き継げる

### Negative

- raw TCPよりlatencyと単位転送量あたりCPU負荷が大きい
- `rt.httprequest()`固有の制約へ対応する必要がある
- Cloudflare WorkersへのRouter直接接続は現状利用できない
- HTTPS Gateway用のVPS等は当面必要

## Follow-up

正式Agentでは以下を追加する。

1. Device ID
2. Agent authentication
3. Device Token / rotation / revoke
4. Tunnel Registryによる複数Agent対応
5. retry / exponential backoff
6. heartbeat / online判定
7. Agent auto-start
8. Bootstrap / Enrollment
9. Agent version管理・self update
10. secretを通常ログへ出力しない

## Revisit conditions

以下の場合はtransport方針を再評価する。

- HTTPSによるRouter CPU負荷が本来のルーティング処理へ明確な悪影響を与える
- 対象機種/Firmwareで`rt.httprequest()`の互換性問題が見つかる
- 実環境で必要なrequest rate / latencyを満たせない
- HTTPS Gatewayコストが許容範囲を超える
- YAMAHAがより適した公式transport APIを提供する

## References

- Issue #4
- `agent/https_tunnel_agent.lua`
- `agent/mux_agent.lua`
