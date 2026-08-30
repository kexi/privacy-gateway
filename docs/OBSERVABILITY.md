# Observability

How to follow one request across the fleet, and what every log event and error
code means. The companion investigation guide is `skills/pgw-logs/LOGS.md`
(agent-facing); this document is the canonical vocabulary both refer to.

Japanese version: [OBSERVABILITY.ja.md](OBSERVABILITY.ja.md).

## 1. The two identifiers

| Identifier   | Where it comes from                                       | Where it appears                                                                      |
| ------------ | --------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `request_id` | a UUIDv7 minted by the Gateway, one per request           | every log line, the `X-Request-ID` response header, the API body, the OKF frontmatter |
| `trace_id`   | W3C `traceparent`, or Cloud Run's `X-Cloud-Trace-Context` | every log line, the API body, the OKF frontmatter, Cloud Trace                        |

`request_id` is a **UUIDv7**: its leading 48 bits are a millisecond timestamp, so
sorting a result set by it also sorts by time. It is always minted server-side by
the Gateway and used as-is as the Token Vault key. An inbound `X-Request-ID`
header is echoed back on the response for correlation, but it is **never
adopted** as the request's own id: the id is the vault key, and a caller who
could choose it could name another request's mapping and read its
placeholders back. There is no `session_id` anywhere in this system — see
`ARCHITECTURE.md` §2 for why sessions were removed entirely.

Both ids reach the user: the web UI shows them with copy buttons, the API returns
them in the body, and the Python client prints them. A bug report that quotes
either one is enough to find everything below.

## 2. Following a request

```
request_id  ─┬─▶ Logs Explorer: jsonPayload.request_id="<id>"   (all three services)
             └─▶ the OKF answer document's frontmatter

trace_id    ─┬─▶ Cloud Trace: one trace, gateway → core → synthesis
             └─▶ Logs Explorer "View trace" (via logging.googleapis.com/trace)
```

1. **Start from `request_id`.** One query returns every line from all three
   services, in order — it is the only correlation id this system has, since
   there is no session to widen the search to.
2. **Switch to `trace_id`** for latency: which hop was slow, and where the time
   went inside it.

Direct links (project `all-thinkgs`):

- Logs for one request:
  `https://console.cloud.google.com/logs/query;query=jsonPayload.request_id%3D%22<request_id>%22?project=all-thinkgs`
- One trace:
  `https://console.cloud.google.com/traces/list?project=all-thinkgs&tid=<trace_id>`

The UI renders both links next to the ids it displays, so the common case needs
no hand-assembled URL.

```bash
gcloud logging read 'resource.type="cloud_run_revision" jsonPayload.request_id="<request_id>"' \
  --project all-thinkgs --freshness=2h --order=asc --format=json \
  | jq -c '.[] | {t:.timestamp, svc:.resource.labels.service_name, ev:.jsonPayload.event, ms:.jsonPayload.duration_ms}'
```

## 3. Log format

One JSON object per line on stdout (stderr for `ERROR`), which Cloud Run ingests
as a structured entry without a sidecar.

### A typed allowlist, not recursive scrubbing

Log fields are filtered against a **typed allowlist** (`packages/common/src/logging.ts`),
not scrubbed. The previous design ran the tokenizer's own regexes over log values —
but those regexes never saw a personal name or a postal address (that is Gemma's job,
upstream), so an exception message or a fragment of a response body could carry either
straight into a log line unmasked. The allowlist instead names every field a log line
may carry and the shape it is coerced into; anything not on the list is **dropped
entirely**, and the dropped key _names_ (never their values) are recorded under
`dropped_fields`, so a developer who adds a new field and forgets the allowlist sees a
visible gap instead of a silently missing log line.

| Field kind    | Meaning                                                      | Example fields                                                                                                                                                                                                                                                                              |
| ------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`          | internal UUIDs / span & trace ids, minted server-side        | `request_id`, `trace_id`, `span_id`                                                                                                                                                                                                                                                         |
| `enum`        | a value drawn from a closed set in the code                  | `agent`, `event`, `severity`, `model`, `status`, `verdict`, `trust_tier`, `document_status`, `freshness`, `hop`, `path`, `method`, `error_code`, `error_class`, `refusal`, `vault_backend`, `time`                                                                                          |
| `number`      | a finite number                                              | `duration_ms`, `attempt`, `port`, `placeholder_count`, `masked_count`, `unstructured_spans`, `span_count`, `tokens_resolved`, `tokens_unknown`, `withheld_count`, `vault_generation`, `body_bytes`, `finding_count`, `text_length`, `tokens_withheld`, `term_count`, `surviving_term_count` |
| `boolean`     | true/false                                                   | `ok`, `leak`, `stale`                                                                                                                                                                                                                                                                       |
| `string_list` | an array of short strings, each truncated to 128 chars       | `finding_kinds`, `categories`, `findings`, `withheld`, `unresolved_tokens`, `invented_tokens`, `issues`                                                                                                                                                                                     |
| `count_map`   | an object of `{category: number}`                            | `counts_by_category`                                                                                                                                                                                                                                                                        |
| `hash`        | a hex digest, treated like an `enum` (truncated, not parsed) | `response_hash`, `masked_prompt_hash`, `attester_sha256`, `computation_sha256`                                                                                                                                                                                                              |

Everything else a caller-controlled value could reach — a prompt, a response
fragment, an exception message, a header value — is not on the allowlist and is
dropped. There is no field for "free text supplied by a caller"; the list is
closed by design.

| Field                           | Always       | Meaning                                           |
| ------------------------------- | ------------ | ------------------------------------------------- |
| `severity`                      | yes          | `DEBUG` / `INFO` / `WARNING` / `ERROR`            |
| `message`                       | yes          | human-readable text; equals `event` for events    |
| `time`                          | yes          | ISO 8601 UTC                                      |
| `agent`                         | yes          | `gateway` / `core` / `synthesis`                  |
| `event`                         | events       | the stable identifier from §4                     |
| `request_id`                    | mostly       | correlation id                                    |
| `trace_id`, `span_id`           | when tracing | raw ids, for local use                            |
| `logging.googleapis.com/trace`  | on GCP       | `projects/<project>/traces/<trace_id>`            |
| `logging.googleapis.com/spanId` | on GCP       | links the line to its span                        |
| `duration_ms`                   | timed        | elapsed milliseconds                              |
| `error_code`, `error_class`     | errors       | see §6; **never `error_message`** — see below     |
| `dropped_fields`                | when needed  | names of keys that were dropped, not their values |

**No raw PII, ever — because it is never on the allowlist to begin with, not
because it was masked.** Identifier-like keys (`request_id`, `trace_id`, `verdict`,
`trust_tier`, `status`, `model`, …) pass through unmasked, because masking them
would make correlation impossible; they carry no PII by construction (they are
minted server-side or drawn from a closed enum). **Raw PII in a log is itself a
bug — report it.**

### `error_class` / `error_code`, never `error_message`

`errorFields()` (`packages/common/src/logging.ts`) emits `error_class` (the
exception's constructor name) and `error_code` (a stable code, defaulting to the
class name), and **deliberately never** an `error_message`. An exception message
routinely embeds the value that caused it — a response body, a prompt fragment, a
header — and no masking pass can be trusted to catch a name or an address inside
one. The class, the code, and the `request_id` that ties the line to the rest of
the request are enough to locate the throw site.

The same rule applies to spans: `withSpan()` (`packages/common/src/telemetry.ts`)
records `error.class` and `error.code` as span attributes on failure, and
**`span.recordException()` is not used anywhere in this codebase** — it copies
`exception.message` and `exception.stacktrace` onto the span verbatim, which is
exactly the leak this design avoids.

## 4. Event vocabulary

Event names are stable identifiers; queries and dashboards depend on them.

### Gateway

| event                    | severity      | meaning / what to check                                                                                                                                                                                          |
| ------------------------ | ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `request.start`          | INFO          | envelope open; carries `method`, `path`                                                                                                                                                                          |
| `request.end`            | INFO          | envelope close; `duration_ms`, `document_status`, `trust_tier`                                                                                                                                                   |
| `mask.done`              | INFO          | `placeholder_count`, `counts_by_category`, `unstructured_spans`, `vault_generation`, `term_count`. Zero on PII-laden input ⇒ detector regression. `term_count` counts the verbatim-mask terms named, never which |
| `mask.gemma.unparseable` | INFO/WARNING  | Gemma's span JSON could not be used; retried once. Persistent ⇒ JSON mode or model not pulled                                                                                                                    |
| `mask.gemma.failed`      | ERROR         | Gemma unreachable during span extraction. This now **fails the request** (`502 extraction_unavailable`) rather than degrading to regex-only, because the regexes cannot see names or addresses at all            |
| `guard.egress.blocked`   | ERROR         | raw PII would have left the boundary; the request was refused. **Correct behaviour** — inspect `categories`                                                                                                      |
| `a2a.core.send`          | INFO          | Core round-trip opened                                                                                                                                                                                           |
| `a2a.core.recv`          | INFO          | Core replied; `duration_ms`, `status`                                                                                                                                                                            |
| `request.refused`        | WARNING/ERROR | a gate refused the request; `refusal` names which one (`reserved_syntax`, `egress_guard`, `extraction_failed`, or a `RefusalKind` proxied from Synthesis), `categories` when applicable                          |
| `request.rate_limited`   | WARNING       | the per-IP demo rate limit was exceeded; `429`                                                                                                                                                                   |
| `warmup.requested`       | INFO          | `POST /v1/warmup` dispatched a wake to the GPU-backed Gemma service. **Spends money**: the instance is billed until it idles out (~15 min). Carries no fields beyond the standard envelope                       |
| `request.failed`         | ERROR         | 5xx; `error_class`, `error_code` (never `error_message`)                                                                                                                                                         |
| `auth.id_token.failed`   | ERROR         | the Gateway could not obtain an ID token for a downstream call; a deployment/credential fault, reported as 502                                                                                                   |
| `server.start`           | INFO          | boot; model ids, vault backend, `trace_id`                                                                                                                                                                       |

The OpenAI-compatible façade (`POST /v1/chat/completions`) runs the same pipeline
and therefore emits the same `request.*`, `mask.*`, `guard.*` and `a2a.*` events
as `/v1/ask`. These four are additional, and identify the compat surface:

| event                         | severity | meaning / what to check                                                                                                                                                         |
| ----------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `openai.compat.chat.start`    | INFO     | a compat request was accepted; `ok` carries whether the caller asked to stream. Never the message text                                                                          |
| `openai.compat.chat.end`      | INFO     | the compat response was shaped; `document_status`, `trust_tier`                                                                                                                 |
| `openai.compat.chat.refused`  | ERROR    | a gate refused; `error_code`, `categories`. The status matches what `/v1/ask` would have returned — the façade never downgrades one                                             |
| `openai.compat.chat.rejected` | WARNING  | the body failed validation before the pipeline ran; `error_code` is `invalid_request`, `empty_prompt`, or `multimodal_unsupported` (a non-text content part — nothing was sent) |

There is no `approve.done` event: human approval does not exist in this system
(see `ARCHITECTURE.md` §2).

### Core

| event                   | severity | meaning                                                                                     |
| ----------------------- | -------- | ------------------------------------------------------------------------------------------- |
| `a2a.receive`           | INFO     | an A2A request was accepted; `placeholder_count`, `text_length`, `path`                     |
| `guard.inbound.blocked` | ERROR    | the payload still held raw PII; `finding_kinds`, `finding_count`, `path` — never the values |
| `server.start`          | INFO     | boot; model id, Vertex AI settings, Agent Card path                                         |

The `llm.gemini` span (see §5) covers the Gemini call itself; there is no
separate `llm.gemini.call` log event — the span, with the model id as its only
attribute, is the record.

### Synthesis

| event                                              | severity     | meaning / what to check                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| -------------------------------------------------- | ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `attest.verdict`                                   | INFO         | `verdict: pass\|fail`, `findings` (categories only, never values)                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `judge.gemma`                                      | INFO/WARNING | the advisory Gemma opinion; `leak` (boolean or absent). A transport failure or parse failure counts as "no usable verdict" and blocks the release just as `leak: true` does — it never falls back to trusting the release                                                                                                                                                                                                                                                                 |
| `judge.retry`                                      | INFO         | the first verdict flagged a leak while naming no category over a body the deterministic attester had already passed, so the judge was asked once more to enrich the category list; the second call's `leak` value is discarded, so this event never precedes a release. `verdict` is the second answer, kept for its categories only. `categories` is what the second call named, which is the whole point of making it. A flag that already names categories is never re-asked           |
| `release.refused`                                  | ERROR        | a gate refused the release; `refusal` is one of `vault_missing`, `vault_expired`, `vault_generation_mismatch`, `invented_token`, `leak_check_failed`, `judge_flagged`, `judge_unavailable`, `unresolved_token`, `rehydration_incomplete`. On `rehydration_incomplete` the line also carries `error_code` naming which invariant broke (`leftover_token` / `missing_withheld` / `substitution_mismatch` / `rebuild_mismatch`) plus the offending token names or categories — never a value |
| `release.ok`                                       | INFO         | the release passed every gate, the post-rehydration completeness check included; `tokens_resolved`, `withheld_count`                                                                                                                                                                                                                                                                                                                                                                      |
| `okf.persist`                                      | INFO         | Firestore write of the masked evidence document (always, on release and on refusal alike); `document_status`, `verdict`. Permission errors ⇒ `sa-synthesis` needs `roles/datastore.user`                                                                                                                                                                                                                                                                                                  |
| `okf.persist.failed`                               | ERROR        | the evidence document could not be persisted after a refusal; `refusal` names the original refusal kind                                                                                                                                                                                                                                                                                                                                                                                   |
| `request.start` / `request.end` / `request.failed` | —            | as for the Gateway                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `request.refused`                                  | ERROR        | the HTTP layer turned a `ReleaseRefusedError` into a response; `refusal`, `categories`                                                                                                                                                                                                                                                                                                                                                                                                    |

### Any service

| event               | severity | meaning                                                                     |
| ------------------- | -------- | --------------------------------------------------------------------------- |
| `config.invalid`    | ERROR    | zod env validation failed at boot; `issues` lists the offending keys. Fatal |
| `otel.export.error` | WARNING  | the trace exporter failed; the service keeps serving, traces are lost       |

## 5. Traces

One user request is one trace. Expected span tree:

```
request                            (gateway)
├── mask.gemma                     unstructured span extraction
├── mask.regex                     deterministic tokenization
├── guard.egress                   the refusal point
├── a2a.core                       ──▶ a2a.receive ──▶ llm.gemini      (core)
└── synthesis.call                 ──▶ attest.leak_check               (synthesis)
                                       judge.gemma
                                       rehydrate
                                       okf.build
                                       persist
```

`llm.gemini` is a real span, not an aspirational one: the Core agent opens it in
an ADK `beforeModelCallback` and closes it in `afterModelCallback` (there is no
function to wrap with `withSpan` — ADK owns the call between the two callbacks),
with the model id as its **only** attribute. Earlier revisions of this document
promised the span before the code carried it; it is now present in
`agents/core/src/agent.ts`.

Span attributes carry counts, verdicts and identifiers — `placeholder_count`,
`tokens_unknown`, `verdict`, `trust_tier`, `request_id` — and **never a PII
value**. On failure, a span records `error.class` and an optional `error.code`
attribute; it never calls `span.recordException()` (see §3).

Propagation: the Gateway injects `traceparent` into both the A2A call to Core and
the HTTP call to Synthesis. On Cloud Run, `X-Cloud-Trace-Context` is translated
into a traceparent when no W3C header is present, so a request entering through
the load balancer still joins one trace. If a hop is missing from Cloud Trace,
that hop's propagation broke: check `OTEL_ENABLED`, then look for
`otel.export.error` in that service's logs.

The end-to-end test asserts this: one trace id across all hops, with the child
spans parented to `request` (`agents/gateway/test/e2e.test.ts`). That test does
**not** cross real process boundaries: it mocks Core and the Gemma endpoint at
the `fetch` layer, and runs Synthesis in-process against an in-memory vault, so
its span tree — while structurally faithful — is not evidence of a live
multi-service deployment.

## 6. Error codes

| `error_code`                | HTTP | Meaning                                                                         | First place to look                               |
| --------------------------- | ---- | ------------------------------------------------------------------------------- | ------------------------------------------------- |
| `invalid_request`           | 400  | the body failed its zod schema (including a stray `session_id`)                 | the `message` field names the offending key       |
| `reserved_syntax`           | 400  | the raw input used the reserved `⟦…⟧` delimiters                                | `request.refused` with `refusal: reserved_syntax` |
| `extraction_unavailable`    | 502  | Gemma span extraction was unusable or unreachable; Core was never called        | `mask.gemma.unparseable` / `mask.gemma.failed`    |
| `outbound_guard_refused`    | 422  | raw PII survived masking; Core was never called                                 | `guard.egress.blocked` and its `categories`       |
| `vault_missing`             | 409  | no live token mapping for this `request_id`                                     | `release.refused` with `refusal: vault_missing`   |
| `vault_expired`             | 410  | the token mapping existed but its TTL passed                                    | `release.refused` with `refusal: vault_expired`   |
| `vault_generation_mismatch` | 409  | the mapping changed generation after this request was masked                    | `release.refused`, `vault_generation`             |
| `invented_token`            | 409  | Core used a placeholder absent from the prompt                                  | `release.refused`, `invented_tokens`              |
| `leak_check_failed`         | 422  | the deterministic leak check found raw PII in Core's response                   | `attest.verdict`, `findings`                      |
| `judge_flagged`             | 422  | the Gemma judge returned `leak: true`                                           | `judge.gemma`                                     |
| `judge_unavailable`         | 422  | the Gemma judge had no usable verdict (transport failure, timeout, unparseable) | `judge.gemma`                                     |
| `unresolved_token`          | 409  | the response referenced a placeholder outside the known mapping                 | `release.refused`, `unresolved_tokens`            |
| `multimodal_unsupported`    | 400  | a non-text content part on the compat endpoint; nothing was sent                | `openai.compat.chat.rejected`, `error_code`       |
| `rehydration_incomplete`    | 500  | the rehydration did not match the disclosure policy — our bug, body withheld    | `release.refused`, its `error_code` and tokens    |
| `rate_limited`              | 429  | the per-IP demo rate limit was exceeded                                         | `request.rate_limited`                            |
| `payload_too_large`         | 413  | the body exceeded `MAX_BODY_BYTES` (64 KB)                                      | —                                                 |
| `deadline_exceeded`         | 504  | the end-to-end deadline (`REQUEST_DEADLINE_SECONDS`, 60 s) passed               | `request.failed`                                  |
| `downstream_agent_failed`   | 502  | Core or Synthesis failed or was unreachable                                     | that service's logs for the same `request_id`     |
| `internal_error`            | 500  | an unhandled failure in this service                                            | `error_class` / `error_code` on `request.failed`  |
| `config.invalid`            | —    | the process refused to start                                                    | `issues` in the log line                          |

There is no `unknown session` / 404 code: there is no session lookup route.
`GET /v1/requests/:id`, `GET /v1/requests/:id/masked-prompt.md` and
`GET /v1/requests/:id/core-response.md` return a plain `404 unknown_request` when
the evidence has expired or never existed.

Every error response carries `request_id`, so the reporter's copy of it is enough
to find the corresponding logs.

## 7. Local development

`just dev` runs all four processes with structured logs multiplexed on stdout:

```bash
just dev 2>&1 | tee /tmp/pgw-dev.log
jq -c 'select(.request_id=="<id>")' /tmp/pgw-dev.log
jq -c 'select(.event=="attest.verdict")' /tmp/pgw-dev.log
```

Set `OTEL_ENABLED=1` without `GOOGLE_CLOUD_PROJECT` to print spans to the console
instead of exporting them.
