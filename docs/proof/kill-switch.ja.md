# キルスイッチ発火テスト

**2026-08-27**、本番環境（プロジェクト `all-thinkgs`、リージョン `us-central1`）に対して
コストキルスイッチを**実際に発火**させた記録。英語版は
[kill-switch.md](./kill-switch.md)（詳細はそちら）。

ユニットテストではない。`just kill-switch-test publish` は実際の
`billing-kill-switch` トピックに実際の予算超過通知を送り、実際の push サブスクリプションと
OIDC トークンを経由する。フリートは本当にオフラインになった。

## 発火内容

```
just kill-switch-test publish   # messageId 21095725789802462
{"costAmount":60,"budgetAmount":50,"currencyCode":"USD","alertThresholdExceeded":1.0}
```

## 前後の状態

| 項目                                  | 発火前 | 発火後         |
| ------------------------------------- | ------ | -------------- |
| `gateway-agent` の `allUsers` invoker | あり   | **削除された** |
| 匿名 `GET /healthz`                   | `200`  | `404`          |
| `gemma-serving` maxScale              | `1`    | **`1` のまま** |

つまり**半分だけ成功した**。公開エンドポイントを閉じる側は正しく約 1 秒で発火した。
一方、本来止めたいコストである GPU の上限設定は効かなかった。

## 所見 1: `scaleToZero` が GPU サービスに対して失敗する

`killswitch.triggered` → `killswitch.invoker_revoked` の後、毎回 `killswitch.failed` が続き、
`gemma-serving` の `maxInstanceCount` は `1` のまま。原因はログに出ない — 本プロジェクトの
ログ方針は例外メッセージを記録せず `error_class` のみとするため、`{"error_class":"Error"}`
としてしか現れない。

疑わしいのは `services/kill-switch/src/actions.ts` の `scaleToZero` で、Service 全体を読んで
`template.scaling` だけ変えて書き戻している。GPU 固有フィールド
（`nodeSelector: nvidia-rtx-pro-6000` など）をそのまま送り返すため v2 API に拒否された可能性がある。
**根本原因は未確定**（直接 `updateService` を呼ぶ検証は本セッションの権限外だった）。

## 所見 2: 失敗が無限の revoke ループになる

こちらの方が深刻で、復旧を困難にした。

push エンドポイントは失敗時に `500` を返して Pub/Sub に再配信させる設計だが、`scaleToZero`
が成功しないため永久に `500` を返し続け、**再配信のたびに `revokePublicInvoker` が再実行される**。

実測: 約 30 秒ごとに約 11 分間、サブスクリプションの `messageRetentionDuration`（600 秒）が
切れる 23:34 頃まで継続した。途中 23:25:55 の `already_applied: false` は、運用者が
`just tf-apply` で復旧した直後にスイッチが再び剥奪したことを示す。

個々の操作は冪等でも、**revoke と運用者による restore が並行すると冪等ではない**。
`billing-kill-switch-push` に dead-letter policy が無いため、保持期間が切れるまで復旧できない。

## 復旧

再配信が止まった後の `just tf-apply` で復旧した（ループ中の apply は約 30 秒で無効化された）。

```
google_cloud_run_v2_service_iam_member.gateway_public: Creation complete after 8s
Apply complete! Resources: 1 added, 0 changed, 0 destroyed.
```

Terraform はスイッチが消した 1 つのバインディングだけを再作成した。復旧経路を Terraform に
置く設計判断は妥当だったと言える。IAM 伝播に約 40 秒かかり、その間 `/v1/models` は `403` を
返した（復旧失敗と早合点しないこと）。

## 結論

- 検知は正しい（`60 >= 50`、ratio 1.2）。
- 公開ドアを閉じる動作は正しく速い。
- **GPU の上限設定は効かない** — 本来止めたいコストが止まらない。
- 部分失敗が **revoke ループ**に劣化し、保持期間中は運用者が復旧できない。

いずれも未修正。推奨対応は英語版の «Suggested fixes» を参照。

---

## 追記（2026-08-28）: 両方の所見を修正した

両方の根本原因を特定し修正した。上に記した推測 — v2 API が出力専用フィールドや GPU 固有
フィールドのせいで全体書き込みを拒否している — は **誤りだった**ので、そのまま残さずここで
訂正する。

### 所見 1 の根本原因: 長時間実行オペレーションを待っていなかった

Cloud Run Admin v2 の `updateService` は完了した書き込みではなく **long-running operation
(LRO)** を返す。旧コードは次のようになっていた。

```ts
await client.updateService({ service: { ... } });   // LRO の「開始」で解決する
```

これは Cloud Run がリクエストを _受理_ した時点で解決してしまう。実際の更新はまだ進行中で、
拒否された場合もそれを捕捉するはずの `try` の外側で表面化する。結果としてハンドラは成功を
報告しつつ `gemma-serving` は `maxInstanceCount = 1` のままだった。`revokePublicInvoker` が
動いて `scaleToZero` が動かなかった理由もこれで説明がつく — `setIamPolicy` はポリシーを直接
返し、待つべきオペレーションが存在しない。

拒否仮説が誤りであった証拠: 同じ全体書き込みを `validateOnly: true` で実サービスに対して
再生したところ、出力専用フィールドと `nodeSelector: nvidia-rtx-pro-6000` を含めて **受理された**。

修正中に独立した 2 つ目のバグも見つかった。Cloud Run v2 にはスケーリング上限が **2 つ** あり、
コードは片方しか書いていなかった。

| フィールド                 | `gemma-serving` | `gateway-agent` |
| -------------------------- | --------------- | --------------- |
| `service.scaling`          | `1`             | `20`            |
| `service.template.scaling` | `1`             | `3`             |

両者は独立した値である。リビジョン側だけを 0 にしてもサービス側の上限が GPU の起動を許して
しまうため、修正では両方を書く。

したがって修正は 3 点: 両方の上限を書く、`operation.promise()` を待つ、そして呼び出しを信用
せず **サーバのエコーを検証する**（上限が反映されずに完了したオペレーションは
`scale_to_zero_not_applied` を投げる）。

### 所見 2 の根本原因: 500 による再配信を止めるものが無かった

ループは設計どおりの挙動だった。push エンドポイントは「失敗した半分をやり直す」ために `500`
を返していたが、失敗する半分は決して成功しないため、再配信のたびに成功済みの半分が再実行され
続けた。配信は **終端的 (terminal)** になった。

- トリップは `gateway-agent` の `kill-switch/tripped` アノテーションとして記録され、**両方**の
  変更が確認できた後にのみ書かれる。再配信はこれを読んで何も触らず `already_tripped` を返す。
- エンドポイントは失敗したトリップでも **ACK (2xx)** する。1 通の通知が引き起こすトリップ試行は
  高々 1 回になった。運用者への通知は ERROR ログであり、リトライの嵐ではない。
- **デッドレタートピック**（`billing-kill-switch-dead-letter`、`max_delivery_attempts = 5`）が、
  アプリ側では応答しようのないトランスポート層のリトライループを打ち切る。`just logs-kill-switch-dlq`
  で確認する。
- `just restore-after-kill` は apply 成功後にマーカーを消してスイッチを再武装する。最後に消すのは
  意図的で、マーカーがある間はスイッチが発火しないため、先に消すと復旧していない fleet に対して
  スイッチを武装することになる。

マーカーの読み取り失敗時に _fail open_ する理由: 本当の超過支出を止め損ねる方が、2 回動作するより
悪いため。
