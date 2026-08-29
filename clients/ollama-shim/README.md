# `@privacy-gateway/ollama-shim`

A localhost shim that makes the Privacy-Preserving Gateway **selectable as a model**
in Claude Desktop's model picker, and in any client that speaks the native Ollama
API.

Japanese: [README.ja.md](README.ja.md).

## What we found out first, and why it changed the design

The premise we started from was: _Ollama v0.33 makes Claude Desktop list models
from a local Ollama, so a shim that answers `/api/tags` and `/api/chat` on
`localhost:11434` will appear in the picker._

**That premise is wrong, and a shim built on it would never appear.** Ollama
v0.33 does not teach Claude Desktop to speak the Ollama protocol. It registers
Ollama as a **third-party gateway provider** — and a Claude third-party gateway
serves the **Anthropic Messages API**, not the Ollama API:

| What Claude Desktop actually calls | Purpose                                       |
| ---------------------------------- | --------------------------------------------- |
| `GET /v1/models`                   | model discovery — builds the picker           |
| `POST /v1/messages`                | inference (SSE streaming)                     |
| `POST /v1/messages/count_tokens`   | optional; falls back to inference when absent |
| `HEAD /api/hello`                  | best-effort connection warming, ignorable     |

Sources:

- [Ollama v0.33 release notes](https://github.com/ollama/ollama/releases/tag/v0.33.0) —
  "configure Claude Desktop to seamlessly work with Ollama as a third-party
  **gateway provider**". The wording is the whole finding: _gateway provider_, not
  _Ollama protocol client_.
- [Anthropic gateway protocol reference](https://code.claude.com/docs/en/llm-gateway-protocol) —
  the authoritative contract. A gateway selected by `ANTHROPIC_BASE_URL` serves
  `/v1/messages` (+ optional `/v1/messages/count_tokens`), and discovery is
  `GET /v1/models?limit=1000` with a 3-second timeout, no redirects.
- [TrueFoundry: Claude Desktop & Cowork](https://www.truefoundry.com/docs/ai-gateway/claude-desktop) —
  an independent gateway vendor documenting the same contract: "the app routes
  inference to a gateway that implements the Anthropic Messages API", and when
  the model field is left empty "Cowork calls the AI Gateway's `GET /v1/models`
  endpoint and builds the picker from the response".
- [ollama/ollama#15992](https://github.com/ollama/ollama/issues/15992) — the
  failure mode confirmed from the other direction: Desktop logs show
  `provider type 'gateway'`, `3P mode active`, and a call to `/v1/models` that
  returned 39 models of which **0 were usable**.

### Two consequences that are easy to get wrong

**1. The model id must contain `claude` or `anthropic`.** Discovery "keeps an
entry when its `id` contains `claude` or `anthropic` anywhere in the string,
matched case-insensitively, and ignores the rest". The fleet's own id,
`privacy-gateway`, contains neither — advertised as-is it is silently filtered
out, which is exactly the "0 usable models" symptom above. So the Anthropic
surface advertises:

```json
{ "id": "claude-privacy-gateway", "display_name": "Privacy Gateway (masked → Gemini)" }
```

The id is a **routing key for the picker, not a claim about the model**. Nothing
behind it is a Claude model: the Gateway is Gemma, Core is Gemini 3.5 Flash. The
display name says so.

**2. Is the Ollama.app handshake mandatory?** For the _one-toggle_ experience,
yes — that toggle is Ollama's own app writing Desktop's third-party gateway
config for you. But the handshake is a **convenience, not a gate**: the same
configuration is reachable by hand through Desktop's Developer settings
(Help → Troubleshooting → Enable Developer mode, then Developer → Configure
Third-Party Inference, connection type **Gateway**), which the setup UI validates
and writes to `~/Library/Application Support/Claude-3p/claude_desktop_config.json`.
Fleet-wide, the same settings are pushed via MDM under the
`com.anthropic.claudefordesktop` domain. So this shim does not need Ollama.app,
and does not need port 11434 — it needs to be **named as the gateway base URL**.

We verified locally that the port alone proves nothing: the installed Ollama
(v0.24.0) already answers `POST /v1/messages` with an Anthropic-shaped error
(`{"type":"error","error":{"type":"invalid_request_error",…}}`) rather than a
404, and serves `GET /v1/models` — i.e. even Ollama satisfies Desktop through the
_Anthropic_ surface, not its own.

### So the shim serves both surfaces

| Surface                | Endpoints                                                                         | Who uses it                     |
| ---------------------- | --------------------------------------------------------------------------------- | ------------------------------- |
| **Anthropic Messages** | `GET /v1/models`, `POST /v1/messages`, `HEAD /api/hello`                          | **Claude Desktop** (the picker) |
| **Native Ollama**      | `/api/tags`, `/api/show`, `/api/chat`, `/api/generate`, `/api/version`, `/api/ps` | `ollama` CLI and its ecosystem  |

One process, one port, both protocols — so the operator does not have to know
which client speaks which.

## Running it

```bash
pnpm -C clients/ollama-shim build
pnpm -C clients/ollama-shim start          # side-by-side on 127.0.0.1:11435
```

| Flag            | Effect                                                                        |
| --------------- | ----------------------------------------------------------------------------- |
| _(none)_        | binds **11435**, so a real Ollama keeps 11434 and both run                    |
| `--takeover`    | binds **11434**; stop Ollama.app first or the shim exits with a clear message |
| `--port <n>`    | any port; wins over `--takeover`, because the operator named it               |
| `--host <addr>` | bind address, default `127.0.0.1` — see the security note                     |

`PGW_GATEWAY_URL` overrides the upstream Gateway (default: the deployed one).

Takeover mode exists only for clients that **hardcode** `localhost:11434`. Claude
Desktop is not one of them: you name the base URL, so side-by-side is the right
mode there and your real Ollama keeps working.

## Pointing Claude Desktop at it

1. Claude Desktop → **Help → Troubleshooting → Enable Developer mode**.
2. **Developer → Configure Third-Party Inference**, connection type **Gateway**.
3. Gateway base URL: `http://127.0.0.1:11435` · auth scheme `bearer` · any
   non-empty key (the shim authenticates nobody — see below).

Leave the model field empty so Desktop runs discovery against `GET /v1/models`;
**Privacy Gateway (masked → Gemini)** then appears in the picker.

> **Honest limitation.** Ollama's one-toggle flow only configures _Ollama_ as the
> gateway. There is no public API for a third party to register itself in
> Ollama's Apps screen, so this shim is configured through Desktop's own
> third-party settings instead — the same destination, reached manually. If a
> real Ollama is already registered as Desktop's gateway, pointing Desktop at the
> shim replaces that; `--takeover` is the alternative, but it requires stopping
> Ollama.app entirely.

## Verified end-to-end against the deployed Gateway

Real transcript, shim on 11439 → deployed Gateway. Note the round trip is the
whole fleet: mask → Core (Gemini, placeholders only) → leak check → rehydrate.

```console
$ curl -s http://127.0.0.1:11439/v1/messages -H 'content-type: application/json' \
  -d '{"model":"claude-privacy-gateway","max_tokens":300,"messages":[
       {"role":"user","content":"Customer Taro Yamada (taro@example.co.jp) reports a failed charge. Draft a one-sentence apology."}]}'

{"id":"msg_01a04acdc36f7b38be0727d9b9300196","type":"message","role":"assistant",
 "model":"claude-privacy-gateway",
 "content":[{"type":"text","text":"Dear Taro Yamada, please accept our sincere apologies for the
   inconvenience caused by the failed charge on your account, and we are working to resolve this
   issue as quickly as possible."}],
 "stop_reason":"end_turn","usage":{"input_tokens":0,"output_tokens":0}}
HTTP 200 in 2.98s
```

The native surface, streaming NDJSON:

```console
$ curl -s http://127.0.0.1:11439/api/chat -H 'content-type: application/json' \
  -d '{"model":"privacy-gateway:latest","messages":[{"role":"user","content":"…failed charge…"}]}'

{"model":"privacy-gateway:latest","message":{"role":"assistant","content":"Dear Taro Yamada, …"},"done":false}
{"model":"privacy-gateway:latest","message":{"role":"assistant","content":""},"done":true,"done_reason":"stop",…}
```

What the fleet actually sent across the boundary, from the same request's
evidence — the masked prompt Core saw:

```text
Customer ⟦PERSON_1⟧ (⟦EMAIL_1⟧) reports a failed charge. Draft a one-sentence apology.
```

And the shim's logs for both calls — event names, ids and durations, no text:

```json
{"severity":"INFO","agent":"ollama-shim","event":"shim.messages.start","request_id":"a13900bb-…","surface":"anthropic","stream":false,"message_count":1}
{"severity":"INFO","agent":"ollama-shim","event":"shim.upstream.ok","request_id":"01a04acd-c36f-…","surface":"anthropic","duration_ms":2974,"status":200}
```

## Maintainer checklist (Claude Desktop, 3 steps)

1. `pnpm -C clients/ollama-shim build && pnpm -C clients/ollama-shim start`
   — expect `{"event":"shim.listening","port":11435}`, then confirm
   `curl -s localhost:11435/v1/models` lists `claude-privacy-gateway`.
2. Desktop → Help → Troubleshooting → **Enable Developer mode** → Developer →
   **Configure Third-Party Inference** → type **Gateway**, base URL
   `http://127.0.0.1:11435`, auth `bearer`, key `unused`, **model field empty**.
3. Restart Desktop, open the model picker, select **Privacy Gateway (masked →
   Gemini)**, and send a message containing an email address. Expect a normal
   answer; check the shim's stderr shows `shim.upstream.ok` and **no prompt text**.

If the picker shows nothing, discovery was filtered or timed out: confirm the id
still contains `claude`, that the base URL does **not** redirect (discovery treats
any redirect as failure), and that `/v1/models` answers within 3 seconds.

## Security note

- **Loopback only.** The default bind is `127.0.0.1`, and that is a security
  property rather than a default worth relaxing: the shim authenticates nobody,
  so a shim on a routable interface is an unauthenticated proxy to the fleet.
  `--host` exists for containers; if you use it, put real authentication in front.
- **No vault access.** The shim depends on `zod` and nothing else. It deliberately
  does _not_ import `@privacy-gateway/common`, whose package pulls in Firestore
  and the ADK — a laptop-side process must not be able to reach the token vault.
  The structured logger is reimplemented locally (~20 lines) for that reason.
- **No text in logs.** Fields pass a typed allowlist; an unlisted field is
  dropped and only its _key name_ recorded under `dropped_fields`. Prompts,
  answers and exception messages have no field to travel in.
- **Refusals stay refusals.** A gate that refuses produces an HTTP error on both
  surfaces, carrying the category findings and the sentence _"the gateway
  refused; do not retry around a safety gate"_. A refusal is never laundered into
  a 200 whose body happens to be an apology — a model that cannot tell the
  difference will retry, and retrying around a privacy gate is another attempt to
  move the same data across the same boundary.
- **Streaming is framing, not incremental release.** Both surfaces emit exactly
  one content chunk. The leak check runs on the _complete_ Core answer, so
  streaming tokens as produced would release text before the verdict deciding
  whether it may be released at all.
- **Pseudonymization, not anonymization.** Placeholders disclose category and
  equality, and surviving quasi-identifiers permit contextual re-identification.

## Tests

`pnpm -C clients/ollama-shim test` — 21 tests: discovery shape on both surfaces
(including the id filter), flattening and `stream:false` upstream, refusal
mapping, SSE and NDJSON framing, fail-closed handling of uninterpretable upstream
responses, and the logger's allowlist.
