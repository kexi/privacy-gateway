# Convergence loop record (2026-08-30 → 08-31)

Reviewer: Codex (gpt-5.6-sol, ultra). Coder: Claude (Opus executors, Fable orchestration).
Loop: review → fix → redeploy → re-review, until VERDICT: CONVERGED.

| Round | Findings | Nature | Fixed at |
|---|---|---|---|
| 3 | 4 | veto retry, ?key= in logs, GPU cap ineffective, stale proofs | 90a9bd8 |
| 4 | 6 | shim image drop, vault overclaim, positional verify, Gemma4 stragglers, DEVPOST wording, diagram | 90ddfc9 |
| 5 | 4 | documentation sync only | 019201f |
| 6 | 4 | doc/string sync only | 9cd9b47 |
| 7 | 0 | **VERDICT: CONVERGED** | — |

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

