# デプロイの証跡

**2026-08-28** に稼働中のデプロイから取得した証跡。プロジェクト `all-thinkgs`、
リージョン `us-central1`。英語版は [README.md](./README.md)。

ここにあるものはすべて **マスク済み** である。再水和された回答は実際の PII を含み、
1 回の API レスポンスで返されるだけで保存されない。したがってこれらのファイルを書く前に
除去した。残っているのはプレースホルダ（`⟦PERSON_1⟧`、`⟦EMAIL_1⟧`、`⟦PHONE_1⟧`）、
ダイジェスト、カテゴリ件数だけである。

## 証跡となるリクエスト

| フィールド    | 値                                     |
| ------------ | -------------------------------------- |
| `request_id` | `01a043e6-afe3-7552-8c20-1f0b7f0a1831` |
| `trace_id`   | `8a3a4d14714ea9699a77fe46466b1e36`     |
| `trust_tier` | `machine-confirmed`                    |
| `status`     | `stable`                               |
| レイテンシ    | エンドツーエンド 8.35 秒（Gemma ウォーム時） |

公開 Gateway に送信したリクエスト:

> Draft a short polite status update for customer Taro Yamada (taro@example.com,
> 090-1234-5678) telling him his order shipped.

トラストバウンダリを出る前にマスクされた状態:

> Draft a short polite status update for customer ⟦PERSON_1⟧ (⟦EMAIL_1⟧, ⟦PHONE_1⟧)
> telling him his order shipped.

## ファイル

| ファイル                 | 内容                                                                       |
| ----------------------- | -------------------------------------------------------------------------- |
| `gateway-answer.json`   | `answer` を除去した API レスポンス全体。マスク済みプロンプト、attestation、consistency、stats |
| `gateway-answer.okf.md` | OKF v0.2 の `Gateway Answer` ドキュメント。本文は **マスク済み** の回答     |
| `logs-request.jsonl`    | 単一の `request_id` に対する構造化ログ。3 エージェントすべてが同じ id を持つ |
| `trace-spans.json`      | Cloud Trace のトレース。gateway → core → synthesis にまたがる 24 スパン      |
| `sa-core-iam.txt`       | Core のサービスアカウントのロール一覧 — **Firestore ロールなし**            |
| `fleet-state.txt`       | Ingress、最小/最大インスタンス数、サービスアカウント、接続された GPU         |

## この証跡が示すこと

**マスキングは実際に機能している。** `stats.counts_by_category` は
`PERSON: 1, EMAIL: 1, PHONE: 1` を記録し、`masked_prompt` が置換後のプレースホルダを示す。
これは **匿名化ではなく仮名化** である。プレースホルダはカテゴリと同一性を開示し、
残存する準識別子により文脈的な再識別が可能である。

**リーク判定は機械が下している。** `verified[].by` は
`process:leak-check@8b427a667e64`、すなわち TypeScript の正規表現による attester であり、
LLM アクターではない。`dimensions.review_identity` が `none` なのは、公開ゲートウェイが
誰も認証しないため、レビュー担当者を名指しできないからである。`trust_tier: machine-confirmed`
はリークポリシー上の確認のみを意味し、回答内容の事実性の検証では **ない**。

**Core は構造的に Vault を読めない。** `sa-core-iam.txt` には `roles/aiplatform.user`、
`roles/cloudtrace.agent`、`roles/logging.logWriter` しかない。`roles/datastore.*` が
1 行も存在しないことこそが保証であり、これはパッケージ構成ではなく IAM が強制している。

**1 リクエスト、1 トレース、3 エージェント。** `logs-request.jsonl` では
`gateway-agent`、`core-agent`、`synthesis-agent` が同一の `request_id` でログを出し、
`trace-spans.json` は経路全体を覆う単一トレースである。`gemma-serving` はリクエスト中に
2 回（マスキング `15:46:27`、助言的ジャッジ `15:46:34`）応答し、いずれも `200` だった。

## 既知の欠落

- **`llm.gemini` スパンがない。** トレースは `a2a.core` ホップを記録するが、Core 内部の
  Gemini 呼び出しは独立したスパンとして出力されないため、Gemini のレイテンシは個別には見えない。
- **`just verify-auth` と `just verify-auth-internal` は完走しなかった。** デプロイ報告の
  「Deviations」を参照。境界の確認は代わりに直接プローブ（VPC 外からの呼び出しは
  すべての非公開サービスで拒否される）と `fleet-state.txt` の `internal` ingress 設定で行った。
