# Devpost submission draft

Category: **Fortified Enterprise Fleet** (also eligible: Best Architectural Design).
Fill-in fields are marked ⟨…⟩.

## Project name

Privacy Gateway — frontier reasoning, closed-model custody

## Elevator pitch (short)

A Cloud Run fleet where self-hosted Gemma masks your secrets, Gemini 3.5 does
the thinking over placeholders, and every answer ships with a replayable
leak-check attestation. Select it as a model from any OpenAI-compatible tool,
or call it from Claude Desktop over MCP.

## Inspiration

Enterprises don't avoid frontier LLMs because they're weak — they avoid them
because prompts carry customer data. We wanted the split to be structural, not
policy: the model that sees secrets runs on hardware we control; the model that
reasons never sees a secret at all.

## What it does

- **Gateway Agent (Gemma on a Cloud Run RTX PRO 6000 GPU)** detects PII with
  deterministic regexes (emails, phones, cards with Luhn, API keys, JWTs,
  Japanese My Number) plus Gemma span extraction for names/addresses, and swaps
  values for typed placeholders (⟦PERSON_1⟧). Mappings live in a Firestore
  token vault, TTL'd, one vault per request.
- **Core Agent (ADK TypeScript + Gemini 3.5 Flash on Vertex AI)** receives only
  the masked prompt over the A2A protocol and reasons over opaque tokens. Its
  service account has **no Firestore role** — the boundary is IAM, not a code
  convention.
- **Synthesis Agent (Gemma)** runs a deterministic leak-check attester plus a
  Gemma judge with veto-only power, rehydrates only after every gate passes,
  and emits the answer as an **OKF v0.2 document**: provenance, a
  `process:leak-check@<sha256>` verifier, and digests you can replay with
  `just verify-answer`.
- **User-defined secret terms** close the gap no detector can: an unreleased
  product name or an internal codename has no lexical shape, so the requester
  names it in `mask_terms` and it is substituted for ⟦CUSTOM_1⟧ before any
  detector runs. Both boundary scans then look for the literal string — the one
  check that _proves_ the masking worked rather than re-running the pattern that
  decided it. The term list is never persisted to evidence or logs; matched
  values are stored only in the TTL'd Token Vault for rehydration, like every
  masked value. The audit record keeps a count only.
- **Fail closed, everywhere**: extraction failure, placeholder injection, vault
  expiry, invented tokens, a surviving secret term, or a flagged leak → no
  answer, only masked evidence ("content withheld"). High-risk categories
  (cards, keys) are withheld by default; they are restored only through an
  explicit per-request opt-in, recorded as `disclosure_requested`, while the
  stored evidence remains masked either way.
- **Consume it six ways**: web UI, REST, an OpenAI-compatible endpoint (select
  `privacy-gateway` as a model in Codex CLI/Cursor/any custom-base-URL tool),
  an MCP server for Claude Desktop/Claude Code, a localhost model-picker shim
  (Anthropic Messages + native Ollama APIs), and a single-file PEP 723 Python
  CLI.
- **Fleet operations**: one request = one Cloud Trace trace across all hops;
  structured logs behind a typed allowlist; scale-to-zero GPU; a billing budget
  that trips a kill switch which unpublishes the gateway.

## How we built it

ADK TypeScript (`@google/adk` 2.x) for all three agents; A2A for discovery and
the Gateway→Core hop; Ollama serving Gemma 4 12B on Cloud Run's NVIDIA RTX PRO
6000; Vertex AI `gemini-3.5-flash` via the global endpoint; Firestore with TTL
for the vault and masked evidence; the whole platform declared in Terraform
(50+ resources, least-privilege service accounts, Direct VPC egress with
Private Google Access, internal ingress). zod validates every boundary.
800+ unit tests and 70+ browser E2E specs; the full gate runs in CI on every
push — lint (oxlint/oxfmt), typecheck, tests, Terraform validation, secret
scanning, and SHA-pinned actions — with the runs themselves as the canonical
evidence: https://github.com/kexi/privacy-gateway/actions/workflows/ci.yml Two adversarial design reviews by an external AI reviewer are in
`docs/reviews/`, with our responses and the diffs they produced.

## Challenges we ran into

- **L4 GPUs were exhausted** in us-central1; Google suggested RTX PRO 6000,
  which ships an auto-granted quota — we switched the same afternoon.
- **`gemini-3.5-flash` exists only on the global Vertex endpoint** — regional
  us-central1 404s. Core pins `GOOGLE_CLOUD_LOCATION=global`.
- **Making refusal real**: our first implementation rehydrated before deciding
  and persisted refused output. The re-review caught it; now every gate runs
  before a single rehydration, and refusals persist hashes only.
- **Cloud Run internal ingress + Direct VPC egress**: private-ranges-only
  routing silently bypasses the VPC for run.app URLs; the fix is all-traffic
  egress through a subnet with Private Google Access.

## What we learned

Pseudonymization is not anonymization — placeholders disclose category and
equality, and we say so. The honest version of "trust me" is an attestation
you can replay: OKF v0.2's generated/verified/attestation fields turned our
audit trail into a standard, portable artifact instead of bespoke JSON.

## What's next

Shipped since: the model-picker shim (`clients/ollama-shim`), so Claude Desktop's
gateway-provider picker can select privacy-gateway directly — it turned out to
require the Anthropic Messages API, not the Ollama protocol, so the shim serves
both, and a per-request disclosure opt-in, so a caller can ask for the high-risk
values _they_ submitted back in _their_ answer without loosening the deployment's
policy. Still ahead: **multimodal input** — every surface is text-only today and
refuses an image part outright rather than dropping it, because regex plus a text
model cannot find, mask or verify PII inside a picture; in-boundary Gemma vision
extraction is the way to support it honestly. Also ahead: authenticated human
review (IAP) to unlock the human-reviewed trust tier; per-tenant disclosure
policies.

## Built with

`google-adk` (TypeScript) · A2A · Gemini 3.5 Flash (Vertex AI, global) ·
Gemma 4 12B (Ollama, Cloud Run GPU RTX PRO 6000) · Firestore · Terraform ·
Cloud Trace/Logging (OpenTelemetry) · Pub/Sub + Cloud Billing budgets ·
zod · vitest · Playwright · MCP · OKF v0.2

## Links

- Hosted demo: https://privacy-gateway.kexi.dev
- Repository: https://github.com/kexi/privacy-gateway ⟨confirm access for judges⟩
- Video: ⟨YouTube URL, ≤4 min, English subtitles⟩
- Architecture diagram: https://github.com/kexi/privacy-gateway/blob/main/docs/diagram/architecture.drawio.png
  (embedded at the top of the README; the PNG carries its own editable draw.io source)

## Gemma integration (bonus)

Gemma 4 12B performs both privacy-critical functions — PII span extraction and
the leak-check judge — self-hosted on a Cloud Run GPU inside the trust
boundary. This is not a garnish: the product's core guarantee depends on an
open model that never leaves our infrastructure.
