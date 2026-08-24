# Privacy-Preserving Multi-Agent Gateway

_English: [README.md](README.md)_

**All Things Agentic Hackathon** — カテゴリ: _Fortified Enterprise Fleet_（_Best Architectural
Design_ も狙う）。

企業はフロンティアモデルの推論力を使いたいが、生の PII やシークレットを信頼境界の外へ
出すことはできない。このエージェント群は、**Gemini** には _トークン化された_ テキストだけを
推論させ、実値への写像は境界の外に出ない自ホストの **Gemma** 側が保持する。

```
User ──HTTP──▶ Gateway (Gemma)
                 │ 1. 検出 + トークン化 ──▶ Firestore Token Vault (session → {token: value})
                 │ 2. マスク済みプロンプト     (送信直前に egress ガードが再走査)
                 ▼ A2A
               Core (Gemini 3.5)  — プレースホルダのみに対する推論 / 計画 / コード生成
                 │ マスク済み回答
                 ▼ A2A
               Synthesis (Gemma)
                 │ 3. leak check  4. 復元  5. 整合性検証
                 ▼
               User  (OKF 回答ドキュメント + 監査証跡)
```

設計の詳細: **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)**。
デプロイ手順: **[docs/DEPLOY.md](docs/DEPLOY.md)**。
ログ・トレース・エラーコード: **[docs/OBSERVABILITY.ja.md](docs/OBSERVABILITY.ja.md)**。

## 「API 呼び出しの前に正規表現をかける」だけではない理由

- **境界は規約ではなくデプロイ構成で担保される。** Core は独立したサービスで独自の IAM
  アイデンティティを持ち、Firestore のロールを **持たない**。コードがどう書かれていようと
  vault を読めない。
- **境界は依存グラフにも刻まれている。** `packages/common` は subpath exports を公開しており、
  Core が import できるのは `@privacy-gateway/common/{logging,config,schema,telemetry}` だけ
  ——いずれも vault に到達しない。将来 Core から vault を読もうとする変更は、存在しない
  import を足さなければ書けない。
- **独立した 2 つのゲート。** Gateway は送出するプロンプトを決定的な検出器で再走査し、
  マスク漏れが 1 件でもあれば送信を拒否する。Synthesis は復元前に応答を独立に検査する。
- **判定は決定的。** leak check は OKF の _Attested Computation_ であり、attester は応答本文
  から findings を自力で再導出する。過少申告する runner は通らずに落ちる。Gemma judge は
  助言でしかなく、判定を覆さない。
- **信頼は可搬なアーティファクト。** すべての回答は `cat` でき diff できる OKF v0.2
  ドキュメントとして残る。

## 必須技術チェックリスト

| 要件                       | 実装箇所                                                                 |
| -------------------------- | ------------------------------------------------------------------------ |
| **Gemini 3.5 (Vertex AI)** | Core Agent（`agents/core`）。モデル ID は `GEMINI_MODEL` から            |
| **Google ADK**             | 3 エージェントすべて。ADK TypeScript（`@google/adk` 2.0.0）              |
| **A2A**                    | Gateway → Core、Gateway → Synthesis。Agent Card + `message/send`         |
| **Cloud Run**              | エージェントごとに 1 サービス。加えて Gemma を Cloud Run GPU (L4) で提供 |
| **Firestore**              | Token Vault（TTL）と OKF 回答ストア                                      |
| **Gemma（ボーナス）**      | Gateway の span 抽出と Synthesis の judge。Ollama で自ホスト             |

Gateway と Synthesis は **`OllamaLlm`** 経由で Gemma に到達する。これは `packages/common` に
ある独自の ADK `BaseLlm` アダプタで、`ollama/*` にマッチするモデル名として `LLMRegistry` に
登録されている。Ollama の OpenAI 互換 `/v1/chat/completions` を話すため、開発時のローカル
Ollama と本番の Cloud Run GPU を同一のコードパスで扱える。

## リポジトリ構成

pnpm workspace は 1 つ。すべてのエージェントが ADK TypeScript。

```
packages/common/   # tokenizer, vault, OKF, guard, ログ, telemetry, zod スキーマ,
                   # A2A クライアント, OllamaLlm, OKF バンドルの attester
agents/gateway/    # ADK エージェント + HTTP 入口 + web/dist の配信
agents/core/       # ADK エージェント（Gemini）+ A2A サーバ
agents/synthesis/  # ADK エージェント + A2A サーバ + HTTP ルート
clients/python/    # pgw.py — 単一ファイルの PEP 723 クライアント（言語非依存の例）
serving/gemma/     # Cloud Run GPU 用の Ollama Dockerfile
web/               # デモ UI（マスク済みと最終回答の対比）+ Playwright スペック
knowledge/         # OKF v0.2 バンドル: ポリシー、Attested Computation、executor skill
infra/terraform/   # Terraform: Cloud Run、IAM、Firestore TTL、Artifact Registry
```

workspace のパッケージは `web`、`packages/common`、`agents/core`、`agents/gateway`、
`agents/synthesis`。

相対 import は **`.ts` 拡張子**を付けて書く（`import { x } from './x.ts'`）。tsconfig の
`allowImportingTsExtensions` + `rewriteRelativeImportExtensions` で有効化され、ビルド時に
tsc が `.js` へ書き換える。ソースは実在するファイル名をそのまま書けばよく、エディタと
ビルド成果物のあいだで import を頭の中で変換する必要がない。

## すべての境界で zod

HTTP のリクエスト / レスポンスボディ、A2A のペイロード、Gemma の JSON 出力、環境変数の
設定、OKF frontmatter は、いずれも `packages/common` の zod スキーマとして定義されている。
環境変数のスキーマは起動時に検証されるので、不正な値はリクエストの途中で表面化するのでは
なく `config.invalid` のログを出してプロセスを止める。`web` は型を手書きせず、同じスキーマ
から `z.infer` で導出する。レスポンス形状の変更はデモではなく UI の型検査を壊す。

## オブザーバビリティ

各サービスは **構造化 JSON ログ**を 1 行 1 オブジェクトで出力する。これは Cloud Logging が
サイドカーなしで取り込める形式。生の PII がログに乗ることはない。文字列値は tokenizer を
通してから直列化されるので、漏れた値は `⟦EMAIL_1⟧` として現れる。

| シグナル     | 得られるもの                                                                                                                                    |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `request_id` | `X-Request-ID` から取るか Gateway が発行する UUIDv7。Gateway → Core → Synthesis に伝播し、レスポンスに反映され、OKF frontmatter にも保存される  |
| `trace_id`   | 全ホップで W3C `traceparent` を伝播する OpenTelemetry。1 リクエスト = 3 サービスにまたがる 1 トレースで、パイプラインの各ステップが span になる |
| UI           | `request_id` と `trace_id` をコピーボタン付きで表示し、Cloud Logging / Cloud Trace コンソールへの直リンクも出す                                 |

`request_id` は UUIDv7 なので、ログ行をこの ID でソートすれば時刻順にもなる。バグ報告に
どちらか一方の ID が書かれていれば、そのリクエストの全ログ行と全 span を引ける。イベント
語彙・span ツリー・エラーコードの仕様は
**[docs/OBSERVABILITY.ja.md](docs/OBSERVABILITY.ja.md)** にある。

## Open Knowledge Format (OKF v0.2)

このエージェント群が出す回答はすべて「エージェントが書いたコンテンツ」なので、来歴と信頼性を
出力ごとに一級市民として持たせる。
[OKF v0.2](https://github.com/GoogleCloudPlatform/open-knowledge-format) を採用する。

リポジトリの知識バンドルは `knowledge/`:

- `policies/pii-masking.md` — 何をマスクすべきか。`human:kei` が執筆・`verified`。
- `computations/leak-check.md` — `type: Attested Computation`、`runtime: typescript`、
  `executor.receipt: [session_id, response_hash, findings]`、
  `attester.resource: /references/attesters/leak_check.ts`。
- `references/skills/run-leak-check.md` — executor の実行手順。

attester のソースは `packages/common/src/attesters/leak_check.ts` にあり（正規表現のみ、
LLM 不使用、ネットワーク不使用）、`@privacy-gateway/common/attesters/leak-check` として公開
されている。Synthesis はまさにそのモジュールを import するので、バンドルが宣言する attester
と実際に動く attester が乖離しない。もう一方の選択肢——`knowledge/` 配下にスクリプトの複製を
置く——では、認可された計算と実行された計算が黙って食い違い得る。

リクエストごとに `type: Gateway Answer` の概念が生成される。`generated.by` は Core の actor、
attestation に通れば `verified` に `synthesis_agent/<model>` が入り（⇒ _machine-confirmed_）、
UI で人が承認すると `human:<id>` が加わる（⇒ _human-reviewed_）。`sources` はマスク済み
プロンプトとポリシーを指し、`stale_after` は vault の有効期限と一致し、相関用に
`request_id` / `trace_id` も入る。attestation に失敗した場合は `status: draft` とし、
`verified` を付けず、理由を本文 `# Attestation` に残す——握りつぶさず必ず表示する。

trust tier は `verified` から **導出** し、保存しない。サーバ側、UI 側（`web/src/api.ts`）、
さらに Python クライアント側の 3 か所で導出する。

このリポジトリで OKF を書くためのエージェント向けガイドは `skills/okf/` にある。

## ローカルでの起動

前提: [pnpm](https://pnpm.io/)（corepack 経由）、[just](https://just.systems/)、Node.js 22、
Gemma 用の [Ollama](https://ollama.com/)。Python クライアントを動かすなら
[uv](https://docs.astral.sh/uv/)。

```bash
cp .env.example .env       # 編集する
just setup                 # pnpm install
just pull-gemma            # ollama pull gemma3:12b
```

`just dev` は 4 プロセス——Gateway (8081)、Core (8082)、Synthesis (8083)、Vite 開発サーバ
(5173)——を in-memory vault で起動する:

```bash
just dev            # gateway + core + synthesis + web
```

<http://localhost:5173> を開く。Vite が `/v1` と `/healthz` を Gateway に proxy するので、
UI は開発時も本番も同じ相対パスのまま動く。

各サービスは単体でも起動できる:

```bash
just dev-gateway    # ポート 8081
just dev-core       # ポート 8082
just dev-synthesis  # ポート 8083
```

ビルド済み UI を Gateway 自身から配信する（本番と同じ形）:

```bash
just web-build      # web/dist を生成
just dev-gateway    # http://localhost:8081
```

### 検査

```bash
just check          # CI と同等の全チェック
just test           # workspace 全体の vitest
just test-coverage  # 同上 + カバレッジ閾値の強制
just typecheck      # パッケージごとの tsc --noEmit
just lint-ts        # oxlint
just fmt-ts         # oxfmt
```

vitest は 21 ファイル・290 テスト。ルートの `vitest.config.ts` が `test.projects` を使うので
`just test` はリポジトリルートから全部を走らせられる一方、各パッケージも自前の `test` script
を保持しており `pnpm --filter X test` も従来どおり動く。`just test-coverage` は
`@vitest/coverage-v8` を使い、パッケージごとの下限を強制する。`packages/common` は行 90%
（マスキング・vault・OKF という保証の土台があるため厳しめ）、エージェントは 70%（その上の
薄いオーケストレーション）。

テストは完全にオフラインで走る。LLM はモックし、Core はモックの A2A サーバ
（Agent Card + `message/send`）に差し替えるので、ネットワークなしで境界の保証を検証できる。

### ブラウザテスト

```bash
just web-e2e        # Playwright、chromium のみ
just setup-browsers # Nix の外では 1 度だけ
```

`web/e2e/` の 9 本の Playwright スペックは、Core（A2A 経由）と Gemma（OpenAI 互換 API 経由）
だけをモックした上で実物の Gateway と Synthesis を起動する。つまりブラウザが叩くのはスタブ
API ではなく本番のリクエスト経路そのもの。chromium のみとしているのは、これらが検証するのは
アプリケーションの挙動であってレンダリング差ではなく、2 つ目のエンジンは追加のシグナルなしに
実行時間だけを倍にするため。Nix ではブラウザを `PLAYWRIGHT_BROWSERS_PATH` から取る。Nix の
外では `just setup-browsers`（`pnpm -C web exec playwright install chromium`）を 1 度実行する。

### API

| メソッド | パス                        | 用途                                                                      |
| -------- | --------------------------- | ------------------------------------------------------------------------- |
| `POST`   | `/v1/ask`                   | `{text, session_id?}` → OKF 文書、マスク済みプロンプト、attestation、統計 |
| `GET`    | `/v1/sessions/{id}/answer`  | 保存済み OKF ドキュメント（Markdown）                                     |
| `POST`   | `/v1/sessions/{id}/approve` | `verified` に `human:<id>` を追加                                         |
| `GET`    | `/v1/sessions/{id}/tier`    | 導出した trust tier と staleness                                          |
| `GET`    | `/healthz`                  | 死活監視                                                                  |

## Python クライアント（言語非依存の利用例）

`clients/python/pgw.py` は依存が `httpx` だけの単一ファイル
[PEP 723](https://peps.python.org/pep-0723/) スクリプト。サポート対象の SDK としてではなく、
設計上のある性質を示すために存在する。すなわち **Gateway が話すのは HTTP 上のごく普通の
JSON** であり、このエージェント群を利用するのに SDK もエージェントとの共通ランタイムも要らない
——Python スクリプトでも curl でも他のどの言語でも同じように使える。

```bash
uv run clients/python/pgw.py ask "text" [--session ID]
uv run clients/python/pgw.py answer <session> [--json]
uv run clients/python/pgw.py approve <session> --by human:<id>
uv run clients/python/pgw.py --gateway https://... ask "text"
```

`--gateway` は **トップレベル**のオプションで、サブコマンドより **前** に置く必要がある。
`just ask`、`just answer`、`just approve` が同じ 3 コマンドをラップしている。

`ask` はマスク済みプロンプト（フロンティアモデルが実際に見たもの）、復元済みの回答、そして
trust tier を表示する。tier はサーバが返した値を読むのではなく、OKF の `verified` フィールド
から **クライアント側で導出** する。OKF SPEC §5.3 は tier を導出すべきものとし保存を禁じて
おり、3 つ目のクライアントが独立に再導出できることこそがこの性質のエンドツーエンドでの
成立を証明する。attestation に失敗した場合は終了コード `2` を返すので、シェルのパイプライン
から leak の判定に反応できる。

## Core Agent

`agents/core` は信頼境界の外側にある唯一のサービス。A2A 経由でマスキング済みのプロンプトを
受け取り、Vertex AI 上の Gemini で推論し、プレースホルダをそのまま返す。

- **Agent Card** は `/.well-known/agent-card.json` で配信する。これは `@a2a-js/sdk` 0.3.x が
  `AGENT_CARD_PATH` としてエクスポートする標準パス（旧表記の `/.well-known/agent.json` では
  配信しない）。RPC は `/jsonrpc`（JSON-RPC）と `/rest`（HTTP+JSON）、`/healthz` は死活監視用。
- **Agent Card にはシステム指示を載せない。** ADK が自動生成するカードは公開の skill
  description に指示文全体を埋め込んでしまう。カードは認証なしで取得できるため、
  `src/server.ts` では明示的なカードを渡している。
- **受信ガード**（`src/guard.ts`）は RPC のペイロードを再走査し、生のメールアドレス・電話番号・
  Luhn を満たすカード番号・既知の資格情報形式を検出したら `400 unmasked_sensitive_data` を返す。
  検出器は vault 側のコードから import せず意図的に重複させてある。Core が vault に到達し得る
  依存を持たないこと自体が構造的な保証であり、Core が import してよい subpath にはそのような
  ものが含まれていない。
- **ツールも Firestore クライアントも持たない。** コードが試みたとしても vault には到達できない。
- **ログ**は `session_id` と `request_id` を含む 1 行 JSON。リクエストボディは記録せず、
  検出結果も種別と長さだけで、一致した値そのものは残さない。

Vertex AI の選択は ADK のドキュメントどおり環境変数で行う。`GOOGLE_GENAI_USE_VERTEXAI=true`、
`GOOGLE_CLOUD_PROJECT`、`GOOGLE_CLOUD_LOCATION`（リージョン指定が必要でなければ `global`）、
および `gcloud auth application-default login` による ADC。

## デプロイ

詳細は **[docs/DEPLOY.md](docs/DEPLOY.md)**。要約:

Google Cloud のリソースは Terraform（`infra/terraform/`）で宣言し、コンテナイメージだけを
Cloud Build で別途ビルドする。コマンド面は従来どおり `just` に一本化されている。

```bash
just tf-bootstrap                 # state 用 GCS バケットを作成（初回のみ。gcloud で作る唯一のリソース）
just tf-init                      # そのバケットを backend として Terraform を初期化
just build                        # 4 つのイメージを Cloud Build でビルド・push
just tf-plan gpu_enabled=false    # 変更内容を確認
just tf-apply gpu_enabled=false   # GPU サービス以外をすべて適用
just tf-apply                     # L4 クォータ承認後に gemma-serving を追加
just urls && just health          # 確認
just tf-destroy                   # 撤収（GPU の課金を最優先で止める）
```

`gpu_enabled=false` は GPU を使う `gemma-serving` を作成対象から外すため、Cloud Run の L4
クォータ申請が承認待ちの間でも残りのフリートを先にデプロイできる。

Core のサービスアカウントには意図的に Firestore ロールを **与えない**。Gemma のエンドポイントは
内部 ingress のみ。サービス間呼び出しは ID トークンで認証する。

## 環境変数

以下はすべて起動時に zod で検証される（`packages/common/src/config.ts`）。不正な値は
リクエストの途中で失敗するのではなくプロセスを停止させる。

| 変数                        | 既定値                      | 用途                                               |
| --------------------------- | --------------------------- | -------------------------------------------------- |
| `GOOGLE_CLOUD_PROJECT`      | —                           | Vertex AI と Firestore の GCP プロジェクト         |
| `GOOGLE_CLOUD_LOCATION`     | `us-central1`               | Vertex AI のリージョン                             |
| `GOOGLE_GENAI_USE_VERTEXAI` | `1`                         | Gemini SDK を Vertex AI 経由にする                 |
| `GEMINI_MODEL`              | `gemini-3.5-flash`          | Core のモデル ID — **下の注記を参照**              |
| `GEMMA_BASE_URL`            | `http://localhost:11434/v1` | OpenAI 互換の Gemma エンドポイント                 |
| `GEMMA_MODEL`               | `gemma3:12b`                | Gemma のモデルタグ                                 |
| `GEMMA_API_KEY`             | `ollama`                    | OpenAI 互換 API 用のダミーキー                     |
| `CORE_BASE_URL`             | `http://localhost:8082`     | Core のベース URL（配下から Agent Card を解決）    |
| `SYNTHESIS_BASE_URL`        | `http://localhost:8083`     | Synthesis のベース URL                             |
| `A2A_TIMEOUT_SECONDS`       | `120`                       | ホップごとのタイムアウト                           |
| `A2A_PUBLIC_URL`            | —                           | Agent Card に書き込む公開ベース URL                |
| `A2A_HOST` / `A2A_PROTOCOL` | `localhost` / `http`        | 公開 URL 未指定時に使うホストとスキーム            |
| `VAULT_BACKEND`             | `memory`                    | `memory` または `firestore`                        |
| `VAULT_COLLECTION`          | `token_vault`               | vault の Firestore コレクション                    |
| `ANSWER_COLLECTION`         | `gateway_answers`           | OKF 回答の Firestore コレクション                  |
| `VAULT_TTL_SECONDS`         | `3600`                      | vault の寿命。各回答の `stale_after` と一致する    |
| `WEB_DIR`                   | `./web/dist`                | Gateway が配信するビルド済み SPA                   |
| `PORT`                      | `8081`                      | Cloud Run が注入する                               |
| `LOG_LEVEL`                 | `INFO`                      | 構造化 JSON ログ。常に PII をマスクする            |
| `DEFAULT_APPROVER`          | `kei`                       | UI の承認ボタンが使う承認者 ID                     |
| `OTEL_ENABLED`              | `0`                         | OpenTelemetry span の出力（Cloud Trace / console） |
| `OTEL_SERVICE_NAME`         | エージェント名              | span 上のサービス名を上書きする                    |
| `VITE_GCP_PROJECT`          | —                           | UI のコンソールリンクに埋め込むプロジェクト ID     |

> **`GEMINI_MODEL` についての注記。** ハッカソンの要件は「Gemini 3.5 以降」。モデル ID の
> 文字列は GA のタイミングで変わり得るため、エージェントのコードには埋め込まず
> `GEMINI_MODEL` から読む。既定値は `gemini-3.5-flash` で、これは実際に Vertex AI へ
> `generateContent` を投げて疎通を確認済み。なお `gemini-3.5-pro` は現時点の Vertex AI では
> 解決できない（404 "Publisher model … not found"）。Pro 系が必要なら
> `gemini-3.1-pro-preview` が利用できる。デモの前に、対象プロジェクトが提供している ID を
> 確認すること。

## ツールチェーンとサプライチェーン対策

Node.js 22 + pnpm workspace。`pnpm-workspace.yaml` で `minimumReleaseAge: 1440` を設定して
おり、公開から 24 時間未満のバージョンは拒否される（侵害されたリリースに対する cooldown）。
postinstall スクリプトは既定で禁止し、`allowBuilds` で本当に必要なもの（esbuild）だけを許可
している。ビルドスクリプトはインストール時の任意コード実行なので、既定の答えは「否」。pnpm
自体は `packageManager` フィールドで corepack 向けに固定。

TypeScript の lint / フォーマットは **oxlint**（1.79.0、型を見るルール用に
`oxlint-tsgolint` を併用）と **oxfmt**（0.64.0）であって eslint/prettier ではない。設定は
リポジトリルートの `.oxlintrc.json` と `.oxfmtrc.json` に 1 か所だけ置く。型検査は独立した
ステップのまま（`just typecheck`）で、oxlint は `tsc --noEmit` を置き換えない。

Python は standalone の PEP 723 スクリプト（`clients/python/pgw.py`）としてのみ残っており、
`uv run` で実行し、ルートの最小限の `ruff.toml` で **ruff** をかける。`pyproject.toml` も
`uv.lock` も `uv sync` もない。インストールすべき Python パッケージが存在しない以上、依存
解決のステップは、自分の依存をインラインで宣言しているスクリプトの周りに lockfile の儀式を
足すだけになるため。
