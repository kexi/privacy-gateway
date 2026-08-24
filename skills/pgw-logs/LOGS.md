# Log investigation guide — Privacy Gateway fleet

Use this when debugging a request, a failed attestation, an A2A error, or a deploy.
Everything is keyed by **`request_id`** (UUIDv7, header `X-Request-ID`) and **`trace_id`**
(W3C traceparent). Get both from the API response headers / body, the web UI, or the OKF
`Gateway Answer` frontmatter (`request_id`, `trace_id`).

## 0. Ground rules

- Logs are one JSON object per line. Never expect raw PII in logs — only `⟦TYPE_N⟧`
  placeholders, counts and hashes. If you see raw PII in a log, that is itself a bug: report it.
- Always start from `request_id`, then widen to `session_id`, then to time window.
- Prefer `gcloud logging read` (returns JSON you can `jq`) over the console for scripted digging.

## 1. Where the logs are

| Environment                              | Service           | Where                                                                                                | How to read                              |
| ---------------------------------------- | ----------------- | ---------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| Local (`just dev`)                       | gateway           | stdout, port **8081**                                                                                | terminal / `just dev` multiplexed output |
| Local                                    | core              | stdout, port **8082**                                                                                | same                                     |
| Local                                    | synthesis         | stdout, port **8083**                                                                                | same                                     |
| Local                                    | Gemma (Ollama)    | port **11434** (`GEMMA_BASE_URL=http://localhost:11434/v1`)                                          | `ollama logs` / stdout                   |
| Cloud Run (`all-thinkgs`, `us-central1`) | `gateway-agent`   | Cloud Logging, `resource.type="cloud_run_revision"`                                                  | see §3                                   |
| Cloud Run                                | `core-agent`      | same                                                                                                 |                                          |
| Cloud Run                                | `synthesis-agent` | same                                                                                                 |                                          |
| Cloud Run (GPU)                          | `gemma-serving`   | same (Ollama stdout)                                                                                 |                                          |
| Traces                                   | all               | Cloud Trace                                                                                          | see §4                                   |
| Audit artifacts                          | synthesis         | Firestore collections `gateway_answers` (OKF docs), `token_vault` (masked mapping, TTL `expires_at`) | `gcloud firestore` / console             |

Local pipe: `just dev 2>&1 | tee /tmp/pgw-dev.log`, then `just logs-local <request_id>`.

## 2. Endpoints (for reproducing / health)

| Service   | Path                                                | Purpose                                                                 |
| --------- | --------------------------------------------------- | ----------------------------------------------------------------------- |
| gateway   | `GET /healthz`                                      | liveness                                                                |
| gateway   | `POST /v1/ask` `{text, session_id?}`                | main entry; returns `request_id`, `trace_id`, masked prompt, OKF answer |
| gateway   | `GET /v1/sessions/:id/answer`                       | OKF markdown of the answer                                              |
| gateway   | `GET /v1/sessions/:id/tier`                         | derived trust tier                                                      |
| gateway   | `POST /v1/sessions/:id/approve`                     | adds `human:<id>` to `verified`                                         |
| core      | `GET /.well-known/agent-card.json`                  | A2A Agent Card (registry)                                               |
| core      | `POST /jsonrpc` (`message/send`)                    | A2A entry (IAM-protected on Cloud Run)                                  |
| synthesis | `GET /.well-known/agent-card.json`, `POST /jsonrpc` | A2A                                                                     |
| synthesis | `POST /v1/synthesize`                               | HTTP route used by gateway                                              |
| gemma     | `GET /v1/models`, `POST /v1/chat/completions`       | Ollama OpenAI-compatible API (internal ingress only)                    |

Cloud Run URLs: `just urls`. Liveness across all services: `just health`.
Agent Card for one service: `just agent-card <service>` (both attach the ID token that
IAM-protected services require; the audience must be the callee's URL).

## 3. Cloud Logging

Console (Logs Explorer), project `all-thinkgs`:
`https://console.cloud.google.com/logs/query?project=all-thinkgs`

Queries (paste into Logs Explorer or use with `gcloud logging read '<query>'`):

```text
# one request across all three agents
resource.type="cloud_run_revision"
jsonPayload.request_id="<request_id>"

# one session (multiple requests, approvals)
resource.type="cloud_run_revision"
jsonPayload.session_id="<session_id>"

# a single service, errors only
resource.type="cloud_run_revision"
resource.labels.service_name="synthesis-agent"
severity>=ERROR

# attestation failures (leak check)
jsonPayload.event="attest.verdict" AND jsonPayload.verdict="fail"

# Cloud Run platform errors (cold start, OOM, 5xx) for a service
resource.type="cloud_run_revision" resource.labels.service_name="gemma-serving"
logName:"run.googleapis.com%2Fvarlog%2Fsystem" OR severity>=WARNING
```

CLI -- use the recipes rather than retyping the queries:

```sh
just logs-request <request_id>        # one request across all agents
just logs-session <session_id>        # one session
just logs-service synthesis-agent 30  # one service, errors, last 30 min
just logs-attest-failures             # failed leak checks
```

Each recipe wraps `gcloud logging read` with the query above and pipes it through
`jq` into one compact object per line. `LOG_FRESHNESS` (default `2h`) sets the window.

Direct link to one request's logs: `just logs-url <request_id>`.

## 4. Cloud Trace (one request = one trace across gateway → core → synthesis)

- One trace: `just trace-url <trace_id>` prints the console URL.
- List: `https://console.cloud.google.com/traces/list?project=all-thinkgs`
- Logs carry `logging.googleapis.com/trace = projects/all-thinkgs/traces/<trace_id>` so Logs Explorer's
  "View trace" and Trace's "Logs" tab cross-link. If a hop is missing from the trace, `traceparent`
  propagation broke at that hop — check the `a2a.core` / `synthesis.call` spans' parent ids.

Expected span tree (names are stable identifiers):
`request` → `mask.regex` → `mask.gemma` → `guard.egress` → `a2a.core` (→ core `a2a.receive` → `llm.gemini`)
→ `synthesis.call` (→ `attest.leak_check` → `judge.gemma` → `rehydrate` → `okf.build` → `persist`).

## 5. Log event vocabulary and error codes

Canonical list: `docs/OBSERVABILITY.md` (English) / `docs/OBSERVABILITY.ja.md`. Key events:

| event                             | agent     | meaning / what to check                                                                       |
| --------------------------------- | --------- | --------------------------------------------------------------------------------------------- |
| `request.start` / `request.end`   | gateway   | envelope; `duration_ms`, `status`                                                             |
| `mask.done`                       | gateway   | `placeholder_count` per category; 0 on PII-laden input ⇒ detector regression                  |
| `guard.egress.blocked`            | gateway   | raw PII would have left the boundary — request refused (correct behavior; inspect categories) |
| `a2a.core.send` / `a2a.core.recv` | gateway   | Core round-trip; `status`, `duration_ms`; 401/403 ⇒ IAM invoker binding / ID token audience   |
| `a2a.receive`                     | core      | inbound A2A request accepted; `placeholder_count`                                             |
| `guard.inbound.blocked`           | core      | Core's own guard refused a payload that still held raw PII (categories only)                  |
| `llm.gemini.call`                 | core      | model id, token counts; 404 ⇒ wrong `GEMINI_MODEL` (use `gemini-3.5-flash`)                   |
| `attest.verdict`                  | synthesis | `verdict: pass                                                                                | fail`, `findings` (categories only) |
| `judge.gemma`                     | synthesis | Gemma judge result; parse failures ⇒ `OllamaLlm` JSON mode / model not pulled                 |
| `rehydrate.done`                  | synthesis | `tokens_resolved`, `tokens_unknown` (>0 ⇒ Core invented a placeholder ⇒ consistency fail)     |
| `okf.persist`                     | synthesis | Firestore write; permission errors ⇒ SA roles (`sa-synthesis` needs datastore.user)           |
| `config.invalid`                  | any       | zod env validation failed at boot; message lists the keys                                     |

## 6. Typical failure → first place to look

| Symptom                                      | Look at                                                                                                                                |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Gateway 502/504                              | gateway `a2a.core.*` events; core service logs for the same `request_id`; core cold start (`gemma` not involved)                       |
| Answer status `draft`, tier `unverified`     | synthesis `attest.verdict` findings; this is the leak check doing its job — inspect what Core emitted (tokenized text is safe to read) |
| Placeholders left unresolved in final answer | `rehydrate.done.tokens_unknown`; vault expiry (`stale_after` passed ⇒ vault TTL purged mapping)                                        |
| Gemma timeouts                               | `gemma-serving` logs (model load on cold start ≈ 30–60 s on L4); `--no-cpu-throttling`, min instances                                  |
| 403 between services                         | `infra/iam.sh` bindings; token audience must be the callee's URL                                                                       |
| No trace / broken trace                      | `OTEL_ENABLED`, exporter errors in that service's logs (`event="otel.export.error"`)                                                   |

## 7. Firestore

- Console: `https://console.cloud.google.com/firestore/databases/-default-/data/panel/gateway_answers?project=all-thinkgs`
- Answers are OKF documents: read `verified`, `status`, `stale_after`, `request_id`, `trace_id` from the frontmatter.
- `token_vault` docs are masked mappings with `expires_at` TTL — they are inside the trust boundary; never copy their contents into a report.
