# Gemma Serving (Ollama on Cloud Run GPU)

The OpenAI-compatible endpoint that the Gateway and Synthesis agents call through
`OllamaLlm`, the ADK `BaseLlm` adapter in `packages/common` registered for
`ollama/*` model names. It sits inside the trust boundary, so it is deployed with
`--ingress internal` and `--no-allow-unauthenticated`.

## Model choice

| Model                  | Size   | Use                                                                                                          |
| ---------------------- | ------ | ------------------------------------------------------------------------------------------------------------ |
| `gemma4:12b` (default) | ~8.1GB | The largest that comfortably fits an L4 (24GB VRAM). Needed for PII span extraction and leak-check accuracy. |
| `gemma4:e4b` (fallback) | ~3.3GB | When L4 quota is unavailable, or to shorten cold starts further.                                             |

Switch with the `gemma_model` Terraform variable (for example
`GEMMA_MODEL=gemma4:e4b just build gemma` then `just tf-apply gemma_model=gemma4:e4b`).
It applies to both build and
deploy: `build.sh` passes it as `--build-arg GEMMA_MODEL`, and `deploy.sh`
injects the same value as the `GEMMA_MODEL` environment variable.

## No-GPU fallback

If L4 quota does not come through in time, Gemma can be reached via a
**Vertex AI Model Garden** endpoint instead. This is a compromise and is
deliberately not the default.

The trade-off: this project's claim is that the model handling sensitive data is
self-hosted inside the trust boundary. Going through Model Garden sends raw,
pre-tokenization text to a Google-managed inference service. The boundary still
stays within the project, which is far better than sending it to an external
SaaS, but it is no longer the same strength of structural guarantee as
"Core (Gemini) only ever sees masked text". Always call out that difference in
the demo.

Full steps are in `docs/DEPLOY.md`, section "Fallback when no GPU is available".
