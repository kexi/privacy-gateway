# Observability

How to follow one request across the fleet, and what every log event and error
code means. The companion investigation guide is `skills/pgw-logs/LOGS.md`
(agent-facing); this document is the canonical vocabulary both refer to.

Japanese version: [OBSERVABILITY.ja.md](OBSERVABILITY.ja.md).

## 1. The two identifiers

| Identifier   | Where it comes from                                       | Where it appears                                                                      |
| ------------ | --------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `request_id` | `X-Request-ID` header, or a UUIDv7 minted by the Gateway  | every log line, the `X-Request-ID` response header, the API body, the OKF frontmatter |
| `trace_id`   | W3C `traceparent`, or Cloud Run's `X-Cloud-Trace-Context` | every log line, the API body, the OKF frontmatter, Cloud Trace                        |

`request_id` is a **UUIDv7**: its leading 48 bits are a millisecond timestamp, so
sorting a result set by it also sorts by time. An inbound value is adopted only
when it is a well-formed UUID — an arbitrary caller string would otherwise become
a log-injection vector.

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
   services, in order.
2. **Widen to `session_id`** when the question spans several requests (placeholder
   stability, an approval that came later).
3. **Switch to `trace_id`** for latency: which hop was slow, and where the time
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

| Field                           | Always       | Meaning                                        |
| ------------------------------- | ------------ | ---------------------------------------------- |
| `severity`                      | yes          | `DEBUG` / `INFO` / `WARNING` / `ERROR`         |
| `message`                       | yes          | human-readable text; equals `event` for events |
| `time`                          | yes          | ISO 8601 UTC                                   |
| `agent`                         | yes          | `gateway` / `core` / `synthesis`               |
| `event`                         | events       | the stable identifier from §4                  |
| `request_id`                    | mostly       | correlation id                                 |
| `session_id`                    | mostly       | the gateway session                            |
| `trace_id`, `span_id`           | when tracing | raw ids, for local use                         |
| `logging.googleapis.com/trace`  | on GCP       | `projects/<project>/traces/<trace_id>`         |
| `logging.googleapis.com/spanId` | on GCP       | links the line to its span                     |
| `duration_ms`                   | timed        | elapsed milliseconds                           |
| `error_code`, `error_message`   | errors       | see §6                                         |

**No raw PII, ever.** Every string value is passed through the tokenizer before
serialization, so a value that reaches a log by accident appears as `⟦EMAIL_1⟧`.
Identifier-like keys (`session_id`, `request_id`, `trace_id`, `verdict`,
`trust_tier`, `status`, `model`, …) pass through unmasked, because masking them
would make correlation impossible. **Raw PII in a log is itself a bug — report it.**

## 4. Event vocabulary

Event names are stable identifiers; queries and dashboards depend on them.

### Gateway

| event                    | severity     | meaning / what to check                                                                                        |
| ------------------------ | ------------ | -------------------------------------------------------------------------------------------------------------- |
| `request.start`          | INFO         | envelope open; carries `method`, `path`                                                                        |
| `request.end`            | INFO         | envelope close; `duration_ms`, `status`, `trust_tier`                                                          |
| `mask.done`              | INFO         | `placeholder_count`, `counts_by_category`, `unstructured_spans`. Zero on PII-laden input ⇒ detector regression |
| `mask.gemma.unparseable` | INFO/WARNING | Gemma's span JSON could not be used; retried once. Persistent ⇒ JSON mode or model not pulled                  |
| `mask.gemma.failed`      | WARNING      | Gemma unreachable. Masking degrades to regex only — the guard still holds                                      |
| `guard.egress.blocked`   | ERROR        | raw PII would have left the boundary; the request was refused. **Correct behaviour** — inspect `categories`    |
| `a2a.core.send`          | INFO         | Core round-trip opened                                                                                         |
| `a2a.core.recv`          | INFO         | Core replied; `duration_ms`, `status`                                                                          |
| `approve.done`           | INFO         | a human approval was recorded; `trust_tier`                                                                    |
| `request.refused`        | ERROR        | 422 to the caller after `guard.egress.blocked`                                                                 |
| `request.failed`         | ERROR        | 5xx; `error_code`, `error_message`                                                                             |
| `server.start`           | INFO         | boot; model ids, vault backend, downstream URLs                                                                |

### Core

| event                   | severity | meaning                                                                |
| ----------------------- | -------- | ---------------------------------------------------------------------- |
| `a2a.receive`           | INFO     | an A2A request was accepted; `placeholder_count`, `text_length`        |
| `guard.inbound.blocked` | ERROR    | the payload still held raw PII; `finding_kinds` only, never the values |
| `llm.gemini.call`       | INFO     | model id, token counts. 404 ⇒ wrong `GEMINI_MODEL`                     |
| `server.start`          | INFO     | boot; model id, Vertex AI settings, Agent Card path                    |

### Synthesis

| event                                              | severity     | meaning / what to check                                                                     |
| -------------------------------------------------- | ------------ | ------------------------------------------------------------------------------------------- |
| `attest.verdict`                                   | INFO         | `verdict: pass\|fail`, `findings` (categories only, never values)                           |
| `judge.gemma`                                      | INFO/WARNING | the advisory Gemma opinion; parse failures ⇒ JSON mode or model not pulled                  |
| `rehydrate.done`                                   | INFO/WARNING | `tokens_resolved`, `tokens_unknown`. `tokens_unknown > 0` ⇒ invented token or expired vault |
| `okf.persist`                                      | INFO         | Firestore write. Permission errors ⇒ `sa-synthesis` needs `roles/datastore.user`            |
| `request.start` / `request.end` / `request.failed` | —            | as for the Gateway                                                                          |

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

Span attributes carry counts, verdicts and identifiers — `placeholder_count`,
`tokens_unknown`, `verdict`, `trust_tier`, `session_id`, `request_id` — and
**never a PII value**.

Propagation: the Gateway injects `traceparent` into both the A2A call and the
Synthesis HTTP call. On Cloud Run, `X-Cloud-Trace-Context` is translated into a
traceparent when no W3C header is present, so a request entering through the load
balancer still joins one trace. If a hop is missing from Cloud Trace, that hop's
propagation broke: check `OTEL_ENABLED`, then look for `otel.export.error` in
that service's logs.

The end-to-end test asserts this: one trace id across all hops, with the child
spans parented to `request` (`agents/gateway/test/e2e.test.ts`).

## 6. Error codes

| `error_code`              | HTTP | Meaning                                         | First place to look                              |
| ------------------------- | ---- | ----------------------------------------------- | ------------------------------------------------ |
| `invalid_request`         | 400  | the body failed its zod schema                  | the `message` field names the offending key      |
| `outbound guard refused`  | 422  | raw PII survived masking; Core was never called | `guard.egress.blocked` and its `categories`      |
| `downstream_agent_failed` | 502  | Core or Synthesis failed or was unreachable     | that service's logs for the same `request_id`    |
| `internal_error`          | 500  | an unhandled failure in this service            | `error_message` on the `request.failed` line     |
| `unknown session`         | 404  | no stored answer for that session               | vault/answer TTL — `stale_after` may have passed |
| `config.invalid`          | —    | the process refused to start                    | `issues` in the log line                         |

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
