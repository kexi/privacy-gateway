# Privacy-Preserving Multi-Agent Gateway

## Inspiration

Enterprises want the reasoning power of frontier AI models, but their prompts often contain names, email addresses, credentials, payment details, and other sensitive information. Sending that data directly to a cloud model creates privacy, compliance, and operational risks.

We were inspired by a simple question:

> Can an organization use a frontier model without giving that model the sensitive values in the prompt?

A prompt telling an LLM to “keep this private” is not a security boundary. We wanted privacy to be enforced by the system architecture: isolate sensitive mappings, restrict access with IAM, inspect every outbound payload, and refuse requests whenever a trustworthy decision cannot be made.

## What It Does

The Privacy-Preserving Multi-Agent Gateway is a fleet of three Google ADK TypeScript agents:

1. **Gateway Agent — Gemma**  
   Detects sensitive spans, replaces them with typed placeholders such as `⟦EMAIL_1⟧`, and stores the mapping in a request-scoped Token Vault.

2. **Core Agent — Gemini 3.5 Flash on Vertex AI**  
   Performs reasoning, planning, and generation using only the pseudonymized prompt. It has no Firestore IAM role and therefore cannot access the Token Vault.

3. **Synthesis Agent — Gemma**  
   Checks the complete response for leaks, creates an auditable OKF document, and allows rehydration only after every safety gate passes.

Only the Gateway-to-Core hop uses Agent2Agent Protocol (A2A). Synthesis is called through authenticated HTTP intentionally, so the final audit artifact can be retrieved without another LLM rephrasing it.

Every request receives a server-generated UUIDv7. There are no sessions or caller-supplied vault identifiers, preventing one caller from attempting to resolve another request’s placeholders.

The final rehydrated answer is returned once and is never persisted. Firestore stores only request-scoped pseudonymized artifacts with expiration policies. High-risk categories such as API keys, JWTs, credit cards, AWS keys, and Japanese My Number identifiers remain masked by default even in the released answer.

This is **pseudonymization, not anonymization**. Typed placeholders still reveal categories and repeated placeholders reveal equality, while contextual clues may permit re-identification.

## How We Built It

We built the fleet with:

- **Google ADK for TypeScript** for all three agents
- **Gemini 3.5 Flash on Vertex AI** for core reasoning
- **Gemma through Ollama** for private-boundary extraction and response review
- **A2A** for Gateway-to-Core discovery and communication
- **Cloud Run** with a separate service identity for each component
- **Cloud Run GPU** for self-hosted Gemma inference
- **Firestore** for the request-scoped Token Vault and masked evidence
- **Terraform** for infrastructure and IAM
- **OpenTelemetry, Cloud Logging, and Cloud Trace** for end-to-end observability
- **zod** validation at every HTTP, A2A, configuration, and model-output boundary

Before a masked prompt can leave the Gateway, a deterministic egress guard scans it again. After Gemini returns an answer, Synthesis runs an independent leak check before any placeholder is resolved.

Every successful result also becomes an **Open Knowledge Format v0.2** `Gateway Answer` document. It records provenance, freshness, content hashes, the request and trace identifiers, and the deterministic process that verified the leak policy. A third party can retrieve the masked evidence and replay the verification instead of simply trusting a badge in the UI.

The same pipeline is available through a web interface, a native REST API, an OpenAI-compatible endpoint, an MCP server, an Anthropic/Ollama-compatible model-picker shim, and a single-file Python client.

## Challenges We Faced

### Privacy without destroying utility

Removing every sensitive-looking word makes a prompt much less useful. Typed placeholders preserve enough structure for Gemini to reason about relationships while keeping detected values outside the Core agent. We also had to preserve placeholder consistency within one request without creating stable identifiers across requests.

### Treating probabilistic models as untrusted components

Gemma can help detect names and addresses that are difficult to identify with regular expressions, but an LLM verdict is not proof. We designed its role asymmetrically: Gemma may veto a release, but it can never certify one. The release verdict comes from deterministic TypeScript checks, and missing or malformed results fail closed.

### Making auditability real

It is easy to display a “safe” badge. It is harder to make that claim independently verifiable. We had to bind the masked prompt, Core response, computation, and attester to SHA-256 digests while keeping the stored artifact free of raw sensitive values.

### Preventing the vault from becoming an oracle

An early session-oriented design would have allowed a caller-controlled identifier to select a vault entry. That could let someone reference another request’s placeholders. We removed sessions entirely and now create one unpredictable, server-generated vault key per request.

### Safe streaming

A privacy gateway cannot stream model tokens before inspecting the complete answer: content already displayed cannot be taken back. Our OpenAI-compatible streaming interface therefore releases a single checked chunk only after all gates pass. Refusals return no partial answer.

### Operating GPU inference economically

Self-hosting Gemma on Cloud Run GPU gives us control over the privacy boundary, but introduces cold starts and cost management challenges. We added explicit warm/cold status, controlled warm-up, scale-to-zero behavior, and a budget-triggered kill switch.

## What We Learned

The most important lesson was that privacy is a property of the entire data path, not just the model prompt.

Strong guarantees came from combining several smaller controls:

- IAM prevents the Core agent from reading the vault.
- Request-scoped identifiers prevent cross-request placeholder resolution.
- Deterministic guards inspect both sides of the model boundary.
- Fail-closed behavior prevents uncertain results from being released.
- Structured logs and traces make failures diagnosable without recording raw PII.
- Portable OKF evidence makes trust inspectable outside our own UI.

We also learned to separate **reasoning** from **verification**. LLMs are useful for understanding ambiguous text, but deterministic code should decide whether a privacy policy passed. In our design, a model can raise an alarm; it cannot award itself trust.

## What We Are Proud Of

We did not build a regex wrapper around an API call. We built a deployable security boundary with separate identities, private services, request-scoped storage, independent release gates, end-to-end tracing, and replayable evidence.

The result lets developers use Gemini through familiar interfaces while making the privacy controls visible, testable, and portable:

> **Private in, powerful out—an auditable AI gateway that keeps PII away from cloud models.**
