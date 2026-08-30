# Gemma Serving (Ollama on Cloud Run GPU)

Gateway / Synthesis Agent が `OllamaLlm`（`packages/common` にある ADK `BaseLlm`
アダプタ。`ollama/*` のモデル名に登録）から叩く OpenAI 互換エンドポイント。
信頼境界の内側に置くため `--ingress internal` + `--no-allow-unauthenticated`。

## モデル選択

| モデル              | サイズ   | 用途                                                                      |
| ------------------- | -------- | ------------------------------------------------------------------------- |
| `gemma4:12b` (既定) | 約 8.1GB | L4 (VRAM 24GB) に収まる最大級。PII スパン抽出と leak check の精度が要件。 |
| `gemma4:e4b` (退避) | 約 3.3GB | L4 quota が取れない、またはコールドスタートを更に縮めたい場合。           |

切り替えは Terraform 変数 `gemma_model` で行う
（例: `GEMMA_MODEL=gemma4:e4b just build gemma` のあと
`just tf-apply gemma_model=gemma4:e4b`）。
ビルドとデプロイの両方に効く。`build.sh` は `--build-arg GEMMA_MODEL` として渡し、
`deploy.sh` は同じ値を `GEMMA_MODEL` 環境変数として注入する。

## GPU なしの退避策 (フォールバック)

L4 quota がハッカソン期間中に下りなかった場合、Gemma を **Vertex AI Model Garden**
のエンドポイント経由で使う手がある。ただしこれは*妥協*であり、既定にはしない。

トレードオフ: 本プロジェクトの主張は「機微データを扱うモデルは信頼境界の内側で
自前ホストする」こと。Model Garden 経由にすると、トークン化前の生テキストが
Google のマネージドな推論サービスに出ていく。境界はプロジェクト内に留まるので
外部 SaaS に出すよりはるかにマシだが、「Core (Gemini) にはマスク済みしか渡さない」
という構造的保証と同じ強度ではなくなる。デモでは必ずこの差分を明示すること。

詳細な手順は `docs/DEPLOY.md` の「GPU が取れない場合」を参照。
