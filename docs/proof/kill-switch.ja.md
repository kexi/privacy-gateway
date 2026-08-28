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
