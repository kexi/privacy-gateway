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

Deployed Gateway: `https://gateway-agent-turszib42q-uc.a.run.app`. Local: `http://localhost:8081`.
Substitute either for the base URL in the examples below.

## 1. The native endpoint

```bash
curl -sS http://localhost:8081/v1/ask \
  -H 'content-type: application/json' \
  -d '{"text":"Customer Taro Yamada (taro@example.co.jp) reports a failed charge."}'
```

`{text}` and nothing else. A body carrying `session_id` is rejected with `400`:
there are no sessions, and a caller-supplied id would be a rehydration oracle.
The response holds the masked prompt that actually crossed the boundary, the
rehydrated answer (returned once, never stored), the OKF document, the four trust
dimensions, and the attestation.

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

**Warm/cold.** `GET /v1/status` reports `{gemma: warm|cold|unknown,
last_active_at?, cold_start_estimate_seconds}`. The GPU-backed Gemma service
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

Codex CLI selects it through a provider profile in `~/.codex/config.toml`:

```toml
[model_providers.privacy-gateway]
name = "Privacy Gateway"
base_url = "https://gateway-agent-turszib42q-uc.a.run.app/v1"
wire_api = "chat"

[profiles.privacy-gateway]
model_provider = "privacy-gateway"
model = "privacy-gateway"
```

`GET /v1/models` advertises exactly one id, `privacy-gateway`: a caller selects
the _fleet_, not the model behind it.

**Message mapping.** `system` and `user` contents are concatenated in order,
separated by a blank line, into the single text the pipeline masks. `assistant`
turns are dropped — they are the fleet's own prior output, already rehydrated in
the caller's transcript, and feeding them back would push raw values at the
boundary the egress guard exists to hold. Multi-turn context is therefore the
caller's concatenation: each request is masked and vault-keyed independently,
because there are no sessions.

**Extension field.** The OpenAI schema has nowhere to put the privacy facts, so
they travel in `x_privacy_gateway`: `request_id`, `trace_id`, `trust_tier`,
`status`, `masked_prompt`, `withheld`. Stock clients ignore it; an aware client
reads it. `id` is `chatcmpl-<request_id>`, so a caller holding only an
OpenAI-shaped response can still fetch `/v1/requests/<id>` for the evidence.

**Refusals** come back as an OpenAI error object with the original status
preserved (422 for a release the guard refused, 400 for reserved syntax, 504 for
the deadline), carrying the category findings. A refusal is never laundered into
a 200 completion whose content happens to be an apology.

A `judge_flagged` refusal (422) may have cost two judge calls rather than one: an
unevidenced flag over an attester-clean body is re-asked exactly once, and a
clear second answer releases the request with `attestation.judge_retries: 1` in
the evidence document. Callers see no new status — a request that is refused was
refused twice, and one that passes on the retry is an ordinary success whose
audit record says it needed a second look.

**Streaming** (`stream: true`) emits one content chunk and then `[DONE]`. This is
not a stub to be improved later: every gate here is fail-closed and the leak
check runs on the _complete_ Core answer, so streaming tokens as produced would
mean releasing text before the verdict that decides whether it may be released at
all. A refusal after the caller has rendered half an answer is not a refusal. The
SSE framing exists so streaming clients work, not to make the answer arrive
sooner — and a request that ends in a refusal never opens an SSE body.

## 3. The MCP server

`clients/mcp` is a stdio MCP server exposing three tools. See
`clients/mcp/README.md` for Claude Desktop / Claude Code / Codex configuration.

| tool           | input          | returns                                                                     |
| -------------- | -------------- | --------------------------------------------------------------------------- |
| `pgw_ask`      | `{text}`       | answer, masked prompt, derived trust tier, status, ids, withheld categories |
| `pgw_evidence` | `{request_id}` | the stored masked OKF document                                              |
| `pgw_verify`   | `{request_id}` | a replayed attestation with a per-digest verdict list                       |

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
uv run clients/python/pgw.py evidence <request_id> [--json]
uv run clients/python/pgw.py verify <request_id>
```

The only client that can check all four digests, because it can hash the bundle
files in the checkout it lives in.

## 6. What to say about the guarantee

The masking is **pseudonymization, not anonymization**. Placeholders disclose
category and equality (`⟦EMAIL_1⟧` twice means the same address twice), and
surviving quasi-identifiers permit contextual re-identification. Say that; do not
describe the output as anonymous.

The trust tier is **derived, never stored** (OKF SPEC §5.3) — clients re-derive
it from the document's `verified` field, which is what proves the property holds
end to end. `human-reviewed` is unreachable in this product: the public gateway
authenticates nobody, so nothing can mint a `human:` actor.
