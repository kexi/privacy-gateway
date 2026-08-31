# Extraction at Codex scale — design (external reviewer, adopted as roadmap)

> Produced by the external design reviewer (Codex gpt-5.6-sol, ultra) on 2026-08-31,
> from live measurements of this fleet. Status: accepted as the post-submission
> roadmap for making the full `codex-e2e` path pass within the interactive budget.
> The shipped mitigations (distinct-once contract, chunking + bisection, tolerant
> parsing, span cache, concurrency cap) are the first steps of this design.

## 推奨案：Coverage-carrying scan manifest

結論として、classifierでコードを除外するのではなく、次の構成が最も安全かつ150秒に入る可能性が高いです。

```text
Responses request
  → Geminiへ実際に転送するテキストだけをmanifest化
  → 安定したscan unitへ分割
  → 10–12KBずつbatch
  → Gemma 4 12B × 最大4並列
     JSON Schema制約付き抽出
  → batch完全性・文字列一致を独立検証
  → offset/categoryだけキャッシュ
  → masking
  → Core
```

### 1. 「HTTP body」ではなく「forwarding manifest」を走査対象にする

`tools`、`reasoning`、`prompt_cache_key`など、GatewayがGeminiへ転送しないフィールドは抽出対象にしません。これはコード判定によるスキップではなく、そもそもegressしないデータの除外です。

`instructions`と実際にforwardするmessage textを、flatten前に個別のmanifest entryとして保持します。

```ts
type ScanUnit = {
  id: string;
  text: string;
  leftContext: string;
  rightContext: string;
};
```

最初に計測すべき値は147KBのContent-Lengthではなく、`forwarded_text_bytes`です。Codexのtool schemaが大部分なら、実抽出量はかなり小さくなる可能性があります。

最終的に、manifestから構築した文字列と、masking前にCoreへ送ろうとしている文字列が完全一致しなければfail closedにします。これで「走査されなかったテキストがGeminiへ流れる」経路を構造的に塞げます。

### 2. 安定した小unitを、10–12KBの推論batchへ詰める

キャッシュ単位と推論単位を分離します。

- キャッシュ単位：message/source境界を尊重した約1–2KB
- 推論単位：複数unitを束ねた10–12KB
- 各unitに128–256文字の左右haloを付与
- halo内で見つかったspanは、開始位置を所有する中央unitだけが採用
- すべてのunitをGemmaへ渡す。コード、コメント、JSON Schemaも除外しない

これにより、会話末尾が増えても静的なinstructionsや過去のmessageのhashが変わりません。現在の「flatten後の固定chunk hash」よりwarm hit率が安定します。

### 3. ADKのJSON modeではなく、JSON Schemaで生成を拘束する

今回の120秒級は、12KBのprefillより、契約を外したGemmaが最大トークン近くまでコードや壊れたJSONを生成している可能性が高いです。OllamaはJSON Schemaを`format`へ渡すstructured outputを正式にサポートし、temperature 0も推奨しています。[Ollama Structured Outputs](https://docs.ollama.com/capabilities/structured-outputs)

Extractorだけは、Gateway内の安全プリミティブとしてOllamaのstructured-output機能を直接使うか、`OllamaLlm`を拡張してADKのresponse schemaをそのまま変換します。

出力はbatch全体の単なる`spans[]`ではなく、unitごとのcoverageを要求します。

```json
{
  "units": [
    {
      "id": "u_01",
      "spans": [{ "text": "Jane Smith", "category": "PERSON" }]
    },
    {
      "id": "u_02",
      "spans": []
    }
  ]
}
```

受理条件は以下のすべてです。

- 要求したunit ID集合と応答のID集合が完全一致
- 重複、欠落、未知IDなし
- categoryはallowlist内
- span textが対応するunit＋haloに完全一致
- `done === true`
- token limit終了ではない
- response全体がZod schemaを通る

Ollamaのレスポンスには`done_reason`、`prompt_eval_duration`、`eval_duration`、各token countがあるため、120秒がprefillか暴走生成かを直接判別できます。[Ollama Chat API](https://docs.ollama.com/api/chat)

`num_predict`は、通常batchなら512程度から始めます。上限到達、欠落、検証失敗はbatchをunit境界で二分します。singletonでも失敗したらリクエスト全体を拒否します。

NDJSONの部分成功は採用しません。途中まで正常でも、未出力unitにPIIがある可能性があるためです。

### 4. モデルには値を返させるが、キャッシュには値を置かない

Gemmaにoffsetを数えさせるのは避けます。Unicode、改行、UTF-16/UTF-8差、重複文字列で壊れやすいためです。

Gemmaには従来どおりexact valueを返させ、Gatewayが決定論的にoffsetへ変換します。その直後にモデル出力の値を破棄し、LRUには次だけを保持します。

```text
key:
  SHA-256(
    model digest
    + extractor prompt/schema version
    + categories
    + central text
    + halo
  )

value:
  [{ start, end, category }]
```

cache hit時は、現在のrequest textから値を再構成してTTL vaultへ入れます。これならキャッシュに以前のrequestの名前や住所を保持しません。モデル更新・prompt更新時の誤った再利用も防げます。

### 5. 並列数はリクエスト単位でなくGPU全体で4

各リクエストがそれぞれ4並列を開始すると、同時に2件来ただけで8本が4 slotへ積まれ、150秒deadlineが予測不能になります。

Gateway全体で4 permitのschedulerを持ちます。

- 大規模Responses requestは同時に1件だけadmit
- 受理時に残りdeadlineから全batchを完走可能か推定
- 間に合わないなら処理開始前に`503 Retry-After`
- 1 batchが失敗したら、兄弟batchもAbortSignalで中止
- deadline後にGemma処理が残る「zombie extraction」を作らない
- Core/Synthesis用に少なくとも30–40秒を予約

これは150秒達成に、chunk size変更以上に重要です。

## レイテンシ概算

147KBすべてがforward対象だった場合でも、

- 147 / 12 ≈ 13 batch
- 4 slotなので4 wave
- structured output後のcodex-like 12KB batchを、4並列時p95で20–25秒以内に抑える
- 抽出：80–100秒
- 1回だけのbisection余裕：15–20秒
- Core＋Synthesis：25–35秒
- 合計：120–150秒

tool schema除外後のforward manifestが例えば60KBなら5 batch、2 waveなので、抽出は40–50秒程度まで下がります。

ただし、この数字はstructured outputによって120秒の大部分を占める無効な長文生成が消えることが前提です。採用判定は、4本同時のcodex-like 12KBについて次を満たすことにします。

```text
max-wave p95 <= 25s
eval_countが設定上限より十分小さい
schema failure率がほぼ0
```

PII密度が極端に高い147KBは、出力token量だけで150秒を超え得ます。これは単一GPU・12B・全走査という条件では保証不能なので、その場合は安全にtimeout/refusalします。

## 採用しない案

- Regex/classifierでコードを除外：コメント、文字列、fixture中の実名を見逃すため不可
- Small modelでemptyなら12Bを省略：small modelのfalse negativeがそのまま漏洩になる
- Small modelと12Bの投機並列：12Bも全textを見るならcritical pathを短縮しない
- 26B：構文逸脱はschemaで解決でき、26Bは単一GPUでレイテンシを悪化させる
- モデル生成offset：位置計算が不安定
- NDJSONの部分受理：未完了領域を安全と認定できない

KV cacheは追加の最適化としては試せますが、予算計算には入れません。llama.cppはprompt cacheを標準で持ち、Gemma 4のSWA cache問題も2026年4月に修正されていますが、4 slotへの割当とOllama側の採用バージョンに依存します。[llama.cpp server options](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md)、[Gemma 4 cache fix](https://github.com/ggml-org/llama.cpp/pull/22288)

## フォールバック

structured output化後も4並列12KBのp95が25秒を超えるなら、同じ安全設計のままCodex Responses surfaceだけcold deadlineを240秒へ上げます。Codex側のrequest timeoutも合わせ、warm callはunit cacheで高速化します。

その場合もclassifier skip、小型モデルへの自動降格、部分結果のreleaseは行いません。150秒が絶対条件なら、安全に残る選択肢はcold requestの拒否かGPU/model条件の変更だけです。

ファイルは変更していません。
