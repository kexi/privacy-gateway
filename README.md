# Privacy-Preserving Multi-Agent Gateway

_日本語版: [README.ja.md](README.ja.md)_

**All Things Agentic Hackathon** — category: _Fortified Enterprise Fleet_ (also targeting
_Best Architectural Design_).

Enterprises want frontier-model reasoning but cannot send raw PII or secrets outside their
trust boundary. This fleet lets **Gemini** reason over _tokenized_ text while an open model
(**Gemma**) that never leaves the boundary owns the mapping back to real values.

```
User ──HTTP──▶ Gateway (Gemma)
                 │ 1. detect + tokenize ──▶ Firestore Token Vault (session → {token: value})
                 │ 2. masked prompt          (egress guard re-scans before sending)
                 ▼ A2A
               Core (Gemini 3.5)  — reasoning / planning / codegen over placeholders only
                 │ masked answer
                 ▼ A2A
               Synthesis (Gemma)
                 │ 3. leak check  4. rehydrate  5. consistency verify
                 ▼
               User  (OKF answer document + audit trail)
```

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
  fails rather than passes. The Gemma judge is advisory and never flips the verdict.
- **Trust is a portable artifact.** Every answer is an OKF v0.2 document you can `cat`, diff
  and hand to any OKF consumer.

## Required-tech checklist

| Requirement                  | Where                                                                    |
| ---------------------------- | ------------------------------------------------------------------------ |
| **Gemini 3.5 via Vertex AI** | Core Agent (`agents/core`). Model id from `GEMINI_MODEL`.                |
| **Google ADK**               | All three agents, ADK TypeScript (`@google/adk` 2.0.0).                  |
| **A2A**                      | Gateway → Core and Gateway → Synthesis, via Agent Card + `message/send`. |
| **Cloud Run**                | One service per agent, plus Gemma serving on Cloud Run GPU (L4).         |
| **Firestore**                | Token Vault (TTL) and the OKF answer store.                              |
| **Gemma (bonus)**            | Gateway span extraction and the Synthesis judge, self-hosted via Ollama. |

Gateway and Synthesis reach Gemma through **`OllamaLlm`**, a custom ADK `BaseLlm` adapter in
`packages/common` registered in `LLMRegistry` for model names matching `ollama/*`. It speaks
Ollama's OpenAI-compatible `/v1/chat/completions`, so the same code path serves local Ollama
in development and Cloud Run GPU in production.

## Repository layout

One pnpm workspace; every agent is ADK TypeScript.

```
packages/common/   # tokenizer, vault, OKF, guard, logging, telemetry, zod schemas,
                   # the A2A client, OllamaLlm, and the OKF bundle's attester
agents/gateway/    # ADK agent + HTTP entry + serves web/dist
agents/core/       # ADK agent (Gemini) + A2A server
agents/synthesis/  # ADK agent + A2A server + HTTP routes
clients/python/    # pgw.py — single-file PEP 723 client, the language-agnostic example
serving/gemma/     # Ollama Dockerfile for Cloud Run GPU
web/               # demo UI (masked vs final, side by side) + Playwright specs
knowledge/         # OKF v0.2 bundle: policy, attested computation, executor skill
infra/             # deploy scripts, IAM, Firestore TTL
```

The workspace packages are `web`, `packages/common`, `agents/core`, `agents/gateway` and
`agents/synthesis`.

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
ingests without a sidecar. No raw PII ever reaches a log: string values pass through the
tokenizer first, so a leaked value appears as `⟦EMAIL_1⟧`.

| Signal       | What it gives you                                                                                                                                          |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `request_id` | A UUIDv7 taken from `X-Request-ID` or minted by the Gateway, propagated Gateway → Core → Synthesis, echoed in responses and stored in the OKF frontmatter. |
| `trace_id`   | OpenTelemetry with W3C `traceparent` on every hop: one request is one trace across all three services, with a span per pipeline step.                      |
| The UI       | Shows `request_id` and `trace_id` with copy buttons and direct Cloud Logging / Cloud Trace console links.                                                  |

Because `request_id` is a UUIDv7, sorting log lines by it also sorts them by time, and a bug
report that quotes one id is enough to retrieve every line and every span for that request.
The event vocabulary, span tree and error codes are specified in
**[docs/OBSERVABILITY.md](docs/OBSERVABILITY.md)**.

## Open Knowledge Format (OKF v0.2)

Every answer the fleet produces is agent-written content, so provenance and trust are
first-class on each output. We adopt
[OKF v0.2](https://github.com/GoogleCloudPlatform/open-knowledge-format).

The repository bundle is `knowledge/`:

- `policies/pii-masking.md` — what must be masked, authored and `verified` by `human:kei`.
- `computations/leak-check.md` — `type: Attested Computation`, `runtime: typescript`, with
  `executor.receipt: [session_id, response_hash, findings]` and
  `attester.resource: /references/attesters/leak_check.ts`.
- `references/skills/run-leak-check.md` — the executor's run instructions.

The attester's source lives at `packages/common/src/attesters/leak_check.ts` (regex only, no
LLM, no network) and is published as `@privacy-gateway/common/attesters/leak-check`. Synthesis
imports exactly that module, so the bundle's declared attester and the one the agent actually
runs cannot drift apart — the alternative, a copy of the script under `knowledge/`, would let
the sanctioned computation and the executed one diverge silently.

Each request produces a `type: Gateway Answer` concept with `generated.by` set to the Core
actor, `verified` gaining `synthesis_agent/<model>` once the attestation passes
(⇒ _machine-confirmed_) and `human:<id>` after approval in the UI (⇒ _human-reviewed_),
`sources` pointing at the masked prompt and the policy, `stale_after` equal to the vault
expiry, and `request_id` / `trace_id` for correlation. A failed attestation yields
`status: draft`, no `verified` entry, and the reason recorded under `# Attestation` —
surfaced, never dropped.

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

### Checks

```bash
just check          # the full CI-equivalent suite
just test           # vitest across the workspace
just test-coverage  # the same, with coverage thresholds enforced
just typecheck      # tsc --noEmit, per package
just lint-ts        # oxlint
just fmt-ts         # oxfmt
```

290 vitest tests across 21 files. The root `vitest.config.ts` uses `test.projects`, so
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

Nine Playwright specs in `web/e2e/` drive the real Gateway and Synthesis with only Core (over
A2A) and Gemma (over the OpenAI-compatible API) mocked, so what the browser exercises is the
production request path rather than a stubbed API. Chromium only: these assert application
behaviour, not rendering differences, and a second engine would double the runtime for no
extra signal. Under Nix the browser comes from `PLAYWRIGHT_BROWSERS_PATH`; outside Nix run
`just setup-browsers` (`pnpm -C web exec playwright install chromium`) once.

### API

| Method | Path                        | Purpose                                                                 |
| ------ | --------------------------- | ----------------------------------------------------------------------- |
| `POST` | `/v1/ask`                   | `{text, session_id?}` → OKF document, masked prompt, attestation, stats |
| `GET`  | `/v1/sessions/{id}/answer`  | the stored OKF document (markdown)                                      |
| `POST` | `/v1/sessions/{id}/approve` | adds `human:<id>` to `verified`                                         |
| `GET`  | `/v1/sessions/{id}/tier`    | derived trust tier + staleness                                          |
| `GET`  | `/healthz`                  | liveness                                                                |

## The Python client (language-agnostic consumption)

`clients/python/pgw.py` is a single-file [PEP 723](https://peps.python.org/pep-0723/) script
whose only dependency is `httpx`. It exists to demonstrate a property of the design rather
than to be the supported SDK: **the gateway speaks ordinary JSON over HTTP**, so consuming
the fleet needs no SDK and no shared runtime with the agents — a Python script, curl, or any
other language works the same way.

```bash
uv run clients/python/pgw.py ask "text" [--session ID]
uv run clients/python/pgw.py answer <session> [--json]
uv run clients/python/pgw.py approve <session> --by human:<id>
uv run clients/python/pgw.py --gateway https://... ask "text"
```

`--gateway` is a **top-level** option and must come _before_ the subcommand. `just ask`,
`just answer` and `just approve` wrap the same three commands.

`ask` prints the masked prompt (what the frontier model actually saw), the rehydrated answer,
and the trust tier — which it **derives client-side** from the OKF `verified` field rather
than reading a server-supplied value. OKF SPEC §5.3 requires the tier to be derived and never
stored, and a third client re-deriving it independently is what proves the property holds end
to end. It exits `2` when the attestation failed, so a shell pipeline can react to a leak
verdict.

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
- **Logs** are single-line JSON with `session_id` and `request_id`; request bodies are never
  logged, and findings record only the kind and length of a match, never the matched value.

Vertex AI is selected by environment, as ADK documents: `GOOGLE_GENAI_USE_VERTEXAI=true`,
`GOOGLE_CLOUD_PROJECT`, `GOOGLE_CLOUD_LOCATION` (use `global` unless a region is required),
plus ADC via `gcloud auth application-default login`.

## Deploy

See **[docs/DEPLOY.md](docs/DEPLOY.md)**. In short:

```bash
just infra-setup       # enable APIs, service accounts, Firestore TTL
just deploy            # all services to Cloud Run
just deploy-gateway    # or one at a time
```

Core's service account deliberately has **no** Firestore role; the Gemma serving endpoint
uses internal-only ingress; service-to-service calls authenticate with ID tokens.

## Environment variables

Every variable below is validated with zod at startup (`packages/common/src/config.ts`); an
invalid value stops the process rather than failing mid-request.

| Variable                    | Default                     | Purpose                                              |
| --------------------------- | --------------------------- | ---------------------------------------------------- |
| `GOOGLE_CLOUD_PROJECT`      | —                           | GCP project for Vertex AI and Firestore              |
| `GOOGLE_CLOUD_LOCATION`     | `us-central1`               | Vertex AI region                                     |
| `GOOGLE_GENAI_USE_VERTEXAI` | `1`                         | route the Gemini SDK through Vertex AI               |
| `GEMINI_MODEL`              | `gemini-3.5-flash`          | Core's model id — **see the note below**             |
| `GEMMA_BASE_URL`            | `http://localhost:11434/v1` | OpenAI-compatible Gemma endpoint                     |
| `GEMMA_MODEL`               | `gemma3:12b`                | Gemma model tag                                      |
| `GEMMA_API_KEY`             | `ollama`                    | placeholder key for the OpenAI-compatible API        |
| `CORE_BASE_URL`             | `http://localhost:8082`     | Core service base URL (Agent Card resolved under it) |
| `SYNTHESIS_BASE_URL`        | `http://localhost:8083`     | Synthesis service base URL                           |
| `A2A_TIMEOUT_SECONDS`       | `120`                       | per-hop timeout                                      |
| `A2A_PUBLIC_URL`            | —                           | public base URL written into the Agent Card          |
| `A2A_HOST` / `A2A_PROTOCOL` | `localhost` / `http`        | host and scheme used when no public URL is set       |
| `VAULT_BACKEND`             | `memory`                    | `memory` or `firestore`                              |
| `VAULT_COLLECTION`          | `token_vault`               | Firestore collection for the vault                   |
| `ANSWER_COLLECTION`         | `gateway_answers`           | Firestore collection for OKF answers                 |
| `VAULT_TTL_SECONDS`         | `3600`                      | vault lifetime; equals each answer's `stale_after`   |
| `WEB_DIR`                   | `./web/dist`                | built SPA served by the Gateway                      |
| `PORT`                      | `8081`                      | injected by Cloud Run                                |
| `LOG_LEVEL`                 | `INFO`                      | structured JSON logs, always PII-masked              |
| `DEFAULT_APPROVER`          | `kei`                       | approver id used by the UI's approve button          |
| `OTEL_ENABLED`              | `0`                         | export OpenTelemetry spans (Cloud Trace, or console) |
| `OTEL_SERVICE_NAME`         | per-agent                   | overrides the service name on spans                  |
| `VITE_GCP_PROJECT`          | —                           | project id baked into the UI's console links         |

> **Note on `GEMINI_MODEL`.** The hackathon requires "Gemini 3.5 or newer". Model id strings
> change as versions reach GA, and the id is therefore never hard-coded in agent code — it is
> read from `GEMINI_MODEL`, with `gemini-3.5-flash` as the documented default. That default
> was verified against Vertex AI with a live `generateContent` call. Note that
> `gemini-3.5-pro` does **not** currently resolve on Vertex AI (404 "Publisher model … not
> found"); `gemini-3.1-pro-preview` does, if a Pro-tier model is wanted. Confirm the id your
> project serves before the demo.

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
