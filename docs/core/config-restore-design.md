# CONFIG Restore / Apply Design (#62)

Status: Approved — implementation update pending
Scope: Core / Community implementation guide
Last updated: 2026-09-22

Related:

- Issue #62「保存したCONFIGをルーターへ復元する」
- `docs/core/agent-protocol.md`
- `docs/core/config-backup-design.md`
- `docs/core/device-profile-discovery-design.md`
- `docs/core/access-control-design.md`
- `docs/core/lua-api-notes.md`
- `docs/core/agent-update-design.md`（Supervisorの自動起動）
- `apps/community/src/config/configSnapshots.ts`
- `apps/community/src/jobs/jobs.ts`（#54）
- `apps/community/src/syslog/service.ts`（#76）

YAMAHA公開仕様:

- [設定の一括更新 (`load`)](https://www.rtpro.yamaha.co.jp/RT/manual/rt-common/operation/load.html)
- [設定内容の保存 (`save`)](https://www.rtpro.yamaha.co.jp/RT/manual/rt-common/operation/save.html)
- [再起動 (`restart`)](https://www.rtpro.yamaha.co.jp/RT/manual/rt-common/operation/restart.html)
- [設定内容の差分表示](https://www.rtpro.yamaha.co.jp/RT/manual/rt-common/showconfig/show_config_difference.html)

この文書は、保存済みCONFIGをRouterへ適用する設計と、適用後の保存・破棄を定義する。Router上の操作を次の3つへ分離する。

```text
適用(load)      CONFIGを動作中設定へ読み込む
保存(save)      動作中設定を不揮発性CONFIGへ保存する
再起動(restart) #54の既存機能。saveの有無を指定して独立に実行する
```

DeviceのCONFIG状態は、Routemonが管理する表示用の状態として次の2つだけを持つ。

```text
未保存 / 保存済み
```

Applyの転送・検証・保存処理には一時的な進行表示を持つが、それをDeviceのCONFIG状態へ追加しない。旧来の段階別な失敗状態は作らず、Deviceの状態は2値に寄せる。

## 1. Goal and non-goals

### 1.1 Goal

AdminがDeviceごとに保存済みのCONFIG世代を選び、現在の動作中CONFIGをServerへ自動snapshot保存して差分を確認したうえで、Routerの動作中設定へ適用できるようにする。

適用ダイアログでは、適用後の保存方法を選ぶ。

```text
◉ 保存しない       動作確認後に保存する。再起動すれば保存済みCONFIGへ戻る
○ すぐ保存する     apply_verifyが一致した場合だけsaveする
```

共通のApply処理は次の順序で行う。

1. 適用前の動作中CONFIGを`pre_apply` snapshotとして保存する。
2. 差分と高リスク項目を表示し、Adminの確認を受ける。
3. 専用frameでCONFIG全体をstagingする。
4. staging完成後にAgentが`load`を1回だけ実行する。
5. 再接続後の`apply_verify` snapshotをtargetと比較し、結果を画面に表示する。
6. 通常はここで止まり、Deviceを「未保存」とする。
7. 「すぐ保存する」が選択され、かつ`apply_verify`が一致した場合だけ、独立したsave操作を1回実行する。

Applyはrestartを実行しない。再起動が必要な場合は、#54の既存の再起動操作を別に実行する。

### 1.2 Non-goals

- 複数Deviceへの一括適用
- Template / Golden Configの配布
- 別DeviceのCONFIGを無検証で適用すること
- 任意CLI commandへCONFIG本文を渡す汎用機能
- Applyの中での自動saveまたは自動restart（「すぐ保存する」の明示選択後を除く）
- Routerへ接続できない状態での、Server側だけの自動復旧
- telnet等で行われた未保存変更を完全に検出すること

## 2. Decision summary

| 項目 | 提案 |
|---|---|
| RouterへのCONFIG転送 | `COMMAND_REQUEST`ではなく、CONFIG Apply専用frameを追加する |
| Router上の一時保存 | Agentが固定の安全なファイル名へ`io.open(..., 'wb')`で分割書き込みする |
| 一括適用 | Agentが`load file <staging-file> silent`を1回だけ実行する |
| 適用後の保存 | Adminの選択が「すぐ保存する」で、かつ`apply_verify`が一致した場合だけ`save`を1回実行する |
| 通常の適用完了 | `apply_verify`の結果を表示し、Deviceを「未保存」として停止する。自動restartはしない |
| 未保存の破棄 | Adminが明示した場合だけ`Jobs.reboot({ deviceId, userId, save: false })`を呼ぶ |
| 適用前snapshot | UIの確認用Prepare処理で`pre_apply` reasonのCONFIG_REQUESTを送り、保存完了後に差分を返す |
| 未保存表示の解除 | #76の`Configuration saved in "CONFIG0" by <実行元>` SYSLOG検知で「保存済み」にする。破棄再起動後は再接続とsnapshot一致を確認して解除する |
| 権限 | Prepare、Apply、save、破棄再起動、差分取得はServer-sideでAdminのみ |
| 競合制御 | DeviceごとにApply、save、restart、設定write操作を同時に実行しない |

「未保存 / 保存済み」はRouterの真の保存状態を完全に表すものではなく、Routemonが行った操作とSYSLOGから得た管理状態である。telnet等を経由した未保存変更は、現在のプログラムではCONFIG0との差分を取得できないため検出できない。この限界はUIと設計に明記する。

初期実装は`load file`が利用可能と確認できるDeviceだけを対象にし、未対応FirmwareへはApplyボタンを表示しない。検証機はRTX830 Rev.15.02.30である。

## 3. Apply経路の比較と推奨

### 3.1 Option A: Agent Protocolへ専用frameを追加する（推奨）

`CONFIG_APPLY_BEGIN`、`CONFIG_APPLY_CHUNK`、`CONFIG_APPLY_END`、`CONFIG_APPLY_ACTIVATE`、`CONFIG_APPLY_RESULT`、`CONFIG_APPLY_ABORT`を追加する。

GatewayからAgentへCONFIG本文をraw byte列として送り、Agentはそれをファイルへ保存してから`load file`を実行する。`save`はCONFIG転送frameに含めず、Serverの独立したsave操作としてCommand経路を使う。restartは#54の既存操作を使う。

長所:

- CONFIG本文をCLI commandの文字列に埋め込まないため、4095文字制限・引用符・改行・Shift_JIS・秘密文字列のescapingを避けられる。
- frameのLengthとchunk sequenceで、1回のHTTP bodyに収まる単位へ分割できる。
- `load`前のstaging、全byte数確認、chunk ACK、`load`後のresultをプロトコル上で表現できる。
- apply operation IDを持たせられ、同じDeviceでの二重適用をServer側で禁止できる。
- saveしない選択を含め、適用後の動作中設定を安全に未保存として扱える。

短所:

- Agent Protocolのframe、Gatewayのqueue / timeout、Agentの状態機械、ServerのApply処理を追加する必要がある。
- 新frameを理解しない旧Agentへは適用できないため、Agent version gateと段階的なrolloutが必要になる。
- frame ACKは既存の一般delivery semanticsにはないため、この転送だけは明示的な再送・重複防止方針を実装する必要がある。

### 3.2 Option B: 既存のCommand経路を使う

`COMMAND_REQUEST`で`lua -e`や設定commandを複数回送り、Agent上でファイルを作成してから`load`を実行する案である。

長所:

- 新しいframe typeを増やさず、既存の`AgentGateway.sendCommand()`を再利用できる。
- 旧Agentとのプロトコル互換を保ちやすい。

短所:

- `rt.command()`のcommand長上限は4095文字であり、CONFIG本文を1 commandで送れない。
- 複数commandで分割すると、各commandの応答・timeout・順序・途中切断をアプリケーション側で再構築する必要がある。
- CONFIG本文をLua sourceまたはCLI文字列へ変換するため、`"`、`?`、`]]`、改行、CR/LF、Shift_JISのbyte列で壊れやすい。
- `io.open(..., 'a')`はRTX830で追記に使えないため、既存ファイルへ安全に継ぎ足せない。
- Commandのtimeout後は二重実行を避けるため再送しない仕様であり、どこまで書けたかを確定できない。途中のファイルを誤って`load`すると、半端なCONFIGを適用し得る。
- 任意Command実行のaudit / output扱いへCONFIG本文が混ざる危険がある。

### 3.3 判断

Option Aを推奨する。CONFIGは「Router CLI command」ではなく「機密性のある大きなbyte列」であり、既存Commandの意味論へ押し込むと、転送の正しさと適用の安全性を同時に保証できないためである。

専用frameはCONFIG本文をstagingしてloadするところまでに限定する。saveは明示的なServer操作、restartは#54の独立操作とし、3つの操作の境界を混ぜない。

## 4. Router / Agentの制約と前提

### 4.1 Transportとサイズ

現在のAgent Protocolには、次の制約がある。

- AgentのHTTP request bodyは`rt.httprequest()`の`post_text`制限を受け、最大640 KBである。
- AgentからGatewayへは`text_escape`、GatewayからAgentへはCOBSを使う。RestoreのCONFIGはGatewayからのresponseに載せるため、`post_text`が拒否するbyteを追加escapeする必要はない。
- Gatewayの1 responseあたりのframe合計は既定256 KiB、Agentが1回に組み立てる送信frame列は既定64 KiBである。
- 既存のCONFIG Backupは`show config`の出力をAgentからGatewayへ送る経路であり、AgentはCONFIGを解釈しない。
- Server側CONFIGサイズ上限は1 MiBである。Restoreではこれを超える世代を適用対象にしない。

初期のRestore chunkはpayload 32 KiBとする。Gatewayは1 responseへ最大4 chunk（frame headerを含めても256 KiB未満）を入れ、Agentは各chunkを受け取った順に書く。1 frameを複数HTTP bodyへ分割してはならない。

### 4.2 CONFIG fileのbyte列

- 保存したCONFIGはServerで復号したbyte列をそのまま送る。UTF-8への変換、行末の正規化、コメントの削除はしない。
- RTXの設定ファイルは内部コードがShift_JISであり、保存時のbyte列を変えないことが必須である。
- Agentは`io.open(path, 'wb')`でstaging fileを開く。`'w'`は改行変換を起こし、`'a'`はRTX830で追記に使えないため使用しない。
- ファイル名はServerから受け取った任意文字列を使わず、Agentが固定prefixと検証済みのoperation IDから組み立てる。
- staging file、frame、Agent log、HTTP error、audit detailへCONFIG本文や`load`の出力を入れない。

### 4.3 `load`が適用できるCONFIG

YAMAHA公開仕様では、`load file`はRTFS等に保存した設定ファイルを動作中設定へ一括更新でき、既定は置換更新である。初期実装では、対象Firmwareでこの`load`の動作が確認できることを前提にする。

YAMAHA公式の[設定の一括更新](https://www.rtpro.yamaha.co.jp/RT/manual/rt-common/operation/load.html)の注意事項には、RTX830を含む「その他の機種」の設定ファイル置換・復元について、2,000行以上を扱えない制限が記載されている。Serverは送信前にLFで行数を数え、2,000行以上のtargetを拒否する。これはbyte数上限とは別の制約である。

初期実装では次も拒否または警告する。

- DeviceのmodelとBackup metadataのmodelが一致しない。
- 現在Firmwareで`load`の動作が確認できない。
- targetが空、1 MiB超、または行数上限超過である。
- target CONFIGに、Supervisorを起動する相対timerの`schedule at ... lua /routemon_bootstrap.lua`行がない。
- 同じDeviceで別のApply、save、restart、または未完了の設定write操作が動いている。

Firmware差分があるBackupは同じDeviceの世代でもcommand互換性が保証されない。初期実装では自動変換しない。許可する場合も、UIにFirmware差分を明示し、`load`失敗時は適用失敗としてAdminの判断へ戻す。

Supervisorの自動起動行は、`docs/core/agent-update-design.md` §17.6で定義されているRouter reboot後のAgent復帰に必須である。初期実装ではtargetのraw CONFIGに、現在の運用で使う`/routemon_bootstrap.lua`を起動する相対timer行が含まれることを事前検証する。検出できないtargetは、遠隔管理を失うことが事前に分かっているCONFIGとして拒否する。UIには理由を表示する。

実機検証の前提として、RTX830 Rev.15.02.30で`load`を読み取り確認した。実機確認では設定を書き換えるコマンドを実行しない。

### 4.4 Routemonが管理するCONFIG状態

Deviceごとに`config_state`を持ち、値は`unsaved`または`saved`だけとする。これはRouterのCONFIG0とrunning configを常時比較した結果ではなく、Routemonが行った操作と受信したSYSLOGから作る表示用の状態である。

既存Deviceの移行時や、まだRoutemonが未保存を記録していない場合は`saved`を初期値とする。これは実機のCONFIG0との一致を保証する値ではなく、未保存のRoutemon管理マーカーが無いことを表す。

状態の基本規則:

- Agentが`load`成功を返したApplyは、saveをまだ実行していないため`unsaved`にする。
- `apply_verify`が一致しても、状態は`unsaved`のままにする。検証は「targetが動作中設定に入った」ことの確認であり、保存ではない。
- 「すぐ保存する」を選んだ場合も、`apply_verify`不一致ならsaveしない。状態は`unsaved`のままにする。
- save後に#76の保存SYSLOGを検知したら、実行元がRoutemon、TELNET、HTTPD等のどれであっても`saved`にする。
- `save` commandの失敗やtimeoutだけでは`saved`にしない。保存SYSLOGを受信するまで成功表示を確定しない。
- `Jobs.reboot({ save: false })`による破棄再起動後、再接続とpre-apply snapshotの一致を確認できたら`saved`にする。

Routemonを経由しない設定変更による未保存分は検知できない。`show config`は動作中設定を返すが、保存済みCONFIG0はパスワード保護されており、現状のプログラムからrunning configとの差分を取得する手段がない。そのため`saved`は「Routerが完全に保存済み」という意味ではなく、「Routemonが未保存として管理していない」という意味に限られる。

## 5. 操作のライフサイクル

### 5.1 Prepare: 適用前snapshotを先に取得する

Applyは直接実行せず、まずPrepare operationを作る。

```text
Admin selects target backup
  ↓
Server creates apply operation
  ↓
Server sends CONFIG_REQUEST(reason = pre_apply)
  ↓
Agent returns CONFIG_BACKUP
  ↓
Server encrypts and stores the current CONFIG
  ↓
Server computes target vs pre-apply diff
  ↓
UI displays the diff and confirmation screen
```

`pre_apply`は内部処理用のsnapshot reasonとして`SnapshotReason`へ追加する。既存の`ConfigSnapshots.request()`は、Deviceごとの操作lockを確認してから要求を送る。`ConfigSnapshots.ingest()`は、要求に対応する`pre_apply` snapshotの待機者へ`backupId`、`capturedAt`、`created`を返す。

同一内容でdedupeされた場合も、今回の取得が成功したことをApply operationへ記録する。新しい世代が増えなくても、既存のbackup IDをpre-apply backupとして参照できる。Serverがsnapshotの完了を確認できない限り、targetの転送を開始しない。

### 5.2 Diffと明示確認

Diffの比較元は、一覧の「最新世代」ではなくPrepareで取得したpre-apply snapshotとする。これにより、最後の定期取得以降に変わった現在の設定を画面へ反映できる。

差分がない場合はRouterへ`load`せず、Applyを完了できる。saveもrestartも行わない。差分がある場合は、target backup ID、pre-apply backup ID、capturedAt、size、model / Firmware差分を画面に表示する。

適用ダイアログには次を表示する。

- 適用するCONFIG世代と取得日時
- 現在のCONFIGとの差分
- WAN、PPPoE、フィルタ、Supervisor自動起動行の差分に対する強い警告
- 適用後の選択（保存しない / すぐ保存する）
- 「このCONFIGをRouterへ適用する」確認checkbox

Confirm時にtarget backupがまだ存在し、保存時のcontent hashが変わっていないことも再確認する。保持世代のprune等でtargetが失われていた場合は、再度Prepareからやり直す。

### 5.3 Transfer: staging fileへ分割転送する

推奨frame sequenceは次のとおりである。

```text
Gateway -> Agent: CONFIG_APPLY_BEGIN
Agent -> Gateway: CONFIG_APPLY_RESULT(ready)

Gateway -> Agent: CONFIG_APPLY_CHUNK(seq=0..n)
Agent -> Gateway: CONFIG_APPLY_RESULT(chunk_ack, seq)

Gateway -> Agent: CONFIG_APPLY_END
Agent -> Gateway: CONFIG_APPLY_RESULT(staged)
```

BEGINでAgentは専用staging fileを`wb`で新規作成する。BEGINで開いたfile handleはAgentのメインループが持つApply stateの変数へ保持し、syncをまたいでもENDまでcloseしない。CHUNKごとに`io.open`し直したり、追記モード`'a'`で開き直したりしない。RTX830では`io.open(path, 'a')`が`Operation not supported`になる場合と、errorにならず内容が変わらない場合の両方を実測しているためである（`docs/core/lua-api-notes.md`のio.openに関する記録）。

CHUNKのwriteが成功した場合だけseqのACKを返す。GatewayはACKを受けたchunkを完了扱いにする。windowを使う場合でも、Agentはseq順に処理する。

ENDでAgentは、受信byte数とServerが指定したtotal bytesが一致すること、file closeが成功したことを確認する。ENDのclose前に`load`を実行してはならない。どちらかが失敗した場合、`load`は呼ばず、staging fileを削除してfailureを返す。

転送中にAgent taskが再起動した場合（A/B切り替えを含む）、LuaのApply stateとfile handleは失われる。新しいAgentはpartial fileを再開・流用せず、staleなApply stagingを掃除して、ServerがBEGINから転送をやり直す。ACTIVATE送信後は、応答が失われてもACTIVATEを自動再送しない。

Agent側のSHA-256を必須にしない。`lua-api-notes.md`で確認済みのpure Lua SHA-256は約0.7KB/sであり、CONFIG全体の検証に長時間かかるためである。TLS、frame length、seq、write byte数、Server側のpost-load snapshot比較で完全性を検証する。BEGINにはtargetのexact SHA-256を含め、Gatewayのoperationと結果の対応付けに利用する。

### 5.4 Activate: 動作中設定へ読み込む

全chunkがstagedになった後、Gatewayは`CONFIG_APPLY_ACTIVATE`を1回だけ送る。Agentは固定生成したpathへ対して次の形式のcommandを実行する。

```text
load file <agent-generated-staging-file> silent
```

`<agent-generated-staging-file>`へユーザー入力やCONFIG本文を入れない。Agentは`load`の出力をServerへ返さず、成功 / 失敗の分類だけを`CONFIG_APPLY_RESULT`で返す。成功しても、staging fileはcommand終了後に削除する。

重要な順序:

```text
load without save
  ↓
Agent reconnect / next sync
  ↓
Server requests CONFIG(reason = apply_verify)
  ↓
received CONFIG matches target
  ↓
Apply result is shown; normally stop as unsaved
  ↓
only when the user selected 「すぐ保存する」: run save once
```

`apply_verify`も内部処理用のsnapshot reasonとして追加する。既存の`stripVolatileLines()`と同じ規則で`# Reporting Date:`だけを比較から外し、その他のbyte列は変換しない。

`load`成功は、動作中設定が入れ替わったことを意味する。`apply_verify`が一致した場合も、それだけで保存済みとは扱わず、Deviceを`unsaved`にする。Applyはここで停止し、restartを呼ばない。

`apply_verify`が一致しない場合、「すぐ保存する」を選択していてもsaveを実行してはならない。結果を画面へ表示し、Deviceを`unsaved`のままAdminの判断へ戻す。

`apply_verify`の`show config`取得だけは、Agentが初回失敗後に1秒、2秒、5秒、10秒待って再試行する（初回を含め最大5回、待機合計18秒）。他のreason (`agent_start`、`pre_apply`、`manual`) は従来どおり1回だけとする。成功時は成功した試行番号、最後まで失敗した場合は試行回数を、CONFIG本文を含めずSYSLOGへ記録する。RTX830 Rev.15.02.30でのIssue #111実機試験では、`load`後の取得が2回目（1秒待機後）に成功した。この実測を踏まえ、busy時間に余裕を持たせるため最大18秒まで再試行する。

この再試行中の`sleep`はAgentのメインループを最大18秒ブロックし、その間のsync、heartbeat/presence、WebGUI中継、Command応答を遅らせる。idle syncが約20秒間隔でpresenceのofflineしきい値がその2倍強である現状では許容するtrade-offだが、再試行時間を延ばす場合はこれらへの影響を再評価する。

`verify`へ入ってから5分以内に`apply_verify`が届かなければ、Serverはoperationを`phase = failed`、`apply_result = unavailable`、`error_code = verify_timeout`で終端化し、Apply lockを解放する。期限は`verify`への遷移時に更新する`updated_at`を基準とし、Serverは10秒間隔で期限を確認する。これはoperationを閉じるための期限であり、Routerへのsave / restartやCONFIG_APPLIEDを発生させない。Deviceは`unsaved`のままとし、UIには「検証結果を確認できず、未保存のままです。」と表示する。期限後のsnapshotは条件付きphase更新により成功・saveへ進めない。

Server再起動時には、既存の`recoverAfterRestart()`が`verify`を含むactive operationを`server_restarted`で失敗終端化する。したがって、すでに停止したServer DB内に残った旧`verify`も、更新版Serverの次回起動でApply lockが解放される。DB migrationは追加しない。

手動のCONFIG再取得 (`reason = manual`) はApply検証に流用しない。reasonだけでは要求と取得時点を相関できず、load前に開始したsnapshotがload後に遅着する可能性があるため、検証に使えるのはApplyが個別に要求した`apply_verify`だけとする。

load後にAgentが戻らない場合も、saveやrestartを自動実行しない。load成功を受け取った後ならDeviceは`unsaved`として表示し、Adminが保存または破棄再起動を選べるようにする。load結果自体を受け取れない場合はApplyを成功扱いにせず、保存操作を自動で続けない。

### 5.5 Apply後の選択: 保存しない / すぐ保存する

#### 保存しない

`apply_verify`の結果を表示したらApplyを完了する。Deviceの状態は`unsaved`となり、Device詳細の警告バーから保存または破棄再起動を選べる。

#### すぐ保存する

「すぐ保存する」は、Apply確認時の意図を記録するだけで、load直後の無条件saveではない。`apply_verify`がtargetと一致した場合だけ、5.6の独立save操作を内部から1回呼ぶ。

- `apply_verify`不一致・取得失敗・load失敗ではsaveしない。
- saveは1回だけ実行し、timeout後に自動再送しない。
- saveのSYSLOGを検知するまではDeviceを`saved`へ変更しない。
- save後もrestartは実行しない。

Applyの進行表示は、共通部分を「送信中 → 読み込み中 → 確認中 → 完了（未保存）」とする。「すぐ保存する」を選んだ場合だけ、確認成功後に独立した「保存中」を表示し、保存SYSLOGを受信できたら「完了（保存済み）」とする。Applyに再起動待ちの段階は持たない。

### 5.6 保存(save)を単独の操作にする

AdminはApply直後に限らず、Deviceの未保存状態を確認した任意の時点で「保存する」を実行できる。この操作はApplyとは独立したServer operation / Jobとして扱い、Routerへ次のCommandを1回だけ送る。

```ts
save
```

save単独操作の規則:

- Admin onlyとする。
- Deviceがonlineで、Applyやrestartなどの設定write操作が実行中でない場合だけ開始する。
- saveだけを実行し、restartは実行しない。
- Command失敗時は保存成功として表示せず、Deviceは`unsaved`のままにする。
- Command timeout後はsaveを自動再送しない。後から届いた保存SYSLOGで実際の保存を検知した場合だけ`config_state`を`saved`へ更新する。
- 成功した保存SYSLOGを#76の既存SYSLOG経路で受信すると、実行元がRoutemon以外でも`saved`へ更新する。

既存の`Jobs.reboot({ save })`はsave単独操作の代替にしない。`save: true`は再起動と結合された#54の既存操作であり、通常の保存ボタンは再起動を伴わない専用操作として実装する。

### 5.7 未保存の変更を破棄して再起動する

Deviceが`unsaved`でAgentがonlineの場合、Adminは「破棄して再起動」を明示的に選べる。これは自動では行わず、#54の既存機能を次の引数で呼ぶ。

```ts
Jobs.reboot({ deviceId, userId, save: false })
```

この操作はsaveを送らずにrestartだけを実行するため、動作中の未保存設定を破棄して保存済みCONFIGへ戻す出口になる。確認画面には、通信が切断されること、保存しないこと、再接続後に保存済みCONFIGへ戻ったことを確認することを表示する。

Applyはrestartを待つ状態を持たない。再起動の進行・timeout・再接続は#54のreboot Jobとして表示する。再接続後にpre-apply snapshotと一致することを確認できたら、Applyの復旧結果を監査へ記録し、Deviceを`saved`へ更新する。再接続できない場合は自動で再起動を繰り返さず、Deviceの`unsaved`表示を維持する。

WAN / PPPoEを壊した場合はAgentが再接続できないため、この操作も遠隔から届かない。未保存であることによりRouterの再起動、または現地での電源断で保存済みCONFIGへ戻せる可能性が残るが、遠隔復旧を保証するものではない。復旧できない場合は現地対応が必要である。

## 6. Proposed Agent Protocol extension

現在の`0x43 AGENT_STATUS`の次をCONFIG Apply用に予約する。Apply専用frameはCONFIGのstagingとloadだけを扱い、save / restartのframeは追加しない。

| Type | Name | 方向 | Stream ID | Payload / semantics |
|---|---|---|---|---|
| `0x44` | CONFIG_APPLY_BEGIN | Gateway→Agent | Apply stream | `operation_id(16 byte)`、`total_bytes(u32 BE)`、`chunk_bytes(u16 BE)`、target exact SHA-256(32 byte) |
| `0x45` | CONFIG_APPLY_CHUNK | Gateway→Agent | 同じApply stream | `seq(u32 BE)` + raw CONFIG bytes。初期payload上限32 KiB |
| `0x46` | CONFIG_APPLY_END | Gateway→Agent | 同じApply stream | 期待byte数(u32 BE)とchunk数(u32 BE) |
| `0x47` | CONFIG_APPLY_ACTIVATE | Gateway→Agent | 同じApply stream | 空。staged済みの場合だけ`load`を1回実行 |
| `0x48` | CONFIG_APPLY_RESULT | Agent→Gateway | 同じApply stream | status、seq、機械可読なerror code。CONFIG本文・CLI出力は含めない |
| `0x49` | CONFIG_APPLY_ABORT | Gateway→Agent | 同じApply stream | Activate前のstagingを削除する。Activate後は受け付けない |

`CONFIG_APPLY_RESULT`のstatus候補は`ready`、`chunk_ack`、`staged`、`loaded`、`write_failed`、`load_failed`、`busy`、`invalid`とする。詳細なRouter出力をpayloadへ入れない。

### 6.1 Delivery rules

- Apply streamはDeviceごとに1つだけ許可し、Command / WebGUI stream IDと衝突させない。
- GatewayはBEGIN / CHUNK / ENDのACKを待って次のwindowを進める。
- Transfer中の再送はBEGINからの再初期化に限る。partial fileへ追記して続けない。
- ACTIVATEはnon-idempotentな境界とみなし、応答未受信でも自動再送しない。次のsync / `apply_verify`で確認する。
- Gateway / Server再起動後にACTIVATE済みoperationを自動再開しない。Adminへ結果を表示し、saveを自動実行しない。
- 旧Agentは未知typeを無視するため、ServerはAgent versionがApply対応版以上であることを確認してからBEGINを送る。

## 7. Server-side operation and Device state

### 7.1 Apply operation

保存済みCONFIG本文は既存の`ConfigBackupStorage`から読み、Apply operationには本文を複製しない。論理的には次のrecordを持つ。

```text
apply_id
tenant_id
device_id
target_backup_id
pre_apply_backup_id
target_content_hash
requested_by_user_id
save_after_apply
phase                  # prepare / transfer / loading / verifying / complete / failed
apply_result           # matched / mismatch / unavailable / failed
save_operation_id
discard_reboot_job_id
prepared_at / applied_at / finished_at
error_code
```

`phase`と`apply_result`は一つのApply操作の進行と結果を保存するための値であり、DeviceのCONFIG状態ではない。Deviceの状態として公開する値は`config_state = unsaved | saved`だけである。

Applyの完了条件:

- `apply_result = matched`は、load成功後に`apply_verify`がtargetと一致した場合だけにする。
- 一致した時点で`CONFIG_APPLIED`を監査へ記録するが、Deviceの状態は`unsaved`である。
- `save_after_apply = true`の場合だけ、別のsave operationを開始する。
- `apply_verify`が不一致または取得不能なら`CONFIG_APPLIED`を記録せず、saveも実行しない。

Communityでは専用`config_applies` tableを追加するか、Job metadataと同等のstorageへ保存する。少なくともServer再起動後にtarget / pre-apply backup / actor / phase / save選択を失わないことを必須にする。

### 7.2 DeviceのCONFIG状態とSYSLOG

`config_state`はDevice recordまたはDevice state storeへ持つ。Apply成功後にsaveしなければ`unsaved`を記録する。

#76で実装済みの`SyslogService`の保存行検知を、次の状態更新へ接続する。

```text
Configuration saved in "CONFIG0" by <実行元>
  ↓
config_state = saved
  ↓
既存のdebounce後にconfig_changed snapshotを要求
```

このSYSLOGはTELNET / HTTPD等の外部実行元でも同じ形式で届くため、telnetからsaveされた場合もRoutemonの表示を解除できる。Routemonが開始したsave operationについては、save requestとSYSLOG検知を同じoperationへ関連付ける。SYSLOGがないCommand成功だけでは保存済み表示を確定しない。

一方、telnetで設定を変更しただけでは保存SYSLOGが出ない。`show config`は動作中設定を返すがCONFIG0との差分を取得できないため、外部から行われた未保存変更を新たに検知することはできない。この制限をDevice詳細と設計書に明記する。

### 7.3 Standalone save operation

概念的には次のoperationを追加する。

```text
config_save_id
tenant_id
device_id
requested_by_user_id
source                 # standalone / apply_after_verify
phase                  # requested / sending / waiting_syslog / complete / failed
result                 # saved / failed / timed_out
requested_at / finished_at
```

これはDeviceのCONFIG状態とは別の操作記録である。Commandは`save`を1回だけ送る。`CONFIG_SAVED`は保存SYSLOGを検知した時点で記録し、失敗・timeout・SYSLOG未受信を成功へ偽装しない。

### 7.4 APIの流れ

概念APIは次のとおりとする。正確なpathは実装時に既存のDevice routesへ合わせる。

```text
POST /devices/:deviceId/config-applies/prepare { backupId }
  -> 202 { applyId }

GET  /devices/:deviceId/config-applies/:applyId
  -> diff / transfer / loading / verifying / complete / failed

POST /devices/:deviceId/config-applies/:applyId/confirm
     { saveAfterApply: boolean, acknowledged: true }
  -> 202 { applyId }

POST /devices/:deviceId/config-save
  -> 202 { saveOperationId }

POST /devices/:deviceId/reboot
     { save: false }
  -> #54の既存reboot Job
```

`confirm`の`saveAfterApply`がfalseなら、apply_verify後にApplyを完了して`unsaved`へする。trueなら、`apply_verify`一致後にだけsave operationを開始する。直接target backup IDを送るApply endpointは作らない。

### 7.5 Conflict lock

Device単位で次を同時に実行しない。

- CONFIG ApplyのPrepare / Transfer / Activate / Verify
- standalone save
- #54のreboot Job
- `load`、`save`、`restart`、`confirm`に相当するgeneric command

既存の任意Command経路から`load file`や`save`を実行すると安全なApply・未保存管理を迂回できるため、Dedicated Apply / save / rebootの操作経路へ誘導する。`load`、`save`、`restart`、`confirm`はgeneric commandのdenylistへ追加する。Applyの「すぐ保存する」場合だけ、Apply verifyとsaveを同じDevice lockの下で順番に実行する。

これはAdminを別の権限へ降格するものではなく、同じAdminが安全な操作経路を選べるようにする誤操作防止である。Native WebGUIは既存のAdmin-only境界として残す。

## 8. Failure and recovery matrix

| 失敗点 | Routerで行うこと | Serverの操作結果 / Device状態 |
|---|---|---|
| Prepare前にoffline | frameを送らない | Applyを失敗として表示。Device状態は変更しない |
| snapshot保存 / 暗号化失敗 | targetを送らない | Applyを失敗として表示。既存backupは削除しない |
| model、Firmware、byte数、行数、Supervisor行の事前検証失敗 | targetを送らない | Applyを失敗として表示。該当する制約を表示 |
| CHUNK timeout / frame欠落 | stagingのみ。`load`しない | BEGINから有限回再試行後、Applyを失敗として表示。partial fileは削除 |
| file write / close失敗 | `load`しない。fileを削除 | Applyを失敗として表示。Device状態は変更しない |
| `load`が明示的に拒否された | save / restartしない | Applyを失敗として表示。既存の`unsaved`状態は維持 |
| ACTIVATE後にAgentが切断し、load結果がない | save / restartしない | Applyを成功扱いにしない。保存操作を自動継続しない |
| load成功後のapply_verify不一致 | save / restartしない | Applyを失敗として表示。Deviceは`unsaved`のまま |
| load成功後5分以内にapply_verifyが届かない | save / restartしない | `failed / unavailable / verify_timeout`で終端化し、Apply lockを解放する。Deviceは`unsaved`のまま。遅着snapshotは成功・saveへ進めない |
| apply_verify一致、保存しない選択 | save / restartしない | Apply完了。Deviceは`unsaved` |
| apply_verify一致、すぐ保存する選択 | `save`を1回だけ実行し、restartしない | SYSLOG検知までは`unsaved`。検知後に`saved` |
| apply_verify不一致、すぐ保存する選択 | save / restartしない | 選択を無視して保存しない。Deviceは`unsaved` |
| standalone save failure / timeout | restartしない。saveを再送しない | 保存操作を失敗またはtimeoutとして表示。Deviceは`unsaved` |
| save成功後に保存SYSLOGを受信 | restartしない | `CONFIG_SAVED`を記録し、Deviceを`saved` |
| telnet等から保存SYSLOGを受信 | Router側の追加操作なし | Deviceを`saved`に更新し、既存の`config_changed` refreshを行う |
| Adminが破棄再起動を選択 | `Jobs.reboot({ save: false })`を1回だけ実行する | #54のreboot Jobを表示。再接続とpre-apply一致後にDeviceを`saved` |
| 破棄再起動後に再接続しない | 自動再起動・再適用しない | Deviceの`unsaved`表示を維持し、現地復旧を案内 |
| WAN / PPPoEを壊した | Agentから追加操作できない | 遠隔操作不能。再起動または現地の電源断が復旧手段になる可能性を表示 |
| Server再起動 | ACTIVATE、save、restartを自動再開しない | `recoverAfterRestart()`がactive operation（verifyを含む）を失敗終端化してlockを解放し、Adminの再確認を求める |

「途中まで適用された状態」を作らないための安全網は次の3段階である。

1. staging fileが完成するまで`load`しない。
2. `load`はACTIVATEで1回だけ実行する。
3. 利用者が「すぐ保存する」を選ばない限り、saveしない。選択した場合も`apply_verify`一致を条件にする。

未保存の動作中設定は、saveを実行しないままRouterを再起動すれば保存済みCONFIGへ戻る。Serverが遠隔から再起動できない場合は、現地での電源断を含む復旧が必要になる。WAN / PPPoEを壊した場合、遠隔から前世代を自動適用することはできない。

## 9. Authorization and audit

### 9.1 Authorization

- `prepare`、`confirm`、standalone save、破棄再起動、Apply statusのCONFIG metadata / diff取得はAdmin onlyとする。既存のCONFIG list / diff / downloadと同じServer-side `requireAdmin`で保護する。
- ViewerにはApply、save、破棄再起動のボタン、target / pre-applyの本文、diffを表示しない。APIを直接呼んでも403を返す。
- Device / Tenant所属を全operationで再検証する。別Tenantのbackup IDやDevice IDを組み合わせられないようにする。
- Adminでも、対象Deviceがdisabled、未接続、操作lock中、またはAgent version gate未達なら開始できない。

### 9.2 Audit events

既存の`CONFIG_APPLIED`を、load成功後の`apply_verify`一致時に利用する。実装時に次のevent typeを追加または整理する。

```text
CONFIG_APPLY_REQUESTED
CONFIG_APPLIED
CONFIG_APPLY_FAILED
CONFIG_SAVE_REQUESTED
CONFIG_SAVED
CONFIG_SAVE_FAILED
CONFIG_APPLY_DISCARD_REQUESTED
CONFIG_APPLY_DISCARDED
CONFIG_SAVED_DETECTED       # telnet / HTTPD等のSYSLOGを検知した場合
```

#54の再起動操作については、既存の`DEVICE_REBOOT_REQUESTED`等のauditを引き続き使用し、破棄再起動のoperation IDをdetailへ関連付ける。

各eventには次のようなmetadataだけを保存する。

```text
actor_user_id              # SYSLOG検知などServer起因の場合はsystem
device_id
apply_id / save_operation_id
target_backup_id / pre_apply_backup_id
reboot_job_id (該当時)
phase / result / error_code
save_after_apply
```

次の条件を満たさない限り成功eventを記録しない。

- `CONFIG_APPLIED`: load成功と`apply_verify`一致の両方が確認できた場合だけ。
- `CONFIG_SAVED`: save commandの成功だけでなく、保存SYSLOGを検知した場合だけ。失敗・timeout・SYSLOG未受信を成功へ偽装しない。
- `CONFIG_APPLY_DISCARDED`: `save: false`のreboot Job後、再接続とpre-apply snapshot一致を確認できた場合だけ。

CONFIG本文、password、Device token、HTTP body、`load` / `show config`の出力、staging pathはauditへ入れない。

## 10. Confirmation UI flow

既存のDevice detailのCONFIG世代セクションを拡張する。

```text
CONFIG世代
  └─ 各世代: [差分] [DL] [適用]
       ↓
1. 「適用」を押す
       ↓
2. Prepare中: 現在のCONFIGを取得してpre_applyとして自動保存
       ↓
3. 適用ダイアログ:
      - 適用する世代の取得日時 / サイズ / hash prefix
      - 現在のCONFIGとの差分
      - WAN / PPPoE / フィルタ / Supervisor自動起動行の強い警告
      - 「適用したあと」の選択
          ◉ 保存しない
          ○ すぐ保存する
      - 適用確認checkbox
       ↓
4. 「このCONFIGを適用する」
       ↓
5. 進行状況:
      送信中 → 読み込み中 → 確認中 → 完了（未保存）
      「すぐ保存する」かつverify一致の場合のみ
      保存中 → 完了（保存済み）
       ↓
6. Apply完了。再起動待ちの表示は持たない
```

Deviceが`unsaved`のときだけ、Device詳細の上部に警告バーを表示する。

```text
このDeviceにはRoutemonから適用後に保存されていない変更があります。
適用日時・実行者: <metadata>
Routerを再起動すると保存済みCONFIGへ戻ります。

[保存する] [破棄して再起動]
```

Device一覧にも`未保存`バッジを表示する。警告バーとバッジには、これはRoutemonが管理する未保存状態であり、telnet等で行われた未保存変更を完全に検出するものではないことを説明できる導線を置く。

「保存する」はsaveだけを実行し、通信を切断するrestartを行わない。「破棄して再起動」は#54の独立操作であり、実行前にsaveしないこと、通信が一度切断されること、再接続後に保存済みCONFIGへ戻ったことを確認することを表示する。

差分にWAN、PPPoE、フィルタ、またはSupervisorの自動起動に関係する行が含まれる場合は、通常の差分表示に加えて高リスク警告を表示する。WAN / PPPoEを壊した場合はAgentが再接続できず、Serverから前世代を適用できないため、復旧がRouterの再起動または現地対応に限られる可能性がある。

高リスク判定はServerの`apps/community/src/config/configRisk.ts`(`classifyConfigRisks`)の1か所にまとめ、単体Applyの詳細API(`risks`)と一括適用の計画(`plan.risks`)の両方で同じ分類を使う。GUIは判定せず、Serverが返した分類を表示名に置き換えて出すだけにする。

再起動中の表示は#54のPower UIで行い、Apply画面に再起動待ちの状態を追加しない。restart commandのtimeoutを独自のApply失敗へ変換せず、既存reboot Jobの意味を表示する。

## 11. Implementation order after approval

1. `packages/core`のApply frame、payload、snapshot reason、byte-level validationを新しいsave境界と整合させる。BEGINにsave選択やrestart情報を含めない。
2. `packages/gateway`にApply stream、chunk queue、ACK、timeout、Device lockを追加する。ACTIVATE後の自動再送を行わない。
3. Agent本体にstaging / `load file` / load resultを追加する。Agentからsaveやrestartを実行しない。
4. `ConfigSnapshots`に`pre_apply` / `apply_verify` requestと待機、target hash比較を追加する。
5. Device state storeへ`config_state = unsaved | saved`、Apply operation、standalone save operationを追加する。
6. CommunityにApply operation、save API、Admin-only routes、audit event、#76 SYSLOGとの状態更新を追加する。
7. `Jobs.reboot({ save: false })`を破棄再起動の明示操作から利用する。Applyの通常完了やsave操作からrestartを呼ばない。
8. Device一覧・詳細の未保存表示と、Prepare → Diff → Apply選択 → Progress → Save / Discard UIを追加する。
9. Agent version gateと旧Agentへの案内を追加する。

## 12. Test plan

設計承認後の実装では、少なくとも次を自動テストする。

- frameのBEGIN / CHUNK / END decode、32 KiB境界、seq欠落、重複、複数HTTP responseへの分割
- COBS responseにShift_JIS、CR/LF、`post_text` unsafe byte相当のbyteが含まれても復元できること
- partial transferで`load`が呼ばれないこと、ACK timeout時にBEGINから再開すること
- ACTIVATEの応答欠落時にACTIVATEを再送しないこと
- pre-apply snapshotが保存されるまでtarget frameが送信されないこと
- `# Reporting Date:`だけが違うtarget / verify snapshotを同一内容として扱うこと
- model、Firmware、1 MiB、2,000行、空CONFIG、Supervisor自動起動行なしの拒否
- BEGINで開いたfile handleがsyncをまたいで保持され、ENDまで同じhandleへwriteされること。`'a'`で再openしないこと、Agent再起動時はBEGINから再開すること
- load failure / disconnect / verify mismatch時にsave / restartが送られないこと
- Apply後に「保存しない」を選んだ場合、save / restartを送らずDeviceが`unsaved`になること
- 「すぐ保存する」を選んだ場合、verify一致時だけsaveを1回送り、不一致時はsaveを送らないこと
- save単独操作が`save`を1回だけ送り、restartを送らないこと
- save timeout後にsaveを再送せず、保存SYSLOG受信時だけ`saved`へ更新すること
- telnet / HTTPDの保存SYSLOGでもDeviceの`unsaved`表示が解除されること
- `Jobs.reboot({ save: false })`が破棄再起動から1回だけ呼ばれ、通常のApplyやsaveでは呼ばれないこと
- 破棄再起動後にpre-apply snapshotと一致した場合だけDeviceを`saved`へ更新すること
- ViewerのApply / save / discard / diff APIが403であること。Tenant境界を越えられないこと
- auditに適用・保存・破棄再起動の成功・失敗が残り、失敗を成功eventへ偽装しないこと
- auditへCONFIG本文、password、token、CLI outputが残らないこと
- Agent version gate未達のDeviceへApply frameを送らないこと

実機検証はPO承認後に、検証用RTX830のテストCONFIGで行う。設計レビュー中は設定を書き換えるCLIやLua処理を実行しない。

## 13. Review points / approval needed

次の判断をPOに確認してから実装へ進む。

1. RouterへのCONFIG転送は専用`CONFIG_APPLY_*` frame familyを使い、save / restartはframeへ含めないこと。
2. 対象Firmwareで`load file ... silent`が利用できるDeviceだけを初期対象にすること。検証機はRTX830 Rev.15.02.30である。
3. Prepareで現在CONFIGを自動snapshotしてから差分を表示し、Adminの明示確認を必須にすること。
4. Applyはload → `apply_verify`確認で止まり、通常はsaveもrestartもしないこと。`すぐ保存する`を選び、verifyが一致した場合だけsaveを1回実行すること。
5. Deviceの状態を`未保存 / 保存済み`の2つに限定し、Apply後は未保存、保存SYSLOG検知または破棄再起動後のsnapshot一致で保存済みへ更新すること。
6. telnet等による未保存変更は検知できないという限界を、Device詳細・一覧・設計に明記すること。
7. Applyとは独立したAdmin-onlyのsave操作を用意し、saveだけを1回実行してrestartしないこと。
8. 「破棄して再起動」はAdminの明示操作に限定し、#54の`Jobs.reboot({ save: false })`を利用すること。Applyから自動restartしないこと。
9. generic commandの`load`、`save`、`restart`、`confirm`をdenylistへ追加し、安全なApply / save / reboot経路へ誘導すること。
10. WAN / PPPoE / フィルタ / Supervisor自動起動行の差分に強い警告を出し、遠隔復旧できない場合は再起動または現地対応になる限界を表示すること。
