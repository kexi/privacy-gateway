# `@privacy-gateway/mcp`

Privacy-Preserving Gateway を 3 つのツールとして公開する
[MCP](https://modelcontextprotocol.io) stdio サーバ。エージェントは生の PII を
自分で保持することなく、信頼境界の向こうへリクエストを送り、生成された監査
ドキュメントを読み、その内容を独立に検証できる。

English version: [README.md](README.md).

## ツール

| tool           | 入力           | 返り値                                                                                                            |
| -------------- | -------------- | ----------------------------------------------------------------------------------------------------------------- |
| `pgw_ask`      | `{text}`       | `answer`, `masked_prompt`, `trust_tier`, `status`, `request_id`, `trace_id`, `leak_check`, `withheld`, `findings` |
| `pgw_evidence` | `{request_id}` | 保存されている **マスク済み** OKF v0.2 ドキュメントと、そこから導出した trust tier                                |
| `pgw_verify`   | `{request_id}` | 再実行した attestation: `ok`、digest ごとの `checks[]`、`independently_derived_findings`、`not_checked`           |

### 拒否はエラーではなく結果として返る

このフリートのゲートはすべて fail-closed であり、拒否はシステムが正しく動作した
ことを意味する。したがってツールは例外を投げず、次のような構造化ペイロードを返す:

```json
{
  "refused": true,
  "status": 422,
  "error": "outbound_guard_refused",
  "message": "raw PII survived masking",
  "categories": ["EMAIL", "PHONE"],
  "guidance": "A fail-closed gate refused this request. Explain the refusal to the user; do not retry or rephrase to get around it."
}
```

MCP のエラーとして投げると、モデルには「一時的な障害なのでリトライすべき」と
読めてしまう。プライバシーゲートをリトライで迂回することは、同じデータを同じ
境界の向こうへ送ろうとする二度目の試行にほかならない。各ツールの description にも
同じ注意を明記している。

### `pgw_verify` が実際に検証すること

gateway が配信する 2 つのマスク済み artifact を再ハッシュし、記録されている各
digest が 64 文字の小文字 hex であることを確認し、ドキュメントが自身を request id
に束縛していることを照合し、**書き写した** scanner で leak-check の verdict を
independently 再導出する。import ではなく書き写しである理由: フリート自身のコードで
再実行しても「フリートが自分自身と一致する」ことしか証明できないため。

`attester_sha256` と `computation_sha256` はフリートのリポジトリ内のファイルを
指しており、このサーバはそれを持たない。よって `not_checked` として報告し、
決して pass とはしない。この 2 つを比較するには、チェックアウト内で
`uv run clients/python/pgw.py verify <id>` を実行する。

## インストール

```sh
pnpm -r build          # または: pnpm --filter @privacy-gateway/mcp build
```

`pgw-mcp` を bin として宣言しているため、`node clients/mcp/dist/index.js` でも
`npx pgw-mcp` でも起動できる。

## 設定

| 変数              | 既定値                  | 意味                 |
| ----------------- | ----------------------- | -------------------- |
| `PGW_GATEWAY_URL` | `http://localhost:8081` | gateway のベース URL |

### Claude Desktop

`claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "privacy-gateway": {
      "command": "node",
      "args": ["/absolute/path/to/all-things-agentic-hackathon/clients/mcp/dist/index.js"],
      "env": {
        "PGW_GATEWAY_URL": "http://localhost:8081"
      }
    }
  }
}
```

### Claude Code

```sh
claude mcp add privacy-gateway \
  --env PGW_GATEWAY_URL=http://localhost:8081 \
  -- node /absolute/path/to/clients/mcp/dist/index.js
```

`claude mcp list` に `privacy-gateway` が表示され、3 つの `pgw_*` ツールが
セッション内で使えるようになる。

### Codex

`~/.codex/config.toml`:

```toml
[mcp_servers.privacy-gateway]
command = "node"
args = ["/absolute/path/to/clients/mcp/dist/index.js"]
env = { PGW_GATEWAY_URL = "http://localhost:8081" }
```

## 注意

- **stdout はプロトコル用のチャネル**。このパッケージは stdout に何も書かず、
  起動時の 1 行は stderr に出す。
- **リクエスト本文をログに出さない**。gateway は生の PII を境界内に留めるために
  存在しており、プロンプトを自前のログに出すクライアントはその漏洩を再導入して
  しまう。診断情報は request id のみを持つ。
- マスキングは **pseudonymization であって anonymization ではない**: placeholder は
  カテゴリと同一性を開示し、残存する準識別子により文脈からの再識別が起こりうる。

## 開発

```sh
pnpm --filter @privacy-gateway/mcp test        # vitest、gateway は fetch 層でモック
pnpm --filter @privacy-gateway/mcp typecheck
pnpm --filter @privacy-gateway/mcp lint
```
