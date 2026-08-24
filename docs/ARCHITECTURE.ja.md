# Privacy-Preserving Multi-Agent Gateway — アーキテクチャ

ハッカソン: All Things Agentic Hackathon (Devpost) — カテゴリ: **Fortified Enterprise Fleet**
（_Best Architectural Design_ も狙う）。締切: 2026-08-31 17:00 PDT。

英語版（正）は [ARCHITECTURE.md](./ARCHITECTURE.md)。デプロイ手順は
[DEPLOY.ja.md](./DEPLOY.ja.md)。

## 1. 課題

企業はフロンティアモデル（Gemini）の推論能力を使いたいが、生の PII やシークレットを
信頼境界の外に出すわけにはいかない。本システムは、商用 LLM には*トークン化された*
データだけを推論させ、機微なマッピングは境界から一歩も出ないオープンモデル（Gemma）に
持たせる。

## 2. エージェント構成（すべて Google ADK、A2A で接続）

| エージェント        | モデル                  | ランタイム          | 責務                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------- | ----------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Gateway Agent**   | Gemma 3（自前ホスト）   | Cloud Run           | ADK TypeScript。ユーザーのリクエストを受ける。PII / シークレットを検出し（ハイブリッド: 決定的な正規表現 + Gemma によるスパン抽出）、安定したトークン `⟦PERSON_1⟧` `⟦EMAIL_1⟧` `⟦SECRET_1⟧` に置換する。マッピングを **Token Vault**（Firestore、セッション単位、TTL 付き）へ保存。*マスク済み*プロンプトを A2A で Core へ転送する。デモ UI と HTTP API を同一オリジンで配信する。                                                                     |
| **Core Agent**      | Gemini 3.5（Vertex AI） | Cloud Run           | マスク済み入力に対する純粋な推論 / プランニング / コード生成。ADK TypeScript（`@google/adk`）を `toA2a` で提供し、Agent Card は `/.well-known/agent-card.json`、RPC は `/jsonrpc` と `/rest`。モデル ID は `GEMINI_MODEL`（既定 `gemini-3.5-flash`、Vertex AI で疎通確認済み）。受信ガードが生の PII を含むペイロードを拒否する。Vault への依存を**持たない** — 規約としてではなく、Vault に到達しうる依存をパッケージが一切持たないという構造による。 |
| **Synthesis Agent** | Gemma 3（自前ホスト）   | Cloud Run           | ADK TypeScript。`toA2a` と HTTP の両方で公開。Core の出力を受け取る。(a) **リークチェック**: 応答に生の PII が含まれないことを検証（正規表現 + Gemma によるジャッジ）。(b) **リハイドレート**: Vault を使ってトークンを元の値へ戻す。(c) **整合性チェック**: プロンプトに無いプレースホルダを Core が捏造していないかを決定的に検証。最終回答と監査レコードを生成する。                                                                                |
| **Gemma Serving**   | Ollama 上の gemma3      | Cloud Run（GPU L4） | Gateway / Synthesis が `OllamaLlm`（`ollama/*` モデル名に登録した ADK `BaseLlm` アダプタ）経由で利用する OpenAI 互換エンドポイント。Ingress は internal のみ。                                                                                                                                                                                                                                                                                         |

信頼境界: `Gateway` / `Synthesis` / `Gemma Serving` / `Firestore` が**内側**。
`Core` へ渡るのはマスク済みテキストのみ（したがって Gemini へ渡るのもマスク済みのみ）。
これは構造的に強制される。すなわち Core のサービスアカウントは Firestore ロールを持たず、
かつ Core 宛の A2A メッセージは送出前に PII スキャナで検証される（多層防御）。

## 3. フロー

```
User ──HTTP──▶ Gateway (Gemma)
                 │ 1. 検出 + トークン化  ──▶ Firestore Token Vault (session_id → {token: value})
                 │ 2. マスク済みプロンプト
                 ▼ A2A
               Core (Gemini 3.5)  — トークン上での推論 / プランニング / コード生成
                 │ マスク済み回答
                 ▼ A2A
               Synthesis (Gemma)
                 │ 3. リークチェック  4. Vault からリハイドレート  5. 整合性検証
                 ▼
               User  （最終回答 + 監査証跡: 何をマスクし、何を検証したか）
```

## 4. Fortified Enterprise Fleet への対応

- **Registry**: サービスごとの A2A Agent Card（`/.well-known/agent-card.json` — `@a2a-js/sdk`
  0.3.x が `AGENT_CARD_PATH` として公開する標準パス）。Gateway は
  Core / Synthesis を card URL（環境変数で設定）から発見する。
- **Runtime**: エージェントごとの ADK `Runner` を、ADK の A2A サーバが Cloud Run 上で提供する。
- **Memory**: Firestore — Token Vault（短命、TTL ポリシー付き）と監査ログ（追記のみ）。
- **Security**: IAM のみによるサービス間認証（Cloud Run invoker + ID token）、最小権限の SA、
  Gemma エンドポイントは internal ingress、ログに PII を残さない（構造化ログはマスク済み）。
- **Observability**: Cloud Logging の構造化ログ（1 行 1 JSON）に `request_id` `session_id` と
  Cloud Trace 連携フィールドを含める。エージェントホップごとに OpenTelemetry スパンを張り、
  `traceparent` の伝搬で 1 本のトレースに統合する。リクエスト単位の監査レコード（マスク件数、
  リークチェック判定、ホップごとのレイテンシ）。イベント名・エラーコード・スパンツリーの正典は
  [OBSERVABILITY.ja.md](OBSERVABILITY.ja.md)。`request_id` は UUIDv7 で、UI と API の双方が表示する。

## 5. リポジトリ構成

単一の pnpm ワークスペース。全エージェントが ADK TypeScript。

```
packages/
  common/        # トークナイザ、vault、OKF、ガード、ロギング、テレメトリ、
                 # zod スキーマ、A2A クライアント、OllamaLlm、OKF バンドルのアテスター
agents/
  gateway/       # ADK エージェント + HTTP エントリ + web UI 配信、Dockerfile
  core/          # ADK エージェント（Gemini）+ A2A サーバ、Dockerfile
  synthesis/     # ADK エージェント + A2A サーバ + HTTP ルート、Dockerfile
clients/python/  # pgw.py — 単一ファイルの PEP 723 クライアント（言語非依存の実例）
serving/gemma/   # Cloud Run GPU 用の Ollama Dockerfile
web/             # デモ UI（マスク済みと最終結果を並べて表示）+ Playwright スペック
knowledge/       # OKF v0.2 バンドル（ポリシー、計算、executor、attester）
infra/           # デプロイスクリプト（gcloud）、IAM、Firestore TTL
docs/            # ARCHITECTURE.md、OBSERVABILITY.md、DEPLOY.md、構成図
justfile         # dev / test / deploy タスク
```

`packages/common` はサブパス export により依存グラフで境界を強制する。Core が
import するのは `/logging` `/config` `/schema` `/telemetry` のみで、いずれも vault に
到達しない。Gateway と Synthesis はパッケージのエントリポイントを import する。

## 6. 主要な設計判断（Why not）

- **なぜ Gemini API 経由の Gemma にしないのか？** 境界の外に出てしまい、本システムの意義が
  失われるから。Cloud Run GPU で自前ホストする。ローカル開発では同じ OpenAI 互換
  インターフェースを持つローカル Ollama を使う。
- **なぜ検出を正規表現 + Gemma のハイブリッドにするのか？** 正規表現は構造化された PII
  （メール、電話番号、カード番号、API キー）に対して決定的で監査可能なカバレッジを与える。
  Gemma は非構造なエンティティ（氏名、住所）を拾う。Gemini が `⟦PERSON_1⟧` について
  一貫して推論できるよう、トークンはセッション内で安定している必要がある。
- **なぜ Gateway でリハイドレートせず、Synthesis を別エージェントにするのか？** 職掌分離。
  *出力*の安全性を検証するエージェントは、*入力*のマスキングを決めた主体と同じであるべきでは
  ない。加えて、これによりリークチェックが全応答に対する独立したゲートになる。
- **なぜプロセス内サブエージェントではなく A2A なのか？** 境界こそがプロダクトだから。
  IAM アイデンティティを分けた別サービスにすることで、「Core は Vault を読めない」が
  コード上の規約ではなくデプロイ可能な保証になる。

## 7. デモシナリオ（4 分以内の動画）

氏名・メール・電話番号・クレジットカード番号・API キーを含むカスタマーサポートのメール →
「返信文と、この顧客のレコードを更新する Python スクリプトを書いて」と依頼する。
見せるもの: Gemini に送られたマスク済みプロンプト、Gemini のトークン化された出力、
リークチェックの通過、リハイドレートされた最終回答、監査レコード、Cloud Run コンソール。

## 8. 知識と信頼のシグナル: Open Knowledge Format (OKF v0.2)

このフリートが生成する回答はすべて*エージェントが書いたコンテンツ*である。各出力について
来歴・信頼・鮮度・ライフサイクル・アテステーションを第一級の概念として扱うため、
[OKF v0.2](https://github.com/GoogleCloudPlatform/open-knowledge-format) を採用する。

- **バンドル** `knowledge/`（リポジトリ内）: `policies/pii-masking.md`（人間が執筆、`human:` で検証済み）、
  `computations/leak-check.md`（`type: Attested Computation`、`runtime: typescript`、
  決定的なアテスター `references/attesters/leak_check.ts`、レシート `[session_id, response_hash, findings]`）。
- **リクエストごとの出力**（Synthesis Agent → Firestore → UI）: `type: Gateway Answer` の OKF コンセプト。
  `generated.by: core_agent/gemini-3.5-*`、リークチェックのアテステーションが通れば
  `verified: [{by: synthesis_agent/gemma-3}]`（⇒ _machine-confirmed_）、UI での承認後に任意で
  `human:<id>`（⇒ _human-reviewed_）、`sources` はマスク済みプロンプトとポリシーを指し、
  `stale_after` は Vault の失効時刻、失敗時は `status: draft`。
- UI は信頼ティアを導出して表示する。アテステーションの失敗は必ず表面化させ、握りつぶさない。
- **なぜ場当たり的な JSON 監査レコードではなく OKF なのか**: 監査証跡が、ポータブルで差分が取れ、
  人間が読めるバンドルになるから。任意の OKF コンシューマ（Knowledge Catalog、エージェント、
  `cat`）が読める。エージェント出力への信頼こそがプロダクトである以上、その信頼の記録もまた
  標準であるべきだ。

本リポジトリで OKF を書く際のエージェント向けガイダンスは `skills/okf/` にある
（`.claude/skills/okf` と `.codex/skills/okf` で共有）。
