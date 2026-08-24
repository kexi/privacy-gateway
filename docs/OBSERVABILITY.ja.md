# オブザーバビリティ

1 リクエストをフリート全体で追跡する方法と、ログイベント・エラーコードの正典。
エージェント向けの調査手順は `skills/pgw-logs/LOGS.md`。本書はその両者が参照する
語彙の定義元。

English version: [OBSERVABILITY.md](OBSERVABILITY.md).

## 1. 2 つの識別子

| 識別子       | 由来                                                           | 出現箇所                                                               |
| ------------ | -------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `request_id` | `X-Request-ID` ヘッダ、無ければ Gateway が UUIDv7 を生成       | 全ログ行、`X-Request-ID` レスポンスヘッダ、API ボディ、OKF frontmatter |
| `trace_id`   | W3C `traceparent`、または Cloud Run の `X-Cloud-Trace-Context` | 全ログ行、API ボディ、OKF frontmatter、Cloud Trace                     |

`request_id` は **UUIDv7**。先頭 48 bit がミリ秒タイムスタンプなので、ID でソート
すると時刻順にもなる。受信した値は整形式の UUID のときだけ採用する — 任意の文字列を
そのまま通すとログインジェクションの経路になるため。

どちらの ID も利用者まで届く: web UI がコピーボタン付きで表示し、API はボディに含め、
Python クライアントは標準出力に出す。バグ報告にどちらか一方があれば、以下すべてを
たどれる。

## 2. リクエストをたどる

```
request_id  ─┬─▶ Logs Explorer: jsonPayload.request_id="<id>"   (3 サービス横断)
             └─▶ OKF 回答ドキュメントの frontmatter

trace_id    ─┬─▶ Cloud Trace: gateway → core → synthesis が 1 本のトレース
             └─▶ Logs Explorer の「トレースを表示」(logging.googleapis.com/trace 経由)
```

1. **まず `request_id`。** 1 クエリで 3 サービス全ログが時系列で返る。
2. **`session_id` に広げる。** 複数リクエストにまたがる問い（プレースホルダの安定性、
   後から行われた承認）はこちら。
3. **レイテンシは `trace_id`。** どのホップが遅く、その内訳がどこかを見る。

直リンク（プロジェクト `all-thinkgs`）:

- 1 リクエストのログ:
  `https://console.cloud.google.com/logs/query;query=jsonPayload.request_id%3D%22<request_id>%22?project=all-thinkgs`
- 1 トレース:
  `https://console.cloud.google.com/traces/list?project=all-thinkgs&tid=<trace_id>`

UI は表示中の ID の隣に同じリンクを出すので、通常はここで URL を組み立てる必要はない。

```bash
gcloud logging read 'resource.type="cloud_run_revision" jsonPayload.request_id="<request_id>"' \
  --project all-thinkgs --freshness=2h --order=asc --format=json \
  | jq -c '.[] | {t:.timestamp, svc:.resource.labels.service_name, ev:.jsonPayload.event, ms:.jsonPayload.duration_ms}'
```

## 3. ログ形式

1 行 1 JSON を stdout（`ERROR` は stderr）へ。Cloud Run はこれをそのまま構造化
エントリとして取り込むため、サイドカーは不要。

| フィールド                      | 常時       | 意味                                      |
| ------------------------------- | ---------- | ----------------------------------------- |
| `severity`                      | ○          | `DEBUG` / `INFO` / `WARNING` / `ERROR`    |
| `message`                       | ○          | 可読テキスト。イベント時は `event` と同値 |
| `time`                          | ○          | ISO 8601 UTC                              |
| `agent`                         | ○          | `gateway` / `core` / `synthesis`          |
| `event`                         | イベント時 | §4 の安定識別子                           |
| `request_id`                    | ほぼ常時   | 相関 ID                                   |
| `session_id`                    | ほぼ常時   | Gateway セッション                        |
| `trace_id`, `span_id`           | トレース時 | 生の ID（ローカル用）                     |
| `logging.googleapis.com/trace`  | GCP 上     | `projects/<project>/traces/<trace_id>`    |
| `logging.googleapis.com/spanId` | GCP 上     | 行とスパンを相互リンク                    |
| `duration_ms`                   | 計測時     | 経過ミリ秒                                |
| `error_code`, `error_message`   | エラー時   | §6 参照                                   |

**生 PII は決して出さない。** 全文字列値はシリアライズ前にトークナイザを通すので、
誤って渡された値も `⟦EMAIL_1⟧` の形でしか残らない。ID 系のキー（`session_id`,
`request_id`, `trace_id`, `verdict`, `trust_tier`, `status`, `model` など）はマスク
しない — マスクすると相関が取れなくなるため。**ログに生 PII があればそれ自体がバグ。
報告すること。**

## 4. イベント語彙

イベント名は安定識別子。クエリとダッシュボードが依存している。

### Gateway

| event                    | severity     | 意味 / 確認事項                                                                                      |
| ------------------------ | ------------ | ---------------------------------------------------------------------------------------------------- |
| `request.start`          | INFO         | エンベロープ開始。`method`, `path`                                                                   |
| `request.end`            | INFO         | エンベロープ終了。`duration_ms`, `status`, `trust_tier`                                              |
| `mask.done`              | INFO         | `placeholder_count`, `counts_by_category`, `unstructured_spans`。PII を含む入力で 0 なら検出器の退行 |
| `mask.gemma.unparseable` | INFO/WARNING | Gemma のスパン JSON を利用できず 1 回リトライ。恒常的なら JSON モードかモデル未取得                  |
| `mask.gemma.failed`      | WARNING      | Gemma へ到達不能。regex のみに縮退（ガードは有効なまま）                                             |
| `guard.egress.blocked`   | ERROR        | 生 PII が境界を越えかけたので拒否。**正しい挙動** — `categories` を確認                              |
| `a2a.core.send`          | INFO         | Core 往復の開始                                                                                      |
| `a2a.core.recv`          | INFO         | Core 応答。`duration_ms`, `status`                                                                   |
| `approve.done`           | INFO         | 人による承認を記録。`trust_tier`                                                                     |
| `request.refused`        | ERROR        | `guard.egress.blocked` を受けて呼び出し元へ 422                                                      |
| `request.failed`         | ERROR        | 5xx。`error_code`, `error_message`                                                                   |
| `server.start`           | INFO         | 起動。モデル ID、vault バックエンド、下流 URL                                                        |

### Core

| event                   | severity | 意味                                                     |
| ----------------------- | -------- | -------------------------------------------------------- |
| `a2a.receive`           | INFO     | A2A リクエストを受理。`placeholder_count`, `text_length` |
| `guard.inbound.blocked` | ERROR    | ペイロードに生 PII。`finding_kinds` のみで値は出さない   |
| `llm.gemini.call`       | INFO     | モデル ID、トークン数。404 は `GEMINI_MODEL` の誤り      |
| `server.start`          | INFO     | 起動。モデル ID、Vertex AI 設定、Agent Card パス         |

### Synthesis

| event                                              | severity     | 意味 / 確認事項                                                                       |
| -------------------------------------------------- | ------------ | ------------------------------------------------------------------------------------- |
| `attest.verdict`                                   | INFO         | `verdict: pass\|fail`, `findings`（カテゴリのみ、値は出さない）                       |
| `judge.gemma`                                      | INFO/WARNING | Gemma の助言的判定。パース失敗は JSON モードかモデル未取得                            |
| `rehydrate.done`                                   | INFO/WARNING | `tokens_resolved`, `tokens_unknown`。`tokens_unknown > 0` は捏造トークンか vault 失効 |
| `okf.persist`                                      | INFO         | Firestore 書き込み。権限エラーは `sa-synthesis` に `roles/datastore.user` が必要      |
| `request.start` / `request.end` / `request.failed` | —            | Gateway と同じ                                                                        |

### 全サービス共通

| event               | severity | 意味                                                             |
| ------------------- | -------- | ---------------------------------------------------------------- |
| `config.invalid`    | ERROR    | 起動時の zod 環境変数検証に失敗。`issues` に該当キー。致命的     |
| `otel.export.error` | WARNING  | トレースのエクスポートに失敗。処理は継続するがトレースは失われる |

## 5. トレース

1 ユーザリクエスト = 1 トレース。期待されるスパンツリー:

```
request                            (gateway)
├── mask.gemma                     非構造スパン抽出
├── mask.regex                     決定的トークン化
├── guard.egress                   拒否ポイント
├── a2a.core                       ──▶ a2a.receive ──▶ llm.gemini      (core)
└── synthesis.call                 ──▶ attest.leak_check               (synthesis)
                                       judge.gemma
                                       rehydrate
                                       okf.build
                                       persist
```

スパン属性は件数・判定・識別子のみ（`placeholder_count`, `tokens_unknown`,
`verdict`, `trust_tier`, `session_id`, `request_id`）。**PII の値は決して入れない。**

伝搬: Gateway は A2A 呼び出しと Synthesis への HTTP 呼び出しの双方に `traceparent`
を注入する。Cloud Run では W3C ヘッダが無い場合 `X-Cloud-Trace-Context` を
traceparent に変換するので、ロードバランサ経由で入ったリクエストも 1 本のトレースに
繋がる。Cloud Trace でホップが欠けていれば、そのホップの伝搬が切れている。
`OTEL_ENABLED` を確認し、そのサービスのログに `otel.export.error` が無いか見る。

E2E テストがこれを検証している: 全ホップで trace_id が同一で、子スパンが `request`
を親に持つこと（`agents/gateway/test/e2e.test.ts`）。

## 6. エラーコード

| `error_code`              | HTTP | 意味                                       | 最初に見る場所                                    |
| ------------------------- | ---- | ------------------------------------------ | ------------------------------------------------- |
| `invalid_request`         | 400  | ボディが zod スキーマ検証に失敗            | `message` が該当キーを示す                        |
| `outbound guard refused`  | 422  | マスク後も生 PII が残存。Core は未呼び出し | `guard.egress.blocked` と `categories`            |
| `downstream_agent_failed` | 502  | Core か Synthesis が失敗・到達不能         | 同じ `request_id` でそのサービスのログ            |
| `internal_error`          | 500  | 当該サービス内の未処理エラー               | `request.failed` 行の `error_message`             |
| `unknown session`         | 404  | そのセッションの回答が無い                 | vault / answer の TTL。`stale_after` 経過の可能性 |
| `config.invalid`          | —    | プロセスが起動を拒否                       | ログ行の `issues`                                 |

全エラーレスポンスが `request_id` を含むので、報告者の手元の ID だけでログを特定できる。

## 7. ローカル開発

`just dev` は 4 プロセスを起動し、構造化ログを stdout に多重化する:

```bash
just dev 2>&1 | tee /tmp/pgw-dev.log
jq -c 'select(.request_id=="<id>")' /tmp/pgw-dev.log
jq -c 'select(.event=="attest.verdict")' /tmp/pgw-dev.log
```

`GOOGLE_CLOUD_PROJECT` を設定せずに `OTEL_ENABLED=1` にすると、スパンはエクスポート
されずコンソールに出力される。
