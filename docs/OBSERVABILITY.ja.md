# オブザーバビリティ

1 リクエストをフリート全体で追跡する方法と、ログイベント・エラーコードの正典。
エージェント向けの調査手順は `skills/pgw-logs/LOGS.md`。本書はその両者が参照する
語彙の定義元。

English version: [OBSERVABILITY.md](OBSERVABILITY.md).

## 1. 2 つの識別子

| 識別子       | 由来                                                           | 出現箇所                                                               |
| ------------ | -------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `request_id` | Gateway がリクエストごとに 1 つ発行する UUIDv7                 | 全ログ行、`X-Request-ID` レスポンスヘッダ、API ボディ、OKF frontmatter |
| `trace_id`   | W3C `traceparent`、または Cloud Run の `X-Cloud-Trace-Context` | 全ログ行、API ボディ、OKF frontmatter、Cloud Trace                     |

`request_id` は **UUIDv7**。先頭 48 bit がミリ秒タイムスタンプなので、ID でソート
すると時刻順にもなる。常に Gateway がサーバー側で発行し、そのまま Token Vault の
キーとして使う。受信した `X-Request-ID` ヘッダは相関のためにレスポンスへエコー
バックされるが、そのリクエスト自身の ID として**採用されることは決してない**:
この ID は Vault のキーであり、任意の値を選べる呼び出し元は他人のリクエストの
マッピングを名指しし、そのプレースホルダを読み戻せてしまう。このシステムに
`session_id` は一切存在しない — セッションが完全に廃止された理由は
`ARCHITECTURE.ja.md` §2 を参照。

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

1. **まず `request_id`。** 1 クエリで 3 サービス全ログが時系列で返る。このシステムに
   相関 ID はこれしか無いので、複数リクエストへ検索を広げる先も存在しない。
2. **レイテンシは `trace_id`。** どのホップが遅く、その内訳がどこかを見る。

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

### 再帰的スクラビングではなく型付き allowlist

ログフィールドは（`packages/common/src/logging.ts` の）**型付き allowlist** で
フィルタされる。以前の設計はトークナイザ自身の正規表現をログ値にも適用していたが、
その正規表現は氏名や住所を一切検出できない（それは上流の Gemma の役割）ため、
例外メッセージやレスポンスボディの断片がマスクされないままログ行に紛れ込む
可能性があった。代わりに allowlist は、ログ行が持ちうるすべてのフィールドと、
それが強制される形状を列挙する。リストに無いものは**すべて破棄**され、破棄された
キーの*名前*（値ではない）が `dropped_fields` に記録される。allowlist への追記を
忘れた開発者は、ログ行がひっそり欠落するのではなく、目に見えるギャップとして
気づける。

| フィールド種別 | 意味                                                                   | 例                                                                                                                                                                                                                                                                                          |
| -------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`           | サーバー側で発行される内部 UUID / span・trace ID                       | `request_id`, `trace_id`, `span_id`                                                                                                                                                                                                                                                         |
| `enum`         | コード中の閉じた集合から選ばれる値                                     | `agent`, `event`, `severity`, `model`, `status`, `verdict`, `trust_tier`, `document_status`, `freshness`, `hop`, `path`, `method`, `error_code`, `error_class`, `refusal`, `vault_backend`, `time`                                                                                          |
| `number`       | 有限の数値                                                             | `duration_ms`, `attempt`, `port`, `placeholder_count`, `masked_count`, `unstructured_spans`, `span_count`, `tokens_resolved`, `tokens_unknown`, `withheld_count`, `vault_generation`, `body_bytes`, `finding_count`, `text_length`, `tokens_withheld`, `term_count`, `surviving_term_count` |
| `boolean`      | true/false                                                             | `ok`, `leak`, `stale`                                                                                                                                                                                                                                                                       |
| `string_list`  | 短い文字列の配列。各要素は 128 文字に切り詰め                          | `finding_kinds`, `categories`, `findings`, `withheld`, `unresolved_tokens`, `invented_tokens`, `issues`                                                                                                                                                                                     |
| `count_map`    | `{カテゴリ: 件数}` の object                                           | `counts_by_category`                                                                                                                                                                                                                                                                        |
| `hash`         | 16 進ダイジェスト。`enum` と同様に扱う（切り詰めるだけでパースしない） | `response_hash`, `masked_prompt_hash`, `attester_sha256`, `computation_sha256`                                                                                                                                                                                                              |

呼び出し元が制御しうる値が到達しうるもの — プロンプト、レスポンスの断片、例外
メッセージ、ヘッダ値 — はすべて allowlist に無く、破棄される。「呼び出し元由来の
自由文字列」用のフィールドは存在しない。リストは設計上クローズドである。

| フィールド                      | 常時       | 意味                                                 |
| ------------------------------- | ---------- | ---------------------------------------------------- |
| `severity`                      | ○          | `DEBUG` / `INFO` / `WARNING` / `ERROR`               |
| `message`                       | ○          | 可読テキスト。イベント時は `event` と同値            |
| `time`                          | ○          | ISO 8601 UTC                                         |
| `agent`                         | ○          | `gateway` / `core` / `synthesis`                     |
| `event`                         | イベント時 | §4 の安定識別子                                      |
| `request_id`                    | ほぼ常時   | 相関 ID                                              |
| `trace_id`, `span_id`           | トレース時 | 生の ID（ローカル用）                                |
| `logging.googleapis.com/trace`  | GCP 上     | `projects/<project>/traces/<trace_id>`               |
| `logging.googleapis.com/spanId` | GCP 上     | 行とスパンを相互リンク                               |
| `duration_ms`                   | 計測時     | 経過ミリ秒                                           |
| `error_code`, `error_class`     | エラー時   | §6 参照。**`error_message` は決して無い** — 下記参照 |
| `dropped_fields`                | 必要時     | 破棄されたキーの*名前*（値ではない）                 |

**生 PII は決して出ない — マスクされたからではなく、そもそも allowlist に無いから
である。** ID 系のキー（`request_id`, `trace_id`, `verdict`, `trust_tier`, `status`,
`model` など）はマスクしない — マスクすると相関が取れなくなる上、これらはサーバー
側で発行されるか閉じた enum から選ばれるため、構造的に PII を含みえない。
**ログに生 PII があればそれ自体がバグ。報告すること。**

### `error_class` / `error_code` のみ、`error_message` は決して無い

`errorFields()`（`packages/common/src/logging.ts`）が出力するのは `error_class`
（例外のコンストラクタ名）と `error_code`（安定したコード、既定はクラス名）で、
**`error_message` は意図的に一切出力しない**。例外メッセージはそれを引き起こした
値 — レスポンスボディ、プロンプトの断片、ヘッダ — を日常的に埋め込んでおり、
マスキングでは氏名や住所を確実に捕捉できない。クラス、コード、そして行を
リクエスト全体に紐づける `request_id` があれば throw の発生箇所を特定するには
十分である。

同じ規則がスパンにも適用される: `withSpan()`（`packages/common/src/telemetry.ts`）
は失敗時に `error.class` と `error.code` をスパン属性として記録し、**このコード
ベースのどこでも `span.recordException()` は使われていない** — これは
`exception.message` と `exception.stacktrace` をそのままスパンにコピーしてしまい、
まさにこの設計が避けようとしているリークそのものだからだ。

## 4. イベント語彙

イベント名は安定識別子。クエリとダッシュボードが依存している。

### Gateway

| event                    | severity      | 意味 / 確認事項                                                                                                                                                                                        |
| ------------------------ | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `request.start`          | INFO          | エンベロープ開始。`method`, `path`                                                                                                                                                                     |
| `request.end`            | INFO          | エンベロープ終了。`duration_ms`, `document_status`, `trust_tier`                                                                                                                                       |
| `mask.done`              | INFO          | `placeholder_count`, `counts_by_category`, `unstructured_spans`, `vault_generation`, `term_count`。PII を含む入力で 0 なら検出器の退行。`term_count` は指定された秘匿語句の件数のみで、内容は載らない  |
| `mask.gemma.unparseable` | INFO/WARNING  | Gemma のスパン JSON を利用できず 1 回リトライ。恒常的なら JSON モードかモデル未取得                                                                                                                    |
| `mask.gemma.failed`      | ERROR         | スパン抽出時に Gemma へ到達不能。以前は regex のみへ縮退していたが、今は**リクエストそのものを失敗させる**（`502 extraction_unavailable`）— 正規表現だけでは氏名や住所を一切検出できないため           |
| `guard.egress.blocked`   | ERROR         | 生 PII が境界を越えかけたので拒否。**正しい挙動** — `categories` を確認                                                                                                                                |
| `a2a.core.send`          | INFO          | Core 往復の開始                                                                                                                                                                                        |
| `a2a.core.recv`          | INFO          | Core 応答。`duration_ms`, `status`                                                                                                                                                                     |
| `request.refused`        | WARNING/ERROR | いずれかのゲートがリクエストを拒否した。`refusal` がどのゲートかを示す（`reserved_syntax`、`egress_guard`、`extraction_failed`、または Synthesis から中継された `RefusalKind`）。該当時は `categories` |
| `request.rate_limited`   | WARNING       | IP 単位のデモ用レート制限超過。`429`                                                                                                                                                                   |
| `warmup.requested`       | INFO          | `POST /v1/warmup` が GPU 版 Gemma サービスへ起動要求を送出した。**課金される**: インスタンスはアイドルアウト（約 15 分）まで課金対象。標準の envelope 以外のフィールドは持たない                       |
| `request.failed`         | ERROR         | 5xx。`error_class`, `error_code`（`error_message` は無い）                                                                                                                                             |
| `auth.id_token.failed`   | ERROR         | Gateway が下流呼び出し用の ID token を取得できなかった。デプロイ / 認証情報側の障害であり 502 として報告される                                                                                         |
| `server.start`           | INFO          | 起動。モデル ID、vault バックエンド、`trace_id`                                                                                                                                                        |

OpenAI 互換ファサード（`POST /v1/chat/completions`）は同じパイプラインを実行する
ため、`/v1/ask` と同じ `request.*` / `mask.*` / `guard.*` / `a2a.*` イベントを出力
する。以下の 4 つが互換面を識別する追加イベントである:

| event                         | severity | 意味 / 確認事項                                                                                                                                                                      |
| ----------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `openai.compat.chat.start`    | INFO     | 互換リクエストを受理。`ok` は stream 要求の有無を表す。メッセージ本文は決して出力しない                                                                                              |
| `openai.compat.chat.end`      | INFO     | 互換レスポンスを整形した。`document_status`, `trust_tier`                                                                                                                            |
| `openai.compat.chat.refused`  | ERROR    | ゲートが拒否した。`error_code`, `categories`。status は `/v1/ask` と同一であり、ファサードが緩めることはない                                                                         |
| `openai.compat.chat.rejected` | WARNING  | パイプライン実行前にボディ検証で失敗。`error_code` は `invalid_request`、`empty_prompt`、`multimodal_unsupported`（テキスト以外のコンテンツパート — 何も送信されていない）のいずれか |

`approve.done` イベントは存在しない: このシステムに人間による承認は無い
（`ARCHITECTURE.ja.md` §2 参照）。

### Core

| event                   | severity | 意味                                                                            |
| ----------------------- | -------- | ------------------------------------------------------------------------------- |
| `a2a.receive`           | INFO     | A2A リクエストを受理。`placeholder_count`, `text_length`, `path`                |
| `guard.inbound.blocked` | ERROR    | ペイロードに生 PII。`finding_kinds`, `finding_count`, `path` のみで値は出さない |
| `server.start`          | INFO     | 起動。モデル ID、Vertex AI 設定、Agent Card パス                                |

Gemini 呼び出し自体は `llm.gemini` スパン（§5 参照）でカバーされる。独立した
`llm.gemini.call` ログイベントは無い — モデル ID のみを属性に持つそのスパンが
記録そのものである。

### Synthesis

| event                                              | severity     | 意味 / 確認事項                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| -------------------------------------------------- | ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `attest.verdict`                                   | INFO         | `verdict: pass\|fail`, `findings`（カテゴリのみ、値は出さない）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `judge.gemma`                                      | INFO/WARNING | Gemma の助言的判定。`leak`（真偽値または欠落）。トランスポート障害やパース失敗は「有効な判定なし」として扱われ、`leak: true` と同様にリリースをブロックする — リリースを信頼する方向にフォールバックすることは決してない                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `judge.retry`                                      | INFO         | 最初の判定が、決定的 attester 済みのボディに対し根拠カテゴリを挙げずに leak を主張したため、カテゴリを補うためだけにジャッジをもう 1 回呼んだ。2 回目の `leak` 値は捨てるので、このイベントの後にリリースが続くことはない。`verdict` は 2 回目の答えだが、採用するのはカテゴリのみ。`categories` は 2 回目が名指ししたカテゴリで、この呼び出しの目的そのものである。既に根拠カテゴリを挙げている flag は再実行しない                                                                                                                                                                                                                                       |
| `release.refused`                                  | ERROR        | いずれかのゲートがリリースを拒否した。`refusal` は `vault_missing`、`vault_expired`、`vault_generation_mismatch`、`invented_token`、`leak_check_failed`、`judge_flagged`、`judge_unavailable`、`unresolved_token`、`rehydration_incomplete` のいずれか。`rehydration_incomplete` の場合はどの検査が破れたかを示す `error_code`（診断用前段の `leftover_token` / `missing_withheld` / `substitution_mismatch`、または決定的な位置的再構築の `rebuild_mismatch`）と、該当するトークン**名**も載る — 値は決して載らず、カテゴリも載らない。`rebuild_mismatch` の token list は**空**である。差分は 2 つの文字列全体の間にあり、そのどちらも引用できないからだ |
| `release.ok`                                       | INFO         | リハイドレート後の完全性検証を含むすべてのゲートを通過してリリースされた。`tokens_resolved`, `withheld_count`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `okf.persist`                                      | INFO         | マスク済み証跡ドキュメントの Firestore 書き込み（リリース時・拒否時のいずれでも常に実行）。`document_status`, `verdict`。権限エラーは `sa-synthesis` に `roles/datastore.user` が必要                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `okf.persist.failed`                               | ERROR        | 拒否後の証跡ドキュメント永続化に失敗。`refusal` が元の拒否種別を示す                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `request.start` / `request.end` / `request.failed` | —            | Gateway と同じ                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `request.refused`                                  | ERROR        | HTTP 層が `ReleaseRefusedError` をレスポンスへ変換。`refusal`, `categories`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |

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

`llm.gemini` は空約束ではなく実在するスパンである: Core エージェントが ADK の
`beforeModelCallback` で開始し `afterModelCallback` で終了する（この間の呼び出しは
ADK が握っているため `withSpan` でラップできる関数が無い）。属性はモデル ID の
みで、**それ以外は一切持たない**。本書の以前の版はコードが実装する前からこの
スパンを約束していたが、現在は `agents/core/src/agent.ts` に実装されている。

スパン属性は件数・判定・識別子のみ（`placeholder_count`, `tokens_unknown`,
`verdict`, `trust_tier`, `request_id`）。**PII の値は決して入れない。** 失敗時
スパンは `error.class` と、あれば `error.code` 属性を記録する。
`span.recordException()` は決して呼ばない（§3 参照）。

伝搬: Gateway は Core への A2A 呼び出しと Synthesis への HTTP 呼び出しの双方に
`traceparent` を注入する。Cloud Run では W3C ヘッダが無い場合 `X-Cloud-Trace-Context`
を traceparent に変換するので、ロードバランサ経由で入ったリクエストも 1 本の
トレースに繋がる。Cloud Trace でホップが欠けていれば、そのホップの伝搬が切れて
いる。`OTEL_ENABLED` を確認し、そのサービスのログに `otel.export.error` が無いか
見る。

E2E テストがこれを検証している: 全ホップで trace_id が同一で、子スパンが `request`
を親に持つこと（`agents/gateway/test/e2e.test.ts`）。ただしこのテストは実プロセス
境界を越えて**いない**: Core と Gemma エンドポイントは `fetch` 層でモックされ、
Synthesis はインメモリ Vault に対してプロセス内で実行される。したがってこの
スパンツリーは構造として正しくても、実際にマルチサービスでデプロイされている
ことの証拠ではない。

## 6. エラーコード

| `error_code`                | HTTP | 意味                                                                                 | 最初に見る場所                                     |
| --------------------------- | ---- | ------------------------------------------------------------------------------------ | -------------------------------------------------- |
| `invalid_request`           | 400  | ボディが zod スキーマ検証に失敗（`session_id` の混入を含む）                         | `message` が該当キーを示す                         |
| `reserved_syntax`           | 400  | 生入力に予約構文 `⟦…⟧` が含まれていた                                                | `refusal: reserved_syntax` の `request.refused`    |
| `extraction_unavailable`    | 502  | Gemma のスパン抽出が利用不能または到達不能。Core は未呼び出し                        | `mask.gemma.unparseable` / `mask.gemma.failed`     |
| `outbound_guard_refused`    | 422  | マスク後も生 PII が残存。Core は未呼び出し                                           | `guard.egress.blocked` と `categories`             |
| `vault_missing`             | 409  | その `request_id` に有効なトークンマッピングが無い                                   | `refusal: vault_missing` の `release.refused`      |
| `vault_expired`             | 410  | マッピングは存在したが TTL を過ぎた                                                  | `refusal: vault_expired` の `release.refused`      |
| `vault_generation_mismatch` | 409  | このリクエストのマスク後にマッピングの generation が変わった                         | `release.refused`, `vault_generation`              |
| `invented_token`            | 409  | Core がプロンプトに無いプレースホルダを使った                                        | `release.refused`, `invented_tokens`               |
| `leak_check_failed`         | 422  | 決定的リークチェックが Core の応答中に生 PII を検出                                  | `attest.verdict`, `findings`                       |
| `judge_flagged`             | 422  | Gemma ジャッジが `leak: true` を返した                                               | `judge.gemma`                                      |
| `judge_unavailable`         | 422  | Gemma ジャッジに有効な判定が無かった（トランスポート障害・タイムアウト・パース不能） | `judge.gemma`                                      |
| `unresolved_token`          | 409  | 応答が既知のマッピング外のプレースホルダを参照していた                               | `release.refused`, `unresolved_tokens`             |
| `multimodal_unsupported`    | 400  | 互換エンドポイントにテキスト以外のコンテンツパート。何も送信されていない             | `openai.compat.chat.rejected`, `error_code`        |
| `rehydration_incomplete`    | 500  | リハイドレートが開示ポリシーと一致しなかった — 我々のバグ。本文は withheld           | `release.refused` の `error_code` とトークン       |
| `rate_limited`              | 429  | IP 単位のデモ用レート制限超過                                                        | `request.rate_limited`                             |
| `payload_too_large`         | 413  | ボディが `MAX_BODY_BYTES`（64 KB）を超過                                             | —                                                  |
| `deadline_exceeded`         | 504  | エンドツーエンドのデッドライン（`REQUEST_DEADLINE_SECONDS`、60 秒）超過              | `request.failed`                                   |
| `downstream_agent_failed`   | 502  | Core か Synthesis が失敗・到達不能                                                   | 同じ `request_id` でそのサービスのログ             |
| `internal_error`            | 500  | 当該サービス内の未処理エラー                                                         | `request.failed` 行の `error_class` / `error_code` |
| `config.invalid`            | —    | プロセスが起動を拒否                                                                 | ログ行の `issues`                                  |

`unknown session` / 404 のコードは存在しない: セッション参照ルート自体が無い。
`GET /v1/requests/:id`、`GET /v1/requests/:id/masked-prompt.md`、
`GET /v1/requests/:id/core-response.md` は、証跡が失効済みまたは元々存在しない
場合、単純に `404 unknown_request` を返す。

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
