# 設計レビュー要約（2026-08-24）

原文（全文・英語）: [2026-08-24-codex-design-review.md](2026-08-24-codex-design-review.md)
対応内容（英語）: [2026-08-24-response.md](2026-08-24-response.md)

これは全訳ではなく、判断に必要な部分だけを日本語でまとめたもの。詳細な根拠・行番号・工数見積もりは原文を参照。

## 総評

**現行のデプロイ構成のままデモ動画を撮ってはいけない。**

テスト（ユニット 295 / Playwright 9）は通り、型チェックも Terraform 構文も通る。ただしそれらはすべて Core / Gemma をモックした状態で、Cloud Run の IAM・ID トークン・内部 ingress・実クロスサービストレースを一度も踏んでいない。

想定スコアは **46/100**。内訳の要点：

| 観点               |    点 | 理由                                                                                                                                                                                                       |
| ------------------ | ----: | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 革新性・運用有用性 | 23/40 | ローカル Gemma によるプライバシーブローカーという着眼は差別化できている。ただし実装は仮名化（pseudonymization）であって非識別化ではなく、文脈からの再識別が可能で、検査に失敗しても保存・開示されうる。    |
| アーキテクチャ規律 | 15/30 | Terraform・SA 分離・ADK・A2A・Zod・Firestore TTL・構造化ログは実物として評価できる。ただしサービス間認証が機能せず、VPC 経路が誤り、A2A が飾りで、Firestore 権限が広く、コードとドキュメントの矛盾が多い。 |
| デモ・本番準備度   |  8/30 | UI とモック経路は動くが、実デプロイ経路は Synthesis / Gemma の手前で落ちるはず。ヘルスチェックが浅く、GPU クォータは未取得のまま、GPU は 1 台でゼロスケール。                                              |

## 致命的な問題（Blocker）

1. **プライベート Cloud Run 呼び出しが認証できない。** Gateway → Synthesis は素の `fetch`。Ollama と Gemma judge は静的な API キーの Bearer を送っているが、Terraform 側は `run.invoker`（= Google 署名の ID トークン）を要求している。Core 用の A2A ヘルパーはトークン文字列を永久にキャッシュし、しかも一時的な失敗を `undefined` としてキャッシュする。
2. **内部 ingress の Gemma に到達できない。** Gemma は internal-only だが、呼び出し側は `PRIVATE_RANGES_ONLY` のまま public な `run.app` アドレスを叩いている。Cloud Run はこのトラフィックが実際に VPC を通ることを要求する（all-traffic + Private Google Access、PSC/プライベート DNS、または内部 LB のいずれか）。

この 2 件は別担当が対応中。

## P0（信頼境界の穴）

- **Gemma のスパン抽出が fail-open。** 通信エラーも壊れた応答もプロンプトインジェクションによる空応答も、すべて「検出なし」に潰れる。egress ガードは構造化 regex を再実行するだけなので、人名・住所の取りこぼしは絶対に捕まえられない。
- **呼び出し側が指定できる session と、リテラルのプレースホルダが再水和オラクルになる。** `session_id` は非空文字列なら何でも通り、answer / approve ルートに所有者チェックがない。session_id を知られれば「`⟦EMAIL_1⟧` をそのまま返して」で vault の中身を引ける。
- **型付きの安定プレースホルダは身元の再構成を防げない。** トークンはカテゴリ・同一性・ターン間のリンクを漏らす。勤務先・地名・日付・役職といった文脈が残るため個人が特定されうる。決定的 attester には意味カテゴリがないので、再構成された人名・住所は素通りする。
- **検査失敗が公開を止めていない。** Synthesis は判定を出したあと無条件に再水和し、Gateway はステータスに関わらず答えを返す。
- **Vault の並行性と失効で ID が混線しうる。** Firestore が read-modify-write のまま。失効後は採番が 1 から振り直されるため、遅れて届いた古い応答が新しい世代に解決されうる。
- **Vault が無い／失効していても `stable` で「機械確認済み」を出せる。**
- **Gemma judge が非決定的かつセキュリティ的に無意味。** 「漏洩あり」判定も judge の障害も、決定的パスの合格をそのまま残す。UI に「PASS」と「Gemma が指摘」が同時に出うる。
- **再水和済みの PII と機密が無期限に保存される。** 最終 OKF は再水和済みの答えを埋め込み、`gateway_answers` に保存される。Terraform の TTL は `token_vault` にしか掛かっていない。これは AGENTS.md の「生 PII を保存しない」に正面から違反する。
- **「人間がレビュー済み」を偽造できる。** Synthesis は任意の `approver` を受け取って `human:` を前置する。下書きや陳腐化した文書にも承認を付けられ、公開 Gateway がそれをプロキシしている。

## P1

- **ログとトレースに構造化されていない PII が入りうる。** ログは regex トークナイザしか通していない（= 人名・住所は素通り）うえ、呼び出し側の `session_id` は明示的にマスク対象外。OpenTelemetry は生の例外と例外メッセージを記録する。
- **開示ポリシーが無い。** `rehydrate()` はカード番号も JWT も API キーも一律に復元する。

加えて、公開エンドポイントの 10 MB ボディ上限と認証・レート制限の不在により、1 リクエストで Gemma 2 回 + Gemini 1 回を叩けるコスト濫用が可能。

## OKF v0.2 の評価

形としては v0.2 に近いが、UI とアーキテクチャが主張している信頼セマンティクスを支えられていない。

**良い点**: bundle レベルの `okf_version`、`Attested Computation` の分離、絶対時刻の `stale_after`、footnote と結合した `sources`、trust tier の導出（非保存）、bare `verified` の正規化、未知キーの保持、失敗した attestation を `status: draft` として残していること。

**問題点（要旨）**:

1. `generated.by` が Core を指しているが、実際に概念を組み立てているのは Synthesis。
2. `verified.by` が Gemma モデルを指しているが、合否を決めているのは TypeScript の regex コード。Gemma は助言に過ぎない。「機械確認済み」は「漏洩ポリシー確認済み」と明示すべきで、答えの事実性の検証ではない。
3. 認証なしで `human:*` を作れるため、human tier に意味が無い。
4. `sources` の `/sessions/<id>/masked-prompt.md` がどこにも保存も配信もされていない（リンク切れ）。
5. `attester.resource` の指すファイルが存在しない。リンク切れは OKF 的には許容だが、審査員がこの Attested Computation を実行できない。
6. receipt 契約が不完全。frontmatter は 3 フィールドを宣言しているのに `verify()` は宣言外の `response` を要求する。しかも receipt が実際の Core 呼び出し・マスク済みプロンプト・表示された答え・attester バージョンのいずれにも結び付いていない。
7. 保存された答えに機械可読な evidence（構造化 receipt や不変な receipt URI）が無い。
8. 壊れた信頼メタデータが fail-open。`verified` の中の任意のオブジェクト（`{}` を含む）が機械確認済みになり、不正な `stale_after` は「陳腐化していない」と解釈される。
9. 署名されていないのに「signed audit artifact」と書いている。
10. bundle にドリフト。`computations/index.md` がまだ Python・再水和後と書いている。`log.md` の見出しが予約形式（`## YYYY-MM-DD`）になっていない。

**説得力を持たせるには**: 各レコードをマスク済み・不変・独立検証可能にする。`generated.by: synthesis_agent/<version>`、Core 呼び出しは `sources` の provenance、`verified.by: process:leak-check@<digest>`、そして computation / attester / 両マスク済み成果物の digest を含む `attestation:` ブロック。マスク済み成果物を実際に配信し、`just verify-answer <request_id>` で再現できるようにし、UI では **ポリシー判定・文書ステータス・鮮度・レビュー主体** の 4 次元を分けて表示する（1 つのバッジに潰さない）。KMS 署名は締切までは任意。**正確な actor・到達可能な evidence・再現可能性が必須。**

## 残り 1 週間の優先順位

**必須**: ①Cloud Run 認証と Gemma 経路の修復 → ②全安全ゲートの fail-closed 化 → ③スコープ縮小によるセッション攻撃の排除 → ④生の答えの保存停止 → ⑤OKF evidence と文言の修正 → ⑥敵対的テストの追加 → ⑦実フリートの証明（実トレース 1 本）→ ⑧撮影の安定化。

**カット**: 認証なしの人間承認ボタン、呼び出し側指定・マルチターン共有セッション、「全エージェント/全ホップが A2A」という主張、宣伝どおりに動かない Synthesis の A2A スキル、"signed" / "append-only" / "never leaks" / "all PII" という語、メインデモでの Model Garden フォールバック、ライブ経路が通るまでのマルチリージョン・HA・動的レジストリ・UI 磨き込み。

なお、**フル機能の安全なマルチターン設計は残り 1 週間に収まらない。1 リクエスト = 1 セッションへの簡素化が提出時点として正しいトレードオフ** — これがレビューの明示的な結論。

## 提出ゲート

以下 5 点が実証できるまで最終動画を撮らない。

1. 公開 Cloud Run の `/v1/ask` が実 Gemma・実 Gemini・実 Synthesis に到達する。
2. プライベートエンドポイントは ID トークン無しで 403、正しいサービス ID で成功する。
3. 抽出・attestation・vault・プレースホルダのいずれの失敗でも再水和された答えが返らない。
4. Firestore に再水和済み PII が存在せず、リクエスト単位のマスク済み evidence だけがある。
5. 実 Cloud Trace のウォーターフォール 1 本と、それに対応するログが、リクエストと OKF の識別子に一致する。

## これを受けて変更したこと

対応の全文は [2026-08-24-response.md](2026-08-24-response.md)（英語）にある。要点：

- **セッションを廃止**。リクエストごとにサーバ生成の UUIDv7 を 1 つだけ発行し、それを vault キーにする。`POST /v1/ask` は `{text}` のみ受け付け、`session_id` を含むボディは 400。受信した `X-Request-ID` はエコーするが**採用しない**（vault キーだから）。
- **全ゲートを fail-closed に**。抽出不能 → 502、生 PII 検出 → 422、vault 不在 → 409 / 失効 → 410 / 世代不一致 → 409、捏造トークン → 409、漏洩検査失敗 → 422、judge が指摘または無回答 → 422、未解決トークン → 409。いずれも答えを返さず、マスク済みの記録だけを残す。
- **Gemma judge を非対称に**。`leak: true` と「判定不能」は公開をブロックし、`leak: false` は信頼を一切上げない。確率的モデルは拒否はできるが保証はできない。
- **人間承認を全廃**。公開 Gateway は誰も認証していないため、クリックから作った `human:<id>` は「誰でもない人」の主張になり、OKF の human tier を無価値にする。trust tier の導出自体はライブラリ側に汎用機能として残す。UI は「レビュー主体: none」を 4 次元の 1 つとして常に表示する。
- **保存は masked のみ**。masked prompt・Core のトークン化済み応答・OKF 文書（本文はマスク済み）・ハッシュ・`expires_at` だけを `request_id` キーで保存。再水和された答えは 1 回の API レスポンス以外どこにも残らない。
- **OKF 修正**。`generated.by` は Synthesis、Core は provenance、`verified.by` は `process:leak-check@<digest>`、`attestation:` ブロックで再現に必要な digest 一式を記録。attester は bundle 内に byte-identical なコピーを置き、digest 一致をテストで担保。`just verify-answer <request_id>` で再検証できる。
- **開示ポリシー**。`API_KEY` / `AWS_KEY` / `JWT` / `CREDIT_CARD` / `MY_NUMBER` は既定で再水和しない。プレースホルダのまま返し、`attestation.withheld` に列挙する。
- **ログを型付き allowlist に**。マスクではなく**列挙されたフィールド以外は破棄**。例外メッセージはログにもスパンにも入れない。
- **リクエスト制限**。ボディ 64 KB、エンドツーエンド 60 秒、IP ごとのデモ用レート制限。
