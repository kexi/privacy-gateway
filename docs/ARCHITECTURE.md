# Privacy-Preserving Multi-Agent Gateway — Architecture

Hackathon: All Things Agentic Hackathon (Devpost) — Category: **Fortified Enterprise Fleet**
(also targeting _Best Architectural Design_). Deadline: 2026-08-31 17:00 PDT.

## 1. Problem

Enterprises want frontier-model reasoning (Gemini) but cannot send raw PII / secrets
outside their trust boundary. This system lets a commercial LLM reason over
_tokenized_ data while an open model (Gemma) that never leaves the boundary owns the
sensitive mapping.

## 2. Agents (all Google ADK, connected via A2A)

| Agent               | Model                  | Runtime            | Responsibility                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------- | ---------------------- | ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Gateway Agent**   | Gemma 3 (self-hosted)  | Cloud Run          | ADK TypeScript. Receives user request. Detects PII/secrets (hybrid: deterministic regex + Gemma span extraction), replaces with stable tokens `⟦PERSON_1⟧`, `⟦EMAIL_1⟧`, `⟦SECRET_1⟧`. Stores mapping in **Token Vault** (Firestore, per-session, TTL). Forwards _masked_ prompt to Core via A2A. Serves the demo UI and the HTTP API from one origin.                                                                                                           |
| **Core Agent**      | Gemini 3.5 (Vertex AI) | Cloud Run          | Pure reasoning / planning / code generation over masked input. ADK TypeScript (`@google/adk`), served via `toA2a`; Agent Card at `/.well-known/agent-card.json`, RPC at `/jsonrpc` and `/rest`. Model id from `GEMINI_MODEL` (default `gemini-3.5-flash`, verified on Vertex AI). An inbound guard rejects any payload still containing raw PII. Has **no** vault dependency — not by convention but because the package depends on nothing that could reach it. |
| **Synthesis Agent** | Gemma 3 (self-hosted)  | Cloud Run          | ADK TypeScript, exposed via `toA2a` and over HTTP. Receives Core's output. (a) **Leak check**: verifies the response contains no raw PII (regex + Gemma judge). (b) **Rehydration**: maps tokens back using the vault. (c) **Consistency check**: deterministically verifies that Core invented no placeholder absent from the prompt. Produces the final answer + audit record.                                                                                 |
| **Gemma Serving**   | gemma3 via Ollama      | Cloud Run (GPU L4) | OpenAI-compatible endpoint consumed by Gateway/Synthesis through `OllamaLlm`, an ADK `BaseLlm` adapter registered for `ollama/*` model names. Ingress: internal only.                                                                                                                                                                                                                                                                                            |

Trust boundary: `Gateway`, `Synthesis`, `Gemma Serving`, `Firestore` are **inside**.
Only masked text crosses to `Core` (and therefore to Gemini). This is enforced
structurally: Core's service account has no Firestore role, and A2A messages to Core
are validated by a PII scanner before egress (defense in depth).

## 3. Flow

```
User ──HTTP──▶ Gateway (Gemma)
                 │ 1. detect + tokenize  ──▶ Firestore Token Vault (session_id → {token: value})
                 │ 2. masked prompt
                 ▼ A2A
               Core (Gemini 3.5)  — reasoning/planning/codegen on tokens
                 │ masked answer
                 ▼ A2A
               Synthesis (Gemma)
                 │ 3. leak check  4. rehydrate from vault  5. consistency verify
                 ▼
               User  (final answer + audit trail: what was masked, what was verified)
```

## 4. Fortified Enterprise Fleet mapping

- **Registry**: A2A Agent Cards (`/.well-known/agent-card.json` — the standard path in `@a2a-js/sdk` 0.3.x, exported as `AGENT_CARD_PATH`) per service; Gateway discovers Core/Synthesis by card URL (env-configured).
- **Runtime**: ADK `Runner` per agent, served by ADK's A2A server on Cloud Run.
- **Memory**: Firestore — Token Vault (short-lived, TTL policy) + Audit Log (append-only).
- **Security**: IAM-only service-to-service auth (Cloud Run invoker + ID tokens), least-privilege SAs, Gemma endpoint internal ingress, no PII in logs (structured logs are masked).
- **Observability**: Cloud Logging structured logs (one JSON object per line) carrying `request_id`, `session_id` and the Cloud Trace correlation fields; OpenTelemetry spans per agent hop, joined into one trace by `traceparent` propagation; per-request audit record (masked count, leak-check verdict, latency per hop). Event names, error codes and the span tree are specified in [OBSERVABILITY.md](OBSERVABILITY.md); `request_id` is a UUIDv7 the UI and the API both surface.

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
clients/python/  # pgw.py — single-file PEP 723 client, the language-agnostic example
serving/gemma/   # Ollama Dockerfile for Cloud Run GPU
web/             # demo UI (masked vs final, side by side) + Playwright specs
knowledge/       # OKF v0.2 bundle (policies, computations, executors, attesters)
infra/           # deploy scripts (gcloud), IAM, Firestore TTL
docs/            # ARCHITECTURE.md, OBSERVABILITY.md, DEPLOY.md, diagram
justfile         # dev / test / deploy tasks
```

`packages/common` exports subpaths so the dependency graph enforces the boundary:
Core imports only `/logging`, `/config`, `/schema` and `/telemetry`, none of which
reach the vault. Gateway and Synthesis import the package entry point.

## 6. Key design decisions (Why not)

- **Why not Gemma via Gemini API?** It would leave the boundary and defeat the point. Self-hosted on Cloud Run GPU; local dev uses local Ollama with the same OpenAI-compatible interface.
- **Why hybrid regex + Gemma for detection?** Regex gives deterministic, auditable coverage for structured PII (emails, phones, card numbers, API keys); Gemma covers unstructured entities (names, addresses). Tokens must be stable within a session so Gemini can reason about `⟦PERSON_1⟧` consistently.
- **Why a separate Synthesis agent instead of rehydrating in Gateway?** Separation of duties: the agent that verifies _output_ safety should not be the one that decided _input_ masking; it also makes the leak check an independent gate on every response.
- **Why A2A instead of in-process sub-agents?** The boundary is the product. Separate services with separate IAM identities make "Core cannot read the vault" a deployable guarantee, not a code convention.

## 7. Demo scenario (≤4 min video)

Customer-support email containing name, email, phone, credit-card and an API key →
ask "draft a reply and a Python script to update this customer's record".
Show: masked prompt sent to Gemini, Gemini's tokenized output, leak-check pass,
rehydrated final answer, audit record, Cloud Run console.

## 8. Knowledge & trust signals: Open Knowledge Format (OKF v0.2)

Every answer the fleet produces is _agent-written content_. We adopt
[OKF v0.2](https://github.com/GoogleCloudPlatform/open-knowledge-format) so that
provenance, trust, freshness, lifecycle and attestation are first-class on each output.

- **Bundle** `knowledge/` (in repo): `policies/pii-masking.md` (human-authored, `human:` verified),
  `computations/leak-check.md` (`type: Attested Computation`, `runtime: typescript`,
  deterministic attester `references/attesters/leak_check.ts`, receipt `[session_id, response_hash, findings]`).
- **Per-request output** (Synthesis Agent → Firestore → UI): an OKF concept `type: Gateway Answer` with
  `generated.by: core_agent/gemini-3.5-*`, `verified: [{by: synthesis_agent/gemma-3}]` once the leak-check
  attestation passes (⇒ _machine-confirmed_), optionally `human:<id>` after approval in the UI (⇒ _human-reviewed_),
  `sources` pointing at the masked prompt and the policy, `stale_after` = vault expiry, `status: draft` on failure.
- The UI derives and shows the trust tier; attestation failures are surfaced, never dropped.
- Why OKF rather than an ad-hoc JSON audit record: the audit trail becomes a portable, diffable, human-readable
  bundle that any OKF consumer (Knowledge Catalog, an agent, `cat`) can read — trust in agent output is the
  product, so the record of that trust should be a standard.

Agent-facing guidance for writing OKF in this repo lives in `skills/okf/` (shared by
`.claude/skills/okf` and `.codex/skills/okf`).
