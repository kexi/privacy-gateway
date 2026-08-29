# `@privacy-gateway/ollama-shim`

Privacy-Preserving Gateway を Claude Desktop のモデルピッカーから **モデルとして
選べる**ようにする localhost シム。ネイティブ Ollama API を話すクライアントからも
使える。

英語正本: [README.md](README.md)。

## 最初に調べたこと、そして設計が変わった理由

出発点にした前提はこうだった。_Ollama v0.33 で Claude Desktop がローカル Ollama の
モデルを一覧するようになったのだから、`localhost:11434` で `/api/tags` と
`/api/chat` に答えるシムを立てればピッカーに出るはずだ。_

**この前提は誤りで、これを土台にしたシムはピッカーに出ない。** v0.33 がやったのは
Claude Desktop に Ollama プロトコルを教えることではなく、Ollama を
**third-party gateway provider** として登録することだった。そして Claude の
third-party gateway が話すのは Ollama API ではなく **Anthropic Messages API** である。

| Claude Desktop が実際に呼ぶもの  | 用途                                 |
| -------------------------------- | ------------------------------------ |
| `GET /v1/models`                 | モデル discovery——ピッカーを構築する |
| `POST /v1/messages`              | 推論（SSE ストリーミング）           |
| `POST /v1/messages/count_tokens` | 任意。無ければ推論側にフォールバック |
| `HEAD /api/hello`                | 接続ウォーミング。無視してよい       |

出典:

- [Ollama v0.33 リリースノート](https://github.com/ollama/ollama/releases/tag/v0.33.0)
  ——「third-party **gateway provider** として Claude Desktop を設定できる」。
  _gateway provider_ であって _Ollama プロトコルのクライアント_ ではない、という
  文言そのものが今回の発見。
- [Anthropic gateway protocol reference](https://code.claude.com/docs/en/llm-gateway-protocol)
  ——正式な契約。`ANTHROPIC_BASE_URL` で選ばれた gateway は `/v1/messages`
  （＋任意の `/v1/messages/count_tokens`）を提供し、discovery は
  `GET /v1/models?limit=1000`、タイムアウト 3 秒・リダイレクト不可。
- [TrueFoundry: Claude Desktop & Cowork](https://www.truefoundry.com/docs/ai-gateway/claude-desktop)
  ——第三者ベンダによる同じ契約の記述。「アプリは Anthropic Messages API を実装した
  gateway に推論をルーティングする」、model 欄を空にすると「gateway の
  `GET /v1/models` を呼んでピッカーを構築する」。
- [ollama/ollama#15992](https://github.com/ollama/ollama/issues/15992)
  ——逆側からの裏取り。Desktop のログに `provider type 'gateway'`、`3P mode active`、
  そして `/v1/models` が 39 モデルを返したが **usable は 0** という症状。

### 間違えやすい帰結が 2 つある

**1. モデル id に `claude` か `anthropic` を含める必要がある。** discovery は
「id に `claude` または `anthropic` が含まれるエントリだけを残し、それ以外は無視する
（大文字小文字は区別しない）」。フリート本来の id である `privacy-gateway` はどちらも
含まないので、そのまま広告すると黙って除外される——上記の「usable 0」がまさにこの症状。
そこで Anthropic サーフェスはこう広告する。

```json
{ "id": "claude-privacy-gateway", "display_name": "Privacy Gateway (masked → Gemini)" }
```

この id は **ピッカー用のルーティングキーであって、モデルについての主張ではない**。
背後に Claude モデルは一切いない（Gateway は Gemma、Core は Gemini 3.5 Flash）。
表示名がそのことを明示している。

**2. Ollama.app のハンドシェイクは必須か。** _ワンタッチ_ の体験に限れば必須で、その
トグルは Ollama 自身が Desktop の third-party gateway 設定を書き込む処理である。
ただしハンドシェイクは **利便性であってゲートではない**。同じ設定は Desktop の
Developer 設定から手動で到達できる（Help → Troubleshooting → Enable Developer mode、
続いて Developer → Configure Third-Party Inference、接続種別 **Gateway**）。設定 UI が
検証したうえで
`~/Library/Application Support/Claude-3p/claude_desktop_config.json` に書き込む。
組織展開では MDM の `com.anthropic.claudefordesktop` ドメイン経由で同じ設定を配布する。
つまりこのシムに Ollama.app は不要で、ポート 11434 も不要である。必要なのは
**gateway base URL として名指しされること** だけ。

ポートを取るだけでは何も証明できないことはローカルで確認した。インストール済みの
Ollama（v0.24.0）は既に `POST /v1/messages` に対して 404 ではなく Anthropic 形式の
エラー（`{"type":"error","error":{"type":"invalid_request_error",…}}`）を返し、
`GET /v1/models` も提供している。つまり Ollama 自身も、自前の API ではなく
_Anthropic_ サーフェスで Desktop を満たしている。

### だからシムは両方のサーフェスを提供する

| サーフェス             | エンドポイント                                                                    | 使う相手                        |
| ---------------------- | --------------------------------------------------------------------------------- | ------------------------------- |
| **Anthropic Messages** | `GET /v1/models`、`POST /v1/messages`、`HEAD /api/hello`                          | **Claude Desktop**（ピッカー）  |
| **ネイティブ Ollama**  | `/api/tags`、`/api/show`、`/api/chat`、`/api/generate`、`/api/version`、`/api/ps` | `ollama` CLI とそのエコシステム |

1 プロセス・1 ポートで両プロトコル。どのクライアントがどちらを話すかを運用者が
意識しなくてよい。

## 起動

```bash
pnpm -C clients/ollama-shim build
pnpm -C clients/ollama-shim start          # 併存モード: 127.0.0.1:11435
```

| フラグ          | 効果                                                                        |
| --------------- | --------------------------------------------------------------------------- |
| _(なし)_        | **11435** を bind。本物の Ollama が 11434 を保持したまま併存できる          |
| `--takeover`    | **11434** を bind。先に Ollama.app を停止すること（さもなくば明示的に終了） |
| `--port <n>`    | 任意のポート。運用者が名指しした以上 `--takeover` より優先される            |
| `--host <addr>` | bind アドレス。既定 `127.0.0.1`——セキュリティ注記を参照                     |

`PGW_GATEWAY_URL` で上流 Gateway を差し替えられる（既定はデプロイ済み Gateway）。

takeover モードは `localhost:11434` を **ハードコード** したクライアント専用。
Claude Desktop はそれに当たらない（base URL を自分で指定するため）ので、こちらでは
併存モードが正しく、本物の Ollama もそのまま動き続ける。

## Claude Desktop から使う

1. Claude Desktop → **Help → Troubleshooting → Enable Developer mode**
2. **Developer → Configure Third-Party Inference**、接続種別 **Gateway**
3. Gateway base URL: `http://127.0.0.1:11435` / auth scheme `bearer` /
   キーは空でなければ何でもよい（シムは誰も認証しない——下記参照）

model 欄は空のままにする。そうすると Desktop が `GET /v1/models` に対して discovery を
実行し、**Privacy Gateway (masked → Gemini)** がピッカーに現れる。

> **正直な限界。** Ollama のワンタッチ機能が設定するのは _Ollama 自身_ を gateway と
> する構成だけである。第三者が Ollama の Apps 画面に自分を登録する公開 API は存在
> しないため、このシムは Desktop 側の third-party 設定から構成する——行き先は同じで、
> 手動で到達するという違いだけ。既に本物の Ollama が Desktop の gateway として登録
> されている場合、シムを指定するとそれを置き換える。代替は `--takeover` だが、
> Ollama.app を完全に停止する必要がある。

## デプロイ済み Gateway での実機確認

実際のトランスクリプト（シムは 11439、上流はデプロイ済み Gateway）。往復の中身は
フリート全体——マスク → Core（Gemini、プレースホルダのみ）→ leak check → 復元。

```console
$ curl -s http://127.0.0.1:11439/v1/messages -H 'content-type: application/json' \
  -d '{"model":"claude-privacy-gateway","max_tokens":300,"messages":[
       {"role":"user","content":"Customer Taro Yamada (taro@example.co.jp) reports a failed charge. Draft a one-sentence apology."}]}'

{"id":"msg_01a04acdc36f7b38be0727d9b9300196","type":"message","role":"assistant",
 "model":"claude-privacy-gateway",
 "content":[{"type":"text","text":"Dear Taro Yamada, please accept our sincere apologies for the
   inconvenience caused by the failed charge on your account, and we are working to resolve this
   issue as quickly as possible."}],
 "stop_reason":"end_turn","usage":{"input_tokens":0,"output_tokens":0}}
HTTP 200 in 2.98s
```

ネイティブサーフェス（NDJSON ストリーミング）:

```console
$ curl -s http://127.0.0.1:11439/api/chat -H 'content-type: application/json' \
  -d '{"model":"privacy-gateway:latest","messages":[{"role":"user","content":"…failed charge…"}]}'

{"model":"privacy-gateway:latest","message":{"role":"assistant","content":"Dear Taro Yamada, …"},"done":false}
{"model":"privacy-gateway:latest","message":{"role":"assistant","content":""},"done":true,"done_reason":"stop",…}
```

同じリクエストの evidence が示す、境界を越えて Core が実際に見たマスク済み
プロンプト:

```text
Customer ⟦PERSON_1⟧ (⟦EMAIL_1⟧) reports a failed charge. Draft a one-sentence apology.
```

両呼び出しに対するシムのログ。イベント名・id・所要時間だけで、本文は無い:

```json
{"severity":"INFO","agent":"ollama-shim","event":"shim.messages.start","request_id":"a13900bb-…","surface":"anthropic","stream":false,"message_count":1}
{"severity":"INFO","agent":"ollama-shim","event":"shim.upstream.ok","request_id":"01a04acd-c36f-…","surface":"anthropic","duration_ms":2974,"status":200}
```

## メンテナ向けチェックリスト（Claude Desktop、3 手順）

1. `pnpm -C clients/ollama-shim build && pnpm -C clients/ollama-shim start`
   ——`{"event":"shim.listening","port":11435}` を確認し、
   `curl -s localhost:11435/v1/models` が `claude-privacy-gateway` を返すことを確認する。
2. Desktop → Help → Troubleshooting → **Enable Developer mode** → Developer →
   **Configure Third-Party Inference** → 種別 **Gateway**、base URL
   `http://127.0.0.1:11435`、auth `bearer`、キー `unused`、**model 欄は空**。
3. Desktop を再起動し、ピッカーから **Privacy Gateway (masked → Gemini)** を選び、
   メールアドレスを含むメッセージを送る。通常どおり回答が返り、シムの stderr に
   `shim.upstream.ok` が出て **本文が一切出ていない** ことを確認する。

ピッカーに何も出ない場合、discovery が除外されたかタイムアウトしている。id に
`claude` が含まれているか、base URL が **リダイレクトしない** か（discovery は
リダイレクトを失敗とみなす）、`/v1/models` が 3 秒以内に応答するかを確認する。

## セキュリティ注記

- **ループバック限定。** 既定の bind は `127.0.0.1`。これは緩めてよい既定ではなく
  セキュリティ特性である——シムは誰も認証しないので、ルーティング可能な
  インタフェースに出したシムはフリートへの無認証プロキシになる。`--host` は
  コンテナ向けであり、使うなら前段に本物の認証を置くこと。
- **Vault に触れない。** 依存は `zod` のみ。`@privacy-gateway/common` を意図的に
  import していない（同パッケージは Firestore と ADK を引き込む）——ラップトップ側の
  プロセスがトークン Vault に到達できてはならないため。構造化ロガーを約 20 行
  ローカルに再実装しているのはこの理由による。
- **ログに本文が乗らない。** フィールドは型付き allowlist を通り、未登録の
  フィールドは破棄されて _キー名だけ_ が `dropped_fields` に記録される。
  プロンプト・回答・例外メッセージには乗る先が無い。
- **拒否は拒否のまま。** ゲートが拒否した場合、両サーフェスとも HTTP エラーを返し、
  カテゴリ所見と「the gateway refused; do not retry around a safety gate」という
  一文を伴う。拒否が「本文がたまたま謝罪文である 200」に化けることはない——
  区別できないモデルは再試行するし、プライバシーゲートを迂回する再試行は
  同じデータを同じ境界の向こうへ運ぼうとする 2 度目の試みだからである。
- **ストリーミングは framing であって逐次リリースではない。** どちらのサーフェスも
  content チャンクはちょうど 1 つ。leak check は _完全な_ Core 回答に対して走るので、
  生成しながらトークンを流すことは、リリース可否を決める判定より先にテキストを
  出してしまうことを意味する。
- **仮名化であって匿名化ではない。** プレースホルダはカテゴリと同一性を漏らし、
  残存する準識別子は文脈による再識別を許す。

## テスト

`pnpm -C clients/ollama-shim test`——21 件。両サーフェスの discovery 形状（id フィルタ
を含む）、フラット化と上流 `stream:false`、拒否のマッピング、SSE と NDJSON の framing、
解釈不能な上流応答の fail-closed 処理、ロガーの allowlist。
