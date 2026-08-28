# デプロイの証跡

**2026-08-28** に稼働中のデプロイから取得した証跡。プロジェクト `all-thinkgs`、
リージョン `us-central1`。英語版は [README.md](./README.md)。

ここにあるものはすべて **マスク済み** である。再水和された回答は実際の PII を含み、
1 回の API レスポンスで返されるだけで保存されない。したがってこれらのファイルを書く前に
除去した。残っているのはプレースホルダ（`⟦PERSON_1⟧`、`⟦EMAIL_1⟧`、`⟦PHONE_1⟧`）、
ダイジェスト、カテゴリ件数だけである。

## 証跡となるリクエスト

| フィールド   | 値                                           |
| ------------ | -------------------------------------------- |
| `request_id` | `01a043e6-afe3-7552-8c20-1f0b7f0a1831`       |
| `trace_id`   | `8a3a4d14714ea9699a77fe46466b1e36`           |
| `trust_tier` | `machine-confirmed`                          |
| `status`     | `stable`                                     |
| レイテンシ   | エンドツーエンド 8.35 秒（Gemma ウォーム時） |

公開 Gateway に送信したリクエスト:

> Draft a short polite status update for customer Taro Yamada (taro@example.com,
> 090-1234-5678) telling him his order shipped.

トラストバウンダリを出る前にマスクされた状態:

> Draft a short polite status update for customer ⟦PERSON_1⟧ (⟦EMAIL_1⟧, ⟦PHONE_1⟧)
> telling him his order shipped.

## ファイル

| ファイル                | 内容                                                                                          |
| ----------------------- | --------------------------------------------------------------------------------------------- |
| `gateway-answer.json`   | `answer` を除去した API レスポンス全体。マスク済みプロンプト、attestation、consistency、stats |
| `gateway-answer.okf.md` | OKF v0.2 の `Gateway Answer` ドキュメント。本文は **マスク済み** の回答                       |
| `logs-request.jsonl`    | 単一の `request_id` に対する構造化ログ。3 エージェントすべてが同じ id を持つ                  |
| `trace-spans.json`      | Cloud Trace のトレース。gateway → core → synthesis にまたがる 24 スパン                       |
| `sa-core-iam.txt`       | Core のサービスアカウントのロール一覧 — **Firestore ロールなし**                              |
| `fleet-state.txt`       | Ingress、最小/最大インスタンス数、サービスアカウント、接続された GPU                          |

### 後日の記録（2026-08-27/28）

| ファイル                                 | 内容                                                                          |
| ---------------------------------------- | ----------------------------------------------------------------------------- |
| [`kill-switch.md`](./kill-switch.md)     | キルスイッチの**実発火**。止まったもの・止まらなかったもの・未修正の欠陥 2 件 |
| [`openai-compat.md`](./openai-compat.md) | 本番に対する `/v1/chat/completions`。および advisory judge の不具合           |
| [`mcp.md`](./mcp.md)                     | MCP stdio サーバを本番に対して実行した記録（`pgw_ask` + `pgw_verify`）        |

## 上記の取得中に判明した未修正の欠陥

すべて green の報告と誤読されないよう記載する。詳細とログ断片は各ドキュメント参照。

1. **advisory Gemma judge が自分のプレースホルダを leak と誤判定する。** `⟦TYPE_N⟧` を含む
   回答は `judge_flagged`（`leak: true`, `categories: []`）で拒否され、`just smoke` は現在
   失敗する。決定的 attester は pass しているため、リークではなく **fail-closed** 側の誤り
   だが、デモは通らない。judge のコードは初回コミットから変更なし。
   `serving/gemma/Dockerfile` が `FROM ollama/ollama:latest`（**未固定**）で、稼働中の
   Ollama 0.33.1 が gemma3 を `--chat-template chatml --no-jinja` で配信している点が
   有力な仮説。[`openai-compat.md`](./openai-compat.md) 参照。
2. **キルスイッチは公開アクセスを剥奪するが GPU の上限を落とせない。** `scaleToZero` が
   `gemma-serving` に対して失敗し、ハンドラが再配信のため `500` を返すので、Pub/Sub の
   保持期間 600 秒が切れるまで約 30 秒ごとに gateway のバインディングを剥奪し続け、
   運用者の復旧を妨げる。[`kill-switch.md`](./kill-switch.md) 参照。

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
