# Convergence loop record (2026-08-30 → 08-31)

Reviewer: Codex (gpt-5.6-sol, ultra). Coder: Claude (Opus executors, Fable orchestration).
Loop: review → fix → redeploy → re-review, until VERDICT: CONVERGED.

| Round | Findings | Nature                                                                                           | Fixed at |
| ----- | -------- | ------------------------------------------------------------------------------------------------ | -------- |
| 3     | 4        | veto retry, ?key= in logs, GPU cap ineffective, stale proofs                                     | 90a9bd8  |
| 4     | 6        | shim image drop, vault overclaim, positional verify, Gemma4 stragglers, DEVPOST wording, diagram | 90ddfc9  |
| 5     | 4        | documentation sync only                                                                          | 019201f  |
| 6     | 4        | doc/string sync only                                                                             | 9cd9b47  |
| 7     | 0        | **VERDICT: CONVERGED**                                                                           | —        |

After round 7 the tree kept moving (Responses API surface, chunked extraction,
codex-smoke/codex-e2e split, OKF tag vocabulary), so a delta loop reviewed only
what changed since. Round 9 ran at **high** effort as the one final round of the
loop — a deliberate cost decision by the maintainer — so its fixes close the
loop without a further re-review verdict.

| Round | Findings | Nature                                                                                     | Fixed at |
| ----- | -------- | ------------------------------------------------------------------------------------------ | -------- |
| 8     | 8        | Synthesis body limit, Responses union bypass, tolerant-parser gaps, fan-out cap, doc drift | 1c407ef  |
| 9     | 3        | per-request semaphore, abort not reaching Ollama, 150 s doc drift                          | 4013f58  |

## Round 4

HEAD `3d82c07` を確認しました。テストはdevShell内でもVitestが無出力停止したため完走結果は得られませんでした。作業ツリーはcleanに戻しており、ファイル変更はありません。

### 1. `clients/ollama-shim/src/ollama.ts:70` — Ollama入力の画像が明示拒否されず、黙って破棄される

**Defect:** OpenAI互換面とAnthropic面は非テキスト入力を拒否しますが、ネイティブOllama面は違います。`/api/chat`の標準的な`messages[].images`は`OllamaMessageSchema`によってstripされ、`/api/generate`の`images`はpassthroughされた後に`flattenGenerateRequest`が無視します。そのままテキストだけがGatewayへ送信されるため、画像付きプロンプトを別のプロンプトへ黙って改変します。これは[README.md:287](/README.md:287)の「Every surface」「never dropped」という審査向け保証にも反します。

**Fix:** 両Ollamaスキーマで`images`を明示的に認識し、空でない場合はGatewayを呼ぶ前に400 `multimodal_unsupported`を返してください。`/api/chat`と`/api/generate`の双方に、upstream未呼び出しを保証するテストが必要です。

### 2. `agents/gateway/src/pipeline.ts:268` — CUSTOM語句は「never persisted」ではない

**Defect:** CUSTOM語句は`result.mapping`の生値になり、ここでToken Vaultへ渡され、Firestore実装が[packages/common/src/vault.ts:227](/packages/common/src/vault.ts:227)の`mapping`として保存します。一方、[README.md:279](/README.md:279)、[docs/submission/DEVPOST.md:45](/docs/submission/DEVPOST.md:45)、[knowledge/policies/pii-masking.md:106](/knowledge/policies/pii-masking.md:106)は語句が一切永続化されないと明言しています。特にknowledge文書は「never persisted」の直後に「in the token vault」と書かれており、自己矛盾しています。

**Fix:** 現行設計を維持するなら「語句リストは証跡・ログへ保存されないが、マッチした値は再水和のためTTL付きToken Vaultへ保存される」と全資料を訂正してください。本当に非永続化を保証するなら、CUSTOMマッピングをFirestoreへ書かずGatewayからSynthesisへ一時的に渡すなど、データ経路自体の変更が必要です。

### 3. `agents/synthesis/src/pipeline.ts:509` — 再水和検証がplaceholderと値の対応関係を検証していない

**Defect:** `verifyRehydration`は各vault値がリリース文の「どこか」に存在することしか確認せず、その後すべての値を全文からグローバルに除去してscanします。例えば`EMAIL_1 → alice@example.com`と`EMAIL_2 → bob@example.com`を逆の位置へ代入しても、両値は存在し、placeholderは残らず、residueから両値が消えるため`pass`になります。任意の場所へ値を挿入し、本来のplaceholderを別テキストで消す改変も同様に見逃せます。「exact vault values」という保証を、位置と対応関係まで含めては証明できていません。

**Fix:** `coreAnswer`を一度走査し、各placeholder位置で期待されるvault値またはwithheld placeholderを独立に組み立て、その期待文字列と`released`を完全一致で比較してください。少なくとも複数placeholderの値入れ替え、重複値、余分な挿入を拒否するテストが必要です。

### 4. `.env.example:23` — Gemma 4への移行が再現用設定に反映されていない

**Defect:** READMEは`.env.example`をコピーする手順を示していますが、その設定は`gemma3:12b`を明示するため、ローカル環境はGemma 4ではなくGemma 3を実行します。[infra/terraform/example.tfvars:18](/infra/terraform/example.tfvars:18)もGemma 3へ上書きします。さらに[packages/common/src/ollama_llm.ts:34](/packages/common/src/ollama_llm.ts:34)と[agents/synthesis/src/agent.ts:211](/agents/synthesis/src/agent.ts:211)にはGemma 3の独立fallbackが残っています。審査者が再現手順を実行すると、提出文の「Gemma 4 12B」と異なるモデルになります。

**Fix:** `.env.example`と`example.tfvars`を`gemma4:12b`へ更新し、モデル既定値を`packages/common/src/config.ts`の単一定義へ集約してください。fallbackの一致をテストし、移行時に再発しないようにするべきです。

### 5. `docs/submission/DEVPOST.md:49` — Devpost正本が開示オプトインと正面から矛盾する

**Defect:** 提出文は「High-risk categories (cards, keys) are never rehydrated」と断言していますが、同じ文書の[96行目](/docs/submission/DEVPOST.md:96)と実装は、リクエスト単位の`rehydrate_allow`でそれらを再水和できます。これは「既定でwithheld」と「絶対に再水和されない」の重要な違いであり、審査者に誤ったセキュリティ保証を提示します。

**Fix:** 「withheld by default; restored only through an explicit per-request opt-in, recorded as `disclosure_requested`, while stored evidence remains masked」と修正してください。

### 6. `docs/submission/DEVPOST.md:117` — 提出用アーキテクチャ図のリンクが壊れ、実体も古い安全設計を示す

**Defect:** 指定された`docs/diagram/architecture.png`は存在せず、追跡されているPNGは`architecture.drawio.png`です。「also embedded in README」も現状と一致しません。さらに図のソースは[docs/diagram/architecture.drawio:48](/docs/diagram/architecture.drawio:48)でGemma 3、[85行目](/docs/diagram/architecture.drawio:85)で無効だった`maxScale → 0` kill switch、17行目で旧「five ways」を示します。Round 3で修正した重要な安全制御を、審査用図版が再び誤って説明しています。

**Fix:** draw.ioソースをGemma 4、manual scaling `manualInstanceCount=0`、fleet invoker revocation、現在の6 consumption surfacesへ更新してPNGを再生成してください。Devpostリンクを実在するファイルまたはGitHubの絶対URLへ直し、READMEへ実際に埋め込むか「embedded」の記述を削除してください。

VERDICT: 6 FINDINGS

## Round 5

1. `skills/pgw-client/CLIENT.md:63`

Defect: クライアント向け正本が依然として “The terms are never persisted” と無条件に主張しています。実際には語句リスト自体は evidence／ログへ保存されませんが、マッチした語句の実値は再水和のため TTL 付き Token Vault に保存されます。README・ポリシー・Devpost 正本と異なり、利用者に誤ったデータ保持保証を与えます。

Fix: 「語句リストは evidence／ログに保存されない」「マッチした値は request_id 単位の TTL Vault mapping に保存される」「未マッチ語句はリクエスト中のメモリにのみ存在する」と境界を明記してください。

2. `README.md:242`, `README.ja.md:242`, `docs/ARCHITECTURE.md:379`, `docs/ARCHITECTURE.ja.md:411`, `docs/OBSERVABILITY.md:187`, `docs/OBSERVABILITY.ja.md:182`

Defect: 審査者向け文書は、再水和後に「復元値を差し引いて attester を再実行する」という旧アルゴリズムを現在も説明しています。現行実装はその residue scan を廃止し、独立した placeholder regex で `coreAnswer` から期待値を位置ごとに再構築して完全一致を要求します。Observability 文書も、既に存在しないカテゴリ診断がログに載ると記載しています。

Fix: 旧3条件を、独立した位置的再構築と完全一致を決定条件とする説明へ置換してください。leftover／missing／substitution の検査は診断用の前段であり、`rebuild_mismatch` は値・抜粋・カテゴリを記録せず空の token list になることも同期してください。

3. `README.md:23`, `README.ja.md:23`

Defect: README 冒頭の主要データフローが `leak check → rehydrate → consistency verify` と示しています。実装では consistency／invented-token／resolvability の各ゲートは再水和前に通過し、再水和後に行うのは完全一致検証だけです。現状の図は、拒否判断より先に実値を組み立てる設計に見え、プロジェクトの中心的な fail-closed 保証と矛盾します。

Fix: `leak check → consistency/resolvability → rehydrate once → positional verification → release` の順に修正し、本文および埋め込み図と一致させてください。

4. `README.md:402`, `README.md:419`, `README.ja.md:405`, `README.ja.md:422`, `docs/submission/DEVPOST.md:71`

Defect: 現在の green gate は 885 Vitest／74 Playwright ですが、README は 801／50、Devpost 正本はさらに古い 545／23 を提示しています。審査資料内で検証規模が三通り存在し、再現可能性と証拠の信頼性を損ないます。

Fix: 現行の 885／74 に英日 README と Devpost を同期するか、継続的に変動する正確な件数を本文から外し、CI結果を正典としてリンクしてください。

VERDICT: 4 FINDINGS

## Round 6

1. `web/src/main.ts:671`, `packages/common/src/schema.ts:405`

Defect: UI は「語句そのものは保存されない」と表示しますが、マッチした語句の値は TTL Vault に保存されます。一方、schema コメントは逆に全語句が Vault に保存されるように記述しています。どちらも実際の境界と異なります。

Fix: 両方を「語句リストは evidence／ログに残らない。マッチした値のみ request-scoped TTL Vault に保存され、未マッチ語句はメモリのみ」に統一してください。

2. `README.md:199`, `README.ja.md:199`, `docs/ARCHITECTURE.md:24`, `docs/ARCHITECTURE.md:41`, `docs/ARCHITECTURE.ja.md:27`, `docs/ARCHITECTURE.ja.md:45`

Defect: `/v1/ask` が `{text}` のみを受け付けると記載されていますが、現行の strict schema は `{text, rehydrate_allow?, mask_terms?}` を受け付けます。同じ ARCHITECTURE の API 表とも矛盾し、主要機能が不正なリクエストに見えます。

Fix: 正確な3フィールドを記載し、「受け付けない」のは `session_id`、caller-supplied ID、その他の未知フィールドだと明確化してください。

3. `README.md:187`, `README.md:202`, `README.ja.md:187`, `README.ja.md:202`

Defect: 受信した `X-Request-ID` がレスポンスへ echo されると記載されています。実装は受信値を一切読まず、新しい UUIDv7 を生成してレスポンスヘッダへ設定します。ARCHITECTURE の「Nothing echoes the inbound value」とも正面から矛盾します。

Fix: 受信値は完全に無視され、レスポンスの `X-Request-ID` は常に Gateway が生成した vault key である、と修正してください。

4. `README.md:450`, `README.ja.md:451`, `docs/submission/DEVPOST.md:71`, `.github/workflows/ci.yml:3`

Defect: README は `just check` が CI と「同じ recipe・同じ順序」であると述べていますが、CI は `just check` を実行せず、複数ジョブへ分割して browser E2E も別途実行します。また README／Devpost の “every push” に対し、workflow の push trigger は `main` 限定で、ほかは pull request 時です。

Fix: `just check` をローカルの CI-equivalent checks、`just web-e2e` を別ゲートとして説明し、CI trigger を「pushes to main and every pull request」と正確に記載してください。

VERDICT: 4 FINDINGS

## Round 7

現行ツリーを再確認し、material な correctness/security defect または審査資料との矛盾は見つかりませんでした。Round 6 の4修正も実装・UI・英日文書・CI定義で整合しています。

VERDICT: CONVERGED

## Round 8

1. `agents/synthesis/src/server.ts:77`, `agents/gateway/src/server.ts:366-377`, `infra/terraform/locals.tf:73-95`

   **Defect:** Gateway は最大 256 KiB を受理しますが、Synthesis の JSON 上限は既定の 64 KiB のままです。Gateway は `masked_prompt` 全体と Core 応答を Synthesis に送るため、フラット化後の入力が 64 KiB を超えるリクエストは、高コストな抽出と Core 呼び出しを完了した後で 413 になります。したがって、大容量リクエストの失敗原因は文書化された 150 秒の GPU 容量制限だけではありません。

   **Fix:** Synthesis の内部上限を、Gateway 最大入力＋Core 最大出力＋JSON エンベロープを収容できる値に設定してください。64 KiB 超の入力を実際の Synthesis パーサーまで通す E2E テストも必要です。

2. `packages/common/src/schema.ts:743-746`, `agents/gateway/src/responses_compat.ts:64-71`, `agents/gateway/src/responses_compat.ts:98-100`

   **Defect:** Responses API の union にある汎用 `{type: string}` 分岐が、不正な `type: "message"` も受理します。例えば `content: 123` は正規の message schema に失敗した後、汎用分岐で通過し、`contentToText()` が数値に対して `.map()` を呼びます。ルートは非同期ハンドラーを `void` で起動しているため、単なる明示的 400 ではなく未処理 rejection になり得ます。

   **Fix:** `type: "message"` は必ず完全な message schema だけで検証し、汎用分岐から除外してください。欠落・scalar content・不正 role が確実に 400 になる回帰テストも追加してください。

3. `agents/gateway/src/agent.ts:566-622`, `docs/ARCHITECTURE.md:117-122`

   **Defect:** tolerant parser は「包装のみ許容し、内容は修復しない」という fail-closed 契約を満たしていません。複数オブジェクトのうち最初に parse できたものを採用するため、`{"spans":[]}` の後に実際の span が続く出力を安全な空結果として扱えます。また、配列全体の検証に失敗すると有効な要素だけを残すため、不正 category を持つ検出結果だけが黙って捨てられ、PII が Gemini に到達し得ます。

   **Fix:** `spans` を持つトップレベルオブジェクトが厳密に一つであり、その配列全体が schema に合格した場合だけ受理してください。複数候補や一件でも不正な span があれば retry／bisect／拒否に進め、空デコイ＋実 span、valid＋invalid 混在の攻撃テストを追加してください。

4. `agents/gateway/src/agent.ts:450-470`, `agents/gateway/src/agent.ts:806-810`, `agents/gateway/src/agent.ts:883-888`, `agents/gateway/src/server.ts:479-488`, `agents/gateway/src/pipeline.ts:182-185`

   **Defect:** concurrency 4 は再帰全体の上限ではありません。4 チャンクが同時に失敗すると、それぞれの bisection が独自の並列 map を開始し、実際の Gemma 呼び出しは 8、さらに次段では 16 まで増え得ます。また deadline の AbortSignal が extractor に渡らないため、504 応答後も既存 worker が残りのチャンクを投入し続けます。既知の「複数チャンクが同時に壊れる」ケースで、単一 GPU を過負荷にする可用性欠陥です。

   **Fix:** 再帰階層ではなく実際の Gemma 呼び出しを共有 semaphore／queue で全体最大4に制限してください。AbortSignal を抽出処理まで伝播し、deadline または最初の終端エラー後は新規タスクを dequeue しない設計にします。最大同時呼び出し数と abort 後の追加呼び出しゼロをテストしてください。

5. `tests/codex/pgw-masking.yaml:40-43`, `tests/codex/README.md:75-82`

   **Defect:** シナリオは送信時には `${PGW_NONCE}` を展開しますが、expect 側では literal の `ACK ${PGW_NONCE}` を待ちます。README 自身が pitty 1.2.2 は expect 内の環境変数を展開しないと説明しているため、この検証は「弱い」のではなく成功不能です。最終チェック用 `codex-e2e` のマスキング証拠として成立していません。

   **Fix:** シナリオを一時ファイルへ事前展開するか、PTY 出力を保存して harness 外で実際の nonce と厳密比較してください。固定 prefix のみ確認するなら、証明範囲をその水準に修正する必要があります。

6. `.just/tooling.just:167-176`, `skills/okf/OKF.md:88-92`, `knowledge/tags.yml:3-5`

   **Defect:** 文書は `lint-okf-tags` が `just check` に含まれるとしていますが、`check` の依存関係にも CI／lefthook にも組み込まれていません。現在のタグは単独 lint を通過しますが、未知タグを追加した変更が通常ゲートを通過できるため、「統制語彙を機械的に強制する」という judge-facing claim が誤りです。

   **Fix:** `lint-okf-tags` を `just check`、対応する CI ジョブ、可能なら knowledge 関連の lefthook に組み込んでください。未知タグを含む fixture が通常ゲートで失敗することも検証してください。

7. `docs/ARCHITECTURE.md:313-335`, `docs/ARCHITECTURE.ja.md:364-366`, `skills/pgw-logs/LOGS.md:240-245`

   **Defect:** 設計・運用文書が現行コードと食い違っています。API 表に `/v1/responses` がなく、Gateway の上限を 64 KiB／60秒と記載していますが、デプロイ値は 256 KiB／150秒です。また運用ガイドは Synthesis も 4096 token、抽出 concurrency は3で1 slotを予約するとしていますが、実装は Synthesis 1024、concurrency 4です。審査説明だけでなく、runaway generation や容量障害の診断を誤らせます。

   **Fix:** 英日両方の設計文書へ Responses API を追加し、コンパイル時既定値とデプロイ時 override を明確に区別してください。運用ガイドも Gateway 4096／Synthesis 1024、抽出4並列・予約 slotなしへ更新してください。

8. `packages/common/src/schema.ts:761-767`, `agents/gateway/src/responses_compat.ts:112-131`, `tests/codex/README.md:26-31`, `infra/terraform/locals.tf:91-102`, `docs/ARCHITECTURE.md:106-109`, `agents/gateway/tools/extraction-lab.ts:57-108`

   **Defect:** 容量説明は Codex の約147 KiB全体、とりわけ top-level tool schemas が抽出対象になる前提ですが、Responses 変換は `instructions` と message input だけをフラット化し、`tools` は受理後に無視します。実験ツールも tool schemas を本文へ埋め込んでおり、実際の wire payload から抽出対象を作る経路を再現していません。このため「約37回の Gemma 呼び出し」「cold heavy path が150秒超」という説明が、実リクエストの抽出量を根拠にしているか確認できません。

   **Fix:** 実 Codex 呼び出しで raw body bytes、フラット化後の forwarded text bytes、チャンク数を値を漏らさず計測し、文書と latency math をその実測値に合わせてください。extraction lab は完全な Responses payload を共通 schema／projection に通すか、単なる人工的ストレス fixture であることを明記してください。

VERDICT: 8 FINDINGS

## Round 9

1. `agents/gateway/src/agent.ts:954`, `docs/ARCHITECTURE.md:355`, `docs/ARCHITECTURE.ja.md:388`

Defect: `ExtractionSemaphore` は `extractUnstructured()` ごとに生成されるため、上限4はリクエスト単位であり、文書が主張するGPU全体のグローバル上限ではありません。同時2リクエストの再現ではGemma疑似呼び出しがピーク8並列になりました。Gatewayは同時40リクエストを受けるため、単一GPUの4 slotへ大量の処理を滞留させ、期限と可用性を予測不能にします。

Fix: Gatewayプロセスで共有する単一schedulerを作り、全リクエスト・retry・bisectionが同じ4 permitを取得するようにしてください。待機者ごとのAbortSignalを扱い、同時複数リクエストでも合計ピークが4以下になるテストを追加してください。

2. `agents/gateway/src/agent.ts:693`, `agents/gateway/src/agent.ts:793`, `agents/gateway/src/server.ts:452`

Defect: deadlineのAbortSignalはsemaphoreの待機キューにしか作用せず、実行中のADK/Ollama呼び出しには渡りません。`runAgentText()`はsignalなしで`runEphemeral()`を呼び、`extractChunk()`も`run(prompt)`しか渡していません。abortを10ms後に発火した再現でも抽出は約182ms後に正常完了しました。したがって「timeout aborts the work」というサーバコメントに反し、504後も最大120秒のGemma処理がGPUを占有し得ます。

Fix: 抽出関数を`run(prompt, signal)`契約にし、ADKのabort対応実行経路または直接のOllama呼び出しまで同じsignalを伝播してください。deadline後に実行中fetchが実際にabortされ、抽出処理が残らないことを実HTTPモックで検証してください。

3. `docs/ARCHITECTURE.md:321`, `docs/ARCHITECTURE.md:348`, `docs/ARCHITECTURE.ja.md:352`, `docs/ARCHITECTURE.ja.md:381`, `tests/codex/README.md:46`, `tests/codex/README.ja.md:44`, `skills/pgw-client/CLIENT.md:205`

Defect: 設計正本は150秒超への延長を「不採用」とし、デプロイ値も150秒と記載していますが、実装は`infra/terraform/locals.tf:133-136`で240秒です。Codex手順も依然「150秒を超える」と説明しており、審査者には現在の容量限界とタイムアウト挙動を誤って伝えます。

Fix: 英日アーキテクチャのデプロイ値と判断理由を240秒へ同期し、「240秒へ延長したが、59KB・15 chunkのfull Codex CLI経路は単一GPUでは依然サポート外」と明記してください。Codexテスト文書とクライアントskillも同じ境界へ統一してください。

VERDICT: 3 FINDINGS
