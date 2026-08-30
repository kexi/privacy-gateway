# デプロイの証跡

**https://privacy-gateway.kexi.dev** で稼働中のデプロイから取得した証跡。プロジェクト
`all-thinkgs`、リージョン `us-central1`。中心となる 1 リクエスト、OpenAI 互換エンドポイント、
フリート/IAM の状態は **2026-08-30** に取り直した。各ファイルの取得日は下表に記載する。
英語版は [README.md](./README.md)。

ここにあるものはすべて **マスク済み** である。再水和された回答は実際の PII を含み、
1 回の API レスポンスで返されるだけで保存されない。したがってこれらのファイルを書く前に
除去した。残っているのはプレースホルダ（`⟦PERSON_1⟧`、`⟦EMAIL_1⟧`、`⟦PHONE_1⟧` など）、
ダイジェスト、カテゴリ件数だけである。

## 解決済みのポストモーテム

以前の証跡取得中に判明し、ここに未修正として記録していた欠陥が 2 件ある。いずれも
**現在は修正済み** である。どちらも誤読ではなく実在の欠陥だった。履歴は意図的に残す。
自らの失敗を黙って消す証跡ディレクトリより、失敗が閉じられていく過程を示すものの方が
価値があるからである。

### 1. advisory judge のフラグが終端でなかった — **修正済み**

Gemma judge は助言的であり、拒否のみが可能で保証はできない。この非対称性が再試行によって
損なわれていた。フラグの立った判定を再度問い合わせ、2 回目の回答を採用できてしまっていた。

**現在:** フラグは終端である。`leak: true` は **常に** `judge_flagged`（HTTP 422）で拒否する。
2 回目の judge 呼び出しが走ることはあるが、それは拒否レコードにカテゴリ名を付けるため
**だけ** であり、その `leak` 値は無条件に破棄され、名指しされたカテゴリのみが採用される。
2 回目の呼び出しがフラグを解放に変えることはない。`attestation.judge_retries` は現在、
判定の振り直しではなくこのカテゴリ補完の試行回数を数える。

`docs/ARCHITECTURE.md` に記載。judge が自分のプレースホルダ `⟦TYPE_N⟧` を leak と誤判定する
別の欠陥は、judge に渡す前に整形式プレースホルダを除去することで修正した。
[`openai-compat.md`](./openai-compat.md) の addendum を参照。

### 2. キルスイッチが GPU の上限を落とせていなかった — **修正済み**

旧実装は `gemma-serving` に `template.scaling.maxInstanceCount = 0` を設定していた。これは
**no-op** だった。Cloud Run の最大値は 1 以上の整数であり、`RevisionScaling.maxInstanceCount`
は presence tracking を持たない素の proto3 `int32` であるため、`0` はそもそもシリアライズされず、
サーバは「最大値の指定なし」と解釈した。上限は 0 に設定されたのではなく **削除された**。
さらに旧来の成功判定は同じ「存在しないフィールド」を読み戻して成功の証拠としていた。
自分自身としか一致しようのない検査である。

**現在:** Cloud Run の **manual scaling** で `gemma-serving` を 0 インスタンスに固定する。
`scaling.scalingMode = MANUAL` かつ `scaling.manualInstanceCount = 0` であり、これが
ゼロインスタンス化の正規の手段である。このフィールドは `proto3_optional` なので明示的な `0` が
シリアライズされて残る。加えて `gemma-serving` に対する gateway と synthesis の
`run.invoker` を剥奪する。成功判定はモードとカウントを明示的に **読み戻して** 確認しており、
フィールドの不在から推測することはない。

`docs/DEPLOY.md` に記載。実発火の記録は [`kill-switch.md`](./kill-switch.md)。

---

## 証跡となるリクエスト

2026-08-30 取得。レスポンス全体は [`gateway-answer.json`](./gateway-answer.json)、
経路の解説は [`demo-sample.md`](./demo-sample.md)。

| フィールド   | 値                                                                   |
| ------------ | -------------------------------------------------------------------- |
| `request_id` | `01a05302-656b-735f-88ed-2e3dd5225497`                               |
| `trace_id`   | `c057cdb3782dd239bbb772aa0ee268e9`                                   |
| `trust_tier` | `machine-confirmed`                                                  |
| `status`     | `stable`                                                             |
| `core_actor` | `core_agent/gemini-3.5-flash`                                        |
| マスク件数   | `PERSON: 1, EMAIL: 1, PHONE: 1, CREDIT_CARD: 1, API_KEY: 1, IPV4: 1` |
| `withheld`   | `API_KEY`, `CREDIT_CARD`                                             |

平文のプロンプトは再掲しない。本リポジトリが唯一保存しない成果物だからである。
トラストバウンダリを出る前にマスクされた状態:

> Draft a short reply to ⟦PERSON_1⟧ (⟦EMAIL_1⟧, ⟦PHONE_1⟧) confirming his order. His card
> ⟦CREDIT_CARD_1⟧ and API key ⟦API_KEY_1⟧ were on file, from ⟦IPV4_1⟧.

## ファイル

| ファイル                                 | 取得日     | 内容                                                                                          |
| ---------------------------------------- | ---------- | --------------------------------------------------------------------------------------------- |
| `gateway-answer.json`                    | 2026-08-30 | `answer` を除去した API レスポンス全体。マスク済みプロンプト、attestation、consistency、stats |
| `gateway-answer.okf.md`                  | 2026-08-30 | OKF v0.2 の `Gateway Answer` ドキュメント。本文は **マスク済み** の回答                       |
| [`demo-sample.md`](./demo-sample.md)     | 2026-08-30 | 同じ 1 往復の詳解。マスク済みプロンプト、Core のトークン化応答、withhold、attestation         |
| [`openai-compat.md`](./openai-compat.md) | 2026-08-30 | 本番に対する `/v1/models` と `/v1/chat/completions`。修正済み judge 欠陥は履歴として保持      |
| `sa-core-iam.txt`                        | 2026-08-30 | Core のサービスアカウントのロール一覧 — **Firestore ロールなし**                              |
| `fleet-state.txt`                        | 2026-08-30 | Ingress、スケーリング、サービスアカウント、接続された GPU                                     |
| [`kill-switch.md`](./kill-switch.md)     | 2026-08-30 | 修正後の manual scaling 方式によるキルスイッチの**実発火**                                    |
| [`mcp.md`](./mcp.md)                     | 2026-08-30 | MCP stdio サーバを本番に対して実行した記録（`pgw_ask` / `pgw_evidence` / `pgw_verify`）       |
| `logs-request.jsonl`                     | 2026-08-30 | 証跡リクエストの構造化ログ。12 イベント、3 エージェントが同一 id                              |
| `trace-spans.json`                       | 2026-08-30 | 同じリクエストの Cloud Trace。16 スパン                                                       |

どちらも現行のリクエスト `01a05302-656b-735f-88ed-2e3dd5225497` について取り直した。
`logs-request.jsonl` は `gcloud logging read 'jsonPayload.request_id="…"'`、
`trace-spans.json` はトレース `c057cdb3782dd239bbb772aa0ee268e9` を Cloud Trace v1 API から
エクスポートしたものである。

トレースについて 1 点だけ正直に断っておく。保持されているのは **16** スパンで、Synthesis
（`synthesize`、`attest.leak_check`、`judge.gemma`、`okf.build`、`rehydrate`、`persist`）、
Firestore の往復、受信側 HTTP ハンドラ（`/v1/synthesize`、`/.well-known/agent-card.json`、
`/v1/chat/completions`）を覆っている。一方で Gateway 自身のトップレベル `request` スパンと
`a2a.core` スパンはエクスポートされたトレースに **含まれていない**。同じ工程は一致する
`trace_id` を持つ `logs-request.jsonl` 側には記録されている。2026-08-27 の旧キャプチャには
それらも含まれていた（24 スパン）ので、これは計装の変更ではなく今回の実行における
エクスポートの欠落である。隠さず記録しておく。

## この証跡が示すこと

**マスキングは実際に機能している。** `stats.counts_by_category` は 6 カテゴリ 6 件の識別子を
記録し、`masked_prompt` が置換後のプレースホルダを示す。これは **匿名化ではなく仮名化** である。
プレースホルダはカテゴリと同一性を開示し、残存する準識別子により文脈的な再識別が可能である。

**withhold は交渉の余地なく強制される。** `CREDIT_CARD` と `API_KEY` は解放された回答でも
マスクされたままだった。`attestation.withheld` が両者を記録し、呼び出し元が受け取った本文にも
プレースホルダがそのまま残っている。呼び出し元が既に持っている秘密を、フロンティアモデル
往復を経てわざわざ返す理由はない。

**リーク判定は機械が下している。** `verified[].by` は
`process:leak-check@8b427a667e64`、すなわち TypeScript の正規表現による attester であり、
LLM アクターではない。`dimensions.review_identity` が `none` なのは、公開ゲートウェイが
誰も認証しないため、レビュー担当者を名指しできないからである。`trust_tier: machine-confirmed`
はリークポリシー上の確認のみを意味し、回答内容の事実性の検証では **ない**。

**Core は構造的に Vault を読めない。** `sa-core-iam.txt` には `roles/aiplatform.user`、
`roles/cloudtrace.agent`、`roles/logging.logWriter` しかない。`roles/datastore.*` が
1 行も存在しないことこそが保証であり、これはパッケージ構成ではなく IAM が強制している。

**1 リクエスト、1 トレース、3 エージェント。** `logs-request.jsonl` では
`gateway-agent`、`core-agent`、`synthesis-agent` が同一の `request_id` で 12 件の
イベントを出し（`request.start` → `mask.done` → `a2a.core.send` → `a2a.receive` →
`a2a.core.recv` → `attest.verdict` → `judge.gemma` → `release.ok` → `okf.persist` →
`request.end`）、`trace-spans.json` は同じ id をこれらの工程にまたがって運ぶ単一トレースである。

## 既知の欠落

- **`llm.gemini` スパンがない。** トレースは `a2a.core` ホップを記録するが、Core 内部の
  Gemini 呼び出しは独立したスパンとして出力されないため、Gemini のレイテンシは個別には見えない。
- **`just verify-auth` と `just verify-auth-internal` は完走しなかった。** デプロイ報告の
  「Deviations」を参照。境界の確認は代わりに直接プローブ（VPC 外からの呼び出しは
  すべての非公開サービスで拒否される）と `fleet-state.txt` の `internal` ingress 設定で行った。
- **エクスポートされたトレースに Gateway 自身のスパンが欠けている。** 「ファイル」節の注記を参照。
