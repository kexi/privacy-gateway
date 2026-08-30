# Privacy-Preserving Multi-Agent Gateway

_日本語版: [README.ja.md](README.ja.md)_

**All Things Agentic Hackathon** — category: _Fortified Enterprise Fleet_ (also targeting
_Best Architectural Design_).

Enterprises want frontier-model reasoning but cannot send raw PII or secrets outside their
trust boundary. This fleet lets **Gemini** reason over _tokenized_ text while an open model
(**Gemma**) that never leaves the boundary owns the mapping back to real values. Placeholders
are a **pseudonym**, not anonymization — see [Pseudonymization, not anonymization](#pseudonymization-not-anonymization)
below.

```
User ──HTTP──▶ Gateway (Gemma)
                 │ 1. detect + tokenize ──▶ Firestore Token Vault (request_id → {token: value})
                 │ 2. masked prompt          (egress guard re-scans before sending)
                 ▼ A2A
               Core (Gemini 3.5)  — reasoning / planning / codegen over placeholders only
                 │ masked answer
                 ▼ HTTP
               Synthesis (Gemma)
                 │ 3. leak check  4. rehydrate  5. consistency verify
                 ▼
               User  (OKF answer document + audit trail)
```

Gateway → Core is the only A2A hop. Gateway → Synthesis is plain authenticated HTTP,
deliberately: the OKF document is an audit artifact and must be retrieved without an LLM
rephrasing it. See [A2A, precisely](#a2a-precisely) below.

Full design: **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)**. Deployment:
**[docs/DEPLOY.md](docs/DEPLOY.md)**. Logs, traces and error codes:
**[docs/OBSERVABILITY.md](docs/OBSERVABILITY.md)**.

## Why this is more than "regex before an API call"

- **The boundary is deployable, not conventional.** Core runs as a separate service with its
  own IAM identity and _no_ Firestore role. It cannot read the vault even if its code tried.
- **The boundary is also in the dependency graph.** `packages/common` publishes subpath
  exports, and Core imports only `@privacy-gateway/common/{logging,config,schema,telemetry}` —
  none of which reach the vault. A future edit that tries to read the vault from Core has to
  add an import that does not exist.
- **Two independent gates.** The Gateway re-scans every outbound prompt with a deterministic
  detector and refuses to send if any raw identifier survived masking. The Synthesis agent
  independently gates the response before rehydration.
- **The verdict is deterministic.** The leak check is an OKF _Attested Computation_ whose
  attester re-derives its own findings from the response text — a runner that under-reports
  fails rather than passes. The Gemma judge is advisory and **asymmetric**: `leak: true` or
  no usable verdict blocks the release, `leak: false` adds no trust at all. A probabilistic
  model may veto; it may never vouch.
- **Trust is a portable artifact.** Every answer is an OKF v0.2 document you can `cat`, diff
  and hand to any OKF consumer.
- **Everything fails closed.** See [Refusals](#refusals) below for the full list — every
  refusal returns no rehydrated answer and persists only masked artifacts.

See also the review at [docs/reviews/2026-08-24-response.md](docs/reviews/2026-08-24-response.md)
(日本語: [docs/reviews/2026-08-24-codex-design-review.ja.md](docs/reviews/2026-08-24-codex-design-review.ja.md))
for the design decisions and known limitations behind these choices.

## Required-tech checklist

|     | Requirement                  | Where                                                                                                                                |
| --- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| ✓   | **Gemini 3.5 via Vertex AI** | Core Agent (`agents/core`), `gemini-3.5-flash` on the **global** endpoint. Model id from `GEMINI_MODEL`.                             |
| ✓   | **Google ADK**               | All three agents, ADK TypeScript (`@google/adk` 2.0.0).                                                                              |
| ✓   | **A2A**                      | Gateway → Core, via Agent Card + `message/send`. Gateway → Synthesis is plain HTTP by design — see [A2A, precisely](#a2a-precisely). |
| ✓   | **Cloud Run**                | One service per agent, plus Gemma serving on Cloud Run GPU (NVIDIA RTX PRO 6000) and the `kill-switch` service.                      |
| ✓   | **Firestore**                | Token Vault and the OKF answer store — both with a TTL policy on `expires_at`.                                                       |
| ✓   | **Gemma (bonus)**            | Gateway span extraction and the Synthesis judge, self-hosted via Ollama.                                                             |

Gateway and Synthesis reach Gemma through **`OllamaLlm`**, a custom ADK `BaseLlm` adapter in
`packages/common` registered in `LLMRegistry` for model names matching `ollama/*`. It speaks
Ollama's OpenAI-compatible `/v1/chat/completions`, so the same code path serves local Ollama
in development and Cloud Run GPU in production.

## Deployed endpoints

The fleet is live in project `all-thinkgs` (`us-central1`). Only the Gateway is public;
every other service is private (IAM invoker + ID token) or internal-ingress only.

| Service           | URL                                               | Access                            |
| ----------------- | ------------------------------------------------- | --------------------------------- |
| `gateway-agent`   | <https://gateway-agent-turszib42q-uc.a.run.app>   | **public** — the demo entry point |
| `core-agent`      | `https://core-agent-turszib42q-uc.a.run.app`      | private (A2A, ID token)           |
| `synthesis-agent` | `https://synthesis-agent-turszib42q-uc.a.run.app` | private (HTTP, ID token)          |
| `gemma-serving`   | `https://gemma-serving-turszib42q-uc.a.run.app`   | internal ingress only             |
| `kill-switch`     | `https://kill-switch-turszib42q-uc.a.run.app`     | private (Pub/Sub push + OIDC)     |

```bash
curl -sS https://gateway-agent-turszib42q-uc.a.run.app/v1/ask \
  -H 'content-type: application/json' \
  -d '{"text":"Customer Taro Yamada (taro@example.co.jp) reports a failed charge."}'
```

`just urls` regenerates this list from Terraform, and `just health` probes every service
with an ID token.

## Six ways to consume it

One pipeline, six entry points — whichever you use, the same fail-closed gates run and the
same masked evidence is stored.

| Surface               | Entry point                       | Best for                                                    |
| --------------------- | --------------------------------- | ----------------------------------------------------------- |
| **Web UI**            | `/` on the Gateway (built SPA)    | the demo: masked prompt and final answer side by side       |
| **REST**              | `POST /v1/ask`                    | the full result — trust dimensions, attestation, stats      |
| **OpenAI-compatible** | `POST /v1/chat/completions`       | dropping the fleet into an existing OpenAI client           |
| **MCP**               | `clients/mcp` (stdio)             | giving an agent ask / evidence / verify tools               |
| **Model picker**      | `clients/ollama-shim` (localhost) | selecting the fleet as a _model_ in Claude Desktop          |
| **Python CLI**        | `clients/python/pgw.py`           | a dependency-light example, and full bundle-digest checking |

Each is documented below: [API](#api), [use as a model](#use-privacy-gateway-as-a-model-in-any-openai-compatible-client),
[MCP](#the-mcp-server), [Python client](#the-python-client-language-agnostic-consumption).

The model-picker shim serves the **Anthropic Messages API** (`GET /v1/models`,
`POST /v1/messages`), because that — not the Ollama protocol — is what Claude Desktop's
third-party gateway actually speaks; it also serves the native Ollama API for `ollama`
clients. See [`clients/ollama-shim/README.md`](clients/ollama-shim/README.md) for the
research, the sources, and the setup steps.

## Repository layout

One pnpm workspace; every agent is ADK TypeScript.

```
packages/common/   # tokenizer, vault, OKF, guard, logging, telemetry, zod schemas,
                   # the A2A client, OllamaLlm, and the OKF bundle's attester
agents/gateway/    # ADK agent + HTTP entry + serves web/dist
agents/core/       # ADK agent (Gemini) + A2A server
agents/synthesis/  # ADK agent + A2A server + HTTP routes
services/kill-switch/  # cost kill switch: budget notification -> stop spending
clients/mcp/       # MCP stdio server: pgw_ask / pgw_evidence / pgw_verify
clients/python/    # pgw.py — single-file PEP 723 client, the language-agnostic example
serving/gemma/     # Ollama Dockerfile for Cloud Run GPU
web/               # demo UI (masked vs final, side by side) + Playwright specs
knowledge/         # OKF v0.2 bundle: policy, attested computation, executor skill
infra/terraform/   # Terraform: Cloud Run, IAM, Firestore TTL, Artifact Registry
```

The workspace packages are `web`, `packages/common`, `agents/core`, `agents/gateway`,
`agents/synthesis`, `services/kill-switch` and `clients/mcp`. The kill switch sits under `services/` rather
than `agents/` because it is not a member of the reasoning fleet: it never sees a prompt, an
answer or a vault entry.

Relative imports carry the **`.ts` extension** (`import { x } from './x.ts'`), enabled by
`allowImportingTsExtensions` + `rewriteRelativeImportExtensions`; tsc rewrites them to `.js`
on build. Source therefore names the file that actually exists, and no import needs to be
mentally translated between the editor and the build output.

## zod at every boundary

HTTP request and response bodies, A2A payloads, Gemma's JSON output, the environment config
and the OKF frontmatter are all defined as zod schemas in `packages/common`. The env schema
is validated at startup, so an invalid value stops the process with a `config.invalid` log
line instead of surfacing halfway through a request. `web` derives its TypeScript types from
those same schemas via `z.infer` rather than hand-writing them, so a change to a response
shape breaks the UI's type check instead of the demo.

## Observability

Every service emits **structured JSON logs**, one object per line, in the shape Cloud Logging
ingests without a sidecar. Logging is a **typed allowlist, not recursive scrubbing**: only
named fields (hashes, counts, enums, internal UUIDs) are emitted, everything else is dropped
with the dropped key names under `dropped_fields`, and exception messages never reach logs or
spans. No raw PII ever reaches a log: string values pass through the tokenizer first, so a
leaked value appears as `⟦EMAIL_1⟧`.

| Signal       | What it gives you                                                                                                                                                                                                                                                                                    |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `request_id` | A UUIDv7 **minted by the Gateway** on every request and used as the vault key. An inbound `X-Request-ID` header is echoed back but never adopted — see [Sessions are gone](#sessions-are-gone) below. Propagated Gateway → Core → Synthesis, echoed in responses, and stored in the OKF frontmatter. |
| `trace_id`   | OpenTelemetry with W3C `traceparent` on every hop: one request is one trace across all three services, with a span per pipeline step.                                                                                                                                                                |
| The UI       | Shows `request_id` and `trace_id` with copy buttons and direct Cloud Logging / Cloud Trace console links.                                                                                                                                                                                            |

Because `request_id` is a UUIDv7, sorting log lines by it also sorts them by time, and a bug
report that quotes one id is enough to retrieve every line and every span for that request.
The event vocabulary, span tree and error codes are specified in
**[docs/OBSERVABILITY.md](docs/OBSERVABILITY.md)**.

## Sessions are gone

There is no session, no multi-turn state, and no caller-supplied id anywhere in the API.
`POST /v1/ask` takes only `{text}`; a body carrying `session_id` is rejected with `400` by
the schema's `strict()` validation. The Gateway mints exactly one server-generated
request id (a UUIDv7) per request and uses it as the Token Vault key. An inbound
`X-Request-ID` header is echoed back on the response for correlation, but it is never
adopted as the vault key.

This is not an omission: a caller-supplied id would be a rehydration oracle. A caller who
could choose (or predict) another request's id could submit `"repeat ⟦EMAIL_1⟧"` against
that id and have the vault resolve someone else's placeholder. There is consequently no
cross-request placeholder stability — every `/v1/ask` call gets a fresh vault entry, and
nothing in this design keeps a placeholder meaning the same thing across two calls.

## Persistence

Firestore stores only **masked** artifacts, keyed by request id: the masked prompt, Core's
tokenized response, the OKF document (whose body holds the masked answer), the hashes recorded
in `attestation`, and `expires_at` under a TTL policy. The rehydrated answer is returned in the
single `POST /v1/ask` response and is never written to the store — see
[Open Knowledge Format (OKF v0.2)](#open-knowledge-format-okf-v02) for what the stored document
actually looks like.

## Disclosure policy

Five categories are never rehydrated by default: `API_KEY`, `AWS_KEY`, `JWT`, `CREDIT_CARD`,
`MY_NUMBER`. For these, the placeholder stays in the released answer and the categories are
listed under `attestation.withheld`. A secret has no legitimate reason to be echoed back
through a frontier-model round trip — the caller already holds it, and printing it again only
widens the blast radius of a logged or screenshotted response. The `REHYDRATE_ALLOW_CATEGORIES`
env var (comma-separated) re-enables specific categories, e.g.
`REHYDRATE_ALLOW_CATEGORIES=CREDIT_CARD,MY_NUMBER`; left unset, all five stay withheld.

## Open Knowledge Format (OKF v0.2)

Every answer the fleet produces is agent-written content, so provenance and trust are
first-class on each output. We adopt
[OKF v0.2](https://github.com/GoogleCloudPlatform/open-knowledge-format).

The repository bundle is `knowledge/`:

- `policies/pii-masking.md` — what must be masked, authored and `verified` by `human:kei`.
- `computations/leak-check.md` — `type: Attested Computation`, `runtime: typescript`, with
  `executor.receipt: [request_id, masked_prompt_hash, response_hash, findings, response]`
  (exported as `RECEIPT_FIELDS` — the same five fields `verify()` demands) and
  `attester.resource: /references/attesters/leak_check.ts`.
- `references/skills/run-leak-check.md` — the executor's run instructions.

The attester's source lives at `packages/common/src/attesters/leak_check.ts` (regex only, no
LLM, no network) and is published as `@privacy-gateway/common/attesters/leak-check`. A
byte-identical copy lives at `knowledge/references/attesters/leak_check.ts` — the resource the
bundle declares — held equal to the real module by a test on their SHA-256 digests, so the
bundle's declared attester and the one Synthesis actually runs cannot drift apart silently.

Each request produces a `type: Gateway Answer` concept. `generated.by` is
`synthesis_agent/<version>`: Synthesis assembles the concept, so §7 attributes the document to
it, while Core's tokenized prose appears as provenance instead — a `core-response` source
authored by `core_agent/<model>`. `sources[]` lists three entries: `masked-prompt`
(`/requests/<id>/masked-prompt.md`), `core-response` (`/requests/<id>/core-response.md`), and
`pii-policy` — the first two are actually served by the Gateway. `verified[].by` is
`process:leak-check@<attester sha256 short>` once the attestation passes (⇒
_machine-confirmed_) — **never an LLM**, and never a `human:` actor (see
[Human approval, removed](#human-approval-removed) below). `stale_after` equals the vault
expiry, and `request_id` / `trace_id` carry correlation. A failed attestation yields
`status: draft`, no `verified` entry, and the reason recorded under `# Attestation` —
surfaced, never dropped. A malformed `verified` entry derives `unverified`, and an invalid or
absent `stale_after` derives freshness `unknown` — never `fresh`.

A new top-level `attestation:` frontmatter block carries everything a third party needs to
replay the verdict: `computation`, `computation_sha256`, `attester_sha256`,
`masked_prompt_sha256`, `core_response_sha256`, `verdict`, `checked_at`, `request_id`,
`trace_id`, and an optional `withheld` list of categories the disclosure policy kept masked.
See [Disclosure policy](#disclosure-policy) below.

Trust tiers are **derived** from `verified`, never stored — server-side, again in the UI
(`web/src/api.ts`), and once more in the Python client.

Agent-facing guidance for writing OKF in this repo lives in `skills/okf/`.

## Local spin-up

Prerequisites: [pnpm](https://pnpm.io/) (via corepack), [just](https://just.systems/),
Node.js 22, [Ollama](https://ollama.com/) for Gemma, and [uv](https://docs.astral.sh/uv/) if
you want to run the Python client.

```bash
cp .env.example .env       # then edit
just setup                 # pnpm install
just pull-gemma            # ollama pull gemma3:12b
```

`just dev` starts all four processes — Gateway (8081), Core (8082), Synthesis (8083) and the
Vite dev server (5173) — with an in-memory vault:

```bash
just dev            # gateway + core + synthesis + web
```

Open <http://localhost:5173>. Vite proxies `/v1` and `/healthz` to the Gateway, so the UI
uses the same relative paths in dev and in production.

Each service can also be run on its own:

```bash
just dev-gateway    # port 8081
just dev-core       # port 8082
just dev-synthesis  # port 8083
```

To serve the built UI from the Gateway itself (as in production):

```bash
just web-build      # produces web/dist
just dev-gateway    # http://localhost:8081
```

`just web-build` runs `pnpm -r build`, so it also compiles `clients/mcp` to
`clients/mcp/dist/` — the entry point the MCP client configs point at.

### Checks

```bash
just check          # the full CI-equivalent suite
just test           # vitest across the workspace
just test-coverage  # the same, with coverage thresholds enforced
just typecheck      # tsc --noEmit, per package
just lint-ts        # oxlint
just fmt-ts         # oxfmt
```

545 vitest tests across 31 files. The root `vitest.config.ts` uses `test.projects`, so
`just test` runs everything from the repository root while each package keeps its own `test`
script for `pnpm --filter X test`. `just test-coverage` uses `@vitest/coverage-v8` and
enforces per-package floors: `packages/common` at 90% lines (it holds the masking, vault and
OKF logic the guarantees rest on), the agents at 70% (thinner orchestration over it).

The suite runs entirely offline: LLMs are mocked and the Core agent is replaced by a mock A2A
server (Agent Card + `message/send`), so the boundary guarantees are exercised without a
network.

### Browser tests

```bash
just web-e2e        # Playwright, chromium only
just setup-browsers # once, outside Nix
```

23 Playwright specs in `web/e2e/` drive the real Gateway and Synthesis with only Core (over
A2A) and Gemma (over the OpenAI-compatible API) mocked, so what the browser exercises is the
production request path rather than a stubbed API. Chromium only: these assert application
behaviour, not rendering differences, and a second engine would double the runtime for no
extra signal. Under Nix the browser comes from `PLAYWRIGHT_BROWSERS_PATH`; outside Nix run
`just setup-browsers` (`pnpm -C web exec playwright install chromium`) once.

### API

| Method | Path                                 | Purpose                                                                                                                     |
| ------ | ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| `POST` | `/v1/ask`                            | `{text}` → masked prompt, ephemeral rehydrated answer, OKF document, four trust dimensions, attestation, consistency, stats |
| `GET`  | `/v1/requests/{id}`                  | the stored **masked** OKF evidence document (markdown)                                                                      |
| `GET`  | `/v1/requests/{id}/masked-prompt.md` | the masked prompt sent to Core                                                                                              |
| `GET`  | `/v1/requests/{id}/core-response.md` | Core's still-tokenized response                                                                                             |
| `POST` | `/v1/chat/completions`               | OpenAI-compatible façade over the same pipeline (see below)                                                                 |
| `GET`  | `/v1/models`                         | OpenAI-compatible model list; one id, `privacy-gateway`                                                                     |
| `GET`  | `/v1/status`                         | is Gemma warm or cold, and the cold-start estimate. Cheap, cached ~5s, and never wakes the GPU                              |
| `POST` | `/v1/warmup`                         | starts the GPU. **Billed while the instance lives** (~15 idle minutes), so it is rate-limited like `/v1/ask`                |
| `GET`  | `/healthz`                           | liveness                                                                                                                    |

`POST /v1/ask` also answers `Accept: text/event-stream` with a progress stream: an
`event: progress` frame per pipeline stage (`masking`, `egress_guard`, `core_reasoning`,
`leak_check`, `rehydrate`) carrying only the stage name, a `start`/`end` marker and
`elapsed_ms`, then a terminal `event: result` with the same `AskResponse` body the JSON
path returns — or `event: refused` carrying the error body and the status it would have
had — followed by `data: [DONE]`. No progress frame ever carries prompt text, an answer
fragment or a placeholder. The status code is `200` from the first frame onwards, because
the headers are flushed long before the pipeline knows whether it will refuse; a streaming
client reads the refusal frame's `status` field instead. The OpenAI-compatible
`stream: true` is unchanged (one content chunk, then `[DONE]`).

`/v1/status` reports `warm` when a Gemma call was recorded in the last 10 minutes, `cold`
when none was, and `unknown` when the record could not be read — it is derived from a
timestamp written after each successful Gemma call, never by probing Gemma, because a probe
would wake the instance it is reporting on.

There is no session-based API any more: `GET /v1/sessions/{id}/answer`,
`POST /v1/sessions/{id}/approve` and `GET /v1/sessions/{id}/tier` are all removed. The evidence
document and its two source artifacts are all that persists server-side; the rehydrated answer
is returned once, in the `/v1/ask` response body, and never stored (see
[Persistence](#persistence) below).

#### Refusals

Every failure mode below fails closed: no rehydrated answer is returned, and only masked
artifacts are persisted.

| Condition                                              | Status                             |
| ------------------------------------------------------ | ---------------------------------- |
| Reserved `⟦…⟧` syntax in the input                     | `400`                              |
| A `session_id` field in the request body               | `400`                              |
| Span extraction unusable or unavailable                | `502` (request never reaches Core) |
| Egress guard finds raw PII in the outbound prompt      | `422`                              |
| Vault mapping missing                                  | `409`                              |
| Vault mapping expired                                  | `410`                              |
| Vault generation mismatch                              | `409`                              |
| Core invented a placeholder absent from the prompt     | `409`                              |
| Leak check failed                                      | `422`                              |
| Gemma judge flags a leak, or returns no usable verdict | `422`                              |
| Unresolved placeholder in the response                 | `409`                              |
| Over the rate limit                                    | `429`                              |
| Request body too large                                 | `413`                              |
| Gateway deadline exceeded                              | `504`                              |

### Use `privacy-gateway` as a model in any OpenAI-compatible client

Point an existing OpenAI-compatible client at the gateway as its `base_url` and select
`privacy-gateway` as the model. No code change, and every gate below still applies.

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

Codex CLI selects it the same way — the fleet is just another OpenAI-compatible provider.
In `~/.codex/config.toml`:

```toml
[model_providers.privacy-gateway]
name = "Privacy Gateway"
base_url = "https://gateway-agent-turszib42q-uc.a.run.app/v1"
wire_api = "chat"

[profiles.privacy-gateway]
model_provider = "privacy-gateway"
model = "privacy-gateway"
```

Then `codex --profile privacy-gateway`. `GET /v1/models` advertises exactly one id,
`privacy-gateway`: a caller selects the _fleet_, not the model behind it.

**Message mapping.** `system` and `user` contents are concatenated in order, separated by a
blank line, into the one text the pipeline masks. `assistant` turns are dropped: they are the
fleet's own prior output, already rehydrated in the caller's transcript, and feeding them back
would push raw values at the boundary the egress guard exists to hold. Multi-turn context is
therefore the caller's concatenation — each request is masked and vault-keyed independently,
because [there are no sessions](#sessions-are-gone).

**Extension field.** `choices[0].message.content` is the rehydrated answer and `id` is
`chatcmpl-<request_id>`, so the evidence stays reachable from an OpenAI-shaped response. The
privacy facts the OpenAI schema cannot express travel in `x_privacy_gateway`: `request_id`,
`trace_id`, `trust_tier`, `status`, `masked_prompt`, `withheld`.

**Refusals** return an OpenAI error object with the status from the table above preserved and
the category findings attached — never a `200` whose content is an apology.

**Streaming** (`stream: true`) emits one content chunk and then `[DONE]`. That is deliberate,
not a stub: the gates are fail-closed and the leak check runs on the _complete_ Core answer,
so streaming tokens as they were produced would release text before the verdict that decides
whether it may be released at all. A refusal that arrives after the caller has rendered half
an answer is not a refusal.

## The MCP server

`clients/mcp` exposes the fleet to any MCP client as three tools — `pgw_ask`, `pgw_evidence`
and `pgw_verify` — so an agent can ask, read the audit document, and independently replay the
attestation. Refusals arrive as structured results rather than thrown errors, so a model can
explain a privacy gate instead of retrying around it.

Build it once (`pnpm -r build`), then register it. Claude Desktop, in
`claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "privacy-gateway": {
      "command": "node",
      "args": ["/absolute/path/to/all-things-agentic-hackathon/clients/mcp/dist/index.js"],
      "env": { "PGW_GATEWAY_URL": "https://gateway-agent-turszib42q-uc.a.run.app" }
    }
  }
}
```

Claude Code and Codex register the same binary:

```bash
claude mcp add privacy-gateway \
  --env PGW_GATEWAY_URL=https://gateway-agent-turszib42q-uc.a.run.app \
  -- node /absolute/path/to/clients/mcp/dist/index.js
```

```toml
[mcp_servers.privacy-gateway]
command = "node"
args = ["/absolute/path/to/clients/mcp/dist/index.js"]
env = { PGW_GATEWAY_URL = "https://gateway-agent-turszib42q-uc.a.run.app" }
```

Full notes — what `pgw_verify` can and cannot check, and why a refusal is a result rather
than a thrown error — are in [`clients/mcp/README.md`](clients/mcp/README.md).

## The Python client (language-agnostic consumption)

`clients/python/pgw.py` is a single-file [PEP 723](https://peps.python.org/pep-0723/) script
whose only dependency is `httpx`. It exists to demonstrate a property of the design rather
than to be the supported SDK: **the gateway speaks ordinary JSON over HTTP**, so consuming
the fleet needs no SDK and no shared runtime with the agents — a Python script, curl, or any
other language works the same way.

```bash
uv run clients/python/pgw.py ask "text"
uv run clients/python/pgw.py evidence <request_id> [--json]
uv run clients/python/pgw.py verify <request_id> [--base URL]
uv run clients/python/pgw.py --gateway https://... ask "text"
```

There is no `--session` option: the gateway mints one id per request and rejects a body
carrying `session_id`. The `approve` and `answer` commands are gone along with the human
approval flow (see [Human approval, removed](#human-approval-removed) below). `just ask`,
`just evidence` and `just verify-answer` wrap the same three commands.

`--gateway` is a **top-level** option and must come _before_ the subcommand.

`ask` prints the masked prompt (what the frontier model actually saw), the rehydrated answer,
and the trust tier — which it **derives client-side** from the OKF `verified` field rather
than reading a server-supplied value. OKF SPEC §5.3 requires the tier to be derived and never
stored, and a third client re-deriving it independently is what proves the property holds end
to end. It exits `2` when the attestation failed, so a shell pipeline can react to a leak
verdict.

`evidence <request_id>` fetches the stored masked OKF document for one request.

`verify <request_id>` is the replayable attestation check: it fetches the evidence document
and both masked sources (the masked prompt and Core's tokenized response) the gateway serves,
re-derives the leak-check verdict with a scanner **transcribed independently** — deliberately
not imported from the fleet's own attester, so the replay proves something rather than
agreeing with itself by construction — and compares every digest the `attestation` block
recorded (`masked_prompt_sha256`, `core_response_sha256`, `verdict`) against what it
recomputes. `just verify-answer <request_id> [base]` wraps it.

## Core Agent

`agents/core` is the only service outside the trust boundary. It receives already-masked
prompts over A2A, reasons over them with Gemini on Vertex AI, and echoes the placeholder
tokens back untouched.

- **Agent Card** is served at `/.well-known/agent-card.json` — the standard path exported as
  `AGENT_CARD_PATH` by `@a2a-js/sdk` 0.3.x. (The older `/.well-known/agent.json` spelling is
  not served.) RPC lives at `/jsonrpc` (JSON-RPC) and `/rest` (HTTP+JSON); `/healthz` answers
  liveness probes.
- **The card deliberately omits the system instruction.** ADK's derived card would embed the
  full instruction text in the public skill description; since the card is fetched
  unauthenticated, `src/server.ts` supplies an explicit card instead.
- **Inbound guard** (`src/guard.ts`) re-scans every RPC payload for raw emails, phone numbers,
  Luhn-valid card numbers and known credential formats, and answers `400
unmasked_sensitive_data` if any survived masking. Its detectors are deliberately duplicated
  rather than imported from the vault-side code: Core holding no vault-reachable dependency
  _is_ the structural guarantee, and the subpath exports it is allowed to import do not
  include one.
- **No tools and no Firestore client.** Core cannot reach the vault even if its code tried.
  Core's `package.json` does depend on the whole `@privacy-gateway/common` package — so the
  package graph alone does not prove the boundary. The actual guarantee is **IAM**: Core's
  service account has no Firestore role at all (see [Deploy](#deploy)). The subpath-export
  argument in [Why this is more than "regex before an API call"](#why-this-is-more-than-regex-before-an-api-call)
  is a second, independent line of defense on top of that, not a substitute for it.
- **Logs** are single-line JSON with `request_id`; request bodies are never logged, and
  findings record only the kind and length of a match, never the matched value.

Vertex AI is selected by environment, as ADK documents: `GOOGLE_GENAI_USE_VERTEXAI=true`,
`GOOGLE_CLOUD_PROJECT`, `GOOGLE_CLOUD_LOCATION` (use `global` unless a region is required),
plus ADC via `gcloud auth application-default login`.

## A2A, precisely

Only **Gateway → Core** uses A2A: an Agent Card fetch followed by `message/send`. Gateway →
Synthesis is plain authenticated HTTP, deliberately — the OKF document Synthesis returns is an
audit artifact, and it must be retrievable without an LLM rephrasing it anywhere on the way
back. Not all three agents are "connected via A2A" in the same sense:

- **Gateway** exposes no Agent Card of its own. It only ever discovers Core's.
- **Core** is the one real A2A server in the fleet: it serves an Agent Card and answers
  `message/send`.
- **Synthesis** mounts an A2A surface, but that surface only acknowledges an exchange — it does
  not perform leak checking, release or OKF assembly over A2A. Those happen over the plain HTTP
  route the Gateway actually calls.

## Human approval, removed

The `DEFAULT_APPROVER` env var and the whole human-approval flow (`POST
/v1/sessions/{id}/approve`, the `human:<id>` actor it minted) are gone. The public gateway
authenticates nobody, so a `human:<id>` actor minted from a UI click would name no one — and
publishing it into `verified` would devalue the OKF `human-reviewed` tier, which is supposed to
mean an identified person looked at the answer. The `packages/common` OKF library still
supports the generic trust-tier derivation (any `human:`-prefixed `verified.by` entry yields
`human-reviewed`), because that derivation is part of the OKF contract itself — this product
simply never mints a `human:` actor. The UI's review-identity dimension always shows **"review
identity: none"**.

The UI shows **four separate dimensions**, never a single collapsed badge: policy verdict,
document status, freshness, and review identity (always `none`). Collapsing them into one badge
is what previously let "PASS" and "Gemma flagged" appear to agree when they did not; each is
derived independently and displayed on its own. A blocked request is shown as its own outcome —
not hidden behind a generic error string.

## Pseudonymization, not anonymization

Nothing this fleet does is anonymization or de-identification. Placeholders are a
**pseudonym**: `⟦EMAIL_1⟧` discloses that a value exists, its category, and its equality with
every other `⟦EMAIL_1⟧` in the same document — an attacker who already suspects the underlying
value can often confirm it from that alone. Beyond that, the masked text still carries
surviving quasi-identifiers the tokenizer does not touch — employer, location, date, role —
and that residual context can permit contextual re-identification even though every detected
identifier was replaced before the prompt left the trust boundary. Treat every masked document
as pseudonymous, not anonymous.

## Deploy

See **[docs/DEPLOY.md](docs/DEPLOY.md)**. In short:

Google Cloud resources are declared in Terraform (`infra/terraform/`); container images
are built separately by Cloud Build. `just` remains the only command surface.

```bash
just tf-bootstrap                 # create the GCS state bucket (once; the only gcloud-made resource)
just tf-init                      # initialise Terraform against that bucket
just build                        # build and push the five images with Cloud Build
just tf-plan gpu_enabled=false    # review the changes
just tf-apply gpu_enabled=false   # apply everything except the GPU service
just tf-apply                     # add the GPU-backed gemma-serving
just urls && just health          # verify
just tf-destroy                   # tear down (GPU billing stops first)
```

`gpu_enabled=false` skips the GPU-backed `gemma-serving` service, so the rest of the fleet
can be deployed without a GPU at all. The accelerator is **NVIDIA RTX PRO 6000**, not L4:
Google declined the L4 quota request (regional exhaustion, 2026-08) and pointed at RTX PRO
6000, which is auto-granted per region, so no quota wait applies.

Core's service account deliberately has **no** Firestore role; the Gemma serving endpoint
uses internal-only ingress; service-to-service calls authenticate with ID tokens.

### Cost, and the automatic kill switch

Idle costs **$0** — every service scales to zero. With everything warm the fleet runs about
**$1.64/hour**, essentially all of it the GPU-backed `gemma-serving`. The one realistic way
to lose money here is forgetting the teardown: left up for a day, that is **~$39**.

So a forgotten teardown is handled automatically rather than by an email nobody reads at 3am.
A **¥8,000 (~$50) Cloud Billing budget** publishes every threshold crossing (50% / 80% / 100%) to a
Pub/Sub topic, whose push subscription calls a small `kill-switch` Cloud Run service. At 100%
it removes the `allUsers` invoker binding from `gateway-agent` and forces `gemma-serving` to
zero max instances — both idempotent, so Pub/Sub redelivery is harmless. Below 100% it only
logs. Restore with `just restore-after-kill` once the underlying spend is fixed.

Note that a cost gate deliberately does **not** fail closed the way this fleet's disclosure
gates do: a notification it cannot parse is logged and ignored, because taking the demo
offline over a malformed message would itself be the outage. Creating the budget needs
`roles/billing.costsManager` **on the billing account** (project Owner is not enough); see
[docs/DEPLOY.md](docs/DEPLOY.md) § "Automatic cost kill switch".

## Environment variables

Every variable below is validated with zod at startup (`packages/common/src/config.ts`); an
invalid value stops the process rather than failing mid-request.

| Variable                     | Default                     | Purpose                                                                                             |
| ---------------------------- | --------------------------- | --------------------------------------------------------------------------------------------------- |
| `GOOGLE_CLOUD_PROJECT`       | —                           | GCP project for Vertex AI and Firestore                                                             |
| `GOOGLE_CLOUD_LOCATION`      | `us-central1`               | Vertex AI location. Core is deployed with `global` — see the note below                             |
| `GOOGLE_GENAI_USE_VERTEXAI`  | `1`                         | route the Gemini SDK through Vertex AI                                                              |
| `GEMINI_MODEL`               | `gemini-3.5-flash`          | Core's model id — **see the note below**                                                            |
| `GEMMA_BASE_URL`             | `http://localhost:11434/v1` | OpenAI-compatible Gemma endpoint                                                                    |
| `GEMMA_MODEL`                | `gemma3:12b`                | Gemma model tag                                                                                     |
| `GEMMA_API_KEY`              | `ollama`                    | placeholder key for the OpenAI-compatible API                                                       |
| `CORE_BASE_URL`              | `http://localhost:8082`     | Core service base URL (Agent Card resolved under it)                                                |
| `SYNTHESIS_BASE_URL`         | `http://localhost:8083`     | Synthesis service base URL                                                                          |
| `A2A_TIMEOUT_SECONDS`        | `120`                       | per-hop timeout                                                                                     |
| `A2A_PUBLIC_URL`             | —                           | public base URL written into the Agent Card                                                         |
| `A2A_HOST` / `A2A_PROTOCOL`  | `localhost` / `http`        | host and scheme used when no public URL is set                                                      |
| `VAULT_BACKEND`              | `memory`                    | `memory` or `firestore`                                                                             |
| `VAULT_COLLECTION`           | `token_vault`               | Firestore collection for the vault                                                                  |
| `ANSWER_COLLECTION`          | `gateway_answers`           | Firestore collection for OKF answers                                                                |
| `VAULT_TTL_SECONDS`          | `3600`                      | vault lifetime; equals each answer's `stale_after`                                                  |
| `MAX_BODY_BYTES`             | `65536`                     | max request body (was a 10 MB literal; a prompt is prose)                                           |
| `REQUEST_DEADLINE_SECONDS`   | `60`                        | end-to-end deadline for one `/v1/ask`                                                               |
| `RATE_LIMIT_PER_MINUTE`      | `20`                        | per-IP quota; `0` disables it                                                                       |
| `REHYDRATE_ALLOW_CATEGORIES` | unset (withhold all)        | comma-separated categories re-enabled for rehydration — see [Disclosure policy](#disclosure-policy) |
| `WEB_DIR`                    | `./web/dist`                | built SPA served by the Gateway                                                                     |
| `PORT`                       | `8081`                      | injected by Cloud Run                                                                               |
| `LOG_LEVEL`                  | `INFO`                      | structured JSON logs, always PII-masked                                                             |
| `OTEL_ENABLED`               | `0`                         | export OpenTelemetry spans (Cloud Trace, or console)                                                |
| `OTEL_SERVICE_NAME`          | per-agent                   | overrides the service name on spans                                                                 |
| `VITE_GCP_PROJECT`           | —                           | project id baked into the UI's console links                                                        |

> **Note on `GEMINI_MODEL` and the global endpoint.** The hackathon requires "Gemini 3.5 or
> newer". Model id strings change as versions reach GA, and the id is therefore never
> hard-coded in agent code — it is read from `GEMINI_MODEL`, with `gemini-3.5-flash` as the
> documented default, verified against Vertex AI with a live `generateContent` call.
>
> `gemini-3.5-flash` is published **only on the global Vertex endpoint**: the `us-central1`
> regional endpoint 404s for it (probed 2026-08-28). Terraform therefore deploys the Core
> service with `GOOGLE_CLOUD_LOCATION=global` while every other resource — Firestore, Cloud
> Run, Artifact Registry — stays in `us-central1`. Only the GenAI SDK reads that variable, so
> overriding it for Core moves nothing else. Note that `gemini-3.5-pro` does **not** currently
> resolve on Vertex AI (404 "Publisher model … not found"); `gemini-3.1-pro-preview` does, if a
> Pro-tier model is wanted. Confirm the id your project serves before the demo.

## Toolchain and supply-chain notes

Node.js 22 with a pnpm workspace. `pnpm-workspace.yaml` sets `minimumReleaseAge: 1440`, so a
package version published less than 24 hours ago is refused — a cooldown against compromised
releases. Postinstall scripts are blocked by default and `allowBuilds` re-enables only the
one that genuinely needs it (esbuild); a build script is arbitrary code execution at install
time, so the default answer is "no". pnpm itself is pinned via `packageManager` for corepack.

TypeScript lint and formatting are **oxlint** (1.79.0, with `oxlint-tsgolint` for type-aware
rules) and **oxfmt** (0.64.0) — not eslint/prettier — configured once at the repository root
in `.oxlintrc.json` and `.oxfmtrc.json`. Type checking stays a separate step (`just
typecheck`); oxlint does not replace `tsc --noEmit`.

Python survives only as standalone PEP 723 scripts (`clients/python/pgw.py`), run with
`uv run` and linted by **ruff** through a minimal root `ruff.toml`. There is no
`pyproject.toml`, no `uv.lock` and no `uv sync`: with no Python package to install, a
dependency-resolution step would only be lockfile ceremony around a script that declares its
own dependencies inline.
