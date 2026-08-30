# OKF v0.2 (Open Knowledge Format) — 共通ガイド

正典仕様: `references/SPEC.md`（GoogleCloudPlatform/open-knowledge-format の SPEC.md 全文）。
迷ったら SPEC.md の該当 § を読む。ここは要約とこのプロジェクト固有の適用ルール。

## 1. 形式の最小要件（§4, §11）

- 1 概念 = 1 つの UTF-8 Markdown ファイル。先頭に `---` で囲んだ YAML frontmatter。
- 必須キーは **`type` のみ**。推奨: `title`, `description`, `resource`, `tags`。
- 予約ファイル名 `index.md`（一覧、frontmatter なし。bundle root のみ `okf_version: "0.2"` 可）と `log.md`（更新履歴、新しい順、`## YYYY-MM-DD` 見出し）。
- 未知の `type` / 未知キー / リンク切れで **拒否してはならない**（consumer 側 MUST NOT reject）。
- 概念間リンクは通常の Markdown リンク。bundle ルート相対 `/tables/orders.md` 形式を推奨。

## 2. Trust 系フィールド（§5）— v0.2 の本体

```yaml
sources: # 来歴 (provenance)
  - id: pii-policy # 本文の footnote [^pii-policy] と結合するキー
    resource: /policies/pii-masking.md # 必須。URL / bundle 相対パス / スコープ記述
    title: PII masking policy
    author: human:kei # 信頼性シグナル（任意）
    usage_count: 120
    last_modified: 2026-08-20T00:00:00Z
usage_window: { from: 2026-08-01T00:00:00Z, to: 2026-08-24T00:00:00Z }
generated: { by: synthesis_agent/0.1.0, at: 2026-08-24T10:00:00Z } # 誰が書いたか
verified: # 誰が確認したか（生成者と別に持つ）
  - { by: process:leak-check@a1b2c3d4e5f6, at: 2026-08-24T10:00:03Z }
  - { by: human:kei, at: 2026-08-24T11:00:00Z } # 認証済みレビュアーが居る consumer のみ
status: stable # draft | stable | deprecated（省略時 stable）
stale_after: 2026-08-25T10:00:00Z # 絶対時刻。TTL ではない
```

- タイムスタンプは **UTC オフセット付き ISO 8601**（例 `2026-08-24T10:00:00Z`）。
- **Actor 規約（§7）**: エージェント/ツールは `<producer>/<version>`、人は `human:<id>`、自動処理は `process:<id>`。trust tier 判定は `human:` プレフィックスで行うので厳守。
- **Trust tier（§5.3）**: `verified` なし ⇒ _unverified_、非 human のみ ⇒ _machine-confirmed_、`human:` を含む ⇒ _human-reviewed_。tier は保存せず **導出する**（スコアを保存しない）。
- `verified` は単一 mapping も可。consumer は 1 要素リストとして扱う。
- **壊れたメタデータは fail-closed に扱う。** `by` が文字列でないエントリは「誰も検証していない」ので tier に数えない（`verified: [{}]` は _unverified_）。`stale_after` が無い／読めない場合の鮮度は `fresh` ではなく **`unknown`**。ただし §11 に従い、壊れた値そのものはドキュメント内に保持する。
- 本文の個別主張の出典は footnote `[^<sources.id>]` で付ける。位置インデックスは使わない。

## 3. Attested Computation（§10）

「値が決められた方法で計算されたか」を機械的に確認する概念。`type: Attested Computation` の独立ドキュメントとし、利用側の概念からリンクする。

```yaml
type: Attested Computation
runtime: typescript # 必須。bigquery | postgres | dbt | python | typescript | ...
parameters:
  - { name: request_id, type: string, required: true }
  - { name: masked_prompt, type: string, required: true }
  - { name: response, type: string, required: true }
computation: references/computations/leak_check.ts # 省略時は本文 `# Computation` のフェンス
executor:
  resource: references/skills/run-leak-check.md # 実行手順 or コード
  # 実行が返さねばならない証拠。attester が要求するフィールドと**同一**にする
  receipt: [request_id, masked_prompt_hash, response_hash, findings, response]
attester:
  resource: references/attesters/leak_check.ts # 決定的（LLM 不使用）な検証コード
```

- エージェントは **parameters の値だけ** 渡せる。computation 本体を書き換えてはならない。
- `executor.receipt` の宣言と attester が実際に要求するフィールドは **一致させる**。宣言外のフィールドを要求する attester は第三者が実行できず、attestation として成立しない。
- `attester.resource` は **必ず解決できる場所** に置く。リンク切れは §11 上許容だが、実行できない Attested Computation は証拠にならない。
- receipt / verdict は **bundle に保存しない**（実行時アーティファクト）。
- `verified`（定義がポリシーに合うか、文書単位・低頻度）と attestation（1 回の実行が正しいか、毎回）は別物。両方必要。
- 失敗した attestation は **黙って落とさず表示する**（§10.5, §11）。

## 4. このプロジェクトでの適用ルール

- リポジトリの知識バンドルは `knowledge/`（bundle root に `index.md` + `okf_version: "0.2"`、`log.md`）。
  - `policies/` … PII マスキング方針など（`author: human:...` で human-reviewed に）
  - `computations/` … `leak-check.md` 等の Attested Computation
  - `references/attesters/` … 決定的な attester（regex のみ、LLM 禁止、`verify(receipt) -> dict` を公開）
  - `references/skills/` … executor の実行手順
- **Synthesis Agent の最終出力は OKF 概念ドキュメント**（`type: Gateway Answer`）として組み立て、Firestore に保存し UI/API で返す。**本文に入れるのはマスク済みの答え**。再水和済みの答えは 1 回の API レスポンスで返すだけで、どこにも保存しない。
  - `generated.by` = **Synthesis Agent**（例 `synthesis_agent/0.1.0`）。概念を組み立てたのは Synthesis であり、§7 は「書いた者」に帰属させる。Core は書き手ではなく来歴。
  - `sources` = `masked-prompt`（`/requests/<request_id>/masked-prompt.md`）、`core-response`（`/requests/<request_id>/core-response.md`、`author: core_agent/<model>`）、`pii-policy`。**前 2 つは Gateway が実際に配信する**（リンク切れの provenance は再現できない）。**生 PII を sources や本文に書かない**。
  - `verified[]` = `process:leak-check@<attester sha256 先頭>` ⇒ machine-confirmed。**LLM の actor を書かない**: 合否を決めるのは TypeScript の regex コードで、Gemma は助言に過ぎない。
  - **`human:` actor をこのプロダクトが作ることはない。** 公開 Gateway は誰も認証していないため、承認クリックから作った `human:<id>` は「誰でもない人」の主張になる。tier 導出自体は汎用機能としてライブラリに残す（他の consumer には認証済みレビュアーが居るため）。
  - トップレベルに `attestation:` ブロックを置く: `computation`, `computation_sha256`, `attester_sha256`, `masked_prompt_sha256`, `core_response_sha256`, `verdict`, `checked_at`, `request_id`, `trace_id`, `withheld`、該当時は `custom_terms: {count: N}`。これが `just verify-answer <request_id>` での再現を可能にする。**`custom_terms` は件数のみ**とする: ユーザー定義の秘匿語句（`mask_terms`）はその性質上機密であり、語句そのものはもちろん、ダイジェストも書かない（推測可能な小さい空間から選ばれるためハッシュは確認オラクルになる）。
  - `stale_after` = Token Vault の有効期限と一致させる。
  - `status: draft` は検査失敗時。失敗理由を本文 `# Attestation` に残し、`verified` は省略する。**失敗時は答えを返さない**（再水和しない）。
- UI では 4 つの次元を **別々に** 表示する: ポリシー判定 / 文書ステータス / 鮮度 / レビュー主体（常に `none`）。1 つの tier バッジに潰さない。tier 自体は `verified` から **導出して** 表示する。
- OKF ドキュメントを書く/読むコードは `packages/common/src/okf.ts` に集約（frontmatter の parse/dump、tier 導出、staleness 判定）。未知キーは round-trip で保持する。frontmatter の zod スキーマ（`GatewayAnswerFrontmatterSchema`、未知キーは passthrough）は `packages/common/src/schema.ts` にあり、web UI もこれを共有する。
- 決定的な attester は `packages/common/src/attesters/leak_check.ts`（`@privacy-gateway/common/attesters/leak-check` として公開）。bundle には `knowledge/references/attesters/leak_check.ts` として **バイト単位で同一のコピー** を置き、`attester.resource` はそれを指す。コピーを置く理由は、`attester.resource` が解決できない bundle は審査者が実行できず attestation にならないため。乖離は `packages/common/test/attester_bundle.test.ts` が SHA-256 の一致で防ぐ。
- `executor.receipt` の宣言と `verify()` が要求するフィールドは **同一の 5 つ** にする（`request_id`, `masked_prompt_hash`, `response_hash`, `findings`, `response`）。attester が `RECEIPT_FIELDS` として export し、テストで一致を保証する。宣言外のフィールドを要求する attester は第三者に実行できない。
- README / ARCHITECTURE で OKF に触れる際は「v0.2」「trust signals」「Attested Computation」の語を正確に使い、spec URL `https://github.com/GoogleCloudPlatform/open-knowledge-format` を参照する。

## 5. 参考ファイル（`references/`）

- `SPEC.md` — 仕様全文
- `example_attested_computation.md` — Attested Computation の実例
- `example_attester.py` — 決定的 attester の実例
- `example_log.md` — log.md の実例
