# CONFIG Bulk Restore Design (#94)

Status: Design proposal — pending review  
Scope: Core behavior / Community storage proposal  
Last updated: 2026-09-24

Related:

- Issue #94「複数DeviceへCONFIGを順次適用して一括ロールバックする」
- `docs/core/config-restore-design.md` (#62: 個別Applyの正本)
- `docs/core/config-backup-design.md`
- `docs/core/access-control-design.md`
- `apps/community/src/config/configApplies.ts`
- `apps/community/src/config/configCheckpoints.ts` (#93)
- `apps/community/src/storage/migrations/010_config_apply.sql`
- `apps/community/src/storage/migrations/011_config_checkpoint.sql`

この文書はIssue #94の設計案である。レビュー・承認後に実装へ進む。ここでいう一括ロールバックは、Deviceごとに既存の#62 Applyを順番に実行する操作であり、複数Routerを同時に、または原子的に変更するトランザクションではない。

## 1. 提案する判断

| 項目 | 提案 |
|---|---|
| Apply単位 | 既存の#62 `ConfigApply`を子操作として再利用し、バッチの順序どおり1件ずつ実行する |
| 準備フェーズ | 全Deviceの`pre_apply` snapshotを先に取得し、diffとtarget検証をまとめて表示する。Routerへの書き込みはしない |
| 実行前の確認 | 既定は全計画を見てAdminが一度だけ確認。その後は順次実行する。慎重に進めたい場合のDeviceごとの確認モードも選べる |
| 時間差対策 | 各DeviceのApply直前にrunning CONFIGを再取得し、準備時snapshotと正規化hashが一致しなければload前にBatchを止める |
| 失敗時 | 最初の失敗でバッチを停止し、未開始の残りを`skipped`にする。自動再試行、自動継続、適用済みDeviceへの自動補償Applyはしない |
| 保存選択 | バッチ作成時に一度だけ選ぶ。全子Applyへ同じ値を使い、実行中に変更できない。既定は#62と同じ「保存しない」 |
| Checkpoint世代 | checkpoint itemが指す`backup_id`をバッチ作成時に固定する。「最新世代」へ置き換えない |
| Checkpointの欠落 | Checkpoint全体を指定する方法では、全itemが`captured`でbackupが利用可能なcheckpointだけを受け付ける。部分checkpointは一括指定として拒否し、必要なsubsetはAdminがDeviceと世代を個別指定する |
| 同時Apply防止 | Batch中はTenant単位のApplyロックを保持し、別Deviceの単体Applyも開始できないようにする。Batch開始前に既存のApplyがないことも確認する |
| 永続化 | 必要。Communityへbatch親・item表とTenant単位のApplyロックを追加し、既存Applyとの関係をDBに保存する |

## 2. 操作フロー

1. Adminが対象、適用順、共通save方針、確認モードを決める。確認モードは`事前一括確認`(既定)または`Deviceごとに確認`。対象は完全なcheckpointか、DeviceとそのDevice自身の保存済み世代の組で指定し、最大50台とする。
2. Serverは全対象Device・target backup・lifecycleとApply競合を検査する。Device間でCONFIGを流用しない。Batch親と順序付きitemをDBへ保存し、Tenant Apply mutexを取得する。
3. **準備フェーズ**では全対象Deviceへ読み取り専用の`pre_apply` snapshot要求を出す。複数Deviceへsnapshot要求を送ることはApplyではなく、Routerの設定を書き換えない。受信した世代IDと正規化hashを各itemに保存し、targetとのdiffを計算する。全targetに対して#62と同じmodel / Firmware / CONFIG行数 / byte size検証を行い、機種・設定の適用可否をまとめる。Routerへの`load`・`save`・`restart`は呼ばない。
4. 全Deviceの計画を一画面に表示する。Deviceごとにtarget世代、diffの追加・削除行数、model / Firmware・CONFIG行数・サイズの検証結果を出し、WAN / PPPoE / filter / Supervisor自動起動行の差分があれば高リスク警告を出す。高リスク判定は単体Applyと同じ`apps/community/src/config/configRisk.ts`(`classifyConfigRisks`)の分類を使い、GUIは`plan.risks`の表示名を出すだけにする。差分のないDeviceも「差分なし」と表示し、実行対象から外せる。差分なしのDeviceを実行対象に残しても、後段で`load`せずno-opにする。
5. 準備に失敗したitemまたは検証NGが1件でもある場合はBatchを停止し、Router設定を変えない。準備済みDeviceだけへ暗黙に範囲を狭めて続行しない。Adminは対象を見直して新しいBatchを作る。全itemの準備に成功した場合、Adminは全計画を確認し、選んだモードに従って実行を承認する。`事前一括確認`では全体計画に対して1回承認する。`Deviceごとに確認`では、実行順に現在Deviceを確認する。どちらのモードも全Device分の計画を確認できる。
6. 実行対象Deviceを一台ずつ処理する。各DeviceのApply直前に現在のCONFIGを再取得し、準備フェーズのsnapshotと比較する。変更があれば「準備時から設定が変わっています」と表示し、そのDeviceでは`load`せずBatchを停止する。一致した場合は#62のtarget検証とhash検証を再実行し、直前snapshotをpre-apply backupとする子`ConfigApply`を作成する。事前一括確認モードではBatch確認を根拠に直ちに子Applyをconfirmし、Deviceごとに確認モードではそのDeviceの明示確認後にこの再取得・比較を行ってApplyする。
7. 子Applyと、saveを選んだ場合のCONFIG_SAVED確認が終端化してから次Deviceへ進む。Applyまたはsaveの失敗・未確認、Agent切断、直前CONFIG不一致でBatchを停止し、残りを実行しない。全itemが終わった場合のみBatchを`complete`にする。停止・完了時にTenant mutexを解放する。

AdminがBatchを停止した場合も後続itemを実行しない。子Applyが転送・`load`・検証中ならRouter操作を中断したとはみなさず、子操作が終端化するかtimeoutになるまで追跡してからBatchを`stopped`にする。Serverから実行中の`load`を安全に取り消す経路は追加しない。準備計画への一括承認はplan完了時から10分、Deviceごとの確認待ちはitemが`awaiting_confirmation`になってから10分とする。期限が切れた場合は停止し、mutexを解放する。

## 3. 状態モデルと適用結果の表示

### 3.1 Batch親と既存Apply子

Batch親は、対象順序、確認モード、全体計画の確認時刻、現在のitem、共通の保存選択、停止理由、操作者を管理する。Deviceごとの実際の適用状態の正本は既存の`config_applies`とJobであり、Batchが#62の`phase`や`apply_result`を重複管理しない。準備フェーズのsnapshot・plan結果はbatch itemへ保存し、実行直前の再取得が一致した時だけ対応する子Applyを作る。各batch itemはその子Apply IDを保持する。

Batch状態:

```text
preparing             全対象の読み取りsnapshotと検証結果を収集中
awaiting_confirmation 計画全体または現在Deviceの確認待ち
running               計画承認済み。現在itemをApply直前検査またはApply中
stopping              Adminが停止を指示し、現在の子Applyの結果を確定中
stopped               失敗またはAdminの停止で終了。再開せず、人間の判断待ち
complete              全選択itemがApply済みまたは差分なしで終了
```

Item状態:

```text
preparing              準備snapshot / diff / target検証を待機中
prepared               準備とtarget検証が成功し、planに表示済み
no_change              targetとの差分なし。実行対象外、または直前再検査後にno-op
excluded               Adminが計画確認時に実行対象から外した
queued                 計画承認済みだが、まだ実行順が来ていない
guarding               Apply直前のrunning CONFIGを再取得中
awaiting_confirmation  Deviceごとに確認するモードの現在Deviceを確認待ち
applying               子Applyのtransfer / load / apply_verify / 必要なsaveを実行中
applied                targetとのapply_verify一致を確認済み
failed                 このitemで処理を止めた
skipped                Batch停止時に未開始だった
```

実行対象に残った差分なしitemも、実行直前のCONFIG再取得で準備時点と一致することを確認してから`no_change`とし、`load`は実行しない。Adminが差分なしitemを外した場合は`excluded`とし、直前再取得は行わない。

Itemの`status`だけでは、`load`後に検証できなかったケースを「未適用」と誤表示し得る。Apply結果と保存結果を別に表示し、少なくとも次の区分を持つ。

| 適用結果 | 表示 |
|---|---|
| `apply_verify`一致 | 適用確認済み |
| Apply直前のCONFIGが準備時から変わった | 未適用（「準備時から設定が変わっています」）。このDeviceより後は未開始 |
| `load`開始前の失敗 | 未適用（load前に停止） |
| `load`開始後に失敗または検証不能 | 適用結果未確認。Router側で設定が変わっている可能性あり |
| itemが未開始で`queued` / `skipped`、またはAdminが外した`excluded` | 未適用（未開始 / 対象外） |

「保存する」を選んだ場合は保存結果も分ける。

```text
apply_verify一致 + CONFIG_SAVED SYSLOG受信 -> 適用確認済み・保存確認済み
apply_verify一致 + save失敗               -> 適用確認済み・保存失敗
apply_verify一致 + 保存SYSLOG未受信        -> 適用確認済み・保存未確認
```

`save` commandの成功応答だけで「保存確認済み」としない。#62と同じくCONFIG_SAVED SYSLOGを確認根拠にする。選択した保存方針の成功を確認するまで次Deviceへ進まず、save失敗またはsave job成功応答後2分以内に保存を確認できない場合はBatchを停止する。

### 3.2 途中停止時

停止画面はDeviceごとに、順序、状態、Apply結果、保存結果、停止理由を表示し、次の3群を判別できるようにする。

- **適用確認済み**: `apply_verify`がtargetと一致したDevice。保存選択に応じて未保存・保存確認済みを併記する。
- **未適用**: 未開始のDevice、および`load`開始前に停止したDevice。
- **適用結果未確認**: `load`開始後に失敗・切断・Server再起動・verify timeoutとなったDevice。未適用とは扱わない。

適用済みDeviceを自動で元に戻す処理は行わない。部分状態を表示してAdminへ判断を戻す。準備中・計画確認待ちのServer再起動ではRouter設定は変わっていないため、Batchを停止し、各itemを未適用として表示する。実行中のServer再起動では#62の個別Applyを自動再送せず、現在のitemをguard / 子Applyの最終phaseに基づいて上記のいずれかへ分類し、後続itemは`skipped`にする。

## 4. 保存方針

Batch作成時にAdminが次の一方を一度だけ選ぶ。

```text
保存しない       各Deviceのapply_verifyが一致したら次へ進む。Deviceは未保存のまま
すぐ保存する     各Deviceのapply_verifyが一致した後にsaveし、保存SYSLOGを確認してから次へ進む
```

選択値はbatch親に保存し、各子`config_applies.save_after_apply`へ同じ値を渡す。子Applyごとに変更できない。既定値は、#62と同じく明示的な保存を避ける「保存しない」とする。Batchを停止して再操作する場合は、残りDeviceを含めて新しいBatchを作るため、保存方針も改めて選び直す。

どちらを選んでもrestartは実行しない。#62の個別Applyと同じく、restartは独立操作である。

## 5. Checkpointと世代選択

Checkpoint指定では、対象itemの`device_id`とそのitemが捕捉した`backup_id`を組にしてBatchへコピーする。世代一覧の先頭やPrepare時点のlatestを再検索して適用先を決めてはならない。Checkpoint削除・後日の新しいsnapshot取得があっても、実行対象は元のbackup IDである。

安全性のため、Checkpoint丸ごと指定はすべてのitemが`captured`であり、そのDeviceとbackupが現存する時だけ受け付ける。部分checkpointを見落として一部だけApplyすることを避ける。明示的なsubsetが必要な場合は、個別選択モードで対象DeviceとそのDevice内の世代を選び、含めないDeviceがあることを確認画面に表示する。

Batchが`preparing`、`awaiting_confirmation`、`running`または`stopping`の間は、itemが参照するtarget世代・準備snapshot・Apply直前snapshotをCONFIG backup retentionで削除しない。実行前に手動削除要求があった場合も拒否する。Targetが消失・復号不能・hash不一致となった場合は別世代へfallbackせず、そのitemでBatchを停止する。

Apply直前snapshotのCONFIGを`stripVolatileLines()`で正規化してSHA-256 hashを計算し、準備時に保存した`prepared_config_hash`と比べる。これは#62のtarget一致判定・CONFIG dedupeが使う正規化と揃え、表示用timestampなどのvolatile行だけを差分として扱わない。hashが一致しない場合は、対象を適用せず停止する。

## 6. 同時Applyの防止

順次実行を単にUIのawait順序だけに任せない。Server側でTenantごとのApply mutexを永続化し、競合をDB transactionで排他する。

- Batch開始は既存のactive `config_applies` がない場合だけ成功し、読み取り専用の準備フェーズ開始前にTenant mutexをBatch IDで取得する。
- Batchは子Applyの確認・Apply・任意saveを一度に1Deviceだけ実行する。
- Batchのmutexがある間、別Deviceへの単体Apply開始を拒否する。Batch子Applyだけは、現在itemとの一致を検証して既存のApply serviceを通す。
- 単体Applyも同じmutexを使うため、Batch開始時の単体Applyとの競合を防ぐ。既存の`config_applies_active_device` indexはDevice内の追加防御として残す。
- Batch完了・停止・Prepare応答timeout・confirmation timeout・Server restart recoveryでは、DB transaction内で状態を終端化してmutexを解放する。Prepare応答timeoutは#93のcheckpoint取得timeoutと同じ2分とする。

これによりBatchの途中に別のAdminが別Deviceの単体Applyを開始して並行Applyになることを防ぐ。ほかの種類のDevice操作については既存のDevice単位lockを維持し、この設計でTenant全体を一括lockしない。

Tenant mutexが`batch`所有の場合、単体Apply Prepare APIは理由を示す409を返す。Responseに`code = config_apply_batch_active`、`batch_id`、Batchの状態・sourceを含め、Device画面は「一括適用が実行中です (Batch <ID>)」と表示してBatch詳細へリンクする。単体Applyの単なる一般エラーとして表示しない。

## 7. Auditと認可

Batch作成・計画準備完了・実行確認・完了・停止を`config_apply_batch`をtargetとする親audit eventに記録する。親eventにはsource、checkpoint ID（checkpoint指定時）、Device数、確認モード、保存方針、結果、停止理由を記録する。順序と各Deviceの選択状態はBatch itemに保存し、CONFIG本文や秘密情報はauditへ含めない。

各子Applyの既存audit eventは残し、`batch_id`と`batch_item_id`を追加して親操作へ辿れるようにする。適用・失敗・save結果は従来どおりDevice単位のeventにも記録する。新しいevent detailは`AUDIT_DETAIL_ALLOWLIST`に明示し、対象Deviceのserial number・MAC address・CONFIG本文を監査detailへ入れない。

Batch作成、順序変更、item確認、停止など状態を変えるAPIはServer側でAdminのみ許可する。Batch状態を返すAPIも既存Apply APIと揃えてAdmin専用とし、画面上のButton非表示だけで認可しない。

## 8. UIと回復範囲の表示

準備計画と実行確認画面に次の注意を常時表示する。

> WAN / PPPoEを壊すCONFIGを適用すると、Routerから外向きに接続するAgentがServerへ再接続できず、このBatchでは復旧できません。「保存しない」で適用した場合は、Routerを再起動すれば適用前の設定へ戻ります(「すぐ保存する」を選んだ場合は戻りません)。この一括適用が効くのは、保存まで通って確定した後に不具合へ気付いた場合です。

現在OfflineのDeviceは準備対象として開始できない。準備中にsnapshotを取得できないDeviceやtarget検証NGのDeviceがあれば、全体計画は実行確認へ進めない。実行中にAgentがOfflineになった場合は自動続行せず停止し、現在のApply結果が確定していない場合は「適用結果未確認」と表示する。

準備画面には全対象を1画面で表示する。Deviceごとに名前・順序・target世代と取得日時・差分行数・model / Firmware / 行数 / byte sizeの検証結果・高リスク差分を見せる。「差分なし」は文字で示し、実行対象から外す操作を用意する。確認モード選択は`事前一括確認`を既定とし、`Deviceごとに確認`へ切り替えられるようにする。実行画面には全体の`n / total`、成功・未適用・結果未確認件数と、Deviceごとの準備 / 直前検査 / 確認待ち / Apply phase / 保存結果を表示する。失敗後は「適用確認済み」「未適用」「適用結果未確認」の一覧を表示し、再試行や自動継続は提示しない。

## 9. DB変更案

メモリ上だけで管理すると、画面再読込・Server再起動後に順序、現在item、停止結果、Apply IDの関連を失う。またTenant単位mutexをDBで競合なく取得する必要があるため、DB schemaは必要と判断する。実装時はCommunity migration `012_config_apply_batch.sql`を追加する案とする。#93のcheckpoint metadataやCONFIG本文は複製しない。

### 9.1 新規logical entity

```text
ConfigApplyBatch
- id, tenant_id, requested_by_user_id
- source, source_checkpoint_id, source_checkpoint_name
- confirmation_mode (`batch` / `per_device`), save_after_apply
- status, current_item_id, stop_reason
- plan_completed_at, confirmed_at, created_at, updated_at, finished_at

ConfigApplyBatchItem
- id, batch_id, sequence
- device_id, device_name snapshot
- target_backup_id, target_content_hash
- prepared_backup_id, prepared_config_hash
- execution_check_backup_id, execution_check_config_hash
- selected_for_execution, plan_summary
- status, failure_code
- apply_id (nullable; 既存ConfigApplyへの参照)
- apply_effect, save_result
- confirmed_at, created_at, updated_at, finished_at

ConfigApplyLock (Tenantごとに最大1行)
- tenant_id (primary key)
- owner_type (`batch` / `single_apply`)
- owner_id
- acquired_at
```

準備フェーズではまだApplyをしていないため、`config_applies` child rowは作らない。batch itemに`prepared_backup_id`と正規化hashを記録する。実行時のguard snapshotが一致した後に子`ConfigApply`を作り、その`pre_apply_backup_id`にはguard snapshot IDを設定する。これで実行時の直前状態を#62のApply履歴・破棄処理と共有しつつ、準備時点との比較も維持できる。

`target_backup_id`、`prepared_backup_id`、`execution_check_backup_id`はbackup tableへのFKを持たないsnapshot ID (`TEXT`) とし、表示・比較のための`target_content_hash` / `prepared_config_hash` / `execution_check_config_hash`も保持する。active Batch中はretentionと手動削除がこれら3種類のIDを参照して本文削除を拒否する。Batch終端後に通常retentionで本文が削除されても、itemのIDとhashは残り、利用不可として履歴表示できる。子`config_applies`のbackup FK挙動は既存仕様を維持する。`plan_summary`はdiff行数、validation結果、model / Firmware、risk codeだけを含む表示用JSONとし、CONFIG本文を保存しない。

### 9.2 Community physical schema案

- `config_apply_batches`: Tenant境界、操作者、source/checkpoint snapshot、共通save選択、batch状態、停止情報を保持する。
- `config_apply_batch_items`: Batch親配下の順序付きDevice item、target・準備・guard snapshot、選択状態、plan summary、子Applyとの対応、表示用結果を保持する。`UNIQUE(batch_id, sequence)`と`UNIQUE(apply_id)`を設ける。
- `config_apply_locks`: `tenant_id`をprimary keyとし、Batchまたは単体Applyが保持するTenant単位mutexを保持する。owner参照の検証と解放はserviceがtransaction内で行う。
- Batch・itemは既存と同じTenant scopeとforeign key policyに従う。Device削除時はitemを削除せず、Device IDをnull化してdevice name snapshotと結果を残す。
- `config_applies`自体は既存個別Applyのphase/resultを正本として残す。子Applyとの対応はitemの`apply_id`から参照するため、既存Apply履歴の大幅な変更は不要。
- `ConfigBackups.prune()`と手動削除を更新し、active Batchのtarget / prepared / execution-check世代を削除対象から除外する。Batchが終端化した後は通常retentionに戻す。

## 10. 受け入れ条件への対応

- CheckpointまたはDeviceごとに選んだ同一Deviceの保存世代を、指定順に#62 Applyで実行する。
- 読み取り専用の準備で全Deviceのpre_apply snapshotとdiff / target検証を揃え、計画全体を一画面で確認できる。
- 既定では計画全体を一度だけ確認する。Deviceごとの確認モードも選べる。
- 差分なしDeviceを計画に明示し、実行対象から外せる。
- 各DeviceのApply直前に準備時CONFIGとの一致を検証し、不一致なら当該Deviceでloadせず停止する。
- Batch内・Batch中の単体Applyを含め、Tenant内で同時に二つのApplyを進行させない。
- 準備が完了しない場合、または最初のguard / confirm / transfer / load / verify / 選択されたsaveの失敗でBatch停止し、後続を`skipped`にする。
- 全体と各itemの状態をServer永続値から表示し、refresh後も結果を維持する。
- 途中停止で適用確認済み、未適用、適用結果未確認を区別する。
- auditのBatch親eventとDeviceごとの既存Apply eventが`batch_id` / `batch_item_id`で追跡できる。
- Server APIでAdmin以外のBatch実行・変更を拒否する。
- Tenant mutex中に単体Applyが拒否された場合、拒否理由と原因Batch IDが画面に表示される。
- WAN / PPPoE変更でAgent外向き接続を失った際、このBatchではRouterへ到達できないと実行前に明示する。

## 11. このIssueでは扱わないこと

- Template / Golden Configの配布
- 別DeviceのCONFIGの適用、CONFIG本文の自動変換
- 自動障害検知、自動rollback起動、自動補償Apply
- Batch内のRouter再起動
- checkpointの部分取得を全体成功とみなすこと
- Apply失敗時に既に適用確認済みのDeviceを自動で元に戻すこと
