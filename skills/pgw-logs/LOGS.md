# Log investigation guide — Privacy Gateway fleet

Use this when debugging a request, a failed attestation, an A2A error, or a deploy.
Everything is keyed by **`request_id`** (UUIDv7, header `X-Request-ID`) and **`trace_id`**
(W3C traceparent). Get both from the API response headers / body, the web UI, or the OKF
`Gateway Answer` frontmatter (`request_id`, `trace_id`).

## 0. Ground rules

- Logs are one JSON object per line, filtered through a **typed allowlist** in
  `packages/common/src/logging.ts`. Only named fields — hashes, counts, enums, internal
  UUIDs — are emitted at all; anything else is **dropped**, and the dropped key _names_
  appear under `dropped_fields`. So a field you expect and cannot find is usually missing
  from the allowlist, not missing from the code. If you ever see raw PII in a log, that is
  a bug: report it.
- **There is no `error_message` field, and spans carry no exception message or stack.**
  An exception message routinely embeds the value that caused it, so only `error_class`
  and `error_code` are recorded. Locate a throw site by class plus `request_id`.
- Everything is keyed by `request_id`. **There is no `session_id`** — one server-generated
  request id per request is also the Token Vault key. Start from `request_id`, then widen
  to a time window.
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
| Cloud Run                                | `kill-switch`     | same; `just logs-kill-switch` filters to its decisions                                               | see §3                                   |
| Traces                                   | all               | Cloud Trace                                                                                          | see §4                                   |
| Audit artifacts                          | synthesis         | Firestore collections `gateway_answers` (OKF docs), `token_vault` (masked mapping, TTL `expires_at`) | `gcloud firestore` / console             |

Local pipe: `just dev 2>&1 | tee /tmp/pgw-dev.log`, then `just logs-local <request_id>`.

## 2. Endpoints (for reproducing / health)

| Service   | Path                                                | Purpose                                                                                                                            |
| --------- | --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| gateway   | `GET /healthz`                                      | liveness                                                                                                                           |
| gateway   | `POST /v1/ask` `{text}`                             | main entry; returns `request_id`, `trace_id`, masked prompt, ephemeral answer, OKF document. A body carrying `session_id` is a 400 |
| gateway   | `GET /v1/requests/:id`                              | the stored **masked** OKF evidence document                                                                                        |
| gateway   | `GET /v1/requests/:id/masked-prompt.md`             | the masked prompt Core received (an OKF `sources` target)                                                                          |
| gateway   | `GET /v1/requests/:id/core-response.md`             | Core's still-tokenized response (an OKF `sources` target)                                                                          |
| gateway   | `POST /v1/chat/completions`                         | OpenAI-compatible façade over the same pipeline; look for the `openai.compat.chat.*` events                                        |
| gateway   | `GET /v1/models`                                    | OpenAI-compatible model list; one id, `privacy-gateway`                                                                            |
| gateway   | `GET /v1/status`                                    | Gemma warm/cold plus the cold-start estimate; derived from a recorded timestamp, cached ~5s, and never wakes the GPU               |
| gateway   | `POST /v1/warmup`                                   | starts the GPU-backed Gemma service; look for `warmup.requested`. **Billed while the instance lives** (~15 idle minutes)           |
| core      | `GET /.well-known/agent-card.json`                  | A2A Agent Card (registry)                                                                                                          |
| core      | `POST /jsonrpc` (`message/send`)                    | A2A entry (IAM-protected on Cloud Run)                                                                                             |
| synthesis | `GET /.well-known/agent-card.json`, `POST /jsonrpc` | A2A                                                                                                                                |
| synthesis | `POST /v1/synthesize`                               | HTTP route used by gateway                                                                                                         |
| gemma     | `GET /v1/models`, `POST /v1/chat/completions`       | Ollama OpenAI-compatible API (internal ingress only)                                                                               |

Deployed gateway: `https://gateway-agent-turszib42q-uc.a.run.app` (the only public service).
Every Cloud Run URL: `just urls`. Liveness across all services: `just health`.
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

# every refused release, by reason
jsonPayload.event="request.refused"
# jsonPayload.refusal is one of: reserved_syntax | egress_guard | extraction_failed |
# vault_missing | vault_expired | vault_generation_mismatch | invented_token |
# unresolved_token | leak_check_failed | judge_flagged | judge_unavailable

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
just logs-refusals [reason]           # every refused release, or one gate
just logs-service synthesis-agent 30  # one service, errors, last 30 min
just logs-attest-failures             # failed leak checks
just logs-kill-switch                 # kill-switch decisions (triggered / under-budget / failures)
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

| event                             | agent     | meaning / what to check                                                                                                                                                                                                                                      |
| --------------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `request.start` / `request.end`   | gateway   | envelope; `duration_ms`, `status`                                                                                                                                                                                                                            |
| `mask.done`                       | gateway   | `placeholder_count` per category; 0 on PII-laden input ⇒ detector regression                                                                                                                                                                                 |
| `mask.gemma.unparseable`          | gateway   | the span extractor's answer could not be read; two of these ⇒ 502, request never reached Core                                                                                                                                                                |
| `mask.gemma.failed`               | gateway   | extractor transport failure ⇒ 502 immediately; the regexes cannot see names or addresses                                                                                                                                                                     |
| `request.refused`                 | gateway   | a gate refused; read `refusal` for which one and `categories` for the (category-level) detail                                                                                                                                                                |
| `request.rate_limited`            | gateway   | over the per-IP demo quota (`RATE_LIMIT_PER_MINUTE`)                                                                                                                                                                                                         |
| `warmup.requested`                | gateway   | a manual GPU wake was dispatched; spends money until the instance idles out                                                                                                                                                                                  |
| `judge.retry`                     | synthesis | the judge was re-asked once after an unevidenced flag over an attester-clean body; `verdict` is the second answer. Capped at one retry                                                                                                                       |
| `guard.egress.blocked`            | gateway   | raw PII would have left the boundary — request refused (correct behavior; inspect categories)                                                                                                                                                                |
| `a2a.core.send` / `a2a.core.recv` | gateway   | Core round-trip; `status`, `duration_ms`; 401/403 ⇒ IAM invoker binding / ID token audience                                                                                                                                                                  |
| `a2a.receive`                     | core      | inbound A2A request accepted; `placeholder_count`                                                                                                                                                                                                            |
| `guard.inbound.blocked`           | core      | Core's own guard refused a payload that still held raw PII (categories only)                                                                                                                                                                                 |
| `llm.gemini.call`                 | core      | model id, token counts; 404 ⇒ wrong `GEMINI_MODEL` (use `gemini-3.5-flash`)                                                                                                                                                                                  |
| `attest.verdict`                  | synthesis | `verdict: pass                                                                                                                                                                                                                                               | fail`, `findings` (categories only) |
| `judge.gemma`                     | synthesis | Gemma judge result. **Asymmetric**: `leak: true` or a null verdict blocks the release; `leak: false` adds no trust                                                                                                                                           |
| `release.ok`                      | synthesis | the answer was released; `tokens_resolved`, `withheld_count`                                                                                                                                                                                                 |
| `release.refused`                 | synthesis | no answer was released; `refusal` names the gate                                                                                                                                                                                                             |
| `okf.persist`                     | synthesis | Firestore write; permission errors ⇒ SA roles (`sa-synthesis` needs datastore.user)                                                                                                                                                                          |
| `openai.compat.chat.*`            | gateway   | the OpenAI-compatible façade: `.start`, `.end`, `.refused`, `.rejected`. Same pipeline and same gates as `/v1/ask`, so the `mask.*` / `guard.*` / `a2a.*` events for the request look identical — filter on these only to tell which surface the caller used |
| `config.invalid`                  | any       | zod env validation failed at boot; message lists the keys                                                                                                                                                                                                    |

## 6. Typical failure → first place to look

| Symptom                                  | Look at                                                                                                                                    |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Gateway 502/504                          | gateway `a2a.core.*` events; core service logs for the same `request_id`; core cold start (`gemma` not involved)                           |
| 4xx with no answer body                  | gateway `request.refused` / synthesis `release.refused`; `refusal` names the gate. This is the fleet working, not failing                  |
| Answer status `draft`, tier `unverified` | synthesis `attest.verdict` findings; the leak check doing its job — inspect what Core emitted (tokenized text is safe to read)             |
| Placeholders left in the released answer | expected for `API_KEY` / `AWS_KEY` / `JWT` / `CREDIT_CARD` / `MY_NUMBER`: the disclosure policy withholds them. See `attestation.withheld` |
| 409 `unresolved_token` / `vault_missing` | vault expiry (`stale_after` passed ⇒ TTL purged the mapping) or a generation mismatch; no answer is released either way                    |
| Gemma timeouts                           | `gemma-serving` logs (model load on cold start ≈ 30–60 s on the RTX PRO 6000); `--no-cpu-throttling`, min instances                        |
| 403 between services                     | `infra/terraform/iam.tf` bindings; token audience must be the callee's URL                                                                 |
| No trace / broken trace                  | `OTEL_ENABLED`, exporter errors in that service's logs (`event="otel.export.error"`)                                                       |

## 7. Firestore

- Console: `https://console.cloud.google.com/firestore/databases/-default-/data/panel/gateway_answers?project=all-thinkgs`
- `gateway_answers` docs are keyed by `request_id` and hold **only masked artifacts**:
  `okf` (the document, whose body is the masked answer), `masked_prompt`, `core_response`
  (still tokenized) and `expires_at`. The rehydrated answer is returned in one API
  response and is never stored — finding one here is a bug.
- Read `verified`, `status`, `stale_after`, `request_id`, `trace_id` and the top-level
  `attestation` block from the frontmatter. Replay a verdict with
  `just verify-answer <request_id>`.
- `token_vault` docs are masked-token → raw-value mappings with an `expires_at` TTL and a
  `generation` counter. They are inside the trust boundary; never copy their contents into
  a report.
