# Consuming the Privacy-Preserving Gateway

How to call the fleet from outside it. Four surfaces, one pipeline: whichever you
use, the same fail-closed gates run and the same evidence is stored.

| surface                              | use it for                                                                            |
| ------------------------------------ | ------------------------------------------------------------------------------------- |
| `POST /v1/ask` (native JSON)         | the full result — trust dimensions, attestation, consistency, stats                   |
| `POST /v1/chat/completions` (OpenAI) | dropping the fleet into any existing OpenAI-compatible client                         |
| MCP server (`clients/mcp`)           | giving an agent tools that ask, fetch evidence, and verify                            |
| `clients/python/pgw.py`              | a dependency-light CLI example, and the only client that can check the bundle digests |

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

## 4. The Python CLI

```bash
uv run clients/python/pgw.py ask "text"
uv run clients/python/pgw.py evidence <request_id> [--json]
uv run clients/python/pgw.py verify <request_id>
```

The only client that can check all four digests, because it can hash the bundle
files in the checkout it lives in.

## 5. What to say about the guarantee

The masking is **pseudonymization, not anonymization**. Placeholders disclose
category and equality (`⟦EMAIL_1⟧` twice means the same address twice), and
surviving quasi-identifiers permit contextual re-identification. Say that; do not
describe the output as anonymous.

The trust tier is **derived, never stored** (OKF SPEC §5.3) — clients re-derive
it from the document's `verified` field, which is what proves the property holds
end to end. `human-reviewed` is unreachable in this product: the public gateway
authenticates nobody, so nothing can mint a `human:` actor.
