# Consuming the Privacy-Preserving Gateway

How to call the fleet from outside it. Six surfaces, one pipeline: whichever you
use, the same fail-closed gates run and the same evidence is stored.

| surface                                       | use it for                                                                            |
| --------------------------------------------- | ------------------------------------------------------------------------------------- |
| Web UI (`/` on the Gateway)                   | the demo: masked prompt and final answer side by side, with the four trust dimensions |
| `POST /v1/ask` (native JSON)                  | the full result — trust dimensions, attestation, consistency, stats                   |
| `POST /v1/chat/completions` (OpenAI)          | dropping the fleet into any existing OpenAI-compatible client                         |
| MCP server (`clients/mcp`)                    | giving an agent tools that ask, fetch evidence, and verify                            |
| Ollama/Anthropic shim (`clients/ollama-shim`) | selecting the fleet as a _model_ in Claude Desktop's picker                           |
| `clients/python/pgw.py`                       | a dependency-light CLI example, and the only client that can check the bundle digests |

Deployed Gateway: `https://privacy-gateway.kexi.dev`. Local: `http://localhost:8081`.
Substitute either for the base URL in the examples below.

## 0. The Basic-auth gate

`BASIC_AUTH_CREDENTIALS=user:pass` on the Gateway turns on an HTTP Basic gate
over every surface; unset, the gateway is exactly as public as the examples
below assume. The deployed demo runs **gated** through the judging window — the
credential is distributed via the submission form, never this repository.
Per-client, verified against the live deployment on 2026-09-01:

- **curl**: `curl -u user:pass …` composes with every example below.
- **Web UI and audit page**: the browser answers the 401 challenge with its own
  credential dialog; enter it once and every in-page fetch inherits it.
- **OpenAI SDK**: the `api_key` field can **not** carry the credential — the SDK
  sends it as `Authorization: Bearer …` and the gate accepts only `Basic `.
  Pass the header explicitly:

  ```python
  client = OpenAI(
      base_url="https://privacy-gateway.kexi.dev/v1",
      api_key="unused",
      default_headers={"Authorization": "Basic <base64(user:pass)>"},
  )
  ```

- **Codex CLI**: `env_key` has the same Bearer problem, so put the header in
  the provider block instead — see the profile in §2.
- **MCP server, Ollama shim, `pgw.py`**: no credential channel today. They work
  against an ungated deployment or `http://localhost:8081`; pointed at the gated
  demo, every call answers 401. Embedding `user:pass@` in `PGW_GATEWAY_URL` does
  not work either — Node's `fetch` rejects a URL that carries credentials.

`/healthz` is exempt so the liveness probe stays unauthenticated — but that is
only observable locally: on Cloud Run, Google's frontend intercepts `/healthz`
and answers its own 404 on both the custom domain and the `run.app` host, so
the request never reaches the container from outside.

## 1. The native endpoint

```bash
curl -sS http://localhost:8081/v1/ask \
  -H 'content-type: application/json' \
  -d '{"text":"Customer Taro Yamada (taro@example.co.jp) reports a failed charge."}'
```

`{text}` plus the optional `rehydrate_allow` and `mask_terms` (both below) and
nothing else. A body carrying `session_id` is rejected with `400`: there are no
sessions, and a caller-supplied id would be a rehydration oracle. The response
holds the masked prompt that actually crossed the boundary, the rehydrated answer
(returned once, never stored), the OKF document, the four trust dimensions, and
the attestation.

**User-defined secret terms.** The detectors cover shapes — an email looks like
an email, a card number carries a checksum. An unreleased product name or an
internal codename has no shape, so the requester names it:

```bash
curl -sS http://localhost:8081/v1/ask \
  -H 'content-type: application/json' \
  -d '{"text":"Summarize the status of Titan Project for the board.",
       "mask_terms":["Titan Project"]}'
```

1–20 terms, each 2–120 characters after trimming, no `⟦`/`⟧`, deduplicated with
case preserved. Each becomes a `⟦CUSTOM_n⟧` placeholder in an exact-match pass
that runs before every detector, so the term never crosses the boundary; longer
terms substitute first, so naming both `Titan` and `Titan Project` produces one
placeholder for the longer phrase rather than splitting it.

**Matching is case-sensitive.** A codename's case is part of its identity —
`Titan` the product is not `titan` inside "titanium alloy" — so folding case
would mask ordinary prose you never asked to hide. Name both spellings if you
want both masked.

`CUSTOM` is **not** in the withheld set: the term comes back in your answer,
because you supplied it and withholding it would only make the answer unreadable.
The protection is that the term never reached the frontier model.

Both boundary scans cover the terms literally: the egress guard checks the
outbound prompt (`422 outbound_guard_refused`) and the attester checks Core's
answer (`422 leak_check_failed`), each reporting category `CUSTOM`. This is the
only check that can _prove_ the masking worked, rather than re-running the
detector that decided it.

**What is kept, precisely.** The term list you send is never persisted to
evidence or to logs — the OKF document records
`attestation.custom_terms: {count: N}` and nothing else, and no log field can
carry a term. A term that _matched_ has its value stored like any other masked
value: in the request-scoped, TTL'd Token Vault mapping, keyed by that request's
`request_id`, because rehydrating `⟦CUSTOM_n⟧` back into your answer requires it.
A term that matched nothing exists only in that request's memory and is gone when
the response is written.

**Per-request disclosure opt-in.** `API_KEY`, `AWS_KEY`, `JWT`, `CREDIT_CARD` and
`MY_NUMBER` are never restored into an answer by default. A caller may allow
specific ones back for one request:

```bash
curl -sS http://localhost:8081/v1/ask \
  -H 'content-type: application/json' \
  -d '{"text":"...the charge on card 4242 4242 4242 4242 failed...",
       "rehydrate_allow":["CREDIT_CARD"]}'
```

The list must be a subset of those five; anything else — including a category
that is never withheld, such as `EMAIL` — is a `400`, because an opt-in that
quietly did nothing is the one failure mode this must not have. The allowance
covers only values submitted **in this same request** (one request, one vault
key, no session to persist into) and is unioned with the deployment's
`REHYDRATE_ALLOW_CATEGORIES`; neither can release a category outside the five.

The response records the request and the outcome separately:
`attestation.disclosure_requested` is what you asked for,
`attestation.withheld` is what you still did not get. The stored OKF document
keeps a masked body either way — the disclosure is for the one response, never
for the audit trail.

**Rehydration is verified.** Every release carries
`attestation.rehydration: {substituted, withheld_remaining, verdict: "pass"}`.
After the single rehydration the fleet checks deterministically that the
surviving placeholders are exactly the withheld set, that every restored
placeholder holds the vault's own value, and that no other identifier appeared.
A violation is `500 rehydration_incomplete` and no answer is released.

**Progress streaming.** Send `Accept: text/event-stream` and the same endpoint
narrates the pipeline instead of waiting silently:

```bash
curl -sS -N http://localhost:8081/v1/ask \
  -H 'content-type: application/json' -H 'accept: text/event-stream' \
  -d '{"text":"Customer Taro Yamada (taro@example.co.jp) reports a failed charge."}'
```

One `event: progress` frame per stage (`masking`, `egress_guard`,
`core_reasoning`, `leak_check`, `rehydrate`) carrying only the stage name, a
`start`/`end` marker and `elapsed_ms` — never prompt text, an answer fragment or
a placeholder. Then `event: result` with the identical `AskResponse` body, or
`event: refused` with the error body and a `status` field, followed by
`data: [DONE]`.

This narrates the wait; it does not release text early. The HTTP status is `200`
from the first frame onwards because the headers are flushed before the pipeline
knows its verdict, so a streaming client reads the refusal frame's `status`
rather than the response code. The OpenAI `stream: true` framing is separate and
unchanged — see §2.

**Warm/cold.** `GET /v1/status` reports `{gemma: warm|warming|cold|unknown,
last_active_at?, warmup_requested_at?, cold_start_estimate_seconds}`. `warming` means a
wake was dispatched within the last 3 minutes and no Gemma call has landed since; it
expires back to `cold`, and a recorded Gemma call always outranks it as `warm`. The GPU-backed Gemma service
scales to zero, so a cold fleet's first request waits roughly two minutes. The
verdict comes from a timestamp recorded after each successful Gemma call, never
from probing Gemma — a probe would wake the instance being reported on. It is
cheap, cached about five seconds, and never 500s: an unreadable store is
`unknown`, not an error.

`POST /v1/warmup` starts the GPU and returns `{started: true}` (202) without
waiting for it — a cold start outlives any sane HTTP timeout, so poll `/v1/status`
to learn when it landed. **It costs money**: the instance is billed until it idles
out, roughly fifteen minutes after the last request. It shares the `/v1/ask` rate
limit for exactly that reason.

## 2. The OpenAI-compatible endpoint

Point any OpenAI-compatible client at the gateway as its `base_url` and select
`privacy-gateway` as the model:

```bash
curl -sS http://localhost:8081/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{
        "model": "privacy-gateway",
        "messages": [
          {"role": "system", "content": "You are terse."},
          {"role": "user", "content": "Draft a reply to taro@example.co.jp about the failed charge."}
        ]
      }'
```

```python
from openai import OpenAI

client = OpenAI(base_url="http://localhost:8081/v1", api_key="unused")
completion = client.chat.completions.create(
    model="privacy-gateway",
    messages=[{"role": "user", "content": "Draft a reply about the failed charge."}],
)
print(completion.choices[0].message.content)
```

Codex CLI reaches the gateway over the **Responses API**, not `chat/completions`.
Codex ≥ 0.149 refuses to start with `wire_api = "chat"`:

```
Error loading config.toml: `wire_api = "chat"` is no longer supported.
How to fix: set `wire_api = "responses"` in your provider config.
```

The same release also rejects `[profiles.*]` tables inside `config.toml`, so the
profile lives in its own file, `~/.codex/pgw.config.toml`:

```toml
model = "privacy-gateway"
model_provider = "pgw"
# Without these two, Codex warns "Model metadata for privacy-gateway not found.
# Defaulting to fallback metadata": it knows no context window for an id that is
# not an OpenAI model, so it guesses one and may truncate turns on its own.
model_context_window = 65536      # the gateway's 256 KiB body limit is ~65k tokens
model_max_output_tokens = 8192

[model_providers.pgw]
name = "Privacy Gateway"
base_url = "https://privacy-gateway.kexi.dev/v1"
wire_api = "responses"
# Only when the deployment is gated (§0). `http_headers`, not `env_key`:
# Codex sends an env_key as `Bearer`, which the Basic gate refuses.
http_headers = { "Authorization" = "Basic <base64(user:pass)>" }
```

Then `codex --profile pgw`. `GET /v1/models` advertises exactly one id,
`privacy-gateway`: a caller selects the _fleet_, not the model behind it.

**Which check to run.** `just codex-smoke` is the routine one: it posts a small
payload straight to `/v1/responses` and asserts the SSE contract (`response.created`
→ nonce → `response.completed`), so it catches a wire-format regression in
seconds. `just codex-e2e` drives the real `codex exec` in a PTY and is the
**heavier, pre-submission-grade check** — the CLI prepends ~147 KB of
instructions to every turn (~59 KB of it actually forwarded), and a warm turn
completes in ~30 s end to end (measured 2026-08-31). See `tests/codex/README.md`
for the prerequisites and why neither is in CI.

**Responses mapping.** `instructions` is prepended to the `input` turns and the
whole thing is flattened into the one text the pipeline masks; `developer` turns
count as system turns, `assistant` turns are dropped, and replayed `reasoning` /
`function_call` items are ignored. The answer comes back as a single `message`
item whose `content[0]` is an `output_text`.

**Tools.** Codex declares its shell toolset on every request. The gateway accepts
the declaration and ignores it: it has no sandbox to run a tool in, and
fabricating a call the model never made would be a command the caller executes.
The honest behaviour is a text answer and never a `function_call` item, which
Codex reads as a turn that chose not to use a tool.

**Streaming.** Codex hard-codes `stream: true`, so the gateway answers SSE. The
whole answer arrives as one delta followed by `response.output_item.done` and
`response.completed`, because the leak check runs on the complete Core answer —
streaming tokens as produced would release text before the verdict that decides
whether it may be released at all. A refused release arrives as a terminal
`response.failed` carrying the gateway's own error code, never as a completed turn.

**Message mapping.** `system` and `user` contents are concatenated in order,
separated by a blank line, into the single text the pipeline masks. `assistant`
turns are dropped — they are the fleet's own prior output, already rehydrated in
the caller's transcript, and feeding them back would push raw values at the
boundary the egress guard exists to hold. Multi-turn context is therefore the
caller's concatenation: each request is masked and vault-keyed independently,
because there are no sessions.

**Extension field.** The OpenAI schema has nowhere to put the privacy facts, so
they travel in `x_privacy_gateway`: `request_id`, `trace_id`, `trust_tier`,
`status`, `masked_prompt`, `withheld`, and `disclosure_requested` when the
request made one. Stock clients ignore it; an aware client reads it. `id` is
`chatcmpl-<request_id>`, so a caller holding only an OpenAI-shaped response can
still fetch `/v1/requests/<id>` for the evidence.

**Request extension.** The same field carries the disclosure opt-in and the
verbatim-mask terms on the way in, since OpenAI has no place for either:

```json
{
  "model": "privacy-gateway",
  "messages": [{ "role": "user", "content": "..." }],
  "x_privacy_gateway": {
    "rehydrate_allow": ["CREDIT_CARD"],
    "mask_terms": ["Titan Project"]
  }
}
```

Same rules as `/v1/ask`. The object is strict — a misspelled key inside it is a
`400` rather than a silently ignored opt-in — while unknown _top-level_ sampling
knobs are still stripped, so a stock SDK keeps working. Strictness matters most
for `mask_terms`: a typo that quietly masked nothing is the one failure mode a
request to hide a codename must not have.

**Text only, by design.** A message whose `content` is an array of parts is
accepted only if every part is `{"type": "text"}`. Any other part kind
(`image_url`, `input_audio`, …) is refused with `400` and
`code: multimodal_unsupported`, naming the kinds it saw — never silently
dropped. Redaction here is deterministic regex plus a text model, so PII inside
an image or an audio clip (a face, a whiteboard, a screenshot of a card, a name
read aloud) cannot be found, masked or verified. Accepting the part and dropping
it would send a prompt you did not write; forwarding it would put unmaskable data
across the boundary. In-boundary Gemma vision extraction is the planned way to
support it. The Anthropic/Ollama shim refuses an `image` block the same way, and
MCP `pgw_ask` takes a `string` with no shape an attachment could arrive in.

**Refusals** come back as an OpenAI error object with the original status
preserved (422 for a release the guard refused, 400 for reserved syntax, 504 for
the deadline), carrying the category findings. A refusal is never laundered into
a 200 completion whose content happens to be an apology.

A `judge_flagged` refusal (422) may have cost two judge calls rather than one: an
unevidenced flag over an attester-clean body is re-asked exactly once, but only to
name categories for the refusal record — the second call's verdict is never
consulted, so a flag never becomes a pass. `attestation.judge_retries: 1` in the
evidence document means the categories were recovered on that second look, not
that the release was in doubt and then cleared.

**Streaming** (`stream: true`) emits one content chunk and then `[DONE]`. This is
not a stub to be improved later: every gate here is fail-closed and the leak
check runs on the _complete_ Core answer, so streaming tokens as produced would
mean releasing text before the verdict that decides whether it may be released at
all. A refusal after the caller has rendered half an answer is not a refusal. The
SSE framing exists so streaming clients work, not to make the answer arrive
sooner — and a request that ends in a refusal never opens an SSE body.

## 2a. Refusals, in full

Every one of these releases nothing and stores no rejected text. The `error` code
is the same on both `/v1/ask` and `/v1/chat/completions`; only the envelope
differs.

| code                        | HTTP | what it means                                                                       |
| --------------------------- | ---- | ----------------------------------------------------------------------------------- |
| `invalid_request`           | 400  | the body failed its schema — a stray `session_id`, or a bad `rehydrate_allow` entry |
| `reserved_syntax`           | 400  | the request wrote the reserved `⟦…⟧` delimiters itself                              |
| `multimodal_unsupported`    | 400  | a non-text content part; nothing was sent (see §2)                                  |
| `outbound_guard_refused`    | 422  | raw PII survived masking; Core was never called                                     |
| `vault_missing`             | 409  | no live token mapping for this request                                              |
| `vault_expired`             | 410  | the mapping existed and aged out; retrying will not help                            |
| `vault_generation_mismatch` | 409  | the mapping changed after the request was masked                                    |
| `invented_token`            | 409  | Core used a placeholder it was never given                                          |
| `leak_check_failed`         | 422  | the deterministic attester found a raw identifier in Core's answer                  |
| `judge_flagged`             | 422  | the advisory Gemma judge flagged a possible leak (see below)                        |
| `judge_unavailable`         | 422  | the judge returned no usable verdict; treated exactly like a flag                   |
| `unresolved_token`          | 409  | the answer references a placeholder absent from the vault                           |
| `rehydration_incomplete`    | 500  | the rehydration did not match the disclosure policy — **our** bug, hence 5xx        |
| `extraction_unavailable`    | 502  | Gemma span extraction was unusable; the request was not forwarded                   |
| `rate_limited`              | 429  | the per-IP demo rate limit                                                          |
| `deadline_exceeded`         | 504  | the whole chain ran past its deadline                                               |

`rehydration_incomplete` is the only 5xx refusal, and deliberately so: every other
entry is the fleet declining something about the _request_, which the caller can
act on. That one is the fleet catching a fault in its own rehydration — the caller
did nothing wrong and changing the input would not help — so it reports as a server
error while still withholding the body like any other refusal.

## 3. The MCP server

`clients/mcp` is a stdio MCP server exposing three tools. See
`clients/mcp/README.md` for Claude Desktop / Claude Code / Codex configuration.

| tool           | input                 | returns                                                                     |
| -------------- | --------------------- | --------------------------------------------------------------------------- |
| `pgw_ask`      | `{text, mask_terms?}` | answer, masked prompt, derived trust tier, status, ids, withheld categories |
| `pgw_evidence` | `{request_id}`        | the stored masked OKF document                                              |
| `pgw_verify`   | `{request_id}`        | a replayed attestation with a per-digest verdict list                       |

`mask_terms` is the same list `/v1/ask` takes — phrases to mask verbatim, matched
exactly and case-sensitively, so pass a codename with the capitalisation it
actually uses.

Two properties matter when writing against it:

- **A refusal is a result, not a thrown error.** Tools return `refused: true`
  with the status, error, message and categories. A thrown MCP error reads to a
  model as a transient fault worth retrying, and retrying around a privacy gate
  is another attempt to move the same data across the same boundary. Every tool
  description says so explicitly.
- **`pgw_verify` transcribes the scanner rather than importing it.** Replaying
  the leak check with the fleet's own code would only prove the fleet agrees with
  itself. It checks digest syntax, re-hashes the two served artifacts, and
  re-derives the verdict independently. The two bundle digests
  (`attester_sha256`, `computation_sha256`) name files in the fleet repository
  and are reported as **not checked**, never as passing — use `pgw.py verify`
  from a checkout to compare those.

## 4. The model-picker shim

`clients/ollama-shim` makes the fleet selectable as a _model_ in Claude Desktop.

The important correction, because the obvious guess is wrong: Ollama v0.33 did
not teach Claude Desktop the Ollama protocol — it registered Ollama as a
**third-party gateway provider**, and a Claude gateway serves the **Anthropic
Messages API**. Desktop calls `GET /v1/models` for discovery and
`POST /v1/messages` for inference. A shim serving only `/api/tags` and
`/api/chat` is reachable from the `ollama` CLI and invisible to Desktop.

Discovery also filters: an entry is kept only when its `id` contains `claude` or
`anthropic`, so the shim advertises `claude-privacy-gateway` with the display
name `Privacy Gateway (masked → Gemini)`. The id is a routing key for the picker,
not a claim about the model — the fleet is Gemma and Gemini throughout.

The shim serves the native Ollama API too, so `ollama`-shaped clients work
unchanged. It binds `127.0.0.1` (it authenticates nobody), depends only on `zod`,
and never imports `@privacy-gateway/common` — a laptop-side process must not be
able to reach the vault. Refusals map to HTTP errors on both surfaces, carrying
the categories and the do-not-retry sentence; both streaming framings emit one
content chunk, for the same reason the OpenAI SSE does.

## 5. The Python CLI

```bash
uv run clients/python/pgw.py ask "text"
uv run clients/python/pgw.py ask "text" --allow CREDIT_CARD --mask-term "Titan Project"
uv run clients/python/pgw.py evidence <request_id> [--json]
uv run clients/python/pgw.py verify <request_id>
```

`--allow` and `--mask-term` are both repeatable and map to `rehydrate_allow` and
`mask_terms` respectively. Note that `--gateway` is a _top-level_ flag, so it
comes before the subcommand.

The only client that can check all four digests, because it can hash the bundle
files in the checkout it lives in.

**Audit view.** `GET /v1/audit` lists stored evidence metadata newest-first (max 50,
no document bodies) and `/audit` is its read-only page; both need an
`X-Admin-Token` header and answer **404 — not 401** when `ADMIN_TOKEN` is unset or
wrong, so a client cannot tell "disabled" from "wrong token". The header is the
only accepted channel — a `?key=` query is refused even with the right value,
because Cloud Run logs the query string verbatim — so a shareable link carries the
token in the fragment (`/audit#key=…`), which browsers never transmit, and the page
turns it into the header. The token is a capability, not an identity: it never
makes a document `human-reviewed`.

## 6. What to say about the guarantee

The masking is **pseudonymization, not anonymization**. Placeholders disclose
category and equality (`⟦EMAIL_1⟧` twice means the same address twice), and
surviving quasi-identifiers permit contextual re-identification. Say that; do not
describe the output as anonymous.

The trust tier is **derived, never stored** (OKF SPEC §5.3) — clients re-derive
it from the document's `verified` field, which is what proves the property holds
end to end. `human-reviewed` is unreachable in this product: the public gateway
authenticates nobody, so nothing can mint a `human:` actor.
