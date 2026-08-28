# Deployment proof

Evidence captured from the live deployment on **2026-08-28**, project `all-thinkgs`,
region `us-central1`. A Japanese version is at [README.ja.md](./README.ja.md).

Everything here is **masked**. The rehydrated answer contains real PII, is returned in a
single API response and is never stored — so it was stripped before these files were
written. Only placeholders (`⟦PERSON_1⟧`, `⟦EMAIL_1⟧`, `⟦PHONE_1⟧`), digests and category
counts survive.

## The proof run

| Field        | Value                                  |
| ------------ | -------------------------------------- |
| `request_id` | `01a043e6-afe3-7552-8c20-1f0b7f0a1831` |
| `trace_id`   | `8a3a4d14714ea9699a77fe46466b1e36`     |
| `trust_tier` | `machine-confirmed`                    |
| `status`     | `stable`                               |
| Latency      | 8.35 s end to end (warm Gemma)         |

Request sent to the public Gateway:

> Draft a short polite status update for customer Taro Yamada (taro@example.com,
> 090-1234-5678) telling him his order shipped.

Masked before it left the trust boundary:

> Draft a short polite status update for customer ⟦PERSON_1⟧ (⟦EMAIL_1⟧, ⟦PHONE_1⟧)
> telling him his order shipped.

## Files

| File                    | What it shows                                                                                |
| ----------------------- | -------------------------------------------------------------------------------------------- |
| `gateway-answer.json`   | The full API response with `answer` removed. Masked prompt, attestation, consistency, stats. |
| `gateway-answer.okf.md` | The OKF v0.2 `Gateway Answer` document, whose body holds the **masked** answer.              |
| `logs-request.jsonl`    | Structured logs for the one `request_id`, showing all three agents on the same id.           |
| `trace-spans.json`      | The Cloud Trace trace: 24 spans across gateway → core → synthesis.                           |
| `sa-core-iam.txt`       | Core's service account roles — **no Firestore role**.                                        |
| `fleet-state.txt`       | Ingress, min/max instances, service accounts, and the attached GPU.                          |

### Later runs (2026-08-27/28)

| File                                     | What it shows                                                                        |
| ---------------------------------------- | ------------------------------------------------------------------------------------ |
| [`kill-switch.md`](./kill-switch.md)     | A **live** kill-switch fire: what stopped, what did not, and two open defects.       |
| [`openai-compat.md`](./openai-compat.md) | `/v1/chat/completions` against production, plus the advisory-judge regression.       |
| [`mcp.md`](./mcp.md)                     | The MCP stdio server driven against production: `pgw_ask` + `pgw_verify` transcript. |

## Open defects found while capturing the above

Recorded here so the evidence is not read as an all-green report. Details and log
excerpts are in the linked documents.

1. **The advisory Gemma judge vetoes its own placeholders.** Any answer containing
   `⟦TYPE_N⟧` is refused with `judge_flagged` (`leak: true`, `categories: []`), so
   `just smoke` currently fails and most real requests are refused. The deterministic
   attester still passes these answers, so the fleet is failing _closed_, not leaking —
   but it is demo-blocking. The judge code is unchanged since the first commit;
   `serving/gemma/Dockerfile` is `FROM ollama/ollama:latest` (**unpinned**) and the
   running Ollama 0.33.1 serves gemma3 under `--chat-template chatml --no-jinja`, which
   is the leading hypothesis. See [`openai-compat.md`](./openai-compat.md).
2. **The kill switch revokes public access but never caps the GPU.** `scaleToZero`
   fails against `gemma-serving`, and because the handler returns `500` to force
   redelivery, it re-revokes the gateway binding every ~30 s until the 600 s Pub/Sub
   retention window drains — which blocks operator restore. See
   [`kill-switch.md`](./kill-switch.md).

## What the evidence establishes

**The masking is real.** `stats.counts_by_category` records `PERSON: 1, EMAIL: 1, PHONE: 1`,
and `masked_prompt` shows the placeholders that replaced them. This is
**pseudonymization, not anonymization**: the placeholders still disclose category and
equality, and surviving quasi-identifiers permit contextual re-identification.

**The leak check is machine-decided.** `verified[].by` is
`process:leak-check@8b427a667e64` — a TypeScript regex attester, never an LLM actor.
`dimensions.review_identity` is `none`, because the public gateway authenticates nobody and
so nothing can name a human reviewer. `trust_tier: machine-confirmed` means leak-policy only;
it is **not** a factual validation of the answer.

**Core is structurally blind to the vault.** `sa-core-iam.txt` lists only
`roles/aiplatform.user`, `roles/cloudtrace.agent` and `roles/logging.logWriter`. The absence
of any `roles/datastore.*` line is the guarantee — enforced by IAM, not by the package graph.

**One request, one trace, three agents.** `logs-request.jsonl` shows `gateway-agent`,
`core-agent` and `synthesis-agent` all logging under the same `request_id`, and
`trace-spans.json` is a single trace covering the whole path. `gemma-serving` served two
calls inside the request window (masking at `15:46:27`, the advisory judge at `15:46:34`),
each `200`.

## Known gaps

- **No `llm.gemini` span.** The trace records the `a2a.core` hop, but Core's internal Gemini
  call is not exported as its own span, so the Gemini latency is not separately visible.
- **`just verify-auth` and `just verify-auth-internal` did not complete.** See
  "Deviations" in the deploy report; the boundary was instead confirmed by direct probes
  (every private service refuses a request from outside the VPC) and by the `internal`
  ingress settings in `fleet-state.txt`.
