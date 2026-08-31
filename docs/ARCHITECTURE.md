# Privacy-Preserving Multi-Agent Gateway — Architecture

Hackathon: All Things Agentic Hackathon (Devpost) — Category: **Fortified Enterprise Fleet**
(also targeting _Best Architectural Design_). Deadline: 2026-08-31 17:00 PDT.

## 1. Problem

Enterprises want frontier-model reasoning (Gemini) but cannot send raw PII / secrets
outside their trust boundary. This system lets a commercial LLM reason over
_tokenized_ data while an open model (Gemma) that never leaves the boundary owns the
sensitive mapping.

## 2. Agents

Only Gateway → Core uses A2A. Gateway → Synthesis is plain authenticated HTTP,
deliberately: the OKF document is an audit artifact and must be retrieved without an
LLM rephrasing it along the way. The Gateway exposes no Agent Card of its own and
discovers only Core by card. Synthesis's A2A surface merely acknowledges a gateway
exchange — its card says so explicitly — while the verification/release pipeline that
actually gates a release runs on its HTTP routes.

| Agent               | Model                  | Runtime       | Responsibility                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------- | ---------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Gateway Agent**   | Gemma 4 (self-hosted)  | Cloud Run     | ADK TypeScript. Receives the user request (`{text, rehydrate_allow?, mask_terms?}`; no caller-supplied ids) and mints one server-generated `request_id` (UUIDv7) that also serves as the Token Vault key. Detects PII/secrets (hybrid: deterministic regex + Gemma span extraction), replaces with stable tokens `⟦PERSON_1⟧`, `⟦EMAIL_1⟧`, `⟦SECRET_1⟧`. Stores the mapping in the **Token Vault** (Firestore, per-request, TTL). Forwards the _masked_ prompt to Core via A2A; reaches Synthesis over plain HTTP. Serves the demo UI and the HTTP API from one origin.                                                                                                                                                                          |
| **Core Agent**      | Gemini 3.5 (Vertex AI) | Cloud Run     | Pure reasoning / planning / code generation over masked input. ADK TypeScript (`@google/adk`), served via `toA2a`; Agent Card at `/.well-known/agent-card.json`, RPC at `/jsonrpc` and `/rest`. Model id from `GEMINI_MODEL` (default `gemini-3.5-flash`, verified on Vertex AI). Deployed with `GOOGLE_CLOUD_LOCATION=global`: `gemini-3.5-flash` is published only on the global Vertex endpoint and the `us-central1` regional one 404s for it. An inbound guard rejects any payload still containing raw PII. Has **no** vault dependency — its package installs the whole `@privacy-gateway/common` package, so it is IAM (Core's service account has no Firestore role), not the dependency graph, that is the actual structural guarantee. |
| **Synthesis Agent** | Gemma 4 (self-hosted)  | Cloud Run     | ADK TypeScript, exposed via `toA2a` (acknowledgement only) and over HTTP (the real pipeline). Receives Core's output. (a) **Leak check**: a deterministic regex re-scan of the masked response, plus an advisory Gemma judge. (b) **Consistency check**: deterministically verifies Core invented no placeholder absent from the prompt. (c) **Rehydration**: restores tokens from the vault, applying the disclosure policy. Assembles the OKF document; only masked artifacts are ever persisted.                                                                                                                                                                                                                                               |
| **Gemma Serving**   | gemma4 via Ollama      | Cloud Run GPU | OpenAI-compatible endpoint consumed by Gateway/Synthesis through `OllamaLlm`, an ADK `BaseLlm` adapter registered for `ollama/*` model names. Accelerator: **NVIDIA RTX PRO 6000** (`var.gpu_type`) — the L4 quota request was declined in 2026-08. Ingress: internal only.                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| **kill-switch**     | none (no LLM)          | Cloud Run     | Not a fleet member and not an agent: it never sees a prompt, an answer or a vault entry. A Cloud Billing budget publishes each threshold crossing to a Pub/Sub topic whose push subscription calls this service with an OIDC token; at 100% it drops the `allUsers` invoker binding on `gateway-agent`, holds `gemma-serving` at zero instances via Cloud Run manual scaling, and strips the fleet's invoker rights on `gemma-serving`. All three actions are idempotent, so Pub/Sub redelivery is harmless. Lives in `services/kill-switch`.                                                                                                                                                                                                     |

Trust boundary: `Gateway`, `Synthesis`, `Gemma Serving`, `Firestore` are **inside**.
Only masked text crosses to `Core` (and therefore to Gemini). Core's service account
has no Firestore role — that IAM fact is what actually keeps Core off the vault, since
Core's package installs the whole `@privacy-gateway/common` package and the dependency
graph alone does not enforce anything. A2A messages to Core are additionally validated
by a PII scanner before egress (defense in depth).

### Sessions are gone

There is no caller-supplied session and no multi-turn state. One HTTP request gets
exactly one server-generated `request_id` (UUIDv7), minted by the Gateway and used as
the Token Vault key. `POST /v1/ask` accepts `{text, rehydrate_allow?, mask_terms?}` and
nothing else; a body carrying `session_id`, any other caller-supplied id, or any unknown
field is rejected with 400 by the schema's `strict()` validation. An inbound `X-Request-ID` header is **ignored entirely**: the
Gateway mints its own id and returns that one in the `X-Request-ID` response header, so
a caller reading the header back gets the server's id, not its own. Nothing echoes the
inbound value. A caller who could choose the id could name another request's mapping and
resolve its placeholders, and no amount of validation on a caller-supplied id removes
that. There is consequently no placeholder stability across requests.

### Human approval is out of scope

There is no approval step and no `human:` OKF actor anywhere in this system. The public
gateway authenticates nobody, so nothing can name a reviewer; an unauthenticated
`human:<id>` actor would make the OKF human-reviewed trust tier meaningless, since
anyone could claim any identity. The OKF trust-tier derivation itself stays generic in
`packages/common` — other consumers of the library do have authenticated reviewers —
this product simply never mints a `human:` actor. The UI always shows review identity
as "none".

## 3. Flow

```
User ──HTTP──▶ Gateway (Gemma)
                 │ 0. reject ⟦…⟧ reserved syntax          (400 reserved_syntax)
                 │ 1. mask_terms pass, then detect + tokenize
                 │                       ──▶ Firestore Token Vault (request_id → {token: value})
                 │ 2. egress guard re-scan + term scan    (422 outbound_guard_refused)
                 ▼ A2A
               Core (Gemini 3.5)  — reasoning/planning/codegen on tokens
                 │ masked answer
                 ▼ HTTP (authenticated)
               Synthesis (Gemma)
                 │ 3. vault lookup + generation check      (409/410)
                 │ 4. consistency check                    (409 invented_token)
                 │ 5. leak check + term scan               (422 leak_check_failed)
                 │ 6. Gemma judge (advisory, asymmetric)    (422 judge_flagged / judge_unavailable)
                 │ 7. rehydrate with disclosure policy      (409 unresolved_token)
                 │    (default-withheld − env allow − request rehydrate_allow)
                 │ 8. post-rehydration completeness check   (500 rehydration_incomplete)
                 ▼
               User  (final answer + OKF evidence document: what was masked, what was verified)
```

Unstructured span extraction (Gemma, inside the Gateway hop) also fails closed: a
transport failure or an uninterpretable response is `502 extraction_unavailable` and
Core is never called, because the regexes alone cannot see a personal name or an
address.

**Chunked extraction.** The extractor caps Gemma's output at `maxOutputTokens: 4096`,
and that cap is not negotiable: without it a ~147 KB prompt from a coding agent made
Gemma generate until the context was exhausted, pinning the project's single Cloud Run
GPU for 15+ minutes — the generating instance never idled out, so the service could
neither serve nor accept a new revision (recovery runbook in `skills/pgw-logs/LOGS.md`).
But a span list for that much input does not fit in 4096 tokens either, so a single
call truncated mid-JSON and every large request refused with `extraction_unavailable`.

**What is actually masked is measured, not assumed.** A real Codex CLI turn was
recorded on the deployed gateway (`openai.compat.responses.start`, 2026-08-31):
`raw_body_bytes` **141,396** but `forwarded_text_bytes` **59,576** — only ~42% of the
body reaches masking. The Responses mapping flattens `instructions` plus the message
turns and **drops the top-level `tools` array** along with `reasoning`, `include`,
`store` and the other knobs, and the declared tool schemas are the bulk of the
difference. So the extraction cost of a CLI turn is ~58 KiB, which at the deployed
4 KB chunk size is roughly **15 chunks, not the ~37 an estimate from the raw body
gives**. Latency math cites the forwarded figure; the raw body is not the workload.
Input above `EXTRACTION_CHUNK_BYTES` (default 12000 characters) is therefore split on
the safest available boundary — paragraph, then line, then a hard cut — with a 200-character
overlap so an entity straddling a boundary is still seen whole by one chunk. Chunks are
extracted concurrently across all 4 of Gemma's llama.cpp slots (`EXTRACTION_CONCURRENCY`),
and the span lists are merged with duplicates collapsed by value + category (the
granularity the tokenizer already works at). Input at or below the threshold takes exactly
the previous single call. The fan-out used to hold one slot back for the Synthesis judge;
that slot was idle during masking, because the judge runs after it rather than beside it,
so reserving it cost a quarter of the fan-out during the only phase that could use it.

**Repeated chunks are extracted once per process.** A coding-agent CLI resends a
near-identical instruction preamble — tool schemas, workspace rules, tens of kilobytes of
it — on every turn, and the chunks it splits into are byte-identical from one request to
the next. An in-process LRU of 256 entries maps a chunk's SHA-256 to the spans extracted
from it, so a second turn pays only for the chunks that changed; measured locally, a
20 KB Codex-shaped payload cost 159 s cold and 1 ms warm. The cache lives in **memory
only and is never persisted**: a span holds the raw personal-data value verbatim, so
writing it to Firestore would be exactly the disclosure this gateway prevents. Only
readable outcomes are cached — an `invalid` is one bad sample, and remembering it would
let a single failed roll refuse every later request carrying that chunk.

**The parser tolerates packaging, never content.** With markdown-and-code input the model
mirrors the input's style back: a code fence around its answer, a sentence introducing it,
an echoed brace from the chunk. Balanced-brace scanning (string-literal aware) picks the
first top-level object carrying a `spans` key, so a preamble that merely mentions `{` no
longer defeats the parse. Nothing is repaired — no brace appended, no truncated string
closed — so malformed JSON is still `invalid` and still fails the request closed.

**Density, not size, is the real bound.** Measurement showed a 5.7 KB prose page with two
entities extracting in 9 s while a **1.7 KB** passage of repeated PII-dense lines refused
after 67 s: what overflows the output budget is the number of distinct spans, and no byte
threshold predicts it. Two changes follow. First, the instruction asks for each distinct
value **exactly once** rather than once per occurrence — `spansToDetections` re-locates
every occurrence with `indexOf`, so the repetition changed no masking decision and was
pure output spend; `mergeSpans` still deduplicates on arrival, because a prompt rule is a
request and not a guarantee. Second, a chunk that is still unreadable after its retry is
**halved and re-extracted**, recursively, down to `EXTRACTION_MIN_CHUNK_BYTES` (default
1000). Each level halves the text, so depth is at most log2(chunk/min) — about 4 with the
defaults, bounding a pathological 12 KB chunk at 126 model calls. The fail-closed contract
is unchanged at the bottom: a chunk that reaches the floor still uninterpretable fails the
whole extraction, because a chunk nobody could read is a chunk whose names are unknown.

### Everything fails closed

Every gate below stops the pipeline on failure: no rehydrated answer is returned, and
only masked artifacts are persisted (`status: draft`, `verified` omitted).

| Gate                                                              | Outcome                                                                                |
| ----------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Reserved `⟦…⟧` syntax in raw input                                | `400 reserved_syntax` (before masking, before the vault)                               |
| Gemma span extraction (`valid-empty` / `valid-spans` / `invalid`) | `invalid` or a transport failure → `502 extraction_unavailable`; Core is never reached |
| Egress guard finds raw PII in the masked prompt                   | `422 outbound_guard_refused`                                                           |
| Egress guard finds a requester-named term in the masked prompt    | `422 outbound_guard_refused`, category `CUSTOM`                                        |
| Vault mapping missing                                             | `409 vault_missing`                                                                    |
| Vault mapping expired                                             | `410 vault_expired`                                                                    |
| Vault generation mismatch                                         | `409 vault_generation_mismatch`                                                        |
| Core invented a placeholder absent from the prompt                | `409 invented_token`                                                                   |
| Deterministic leak check fails                                    | `422 leak_check_failed`                                                                |
| Core's answer contains a requester-named term                     | `422 leak_check_failed`, category `CUSTOM`                                             |
| Gemma judge returns `leak: true`                                  | `422 judge_flagged`                                                                    |
| Gemma judge unavailable / no usable verdict                       | `422 judge_unavailable`                                                                |
| Unresolved placeholder survives rehydration                       | `409 unresolved_token`                                                                 |
| A non-text content part on the OpenAI-compatible endpoint         | `400 multimodal_unsupported` (see §9a); nothing is sent                                |
| `rehydrate_allow` names a category outside the withheld set       | `400 invalid_request`; nothing is sent                                                 |
| The rehydration did not match the disclosure policy               | `500 rehydration_incomplete` (see §9b) — our bug, so 5xx; the body is still withheld   |
| A second heavy request while one already occupies the GPU         | `503 gpu_busy` with `Retry-After: 30` — refused before any GPU work is spent           |
| Per-IP demo rate limit exceeded                                   | `429`                                                                                  |
| Body over `MAX_BODY_BYTES`                                        | `413`                                                                                  |
| End-to-end deadline exceeded                                      | `504`                                                                                  |

### The Gemma judge is asymmetric and probabilistic

The Gemma judge in Synthesis is advisory in one direction only: `leak: true`, or "no
usable verdict" (transport failure, timeout, unparseable answer), **blocks** the
release; `leak: false` adds **no trust whatsoever** — it never upgrades a verdict or
contributes to the trust tier. A probabilistic model may veto a release; it may never
be the reason one is trusted. It runs at temperature 0 for reproducibility and never
sees the rehydrated body — only the masked (still-tokenized) response — so it cannot
itself become a channel for real PII.

**What it is shown.** Placeholders are replaced with readable neutral markers
(`⟦EMAIL_1⟧` → `[masked email]`) rather than deleted, and the answer travels with the
masked prompt it answers (truncated at 2000 characters) plus the per-category counts of
what was masked. All of it is PII-free by construction — the prompt is the string that
crossed the boundary, the categories are already public in the placeholders and the OKF
document, and no mapping value is read. Why not the earlier deletion: a gap-riddled
sentence made the model infer what the gaps held, which is exactly how it came to flag
nearly every masked answer while naming no category. This input redesign is the whole fix
for that false-positive rate; there is no longer any second chance at the verdict behind
it, so it has to be right on the first call.

There is no exception to "a flag blocks": the judge's first verdict is authoritative, and
`leak: true` always refuses (`judge_flagged`, 422) — no second call turns a flag into a
release. When that first verdict flags a leak while naming **no** category, over a body the
deterministic attester has already passed, the judge is asked one more time, but only to
enrich the category list the refusal record carries; the second call's `leak` value is
discarded outright, and only categories it names (if any) are adopted. The outcome is still
a refusal, recorded with `attestation.judge_retries: 1` and a `judge.retry` log event. A flag
that already names categories needs no enrichment and is never re-asked; an unavailable
judge is never retried either. Why not let a clear second answer release: the deterministic
attester does not detect names or postal addresses at all, so an unevidenced flag over an
attester-clean body is exactly the case where the judge is the only coverage those categories
get — re-asking a probabilistic veto until it stops flagging is how a veto becomes theatre,
not verification. The asymmetry is unchanged — a judge has never been able to vouch for a
release, and now it cannot even undo its own flag.

### User-defined secret terms

Detection covers _shapes_. An email looks like an email, a card number carries a
Luhn checksum, a personal name is something Gemma can recognise. An unreleased
product name or an internal codename has none of that: it is an ordinary-looking
noun phrase whose confidentiality is a fact about the enterprise, not about the
string. No regex and no model can know to protect it.

So the requester names it. `POST /v1/ask` accepts an optional
`mask_terms: string[]` (1–20 entries, each 2–120 characters after trimming, no
`⟦`/`⟧`, deduplicated case-preserving). Each term is substituted for a
`⟦CUSTOM_n⟧` placeholder in an exact-match pass that runs **before** every
detector, and the mapping goes into the vault like any other. A regex detection
overlapping a term is dropped rather than splitting it: the requester's assertion
that this exact string is confidential outranks a heuristic, and splitting a
codename would leave part of it in the clear.

**Matching is case-sensitive.** Why not case-insensitive: a codename's case is
part of its identity — `Titan` the unreleased product and `titan` inside
"titanium alloy" are different strings meaning different things — so folding case
would mask ordinary prose the requester never asked to hide, mangling the prompt
Core is asked to reason about, and would mask more than the requester can
predict. A requester who wants both spellings names both.

**`CUSTOM` is not withheld.** It rehydrates by default, unlike the five high-risk
categories in §9. Why not withhold it: the requester typed the term into this
very request, so withholding protects nothing they do not already hold — and it
would break the answer, since a reply about `⟦CUSTOM_1⟧` is unreadable to the
person who asked about their own codename. The protection is that the term never
crossed the boundary, not that it never comes back.

**The terms are the strongest thing the boundary checks.** Both the egress guard
and the Synthesis attester gain a per-request literal scan — the guard over the
outbound masked prompt, the attester over Core's tokenized output — and either
one finding a term refuses the request (`422 outbound_guard_refused` /
`422 leak_check_failed`, category `CUSTOM`). Every other guard check re-runs the
same patterns that decided the masking, so it can only catch a tokenizer bug over
shapes it already knows; a term is compared as a literal string, so if the
substitution failed anywhere, this finds it. It is the one category where the
guard can _prove_ the masking worked rather than re-running the detector that
decided it.

The terms travel Gateway → Synthesis (both inside the boundary, and Synthesis
already holds every raw value behind every placeholder) and are **never**
persisted: the OKF document records `attestation.custom_terms: {count: N}` and
nothing more. Why not a digest per term: a codename comes from a small guessable
space, so a hash of one is a confirmation oracle rather than a redaction. Logs
carry `term_count` and `surviving_term_count` only — there is no field in the
logging allowlist a term could travel in.

The same list is accepted on the OpenAI-compatible endpoint under
`x_privacy_gateway: {mask_terms}` and by MCP `pgw_ask`.

### Pseudonymization, not anonymization

Masking here is pseudonymization, not anonymization or de-identification, and the
residual risk is real: a placeholder still discloses the category of what it replaced
and preserves equality (the same `⟦PERSON_1⟧` recurring shows the same person is meant
each time). Surviving quasi-identifiers — employer, location, date, role, event
context — are not tokenized at all and can permit contextual re-identification even
when every direct identifier has been replaced.

## 4. Fortified Enterprise Fleet mapping

- **Registry**: an A2A Agent Card (`/.well-known/agent-card.json` — the standard path in `@a2a-js/sdk` 0.3.x, exported as `AGENT_CARD_PATH`) for Core. The Gateway discovers Core by card URL (env-configured) and exposes no Agent Card of its own; Synthesis publishes a card that only acknowledges a gateway exchange (see §2).
- **Runtime**: ADK `Runner` per agent, served by ADK's A2A server on Cloud Run.
- **Memory**: Firestore — the Token Vault (per-request, TTL policy) and a per-request evidence document (masked prompt, Core's tokenized response, the OKF document; TTL policy, not append-only).
- **Security**: IAM-only service-to-service auth (Cloud Run invoker + ID tokens), least-privilege SAs, Gemma endpoint internal ingress, a typed logging allowlist rather than PII scrubbing (see OBSERVABILITY.md).
- **Observability**: Cloud Logging structured logs (one JSON object per line) carrying `request_id` and the Cloud Trace correlation fields; OpenTelemetry spans per agent hop, joined into one trace by `traceparent` propagation; a per-request OKF evidence document (masked count, leak-check verdict, latency per hop). Event names, error codes and the span tree are specified in [OBSERVABILITY.md](OBSERVABILITY.md); `request_id` is a UUIDv7 the UI and the API both surface.

## 5. Repository layout

One pnpm workspace; every agent is ADK TypeScript.

```
packages/
  common/        # tokenizer, vault, OKF, guard, logging, telemetry, zod schemas,
                 # the A2A client, OllamaLlm, and the OKF bundle's attester
agents/
  gateway/       # ADK agent + HTTP entry + static web UI, Dockerfile
  core/          # ADK agent (Gemini) + A2A server, Dockerfile
  synthesis/     # ADK agent + A2A server + HTTP routes, Dockerfile
services/
  kill-switch/   # cost kill switch: budget notification -> stop spending, Dockerfile
clients/
  mcp/           # MCP stdio server: pgw_ask / pgw_evidence / pgw_verify
  python/        # pgw.py — single-file PEP 723 client, the language-agnostic example
serving/gemma/   # Ollama Dockerfile for Cloud Run GPU
web/             # demo UI (masked vs final, side by side) + Playwright specs
knowledge/       # OKF v0.2 bundle (policies, computations, executors, attesters)
infra/terraform/ # Terraform: Cloud Run, IAM, Firestore TTL, Artifact Registry, budget
docs/            # ARCHITECTURE.md, OBSERVABILITY.md, DEPLOY.md, diagram
justfile         # dev / test / deploy tasks
```

`packages/common` exports subpaths, and Core imports only `/logging`, `/config`,
`/schema` and `/telemetry`. That convention keeps Core's own code away from the
vault module, but Core's package still installs the whole `@privacy-gateway/common`
package, so the dependency graph on disk does not by itself prevent Core from
reaching Firestore — the actual structural guarantee is IAM: Core's service account
has no Firestore role. Gateway and Synthesis import the package entry point.

## 6. Key design decisions (Why not)

- **Why not Gemma via Gemini API?** It would leave the boundary and defeat the point. Self-hosted on Cloud Run GPU; local dev uses local Ollama with the same OpenAI-compatible interface.
- **Why hybrid regex + Gemma for detection?** Regex gives deterministic, auditable coverage for structured PII (emails, phones, card numbers, API keys); Gemma covers unstructured entities (names, addresses). Tokens must be stable within one request so Gemini can reason about `⟦PERSON_1⟧` consistently across the single round trip; there is no multi-turn stability requirement because there is no multi-turn state (see §2).
- **Why a separate Synthesis agent instead of rehydrating in Gateway?** Separation of duties: the agent that verifies _output_ safety should not be the one that decided _input_ masking; it also makes the leak check an independent gate on every response.
- **Why A2A for Gateway → Core but plain HTTP for Gateway → Synthesis?** Core's job is reasoning, so A2A's LLM-oriented protocol fits. Synthesis's HTTP routes return an audit artifact (the OKF document, the masked prompt, Core's tokenized response) that must come back byte-for-byte, not as something an LLM has rephrased — so the route the Gateway actually uses is plain authenticated HTTP even though Synthesis also exposes an A2A surface that acknowledges the exchange.
- **Why separate services at all instead of in-process sub-agents?** The boundary is the product. Separate services with separate IAM identities make "Core cannot reach Firestore" a deployable guarantee enforced by IAM, not a code convention — see the note on the dependency graph in §5.

**Not adopted (and why).** A `gemma:g26b` image exists in Artifact Registry from an experiment in raising the extractor to `gemma4:26b`, on the theory that a larger model breaks the JSON-only contract less often. It is not deployed: measurement showed `gemma4:12b` already returning clean JSON on Codex-shaped chunks, so the contract was not the bottleneck — per-chunk latency was — and a larger model generates more slowly, which makes that worse. `REQUEST_DEADLINE_SECONDS` was raised once, from 150 s to 240 s, after measuring a real Codex CLI turn (59,576 forwarded text bytes → 15 chunks): the extra window covers a warm Codex-scale turn. It does **not** make the full cold Codex CLI path fit on a single GPU, and raising it further was rejected — past this point a longer deadline hides the capacity limit instead of removing it, and the chunk cache addresses the repeat-turn case that actually matters.

## 7. API surface

| Route                               | Method | Purpose                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ----------------------------------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/v1/ask`                           | POST   | `{text}` plus the optional `rehydrate_allow` (§9) and `mask_terms` (§3). Returns the rehydrated answer, the OKF markdown, `trust_tier`, `status`, the four `dimensions`, `attestation`, `consistency` and `stats`. `400` if the body carries `session_id` (or any other unknown field — the schema is `strict()`).                                                                                                                                                                                                                        |
| `/v1/requests/:id`                  | GET    | The masked OKF evidence document for that request.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `/v1/requests/:id/masked-prompt.md` | GET    | The masked prompt as sent to Core (an OKF `sources[]` target).                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `/v1/requests/:id/core-response.md` | GET    | Core's tokenized response (an OKF `sources[]` target).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `/v1/chat/completions`              | POST   | OpenAI-compatible façade over the same pipeline and the same gates. `system`/`user` contents are concatenated, `assistant` turns dropped; privacy facts travel in `x_privacy_gateway`; refusals keep their status rather than becoming a 200 apology.                                                                                                                                                                                                                                                                                     |
| `/v1/responses`                     | POST   | OpenAI **Responses API** façade over the same pipeline and the same gates — the only wire Codex CLI ≥ 0.149 speaks to a custom provider. `instructions` plus the message turns are flattened into one masked text; `assistant` turns and replayed `reasoning` / `function_call` items are dropped; declared `tools` are accepted and ignored. Codex hard-codes `stream: true`, so the reply is SSE: one delta, then `output_item.done`, then `response.completed`. A refusal after the 200 is a terminal `response.failed`, never a turn. |
| `/v1/models`                        | GET    | OpenAI-compatible model list. Exactly one id, `privacy-gateway`: a caller selects the fleet, not the model behind it.                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `/healthz`                          | GET    | Liveness.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |

There is no approval route, no tier-lookup route and no session-scoped answer route:
`POST /v1/sessions/:id/approve`, `GET /v1/sessions/:id/tier` and
`GET /v1/sessions/:id/answer` do not exist in this design (see §2 — sessions and human
approval are both gone). Every route above is keyed by `request_id`.

**Request limits, as compiled in and as deployed.** The two differ on purpose, and
confusing them makes a capacity incident unreadable:

| Limit                      | Code default (`packages/common/src/config.ts`) | Deployed (`infra/terraform/locals.tf`) | Why the override                                                                                                                                                                                                                                                        |
| -------------------------- | ---------------------------------------------- | -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MAX_BODY_BYTES` (gateway) | 64 KiB                                         | 256 KiB                                | Codex CLI turns carry an instruction block far past 64 KiB. Cost stays bounded by the rate limit, the deadline, one GPU instance and the kill switch.                                                                                                                   |
| `SYNTHESIS_MAX_BODY_BYTES` | `MAX_BODY_BYTES × 2 + 64 KiB` (192 KiB)        | 576 KiB                                | Synthesis receives a whole masked prompt **plus** a whole Core answer in one body, so its limit must be derived from the gateway's, never copied.                                                                                                                       |
| `REQUEST_DEADLINE_SECONDS` | 60 s                                           | 240 s                                  | 60 s is right once Gemma is warm. A scale-from-zero request also waits for Ollama to load `gemma4:12b` (~8 GB; worst case from cold ~90 s), and a measured Codex-scale turn masks 15 chunks. 240 s covers those; the full cold Codex CLI path still does not fit (§9a). |
| `EXTRACTION_CHUNK_BYTES`   | 12000                                          | 4000                                   | Per-chunk Gemma latency falls superlinearly with size, so many small parallel chunks beat few large ones on a single GPU.                                                                                                                                               |
| `EXTRACTION_CONCURRENCY`   | 4                                              | 4                                      | All four llama.cpp slots. No slot is reserved: the Synthesis judge runs _after_ masking, not beside it.                                                                                                                                                                 |
| `RATE_LIMIT_PER_MINUTE`    | 20                                             | 20                                     | Demo-grade per-IP quota; `0` disables it.                                                                                                                                                                                                                               |

These are demo-grade: the public gateway authenticates nobody, and one request drives
two Gemma calls plus a Gemini call, so an unbounded endpoint is a cost incident waiting
to happen. The extraction concurrency is a **global** cap — one semaphore shared across
chunking, every level of the bisection recursion **and every concurrent request in
the process** (the gateway is pinned to one instance, so the process sees the whole
GPU) — so neither a request whose chunks all fail at once nor two requests arriving
together can multiply the fan-out past four. On top of the permit pool sits an
admission gate: only one _heavy_ request (body text above `HEAVY_REQUEST_BYTES`,
default 16 KiB) runs at a time, and a second one is refused up front with
`503 gpu_busy` and a `Retry-After` header rather than being admitted and then
failed at its deadline after burning GPU time.

## 8. Persistence and the vault

Firestore stores **only masked artifacts**, keyed by `request_id`:

- the **Token Vault** (`token_vault` collection): the placeholder → raw-value mapping
  for one request, a `generation` counter, and `expires_at`. Firestore allocation runs
  inside `runTransaction` so two concurrent writers cannot silently overwrite each
  other's mapping. Synthesis is handed the generation the Gateway wrote and refuses to
  rehydrate against any other one.
- the **evidence store** (`gateway_answers` collection): the masked prompt, Core's
  still-tokenized response, the OKF document (whose body holds the _masked_ answer),
  and `expires_at`. It uses the same `expires_at` field name as `token_vault` so one
  Firestore TTL policy shape covers both collections.

The rehydrated answer exists only inside the one `/v1/ask` API response that produced
it. It is never written to Firestore, in any collection, under any status.

**A refusal persists no rejected Core text.** Once a gate has run, a refused request
persists an evidence document — `status: draft`, `verified` omitted — whose body is the
literal marker `content withheld` and whose stored `core_response` is the same marker.
The rejected text is precisely the text a gate refused to release, and the evidence
routes are unauthenticated, so storing it would recreate the leak the gate just stopped.
What survives is the `attestation` block: the SHA-256 of the rejected response still
binds the record to the exchange, so an auditor holding the original can prove which
text this was about without the store ever having held it.

Two refusals happen _before_ any evidence document exists: `vault_missing` (409) and
`vault_expired` (410) are decided before the pipeline has a mapping to build a document
against, and `vault_generation_mismatch` (409) likewise. Those requests are auditable
from the structured logs (`release.refused` with the `refusal` field), not from a stored
document. Every content-policy refusal — `invented_token`, `leak_check_failed`,
`judge_flagged`, `judge_unavailable`, `unresolved_token` — does persist one.

Neither collection is append-only: each is a per-request document with a TTL, not a log.
The evidence record's `expires_at` is the **vault entry's own expiry**, read back from
the document's `stale_after`, not `now + TTL` computed when persistence happens — the
latter let the service serve a record past the freshness the document advertises.

## 9. Disclosure policy

`API_KEY`, `AWS_KEY`, `JWT`, `CREDIT_CARD` and `MY_NUMBER` are never rehydrated into a
released answer by default — the placeholder stays in place and the withheld
categories are listed in both `attestation.withheld` (OKF) and the API response's
`attestation.withheld`. The rationale: the caller who submitted a secret already holds
it, and echoing it back through a frontier-model round trip only widens the blast
radius of a logged or screenshotted response. `REHYDRATE_ALLOW_CATEGORIES`
(comma-separated, e.g. `CREDIT_CARD,MY_NUMBER`) re-enables specific categories for a
deployment that needs them released.

### Per-request opt-in

A caller may also ask, for one request only, that specific high-risk categories be
restored: `POST /v1/ask` accepts an optional `rehydrate_allow: string[]`, and the
OpenAI-compatible endpoint accepts the same list under
`x_privacy_gateway: {rehydrate_allow}`. The list is validated against the
default-withheld set and **anything else is a 400** — naming `EMAIL` would allow a
category nothing withholds, so accepting it silently would report success for an
opt-in that did nothing.

The two allowances are a **union**: the effective policy is the default-withheld set
minus the operator's `REHYDRATE_ALLOW_CATEGORIES` minus this request's own list.
Neither can widen past the default-withheld set, because that fixed list is what is
being filtered.

The scope is deliberately narrow. The opt-in covers only the values the requester
submitted **in this same request**, because one request is all the vault key names;
there is no session for it to persist into, and an opt-in that outlived the request
would apply to data the person granting it has not seen yet. The risk being accepted
is that _this_ answer gets logged or screenshotted, which is a risk only the sender is
positioned to accept.

The audit record keeps the request and the outcome apart: `attestation.disclosure_requested`
lists what was asked for and `attestation.withheld` lists what was still not given, in
both the API response and the OKF document. A deliberate disclosure and an accidental
one produce the same released text; only the record distinguishes them. The stored
evidence document's body stays masked either way — the disclosure is for the one
response, never for the audit trail.

## 9a. Text only, by design

Every surface is text-only, and a non-text content part is **refused by name**, never
dropped. `POST /v1/chat/completions` returns `400 multimodal_unsupported` naming the
part kinds it saw (`image_url`, `input_audio`, …) when any message content part is not
text; the Anthropic/Ollama shim refuses an `image` block the same way; MCP `pgw_ask`
takes a `string` and has no shape an attachment could arrive in.

The reason is the masking itself. Redaction here is deterministic regex plus a text
model, so PII inside an image or an audio clip — a face, a whiteboard, a screenshot of
a card, a name read aloud — cannot be found, masked, or verified by any gate in this
fleet. Accepting the part and dropping it would send a prompt the caller did not write;
forwarding it would put unmaskable data across the boundary. Refusing is the only
fail-closed reading, and it has to be loud enough that a caller knows their image never
went. In-boundary Gemma vision extraction is the planned way to support it.

## 9b. Post-rehydration completeness check

Rehydration is the one step that turns placeholders back into real values, so after the
single rehydration Synthesis verifies deterministically — no model, no second vault
read — that it did exactly what the policy said:

The decisive check is a **positional rebuild**. Core's tokenized answer is walked once
with a placeholder regex **transcribed rather than imported** — a second copy on purpose,
since a check that shares the tokenizer's pattern cannot see a tokenizer bug. Each
placeholder is replaced by its vault value, or copied through verbatim when the policy
withheld it, and every character between placeholders is copied unchanged. The rebuilt
string must then equal the released string **exactly**. Nothing else can hold if that
does: a rehydrator that swapped two values of the same category, wrote a value the vault
does not hold, restored a withheld token, or inserted text anywhere fails a byte
comparison.

Why equality rather than the set-and-substring properties it replaced: those asked only
whether each value appeared _somewhere_. Given `⟦EMAIL_1⟧ → alice@…` and
`⟦EMAIL_2⟧ → bob@…`, an answer that filled them in the wrong order still contained both
values, still had no leftover placeholder, and still left an empty residue — three
passing checks over a released string that told the reader Bob's address was Alice's.
Equality makes the _correspondence_ between placeholder and value part of the guarantee,
not just their presence. It also subsumes the old residue scan (re-running the attester
over the released text minus the restored values): any character that materialized during
rehydration fails equality, whether or not it happens to look like PII to a scanner.

Two cheaper checks run ahead of the rebuild purely as **diagnostic preambles**, so a
failure names _what_ went wrong instead of only that the strings differ:

1. **The leftover set equals the withheld set** (`leftover_token` / `missing_withheld`).
   A `⟦…⟧` surviving that the policy did not withhold is a substitution that silently
   failed; a withheld placeholder that _vanished_ means something replaced it, which is
   the disclosure the policy forbade.
2. **Every restored placeholder carries the vault's own value** (`substitution_mismatch`),
   checked per token so a forged substitution is reported by name — which equality alone
   cannot do.

A rebuild failure is `rebuild_mismatch`, and it deliberately carries **no token list, no
excerpt and no category**: the difference is not attributable to any single token, and
the two strings under comparison are the answer itself, so there is nothing that could be
quoted without quoting the answer. Its token list is empty.

Any violation is `500 rehydration_incomplete` — alone among the refusals in being 5xx,
because it is a fault in our code rather than something the caller could fix — and the
body is withheld exactly as every other refusal withholds it. The verdict is recorded as
`attestation.rehydration: {substituted, withheld_remaining, verdict: "pass"}`, present
only on a release.

Why post-hoc and deterministic rather than trusting `rehydrateWithPolicy`: that function
is the thing being checked, and a verification sharing its implementation would only
prove the implementation agrees with itself.

**Replay coverage.** `just verify-answer <request_id>` replays what the stored artifacts
support: the recorded digests, the leak-check verdict over the masked prompt and core
response, and the presence of `disclosure_requested` / `rehydration` in the attestation
block. It cannot replay the rehydration itself — the check runs over the rehydrated text,
which by design exists only inside the one API response and is never persisted, and over
the vault mapping, which is TTL'd and unreachable after expiry. Those parts are
**runtime-only**: what survives is the fleet's attestation that they passed.

## 10. UI trust dimensions

The UI shows four dimensions **separately**, never collapsed into one badge, so a
partial failure cannot read as a clean pass:

- **policy verdict** — `pass` / `fail` (the deterministic leak check and consistency check)
- **document status** — `draft` / `stable` / `deprecated`
- **freshness** — `fresh` / `stale` / `unknown` (derived from `stale_after`; a missing or unparseable `stale_after` is `unknown`, never `fresh`)
- **review identity** — always `none` (see §2 — human approval is out of scope)

A blocked request is shown as its own outcome, not folded into one of the four
dimensions.

## 11. Demo scenario (≤4 min video)

Customer-support email containing name, email, phone, credit-card and an API key →
ask "draft a reply and a Python script to update this customer's record".
Show: masked prompt sent to Gemini, Gemini's tokenized output, leak-check pass, the
rehydrated final answer, the OKF evidence document, Cloud Run console.

## 12. Knowledge & trust signals: Open Knowledge Format (OKF v0.2)

Every answer the fleet produces is _agent-written content_. We adopt
[OKF v0.2](https://github.com/GoogleCloudPlatform/open-knowledge-format) so that
provenance, trust, freshness, lifecycle and attestation are first-class on each output.

- **Bundle** `knowledge/` (in repo): `policies/pii-masking.md` (human-authored, `human:` verified),
  `computations/leak-check.md` (`type: Attested Computation`, `runtime: typescript`,
  deterministic attester `references/attesters/leak_check.ts`, receipt
  `[request_id, masked_prompt_hash, response_hash, findings, response, masked_prompt]`).
  The receipt carries both `response` and `masked_prompt` so the attester re-derives
  _both_ hashes itself: a receipt that merely asserted `masked_prompt_hash` could be
  replayed against a different exchange, so the prompt binding is attested rather than
  claimed. `executor.receipt` and the attester's exported `RECEIPT_FIELDS` are the same
  list, and a test enforces that.
- **Per-request output** (Synthesis Agent → Firestore → UI): an OKF concept `type: Gateway Answer`.
  `generated.by` is `synthesis_agent/<version>` — Synthesis assembles the concept, so OKF SPEC §7's
  actor convention attributes the document to it; Core supplies the tokenized prose and appears
  instead as a `core-response` provenance source (`author: core_agent/<GEMINI_MODEL>`). `sources[]`
  carries three entries: `masked-prompt` (`/v1/requests/<id>/masked-prompt.md`),
  `core-response` (`/v1/requests/<id>/core-response.md`) and `pii-policy`. The first two are
  the exact paths the Gateway serves (§7 above), byte for byte — a source that named
  `/requests/<id>/...` while the route was `/v1/requests/<id>/...` was a dangling link, and a
  document whose provenance cannot be followed cannot be replayed. `verified[].by` is `process:leak-check@<attester sha256 short>` once the leak-check
  attestation passes (⇒ _machine-confirmed_); it is never an LLM actor, and there is no `human:<id>`
  entry ever (§2). `stale_after` = vault expiry, `status: draft` on any failed gate.
- A top-level `attestation:` block carries `computation`, `computation_sha256`, `attester_sha256`,
  `masked_prompt_sha256`, `core_response_sha256`, `verdict`, `checked_at`, `request_id`, `trace_id`
  and, when applicable, `withheld` and `custom_terms: {count: N}` — enough for a third party to
  replay the verdict without trusting this fleet. `custom_terms` is a **count only**: the terms are
  confidential by construction (§3), and a digest of one would be a confirmation oracle rather than
  a redaction, so the record states that the scan ran and over how many terms and stops there.
  Replay it with `just verify-answer <request_id>`.
- Malformed `verified` entries (missing or non-string `by`) are excluded from the trust-tier
  derivation, so a corrupted field derives `unverified` rather than crashing or over-trusting. An
  invalid or absent `stale_after` derives freshness `unknown`, never `fresh`.
- The UI derives and shows the four trust dimensions (§10) separately; attestation failures are
  surfaced, never dropped.
- Why OKF rather than an ad-hoc JSON audit record: the audit trail becomes a portable, diffable, human-readable
  bundle that any OKF consumer (Knowledge Catalog, an agent, `cat`) can read — trust in agent output is the
  product, so the record of that trust should be a standard.

Agent-facing guidance for writing OKF in this repo lives in `skills/okf/` (shared by
`.claude/skills/okf` and `.codex/skills/okf`).
