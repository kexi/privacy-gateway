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

## 2. エージェント構成

A2A を使うのは Gateway → Core だけである。Gateway → Synthesis は意図的に素の認証付き
HTTP にしている: OKF ドキュメントは監査アーティファクトであり、途中で LLM に言い換え
られることなく取得できなければならないからだ。Gateway は自身の Agent Card を公開せず、
発見するのは Core のみ。Synthesis の A2A サーフェスは Gateway とのやり取りを
*確認するだけ*で、Card にも明記されている — 検証・リリースを実際に行うパイプラインは
Synthesis の HTTP ルート側にある。

| エージェント        | モデル                  | ランタイム       | 責務                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------- | ----------------------- | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Gateway Agent**   | Gemma 3（自前ホスト）   | Cloud Run        | ADK TypeScript。ユーザーのリクエスト（`{text}` のみ）を受け、サーバー側で 1 件の `request_id`（UUIDv7）を発行する。これが Token Vault のキーも兼ねる。PII / シークレットを検出し（ハイブリッド: 決定的な正規表現 + Gemma によるスパン抽出）、安定したトークン `⟦PERSON_1⟧` `⟦EMAIL_1⟧` `⟦SECRET_1⟧` に置換する。マッピングを **Token Vault**（Firestore、リクエスト単位、TTL 付き）へ保存。*マスク済み*プロンプトを A2A で Core へ転送し、Synthesis へは素の HTTP で到達する。デモ UI と HTTP API を同一オリジンで配信する。                                                                                                                                                                                                                                         |
| **Core Agent**      | Gemini 3.5（Vertex AI） | Cloud Run        | マスク済み入力に対する純粋な推論 / プランニング / コード生成。ADK TypeScript（`@google/adk`）を `toA2a` で提供し、Agent Card は `/.well-known/agent-card.json`、RPC は `/jsonrpc` と `/rest`。モデル ID は `GEMINI_MODEL`（既定 `gemini-3.5-flash`、Vertex AI で疎通確認済み）。デプロイ時は `GOOGLE_CLOUD_LOCATION=global`: `gemini-3.5-flash` は global の Vertex エンドポイントにのみ公開されており、`us-central1` のリージョナルエンドポイントは 404 を返す。受信ガードが生の PII を含むペイロードを拒否する。Vault への依存を**持たない** — ただし Core のパッケージは `@privacy-gateway/common` パッケージ全体をインストールしているため、実際にこれを保証しているのは依存グラフではなく IAM（Core のサービスアカウントは Firestore ロールを持たない）である。 |
| **Synthesis Agent** | Gemma 3（自前ホスト）   | Cloud Run        | ADK TypeScript。`toA2a`（確認のみ）と HTTP（実際のパイプライン）の両方で公開。Core の出力を受け取る。(a) **リークチェック**: マスク済み応答に対する決定的な正規表現の再スキャンと、助言的な Gemma ジャッジ。(b) **整合性チェック**: プロンプトに無いプレースホルダを Core が捏造していないかを決定的に検証。(c) **リハイドレート**: Vault からトークンを復元し、開示ポリシーを適用する。OKF ドキュメントを組み立てる。永続化されるのは常にマスク済みアーティファクトのみ。                                                                                                                                                                                                                                                                                           |
| **Gemma Serving**   | Ollama 上の gemma3      | Cloud Run（GPU） | Gateway / Synthesis が `OllamaLlm`（`ollama/*` モデル名に登録した ADK `BaseLlm` アダプタ）経由で利用する OpenAI 互換エンドポイント。アクセラレータは **NVIDIA RTX PRO 6000**（`var.gpu_type`） — L4 のクォータ申請は 2026-08 に却下された。Ingress は internal のみ。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| **kill-switch**     | なし（LLM を使わない）  | Cloud Run        | フリートの一員でもエージェントでもない: プロンプトも回答も vault エントリも一切見ない。Cloud Billing budget がしきい値超過のたびに Pub/Sub topic へ publish し、その push サブスクリプションが OIDC トークン付きでこのサービスを呼ぶ。100% では `gateway-agent` の `allUsers` invoker バインディングを外し、`gemma-serving` の max instances を 0 に落とす。どちらも冪等なので Pub/Sub の再配信は無害。実体は `services/kill-switch`。                                                                                                                                                                                                                                                                                                                               |

信頼境界: `Gateway` / `Synthesis` / `Gemma Serving` / `Firestore` が**内側**。
`Core` へ渡るのはマスク済みテキストのみ（したがって Gemini へ渡るのもマスク済みのみ）。
Core のサービスアカウントは Firestore ロールを持たない — これが Core を Vault から
遠ざけている実際の事実である。Core のパッケージは `@privacy-gateway/common` パッケージ
全体をインストールしているため、依存グラフそのものは何も強制していない。加えて、
Core 宛の A2A メッセージは送出前に PII スキャナで検証される（多層防御）。

### セッションは廃止された

呼び出し元が指定するセッションや、複数リクエストにまたがる状態は存在しない。1 件の
HTTP リクエストに対して、Gateway がサーバー側で生成する `request_id`（UUIDv7）が
ちょうど 1 つ発行され、これが Token Vault のキーになる。`POST /v1/ask` が受け付ける
のは `{text}` のみで、ボディに `session_id` が含まれていれば 400 で拒否される。受信した
`X-Request-ID` ヘッダは**完全に無視される**: Gateway は自前で ID を発行し、
`X-Request-ID` レスポンスヘッダで返すのはその ID である。したがって、ヘッダを読み返した
呼び出し元が手にするのはサーバー側の ID であって自分の ID ではない。受信値がエコーされる
ことは一切ない。任意の ID を選べる呼び出し元がいれば、他人のリクエストのマッピングを
名指しし、そのプレースホルダを解決できてしまう — 呼び出し元指定の ID をどれだけ検証
しても、この問題は消えない。したがって、複数リクエストにまたがるプレースホルダの
安定性は存在しない。

### 人間によるレビューはスコープ外

このシステムには承認ステップも、`human:` の OKF アクターも一切存在しない。公開
Gateway は誰も認証しないため、レビュアーを名指しする手段が無い。認証されていない
`human:<id>` アクターを許すと、誰でも任意の識別子を名乗れてしまい、OKF の
human-reviewed 信頼ティアが無意味になる。OKF の信頼ティア導出ロジック自体は
`packages/common` の中で汎用のまま残している — ライブラリの他の利用者には認証された
レビュアーが存在しうるからだ — が、この製品では `human:` アクターを一切発行しない。
UI のレビュー識別は常に「なし」と表示される。

## 3. フロー

```
User ──HTTP──▶ Gateway (Gemma)
                 │ 0. 予約構文 ⟦…⟧ を拒否                  (400 reserved_syntax)
                 │ 1. 検出 + トークン化  ──▶ Firestore Token Vault (request_id → {token: value})
                 │ 2. egress ガードによる再スキャン         (422 outbound_guard_refused)
                 ▼ A2A
               Core (Gemini 3.5)  — トークン上での推論 / プランニング / コード生成
                 │ マスク済み回答
                 ▼ HTTP（認証付き）
               Synthesis (Gemma)
                 │ 3. Vault 参照 + generation 検証          (409/410)
                 │ 4. 整合性チェック                        (409 invented_token)
                 │ 5. リークチェック                        (422 leak_check_failed)
                 │ 6. Gemma ジャッジ（助言的・非対称）      (422 judge_flagged / judge_unavailable)
                 │ 7. 開示ポリシーに従ってリハイドレート    (409 unresolved_token)
                 ▼
               User  （最終回答 + OKF 証跡ドキュメント: 何をマスクし、何を検証したか）
```

非構造スパン抽出（Gemma、Gateway ホップ内）も fail-closed である。トランスポート障害
または解釈不能な応答は `502 extraction_unavailable` となり、Core は一切呼び出されない
— 正規表現だけでは氏名や住所を検出できないため。

### すべてが fail-closed

以下のゲートはいずれも失敗するとパイプラインを止める。リハイドレートされた回答は
一切返さず、永続化されるのはマスク済みアーティファクトのみ（`status: draft`、
`verified` は省略）。

| ゲート                                                          | 結果                                                                                   |
| --------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| 生入力に予約構文 `⟦…⟧`                                          | `400 reserved_syntax`（マスキング前、Vault 書き込み前）                                |
| Gemma のスパン抽出（`valid-empty` / `valid-spans` / `invalid`） | `invalid` またはトランスポート障害 → `502 extraction_unavailable`。Core には到達しない |
| egress ガードがマスク済みプロンプト中に生 PII を検出            | `422 outbound_guard_refused`                                                           |
| Vault マッピングが存在しない                                    | `409 vault_missing`                                                                    |
| Vault マッピングが失効                                          | `410 vault_expired`                                                                    |
| Vault の generation 不一致                                      | `409 vault_generation_mismatch`                                                        |
| Core がプロンプトに無いプレースホルダを捏造                     | `409 invented_token`                                                                   |
| 決定的リークチェックが失敗                                      | `422 leak_check_failed`                                                                |
| Gemma ジャッジが `leak: true` を返す                            | `422 judge_flagged`                                                                    |
| Gemma ジャッジが利用不能 / 有効な判定なし                       | `422 judge_unavailable`                                                                |
| リハイドレート後も未解決のプレースホルダが残る                  | `409 unresolved_token`                                                                 |
| IP 単位のデモ用レート制限超過                                   | `429`                                                                                  |
| `MAX_BODY_BYTES` を超えるボディ                                 | `413`                                                                                  |
| エンドツーエンドのデッドライン超過                              | `504`                                                                                  |

### Gemma ジャッジは非対称かつ確率的

Synthesis の Gemma ジャッジは一方向にのみ助言的である: `leak: true`、または「有効な
判定なし」（トランスポート障害・タイムアウト・パース不能な応答）は**リリースを
ブロックする**。一方 `leak: false` は**信頼を一切加算しない** — 判定を格上げしたり
信頼ティアに寄与したりすることは決してない。確率的なモデルはリリースを拒否権で
止めることはできても、それがリリースを信頼する理由になることは決してない。
温度 0 で実行され再現性を確保しており、リハイドレート後の本文を見ることは決してない
— 見るのはマスク済み（トークンのまま）の応答のみで、これ自体が実 PII の漏出経路に
なることはない。

### 匿名化ではなく仮名化

このシステムのマスキングは**仮名化（pseudonymization）**であり、匿名化や
非識別化ではない。残存リスクは現実のものである: プレースホルダはそれが置き換えた
値の**カテゴリ**を開示し、**等価性**を保持する（同じ `⟦PERSON_1⟧` が繰り返し現れれば、
同一人物を指していることが分かる）。雇用主・所在地・日付・役職・出来事の文脈といった、
トークン化されずに残る準識別子は、あらゆる直接識別子が置き換えられた後でも文脈的な
再識別を許しうる。

## 4. Fortified Enterprise Fleet への対応

- **Registry**: Core 用の A2A Agent Card（`/.well-known/agent-card.json` — `@a2a-js/sdk`
  0.3.x が `AGENT_CARD_PATH` として公開する標準パス）。Gateway は Core を card URL
  （環境変数で設定）から発見し、自身の Agent Card は公開しない。Synthesis が公開する
  card は Gateway とのやり取りを確認するだけのもの（§2 参照）。
- **Runtime**: エージェントごとの ADK `Runner` を、ADK の A2A サーバが Cloud Run 上で提供する。
- **Memory**: Firestore — Token Vault（リクエスト単位、TTL ポリシー付き）と、リクエスト
  ごとの証跡ドキュメント（マスク済みプロンプト、Core のトークン化済み応答、OKF
  ドキュメント。TTL ポリシーであり追記のみのログではない）。
- **Security**: IAM のみによるサービス間認証（Cloud Run invoker + ID token）、最小権限の
  SA、Gemma エンドポイントは internal ingress、PII をスクラブする代わりに型付き
  ロギング allowlist を使う（OBSERVABILITY.ja.md 参照）。
- **Observability**: Cloud Logging の構造化ログ（1 行 1 JSON）に `request_id` と
  Cloud Trace 連携フィールドを含める。エージェントホップごとに OpenTelemetry スパンを張り、
  `traceparent` の伝搬で 1 本のトレースに統合する。リクエスト単位の OKF 証跡ドキュメント
  （マスク件数、リークチェック判定、ホップごとのレイテンシ）。イベント名・エラーコード・
  スパンツリーの正典は [OBSERVABILITY.ja.md](OBSERVABILITY.ja.md)。`request_id` は
  UUIDv7 で、UI と API の双方が表示する。

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
services/
  kill-switch/   # コストキルスイッチ: 予算通知 → 支出を止める、Dockerfile
clients/
  mcp/           # MCP stdio サーバ: pgw_ask / pgw_evidence / pgw_verify
  python/        # pgw.py —単一ファイルの PEP 723 クライアント（言語非依存の実例）
serving/gemma/   # Cloud Run GPU 用の Ollama Dockerfile
web/             # デモ UI（マスク済みと最終結果を並べて表示）+ Playwright スペック
knowledge/       # OKF v0.2 バンドル（ポリシー、計算、executor、attester）
infra/terraform/ # Terraform: Cloud Run、IAM、Firestore TTL、Artifact Registry、budget
docs/            # ARCHITECTURE.md、OBSERVABILITY.md、DEPLOY.md、構成図
justfile         # dev / test / deploy タスク
```

`packages/common` はサブパス export を提供しており、Core が import するのは
`/logging` `/config` `/schema` `/telemetry` のみである。この規約により Core 自身の
コードは vault モジュールに触れずに済むが、Core のパッケージは
`@privacy-gateway/common` パッケージ全体をインストールしているため、依存グラフ自体は
Core が Firestore に到達できないことをディスク上で保証するものではない。実際の構造的
保証は IAM である: Core のサービスアカウントは Firestore ロールを持たない。Gateway と
Synthesis はパッケージのエントリポイントを import する。

## 6. 主要な設計判断（Why not）

- **なぜ Gemini API 経由の Gemma にしないのか？** 境界の外に出てしまい、本システムの意義が
  失われるから。Cloud Run GPU で自前ホストする。ローカル開発では同じ OpenAI 互換
  インターフェースを持つローカル Ollama を使う。
- **なぜ検出を正規表現 + Gemma のハイブリッドにするのか？** 正規表現は構造化された PII
  （メール、電話番号、カード番号、API キー）に対して決定的で監査可能なカバレッジを与える。
  Gemma は非構造なエンティティ（氏名、住所）を拾う。Gemini が `⟦PERSON_1⟧` について
  一貫して推論できるよう、トークンは 1 リクエストの往復の中で安定している必要がある。
  複数リクエストにまたがる安定性の要件は存在しない。複数リクエストにまたがる状態自体が
  無いためである（§2 参照）。
- **なぜ Gateway でリハイドレートせず、Synthesis を別エージェントにするのか？** 職掌分離。
  *出力*の安全性を検証するエージェントは、*入力*のマスキングを決めた主体と同じであるべきでは
  ない。加えて、これによりリークチェックが全応答に対する独立したゲートになる。
- **なぜ Gateway → Core は A2A で、Gateway → Synthesis は素の HTTP なのか？** Core の
  役割は推論なので、LLM 志向のプロトコルである A2A が適合する。Synthesis の HTTP
  ルートが返すのは監査アーティファクト（OKF ドキュメント、マスク済みプロンプト、
  Core のトークン化済み応答）であり、LLM に言い換えられずそのまま返る必要がある —
  そのため Gateway が実際に使う経路は素の認証付き HTTP であり、Synthesis がやり取りを
  確認するだけの A2A サーフェスも別途公開しているにすぎない。
- **なぜプロセス内サブエージェントではなく別サービスに分けるのか？** 境界こそが
  プロダクトだから。IAM アイデンティティを分けた別サービスにすることで、「Core は
  Firestore に到達できない」がコード上の規約ではなく IAM が強制するデプロイ可能な保証に
  なる（§5 の依存グラフに関する注記も参照）。

## 7. API サーフェス

| ルート                              | メソッド | 用途                                                                                                                                                                                                                                                  |
| ----------------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/v1/ask`                           | POST     | `{text}` のみ。リハイドレート済みの回答、OKF markdown、`trust_tier`、`status`、4 つの `dimensions`、`attestation`、`consistency`、`stats` を返す。ボディに `session_id`（または他の未知のフィールド — スキーマは `strict()`）が含まれていれば `400`。 |
| `/v1/requests/:id`                  | GET      | 当該リクエストのマスク済み OKF 証跡ドキュメント。                                                                                                                                                                                                     |
| `/v1/requests/:id/masked-prompt.md` | GET      | Core へ送られたマスク済みプロンプト（OKF `sources[]` のターゲット）。                                                                                                                                                                                 |
| `/v1/requests/:id/core-response.md` | GET      | Core のトークン化済み応答（OKF `sources[]` のターゲット）。                                                                                                                                                                                           |
| `/v1/chat/completions`              | POST     | 同一パイプライン・同一ゲートの OpenAI 互換ファサード。`system`/`user` の content を連結し `assistant` ターンは捨てる。プライバシー情報は `x_privacy_gateway` で運ぶ。拒否はステータスを保ったまま返り、200 の謝罪文にはならない。                     |
| `/v1/models`                        | GET      | OpenAI 互換のモデル一覧。ID は `privacy-gateway` ただ 1 つ — 呼び出し側が選ぶのは背後のモデルではなくフリートである。                                                                                                                                 |
| `/healthz`                          | GET      | 死活監視。                                                                                                                                                                                                                                            |

承認ルート・ティア参照ルート・セッション単位の回答ルートは存在しない:
`POST /v1/sessions/:id/approve`、`GET /v1/sessions/:id/tier`、
`GET /v1/sessions/:id/answer` はこの設計には無い（§2 参照 — セッションと人間による
承認はどちらも廃止されている）。上記のルートはすべて `request_id` をキーとする。

リクエスト上限: ボディサイズは 64 KB（`MAX_BODY_BYTES`）、Gateway → Core → Synthesis
のチェーン全体で 60 秒のデッドライン（`REQUEST_DEADLINE_SECONDS`）、IP 単位のデモ用
レート制限（`RATE_LIMIT_PER_MINUTE`、既定 20 リクエスト/分、`0` で無効化）を課している。
これらはデモ用の粗い制限である: 公開 Gateway は誰も認証しておらず、1 リクエストで
Gemma 呼び出しが 2 回と Gemini 呼び出しが 1 回走るため、無制限のエンドポイントは
コスト事故の火種になる。

## 8. 永続化と Vault

Firestore が保存するのは `request_id` をキーとした**マスク済みアーティファクトのみ**:

- **Token Vault**（`token_vault` コレクション）: 1 リクエスト分のプレースホルダ →
  生の値のマッピング、`generation` カウンタ、`expires_at`。Firestore への書き込みは
  `runTransaction` の内側で行われるため、同時に書き込む 2 者が互いのマッピングを
  黙って上書きすることはない。Synthesis には Gateway が書き込んだ generation が渡され、
  それ以外の generation に対するリハイドレートは拒否する。
- **証跡ストア**（`gateway_answers` コレクション）: マスク済みプロンプト、Core の
  トークン化されたままの応答、OKF ドキュメント（本文が保持するのは*マスク済み*回答）、
  そして `expires_at`。`token_vault` と同じ `expires_at` フィールド名を使うことで、
  1 つの Firestore TTL ポリシー形状が両コレクションをカバーする。

リハイドレートされた回答が存在するのは、それを生成した 1 回の `/v1/ask` API
レスポンスの中だけである。いかなるコレクションにも、いかなる status でも Firestore
に書き込まれることはない。

**拒否は、拒否された Core のテキストを一切永続化しない。** ゲートが一度でも走った後に
拒否されたリクエストは証跡ドキュメントを永続化する — `status: draft`、`verified` は
省略 — が、その本文は文字通りのマーカー `content withheld` であり、保存される
`core_response` も同じマーカーである。拒否されたテキストはまさにゲートがリリースを
拒んだテキストそのものであり、証跡ルートは未認証なので、それを保存してしまえば
ゲートが今しがた止めた漏洩を再現することになる。生き残るのは `attestation` ブロックで
ある: 拒否された応答の SHA-256 が記録をその exchange に紐づけたままにするので、
オリジナルを持つ監査者は、ストアがそのテキストを一度も保持していなくても、これが
何についてのテキストだったかを証明できる。

2 種類の拒否は、そもそも証跡ドキュメントが存在する*前*に起きる: `vault_missing`
（409）と `vault_expired`（410）は、パイプラインがドキュメントを組み立てる元になる
マッピングをまだ持っていない段階で決まり、`vault_generation_mismatch`（409）も同様
である。これらのリクエストは、保存されたドキュメントからではなく、構造化ログ
（`refusal` フィールドを伴う `release.refused`）から監査できる。一方、コンテンツ
ポリシーによる拒否 — `invented_token`、`leak_check_failed`、`judge_flagged`、
`judge_unavailable`、`unresolved_token` — はいずれもドキュメントを 1 件永続化する。

どちらのコレクションも追記のみのログではない: どちらも TTL 付きのリクエスト単位の
ドキュメントである。証跡レコードの `expires_at` は **Vault エントリ自身の失効時刻**
であり、ドキュメントの `stale_after` から読み戻した値である。永続化時点で計算した
`now + TTL` ではない — 後者だと、ドキュメントが自ら示す鮮度を超えてレコードを
提供できてしまう。

## 9. 開示ポリシー

`API_KEY` `AWS_KEY` `JWT` `CREDIT_CARD` `MY_NUMBER` は既定でリリースされる回答に
リハイドレートされない — プレースホルダはそのまま残り、開示が抑制されたカテゴリは
OKF の `attestation.withheld` と API レスポンスの `attestation.withheld` の双方に
列挙される。理由: シークレットを送った呼び出し元自身は既にそれを保持しているのだから、
フロンティアモデルの往復を経由してもう一度エコーバックしても、ログやスクリーンショット
に残った際の被害範囲が広がるだけである。`REHYDRATE_ALLOW_CATEGORIES`（カンマ区切り、
例: `CREDIT_CARD,MY_NUMBER`）で、特定のカテゴリだけをそのデプロイで再度リリース対象に
できる。

## 10. UI の信頼ディメンション

UI は 4 つのディメンションを**別々に**表示し、1 つのバッジに折り畳むことは決してない
— そうしないと部分的な失敗が「合格」として読めてしまうからだ。

- **policy verdict（ポリシー判定）** — `pass` / `fail`（決定的リークチェックと整合性チェック）
- **document status（ドキュメントステータス）** — `draft` / `stable` / `deprecated`
- **freshness（鮮度）** — `fresh` / `stale` / `unknown`（`stale_after` から導出。欠落または
  パース不能な `stale_after` は `unknown` であり、`fresh` になることは決してない）
- **review identity（レビュー識別）** — 常に `none`（§2 参照 — 人間によるレビューはスコープ外）

ブロックされたリクエストは 4 つのディメンションのいずれかに畳み込まず、それ自体を
独立した結果として表示する。

## 11. デモシナリオ（4 分以内の動画）

氏名・メール・電話番号・クレジットカード番号・API キーを含むカスタマーサポートのメール →
「返信文と、この顧客のレコードを更新する Python スクリプトを書いて」と依頼する。
見せるもの: Gemini に送られたマスク済みプロンプト、Gemini のトークン化された出力、
リークチェックの通過、リハイドレートされた最終回答、OKF 証跡ドキュメント、Cloud Run
コンソール。

## 12. 知識と信頼のシグナル: Open Knowledge Format (OKF v0.2)

このフリートが生成する回答はすべて*エージェントが書いたコンテンツ*である。各出力について
来歴・信頼・鮮度・ライフサイクル・アテステーションを第一級の概念として扱うため、
[OKF v0.2](https://github.com/GoogleCloudPlatform/open-knowledge-format) を採用する。

- **バンドル** `knowledge/`（リポジトリ内）: `policies/pii-masking.md`（人間が執筆、`human:` で検証済み）、
  `computations/leak-check.md`（`type: Attested Computation`、`runtime: typescript`、
  決定的なアテスター `references/attesters/leak_check.ts`、レシート
  `[request_id, masked_prompt_hash, response_hash, findings, response, masked_prompt]`）。
  レシートが `response` と `masked_prompt` の両方を運ぶのは、アテスター自身が*両方*の
  ハッシュを再計算するためである: レシートが `masked_prompt_hash` を主張するだけなら、
  それを別の exchange に対してリプレイできてしまう。だからプロンプトの紐付けは
  「主張される」のではなく「証明される」。`executor.receipt` とアテスターがエクスポート
  する `RECEIPT_FIELDS` は同一のリストであり、それをテストが強制している。
- **リクエストごとの出力**（Synthesis Agent → Firestore → UI）: `type: Gateway Answer` の OKF
  コンセプト。`generated.by` は `synthesis_agent/<version>` — このコンセプトを組み立てるのは
  Synthesis なので、OKF SPEC §7 のアクター規約に従い文書は Synthesis に帰属する。Core は
  トークン化された文章を供給する側であり、代わりに `core-response` という provenance
  ソース（`author: core_agent/<GEMINI_MODEL>`）として現れる。`sources[]` は 3 エントリ:
  `masked-prompt`（`/v1/requests/<id>/masked-prompt.md`）、`core-response`
  （`/v1/requests/<id>/core-response.md`）、`pii-policy`。最初の 2 つは Gateway が実際に
  配信するパスと一字一句同じである（上記§7） — `/requests/<id>/...` のように `/v1` を
  欠いた名前を付けていた頃は、実際のルートが `/v1/requests/<id>/...` だったため
  dangling link になっていた。provenance をたどれないドキュメントはリプレイできない。
  `verified[].by` はリークチェックのアテステーションが通れば
  `process:leak-check@<attester sha256 の短縮形>`（⇒ _machine-confirmed_）で、LLM
  アクターになることは決してなく、`human:<id>` エントリも一切存在しない（§2）。
  `stale_after` は Vault の失効時刻、いずれかのゲートが失敗すれば `status: draft`。
- トップレベルの `attestation:` ブロックが `computation`、`computation_sha256`、
  `attester_sha256`、`masked_prompt_sha256`、`core_response_sha256`、`verdict`、
  `checked_at`、`request_id`、`trace_id`、該当する場合は `withheld` を保持する —
  第三者がこのフリートを信頼せずに判定を再現できるだけの情報が揃っている。
  `just verify-answer <request_id>` で再現できる。
- 壊れた `verified` エントリ（`by` が欠落または文字列でない）は信頼ティア導出の対象から
  除外されるため、破損したフィールドはクラッシュしたり過剰に信頼したりせず `unverified`
  を導出する。`stale_after` が不正または欠落している場合の鮮度は `unknown` であり、
  `fresh` になることは決してない。
- UI は 4 つの信頼ディメンション（§10）を個別に導出して表示する。アテステーションの
  失敗は必ず表面化させ、握りつぶさない。
- **なぜ場当たり的な JSON 監査レコードではなく OKF なのか**: 監査証跡が、ポータブルで差分が取れ、
  人間が読めるバンドルになるから。任意の OKF コンシューマ（Knowledge Catalog、エージェント、
  `cat`）が読める。エージェント出力への信頼こそがプロダクトである以上、その信頼の記録もまた
  標準であるべきだ。

本リポジトリで OKF を書く際のエージェント向けガイダンスは `skills/okf/` にある
（`.claude/skills/okf` と `.codex/skills/okf` で共有）。
