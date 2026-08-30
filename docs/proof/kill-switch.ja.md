# キルスイッチ発火テスト

**現状: スイッチは正しく動作する。** **2026-08-30**、本番環境（プロジェクト `all-thinkgs`、
リージョン `us-central1`）に対して**実際に発火**させ、全段階が engage した — 公開ドアの閉鎖、
Cloud Run 自身によるインスタンス数ゼロでの GPU 停止、そして fleet のサービスアカウントから
GPU 呼び出し権限の剥奪 — 1 回の配信で 2 秒以内、再配信ループなし。英語版は
[kill-switch.md](./kill-switch.md)（詳細はそちら）。

それを証明する 1 行が、Cloud Run 自身が出した `gemma-serving` のログである。

```
2026-08-30T14:12:51.128284Z  Shutting down user disabled instance
```

これはプラットフォーム自身が「ゼロ保持設定のためインスタンスを停止した」と報告している。
本プロジェクトの過去の発火では一度も得られなかった証拠である。

ユニットテストではない。`just kill-switch-test publish` は実際の `billing-kill-switch`
トピックに実際の予算超過通知を送り、実際の push サブスクリプションと OIDC トークンを経由する。
フリートは本当にオフラインになった。

失敗に終わった 2026-08-27 の発火は、末尾に**解決済みポストモーテム**として残してある。

## 発火内容

```
just kill-switch-test publish
# 2026-08-30T14:12:39Z 発行、messageId 21507257514954541
{"budgetDisplayName":"agentic-fleet-kill-switch","costAmount":60,
 "budgetAmount":50,"currencyCode":"USD","alertThresholdExceeded":1.0}
```

## 前後の状態

いずれも発火後に実環境から読み戻して確認した。

| 項目                                  | 発火前                                               | 発火後                                                                            |
| ------------------------------------- | ---------------------------------------------------- | --------------------------------------------------------------------------------- |
| `gemma-serving` サービス `scaling`    | `scalingMode: automatic`、`manualInstanceCount` なし | `{"scalingMode":"MANUAL","manualInstanceCount":0}`                                |
| `gemma-serving` `template.scaling`    | `{"maxInstanceCount":1}`                             | `{"maxInstanceCount":1}`（意図的に不変）                                          |
| `gemma-serving` の `run.invoker`      | `sa-gateway@…` と `sa-synthesis@…`                   | **バインディングごと消滅**（残るのは `sa-kill-switch` の `roles/run.admin` のみ） |
| `gateway-agent` の `allUsers` invoker | あり                                                 | **削除された**                                                                    |
| 匿名 `GET /healthz`                   | `404`                                                | `404`（下の注記参照。この probe は閉鎖の証拠にならない）                          |
| `just smoke`                          | 成功（`core_actor: core_agent/gemini-3.5-flash`）    | —                                                                                 |

コンソールのアノテーションも一致している:
`run.googleapis.com/scalingMode: manual`、`run.googleapis.com/manualInstanceCount: '0'`。

API の読み戻しは**設定が反映されたこと**を示すが、上掲の
`Shutting down user disabled instance` は**プラットフォームが実際に GPU を落としたこと**を
示す。ここが決定的な違いである。

> **`/healthz` probe は証拠にならない。2026-08-27 の proof はこれを証拠として扱った点が
> 誤りだった。** `privacy-gateway.kexi.dev` の `GET /healthz` は、公開ドアが開いていても
> 閉じていても `404` を返す。ルート自体は Gateway に登録されているが、このパスへの
> リクエストはコンテナまで届かず、Google のフロントエンドが応答してしまう。2026-08-30 に
> フリートを完全復旧し `allUsers` バインディングを戻した状態で再計測しても `404` のまま
> だった。両方の状態で同じ値を返す probe は何も区別しない。
>
> 閉鎖を示すのは上表の IAM の読み戻し（`allUsers` バインディングが実行前は存在し実行後は
> 消えている）であり、これがプラットフォームが実際に強制している状態である。今後の
> ライブ発火では `GET /` か `GET /v1/models` を使うべきである。どちらもドアが開いている
> 間は `200` を返すことを 2026-08-30 の復旧後に確認済みである。

## スイッチの動作

3 つの変更を順に実行する。いずれも冪等で、1 回の配信から約 2 秒以内に完了した。

```
2026-08-30T14:12:42.225Z  WARNING  killswitch.triggered               budget_ratio 1.2, cost 60, budget 50
2026-08-30T14:12:42.702Z  INFO     killswitch.invoker_revoked         already_applied false
2026-08-30T14:12:43.228Z  INFO     killswitch.scaled_to_zero          already_applied false
2026-08-30T14:12:43.677Z  INFO     killswitch.fleet_invokers_revoked  already_applied false
2026-08-30T14:12:44.137Z  WARNING  killswitch.mark_failed             error_class "Error"
2026-08-30T14:12:44.137Z  INFO     killswitch.completed               already_applied false
```

1. **`revokePublicInvoker('gateway-agent')`** — `allUsers` の `roles/run.invoker` を剥奪する。
2. **`scaleToZero('gemma-serving')`** — **サービスレベル**の `scaling.scalingMode = MANUAL` と
   `scaling.manualInstanceCount = 0` を設定する。Cloud Run が文書化している「サービスをゼロ
   インスタンスに固定する」機構である。`template.scaling.maxInstanceCount` は意図的に `1` のまま
   触らない。
3. **`revokeFleetInvokers('gemma-serving')`** — 新規。gateway と synthesis の `roles/run.invoker`
   を GPU サービスから剥奪する。仮に Cloud Run がリクエストを通したとしても、呼び出す権限を持つ
   者がいない状態にする（二重防御）。メンバー一覧は Terraform が設定する
   `KILL_SWITCH_FLEET_MEMBERS` 環境変数から取る。

**なぜ `template.scaling.maxInstanceCount = 0` にしないのか** — 2026-08-27 の発火が失敗した
理由そのものだから。Cloud Run の最大インスタンス数は 1 以上の整数であり、
`RevisionScaling.maxInstanceCount` は presence tracking を持たない素の proto3 `int32` なので、
`0` はそもそも送信されない。サーバは**フィールド不在**を受け取り、それは「上限なし」を意味する
— 上限は設定されるのではなく**外される**。一方 `ServiceScaling.manualInstanceCount` はこの領域で
唯一 `proto3_optional`（synthetic oneof `_manualInstanceCount`）で宣言されており、明示的な `0` が
presence tracking され往復を生き延びる。ゼロを表現できるのはこのフィールドだけである。

**なぜ書き込み結果を信用しないのか** — 成功判定は適用後の状態を**明示的に**読み戻して行う
（scaling mode と manual count の両方）。フィールド不在から推測することは二度としない。scaling
ブロックが空・不在なら `scale_to_zero_not_applied` で失敗する。

## 既知の粗さ 2 点

いずれも隠さず記録する。保証には影響しない。

**1. `killswitch.mark_failed`** — `gateway-agent` への `kill-switch/tripped` アノテーション書き込みが
失敗を報告した。しかし**書き込み自体は成功していた**（後から `2026-08-30T14:12:43.767Z` として
読み戻せた）。書き込みは着地し、確認だけが失敗を報告した — scaling 側が読み戻しで既に対処して
いる「誤解を招く LRO」と同種の挙動である。設計上許容している: WARNING でログするだけでトリップは
ロールバックしない。**なぜここで失敗させないのか** — 3 つの変更がすべて成功した後に拒否すると、
成功したトリップを再配信ループに変えてしまう。マーカーは実際に存在するので再配信は no-op になる。
保証への影響はない。

**2. 復旧に 2 回目の `terraform apply` が要る** — 下記「復旧」を参照。

## 復旧

| 項目                               | 結果                                                    |
| ---------------------------------- | ------------------------------------------------------- |
| `gateway-agent` の `allUsers`      | 再設定された                                            |
| `gemma-serving` サービス `scaling` | `{"scalingMode":"AUTOMATIC","maxInstanceCount":1}`      |
| `gemma-serving` の `run.invoker`   | fleet 両方のバインディングを再作成                      |
| `kill-switch/tripped` マーカー     | 削除し、**不在**を読み戻して確認 — スイッチは再武装済み |
| `just smoke`                       | 成功（`core_actor: core_agent/gemini-3.5-flash`）       |

運用上の注意: `terraform apply` は `gemma-serving` で
`Container failed to become healthy. Startup probes timed out after 11m` エラーになる。これは
2026-08-28 から続く**既存の問題**でキルスイッチとは無関係（この deployment では GPU リビジョンが
startup probe を通らない）。scaling の変更自体は反映されるが、このエラーが invoker バインディングの
再作成**前に** apply を中断させるため、2 回目の `terraform apply`（または
`-target=google_cloud_run_v2_service_iam_member.invoker`）が必要になる。
`just restore-after-kill` はこの前提で実行すること。

---

## 解決済みポストモーテム: 2026-08-27 の発火

診断内容に価値があるため残す。**この節の内容はすべて修正済みで、現在のコードはこの挙動をしない。**

当時の記録は正直に半分の失敗を示していた。`gateway-agent` の `allUsers` は削除された一方、
`gemma-serving` の maxScale は `1` のままで `killswitch.failed` が出ていた。当時は匿名
`GET /healthz` の `404` も閉鎖の証拠として記録していたが、これは結論を支えていなかった
（上の注記参照）。閉鎖自体は 2026-08-27 にも本当に起きており、それを示していたのは
IAM の読み戻しのほうである。

### 根本原因: `maxInstanceCount = 0` は上限を「設定」せず「解除」する

旧 `scaleToZero` は `template.scaling.maxInstanceCount = 0`（および
`scaling.maxInstanceCount = 0`）を書いていた。これは二重に誤りだった。

- `RevisionScaling.maxInstanceCount` は presence tracking を持たない proto3 `int32` なので `0` は
  送信されない。サーバが受け取るのはフィールド不在で、それは「上限なし」を意味する。意図と逆に
  上限が**外れる**。
- 成功判定はその**同じ不在フィールド**を読み戻して「ゼロ上限が効いた」と解釈していた。0 と unset が
  同一のワイヤ表現である以上、「0 または unset なら成功」という条件は反証不可能である。結果、
  何も止まっていないのにスイッチは GPU 停止を報告していた。

2026-08-28 の追記はこれを修正済みと主張したが、**修正されていなかった** — 壊れた機構はそのままに、
不在フィールドを受け入れる誤った成功判定を足しただけだった。その主張はここで撤回する。

本当の修正は、ゼロを表現できないフィールドでゼロを表現するのをやめることだった（上記「スイッチの動作」）。

### 2 つ目の所見: 失敗が無限の revoke ループになった

push エンドポイントが失敗時に `500` を返して再配信させる設計だったが、`scaleToZero` が決して
成功しないため永久に `500` を返し続け、再配信のたびに `revokePublicInvoker` が再実行された。
実測で約 30 秒ごとに約 11 分間、保持期間（600 秒）が切れるまで継続。運用者の `just tf-apply` に
よる復旧を次の再配信が打ち消した。個々の操作は冪等でも、**revoke と運用者の restore が並行すると
冪等ではない**。

**修正済み。** 配信は終端的になった: 失敗したトリップでもエンドポイントは ACK し、
`kill-switch/tripped` アノテーションが再配信を no-op にし、dead-letter policy がトランスポート層の
リトライを打ち切る。2026-08-30 の発火では `killswitch.triggered` は**ちょうど 1 回**、
dead-letter サブスクリプション `billing-kill-switch-dead-letter-hold` は**空**だった。

**なぜ 500 による再配信設計を維持しないのか** — 障害が一時的な場合にしか効かず、恒久的な場合は
無制限になる。運用者への通知は ERROR ログであり、運用者の復旧と喧嘩するリトライの嵐ではない。

### 今も有効な診断

- `updateService` は LRO を返す。旧コードは LRO の「開始」で解決していたため、拒否が `try` の
  外側で表面化した。`setIamPolicy` はポリシーを直接返すので待つべきオペレーションがない — invoker
  剥奪だけが動いていた理由である。
- **オペレーションの拒否は最終判定ではない。** この GPU サービスでは、変更が着地していても
  オペレーションが失敗を報告しうる。1 回後の読み戻しで得たサービス自身の状態が判定に使われる。
  上記 `killswitch.mark_failed` はアノテーション書き込みで起きた同じ現象である。
- **Artifact Registry の読み取り権限が要る。** サービス更新はコンテナイメージを再検証するため、
  scaling しか触らなくても `artifactregistry.repositories.downloadArtifacts` が必要。
  `roles/run.admin` はこれを含まない（`roles/artifactregistry.reader` を付与）。
- **ランタイム ID への `actAs` が要る。** サービス更新は実行サービスアカウントの割り当てを伴うため、
  ID が不変でも act as できる必要がある。`sa-gemma` と（マーカー書き込み用に）`sa-gateway` に対して
  `roles/iam.serviceAccountUser` を、プロジェクト全体ではなく当該アカウントに限定して付与している。
  **なぜプロジェクト全体にしないのか** — invoker 剥奪は `setIamPolicy` で `actAs` を一切必要とせず、
  広い付与は何も得ずに `sa-kill-switch` 侵害時の影響範囲だけを広げるため。

いずれも `infra/terraform/killswitch.tf` に宣言済み。

---

## 解決済み所見: `restore-after-kill` がスイッチを恒久的に無効化していた

2026-08-30 の復旧作業中に発見・修正した。復旧経路の**沈黙する失敗**であり、最も質が悪い場所での
バグだったため記録する。

`just restore-after-kill` は `kill-switch/tripped` マーカーを
`gcloud run services update ... --remove-annotations ... || echo "(no marker was set)"` で消していた。
`--remove-annotations` は**存在しないフラグ**で、gcloud は unrecognised として拒否する。`|| echo` が
その拒否を握り潰し、実際に起きたことと**正反対**のメッセージ（「マーカーは設定されていなかった」）を
表示していた。マーカーは設定されたままで、消去は一度も実行されていない。

影響は誤記の割に深刻である。マーカーが設定されている間、以降のトリップはすべて no-op になる。
つまり運用者は「復旧成功」と思ってその場を離れ、スイッチは**恒久的に無効化された**まま、次の
本物の超過支出で初めてそれに気づくことになる。

修正: レシピは Admin API 経由で v2 Service を read-modify-write してマーカーを消し、**不在を
読み戻して確認する**。2026-08-30 に検証済み — マーカーは不在を読み戻し、スイッチは武装している。

**なぜ `|| echo` のフォールバックを残さないのか** — 「やることがなかった」と「コマンドが動かない」を
区別できない復旧ステップは、メッセージが無いより悪い。声の大きい失敗を、自信に満ちた誤った安心に
変換してしまうため。以後、消去は必ず読み戻しで終わる。
