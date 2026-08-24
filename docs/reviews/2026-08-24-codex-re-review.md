# Design Re-Review — commit `0619c5d`

## Executive verdict

**Submission gate: HOLD / NO-GO.**

The revision fixes the original Cloud Run authentication and routing design on paper and substantially improves the local test surface. It does not yet support the central claim that refused responses never persist raw PII, and production containers will emit unusable attestation digests while still assigning the `machine-confirmed` tier.

Provisional score: **62/100**, up from 46/100.

| Criterion                             |      Score | Assessment                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------------------- | ---------: | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Innovation & Operational Utility      |  **27/40** | The hybrid Gemma/Gemini boundary, per-request pseudonymization, asymmetric Gemma veto, disclosure policy, and OKF evidence are differentiated. Utility remains constrained by one-shot operation, no caller authentication, probabilistic PERSON/ADDRESS coverage, and fail-closed dependence on two Gemma calls.                                                             |
| Architectural Discipline & Tech Stack |  **20/30** | Service IAM, Direct VPC egress, per-request IDs, transactional Firestore writes, zod schemas, TTLs, and typed telemetry are materially better. Raw rejected Core output is still persisted; attestation packaging is broken in the production image; refusal ordering contradicts the design; the logging “typed allowlist” validates shapes rather than actual enum domains. |
| Demo & Production Readiness           |  **15/30** | `424` tests, typecheck, Terraform validation, and `16` Playwright tests pass. However, `just smoke` sends the wrong request schema, `just verify-auth` expects impossible results for internal-ingress services, attestation hashes fail in the production image, and no live four-service result is demonstrated by the tree.                                                |
| **Total**                             | **62/100** | Credible prototype, not yet safe to submit under its current security claims.                                                                                                                                                                                                                                                                                                 |

### Fortified Enterprise Fleet fit: **5.5/10 — partial**

| Fleet dimension | Assessment                                                                                                                                                                                                                                                                                                              |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Registry        | Weakest area. Core is discovered through an Agent Card, while Synthesis is statically addressed over HTTP and its A2A skill only acknowledges exchanges ([ARCHITECTURE.md:15](/docs/ARCHITECTURE.md:15), [server.ts:299](/agents/synthesis/src/server.ts:299)). This is discoverability, not a scalable fleet registry. |
| Runtime         | Real ADK agents and separate Cloud Run identities. Good fit, subject to live proof.                                                                                                                                                                                                                                     |
| Memory          | Firestore per-request vault and evidence TTLs fit the category, but rejected raw output persistence currently violates the memory-boundary claim.                                                                                                                                                                       |
| Security        | IAM and network design are credible; release and persistence paths are not yet fortified.                                                                                                                                                                                                                               |
| Observability   | Structured events, request IDs and OpenTelemetry are present. Core’s shared model-span handle is unsafe under configured concurrency, and no real distributed trace is yet evidenced.                                                                                                                                   |
| Gemma bonus     | Architecturally eligible: Gemma performs extraction and veto inside the boundary. Do not expect bonus credit without showing the actual L4-backed service in the demo.                                                                                                                                                  |

The `ALL_TRAFFIC` plus Private Google Access combination is a valid documented way for one Cloud Run service to reach another service with internal ingress at its `run.app` URL. The revised Terraform follows that pattern. [Cloud Run private networking](https://docs.cloud.google.com/run/docs/securing/private-networking?hl=en), [Cloud Run ingress controls](https://docs.cloud.google.com/run/docs/securing/ingress?authuser=0). Likewise, Google-signed ID tokens plus `roles/run.invoker` are the correct service-to-service authentication mechanism. [Cloud Run service authentication](https://docs.cloud.google.com/run/docs/authenticating/service-to-service?authuser=2).

## 1. Status of every original §2 weakness

“Fixed” below means implemented in the current tree, not proven against the deployed fleet.

| Original weakness                                                      | Status                                     | Evidence and residual issue                                                                                                                                                                                                                                                                                                                                                                                                              |
| ---------------------------------------------------------------------- | ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Private Cloud Run calls lacked authentication                          | **Fixed statically**                       | Gateway→Synthesis uses `authorizedFetch` ([gateway server.ts:212](/agents/gateway/src/server.ts:212)); A2A card and RPC fetches use it ([a2a.ts:52](/packages/common/src/a2a.ts:52), [a2a.ts:111](/packages/common/src/a2a.ts:111)); Gemma IAM mode obtains an ID token ([ollama_llm.ts:187](/packages/common/src/ollama_llm.ts:187), [synthesis agent.ts:103](/agents/synthesis/src/agent.ts:103)). Live verification remains required. |
| Internal-ingress Gemma was unreachable through `PRIVATE_RANGES_ONLY`   | **Fixed statically**                       | Dedicated subnet enables Private Google Access ([network.tf:44](/infra/terraform/network.tf:44)); callers use Direct VPC egress with `ALL_TRAFFIC` ([cloudrun.tf:158](/infra/terraform/cloudrun.tf:158)). This matches current Cloud Run guidance.                                                                                                                                                                                       |
| Gemma span extraction failed open                                      | **Fixed for transport and parse failures** | Extraction distinguishes `valid-empty`, `valid-spans`, and `invalid` ([gateway agent.ts:150](/agents/gateway/src/agent.ts:150)); unusable output throws after retry ([agent.ts:264](/agents/gateway/src/agent.ts:264)). A plausible but incorrect `{"spans":[]}` remains indistinguishable from a true negative.                                                                                                                         |
| Caller-controlled sessions and placeholder rehydration oracle          | **Fixed**                                  | Gateway mints UUIDv7 and ignores the inbound ID ([gateway server.ts:156](/agents/gateway/src/server.ts:156)); request schema accepts only `{text}` ([schema.ts:150](/packages/common/src/schema.ts:150)); literal placeholder delimiters are rejected before vault allocation ([gateway pipeline.ts:113](/agents/gateway/src/pipeline.ts:113)).                                                                                          |
| Typed placeholders and contextual re-identification                    | **Partially fixed**                        | Cross-request linkage is removed and the documentation now correctly calls the scheme pseudonymization ([ARCHITECTURE.md:114](/docs/ARCHITECTURE.md:114)). Category, equality and quasi-identifier leakage remain. A Gemma false negative can still permit Core-reconstructed PERSON/ADDRESS text.                                                                                                                                       |
| Failed attestation did not gate release                                | **Partially fixed**                        | Failed gates no longer return an answer, but the pipeline creates `released.text` at [pipeline.ts:287](/agents/synthesis/src/pipeline.ts:287) before it evaluates `releaseOk` at [pipeline.ts:294](/agents/synthesis/src/pipeline.ts:294) and throws at [pipeline.ts:362](/agents/synthesis/src/pipeline.ts:362). It is withheld from the response, but “no rehydrated text is produced” is false.                                       |
| Vault concurrency and expiry races                                     | **Partially fixed**                        | Real Firestore allocation uses `runTransaction` ([vault.ts:210](/packages/common/src/vault.ts:210)), and per-request UUIDs remove normal contention. The interface still permits a non-transactional production fallback ([vault.ts:219](/packages/common/src/vault.ts:219)); expired and missing records are collapsed into the same `null` result.                                                                                     |
| Missing/expired mapping could produce stable, machine-confirmed output | **Fixed for release safety**               | A missing live entry immediately refuses release ([pipeline.ts:202](/agents/synthesis/src/pipeline.ts:202)); generation mismatch refuses at [pipeline.ts:210](/agents/synthesis/src/pipeline.ts:210). Expired records are incorrectly reported as `vault_missing`, not `vault_expired`.                                                                                                                                                  |
| Gemma judge was nondeterministic and security-inert                    | **Partially fixed**                        | `true` and `null` veto; `false` adds no trust ([pipeline.ts:251](/agents/synthesis/src/pipeline.ts:251)). Temperature is zero ([synthesis agent.ts:126](/agents/synthesis/src/agent.ts:126)). Generation is still probabilistic, and a false-negative `leak:false` permits release.                                                                                                                                                      |
| Rehydrated PII was persisted indefinitely                              | **Partially fixed**                        | The successful rehydrated answer is no longer stored. However, a rejected Core body is persisted verbatim as both `core_response` and part of the OKF document; see new P0 finding below. The evidence collection now has TTL ([main.tf:84](/infra/terraform/main.tf:84)).                                                                                                                                                               |
| Forgeable human approval                                               | **Fixed**                                  | Approval routes and product-generated `human:` verification are removed; the design states review identity is always `none` ([ARCHITECTURE.md:46](/docs/ARCHITECTURE.md:46)).                                                                                                                                                                                                                                                            |
| Logs/traces could contain unstructured PII                             | **Partially fixed**                        | Exception messages and `recordException` were removed ([logging.ts:268](/packages/common/src/logging.ts:268), [telemetry.ts:173](/packages/common/src/telemetry.ts:173)). Allowlisted string values remain unvalidated, logger messages remain free text, and Gemma-controlled categories can reach logs.                                                                                                                                |
| No output disclosure policy                                            | **Fixed**                                  | Secret-bearing categories are withheld by default and explicitly reported ([ARCHITECTURE.md:208](/docs/ARCHITECTURE.md:208), [pipeline.ts:286](/agents/synthesis/src/pipeline.ts:286)).                                                                                                                                                                                                                                                  |
| Public cost/storage abuse                                              | **Partially fixed**                        | 64 KB body limit, deadline and per-IP limiter exist ([config.ts:27](/packages/common/src/config.ts:27), [gateway server.ts:114](/agents/gateway/src/server.ts:114)). The limiter is per instance, and the `Promise.race` deadline does not cancel underlying Core/Synthesis/Gemma work ([server.ts:268](/agents/gateway/src/server.ts:268)).                                                                                             |

## 2. New weaknesses and regressions

### P0 — refused Core output is persisted verbatim

The most serious regression is in the audit path.

When the deterministic check finds `leaked.person@example.com`, or the Gemma judge flags a name/address, the pipeline builds the OKF body from the unmodified `coreAnswer` ([pipeline.ts:312](/agents/synthesis/src/pipeline.ts:312)). The refusal helper clears only the ephemeral `answer` field ([pipeline.ts:417](/agents/synthesis/src/pipeline.ts:417)). The HTTP layer then persists the original `input.core_answer` ([server.ts:209](/agents/synthesis/src/server.ts:209)), and the store writes it verbatim ([store.ts:94](/agents/synthesis/src/store.ts:94)).

Consequences:

- Rejected raw PII is stored in `core_response`.
- The same raw value is embedded in the draft OKF body.
- The unauthenticated evidence routes can return it to anyone holding the request ID.
- This directly contradicts “never log or persist raw PII.”

Mitigation: on refusal, persist only hashes, category findings, request metadata, and a body such as “content withheld.” Do not persist or serve the rejected Core text. **Effort: 3–5 h.**

### P0 — production attestation digests become `unavailable`

`attestation.ts` hashes TypeScript source and knowledge files, falling back to the literal string `unavailable` ([attestation.ts:34](/packages/common/src/attestation.ts:34), [attestation.ts:46](/packages/common/src/attestation.ts:46)). The production Synthesis image copies only `packages/common/dist` and `agents/synthesis/dist`; neither source `.ts` files nor `knowledge/` are present ([agents/synthesis/Dockerfile:58](/agents/synthesis/Dockerfile:58)).

A successful document still receives `verified` and therefore `machine-confirmed` ([okf.ts:299](/packages/common/src/okf.ts:299)). The schema accepts any string as a digest ([schema.ts:57](/packages/common/src/schema.ts:57)).

Expected production output:

```yaml
attester_sha256: unavailable
computation_sha256: unavailable
verified:
  - by: process:leak-check@unavailable
```

Mitigation: compute hashes at build time and inject validated 64-hex constants, or copy the exact attester and computation sources into the runtime image. Refuse machine-confirmed output if either digest is unavailable. Add a test that runs inside the built Synthesis image. **Effort: 3–6 h.**

### P0 — the refusal path rehydrates before deciding

The stated sequence is “all gates, then rehydrate.” The code does:

1. deterministic verdict;
2. judge;
3. `rehydrateWithPolicy`;
4. build a result containing the released string;
5. throw.

See [pipeline.ts:281](/agents/synthesis/src/pipeline.ts:281) through [pipeline.ts:397](/agents/synthesis/src/pipeline.ts:397).

Mitigation: reject consistency, deterministic, and judge failures before calling `rehydrateWithPolicy`. Validate token resolvability without materializing raw values, then perform the single rehydration operation only after every gate passes. **Effort: 2–4 h.**

### P1 — the logging allowlist is not semantically typed

`enum`, `id`, and `hash` all accept any string and only truncate it ([logging.ts:105](/packages/common/src/logging.ts:105)). `string_list` accepts arbitrary model-controlled strings. In particular:

- `LeakJudgeSchema.categories` is `z.array(z.string())` ([schema.ts:349](/packages/common/src/schema.ts:349)).
- Those categories reach `ReleaseRefusedError`, logs, and the public response ([pipeline.ts:379](/agents/synthesis/src/pipeline.ts:379), [server.ts:220](/agents/synthesis/src/server.ts:220)).
- `message` bypasses the field allowlist entirely ([logging.ts:221](/packages/common/src/logging.ts:221)).
- Startup configuration errors directly log full zod issues, including invalid values ([config.ts:240](/packages/common/src/config.ts:240)).

A malicious or confused Gemma response such as `categories: ["Taro Yamada"]` is therefore a log and response disclosure channel.

Mitigation: use closed category enums, validate UUID/hash syntax, remove arbitrary logger methods from production code, and log configuration key plus error code—not the rejected value. **Effort: 3–5 h.**

### P1 — OKF replay is incomplete and provenance URLs still dangle

The generated sources use `/requests/<id>/...` ([okf.ts:257](/packages/common/src/okf.ts:257)), but the Gateway serves `/v1/requests/<id>/...` ([gateway server.ts:180](/agents/gateway/src/server.ts:180)). Following the source as an origin-relative URL returns 404.

`pgw.py verify` checks the two artifact hashes and verdict only ([pgw.py:306](/clients/python/pgw.py:306)). It merely prints `attester_sha256`; it does not verify either the attester or computation digest ([pgw.py:325](/clients/python/pgw.py:325)). Therefore the claim that it “compares every recorded digest” is false.

The attester also treats any non-empty `masked_prompt_hash` as bound evidence without receiving the prompt or independently validating that hash ([leak_check.ts:169](/packages/common/src/attesters/leak_check.ts:169)).

Mitigation: serve exact source URLs, expose or package computation/attester resources, verify all four hashes plus request ID, and reject non-hex digests. **Effort: 4–7 h.**

### P1 — vault and evidence expiry semantics disagree

`TokenVault.get()` returns `null` for both missing and expired records ([vault.ts:225](/packages/common/src/vault.ts:225)), so the documented `410 vault_expired` path cannot execute.

The OKF `stale_after` comes from the vault entry expiry, but evidence persistence assigns a new `Date.now() + TTL` expiry after inference finishes ([synthesis server.ts:106](/agents/synthesis/src/server.ts:106)). The service can therefore return a document after its own `stale_after`.

Mitigation: return a discriminated `missing | expired | live` vault result and persist evidence with the exact vault expiry. **Effort: 2–4 h.**

### P1 — release verification recipes are broken

- `just smoke` sends `{"prompt": ...}` ([.just/logs.just:180](/.just/logs.just:180)), while `/v1/ask` accepts only `{"text": ...}`. It will return 400.
- The same wrong body appears in the manual deployment example ([DEPLOY.md:738](/docs/DEPLOY.md:738)).
- `just verify-auth` expects authenticated laptop calls to Core and Synthesis to return 200 ([.just/logs.just:142](/.just/logs.just:142)), but both now use internal ingress and should return 403 from a laptop, just like Gemma.

Mitigation: fix the smoke schema; test IAM success from Gateway or a Cloud Run job inside the VPC, not from a laptop. **Effort: 2–3 h plus deployment time.**

### P1 — gateway deadline does not cancel work

`Promise.race` returns 504 after 60 seconds, but no `AbortSignal` is passed through `ask`, Core, or Synthesis ([gateway server.ts:268](/agents/gateway/src/server.ts:268)). The original request can continue invoking models, rehydrating, and persisting after the caller has already received a timeout.

Mitigation: create one request-scoped `AbortController` and propagate its signal through every client and model call. **Effort: 4–8 h.**

### P2 — `http_client.ts` needs tighter boundaries

The ID-token client cache correctly stores clients rather than token strings and evicts rejected promises. Residual issues:

- Every non-local HTTPS URL is assumed to be a Google IAM target ([http_client.ts:54](/packages/common/src/http_client.ts:54)). A configuration mistake sends a Google-signed service identity token to an arbitrary HTTPS origin.
- A caller-supplied signal listener is never removed and a signal already aborted before registration is not handled ([http_client.ts:224](/packages/common/src/http_client.ts:224)).
- A2A card lookup catches `IdTokenError` and rethrows a generic `Error` ([a2a.ts:52](/packages/common/src/a2a.ts:52)), so Gateway loses the intended `auth.id_token.failed` classification.

Use an explicit allowlist of configured Cloud Run origins and preserve typed authentication failures.

### P2 — VPC isolation depends on an existing shared network

The subnet is dedicated, but it is attached to `var.vpc_network`, defaulting to the project’s existing `default` network ([variables.tf:88](/infra/terraform/variables.tf:88), [network.tf:44](/infra/terraform/network.tf:44)). Routes, firewall policy, or Cloud NAT added elsewhere to that network also affect the fleet. `ALL_TRAFFIC` is correct for internal Cloud Run routing, but it is not an egress-control policy.

For the hackathon, document the inherited-network assumption. For a production claim, use a Terraform-owned VPC plus explicit egress policy or VPC Service Controls.

### P2 — Core’s model span is unsafe under concurrency

The Core agent stores one mutable `modelSpan` handle in the shared agent instance ([core agent.ts:86](/agents/core/src/agent.ts:86)), while Cloud Run allows concurrency 40 ([cloudrun.tf:133](/infra/terraform/cloudrun.tf:133)). Concurrent model calls can end each other’s spans. The comment claiming calls cannot interleave is false.

Use request-local state or ADK callback context rather than an agent-global handle.

## 3. OKF v0.2 reassessment

The conceptual use is improved but the deployed implementation is currently unsound.

Correct changes:

- `generated.by` names Synthesis.
- Core appears as provenance.
- `verified.by` names deterministic process code rather than Gemma.
- Failed documents are draft and omit `verified`.
- Trust tier and freshness derivation handle malformed metadata conservatively.
- The scope statement correctly says the leak check is not factual verification.

Remaining problems:

1. Production emits `unavailable` hashes while still granting `machine-confirmed`.
2. Source URLs do not match the routes.
3. Replay does not validate every recorded digest.
4. The prompt hash is asserted rather than attested by `verify()`.
5. The generic `machine-confirmed` tier still visually applies to the entire answer even though only a narrow leak-policy property was checked.

To make the OKF feature compelling, show a valid 64-character attester digest from the running container, let the judge follow every source URL, make `just verify-answer` validate every digest, and label the badge explicitly as **“machine-confirmed: leak-policy only.”**

## 4. Re-check of the original §5 contradictions

| Original contradiction                                  | Current status                                                                                                                                                                                                             |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| “All agents connected by A2A” vs only Gateway→Core A2A  | **Resolved.** Architecture now states the exact topology.                                                                                                                                                                  |
| Gateway discovers Core and Synthesis cards              | **Resolved.** It states only Core is discovered.                                                                                                                                                                           |
| Synthesis A2A skill performs verification               | **Mostly resolved.** Agent Card says acknowledgement only, although the internal `LlmAgent.description` still claims verification and rehydration ([synthesis agent.ts:41](/agents/synthesis/src/agent.ts:41)).            |
| IAM authentication on every edge vs missing tokens      | **Resolved statically; live proof absent.**                                                                                                                                                                                |
| Internal Gemma reachable through `PRIVATE_RANGES_ONLY`  | **Resolved statically.** `ALL_TRAFFIC` plus Private Google Access is valid.                                                                                                                                                |
| Egress regex guard catches Gemma-missed names/addresses | **Not fully resolved.** Architecture admits regex cannot detect them, but `guard.ts` still claims it structurally catches an unstructured Gemma miss ([guard.ts:1](/packages/common/src/guard.ts:1)).                      |
| Gemma judge documented as verification but ignored      | **Resolved.** It is an asymmetric veto.                                                                                                                                                                                    |
| Failed computation must not rehydrate                   | **Not resolved.** Rehydration precedes the release decision.                                                                                                                                                               |
| Append-only audit claim vs overwrite                    | **Resolved.** Documents are now described as per-request TTL records.                                                                                                                                                      |
| Raw PII never persisted                                 | **Not resolved.** Rejected Core output is persisted verbatim.                                                                                                                                                              |
| Missing/expired mapping could still be stable           | **Resolved for release**, but documented 410 expiry is unreachable.                                                                                                                                                        |
| Logs and spans contain no PII                           | **Partially resolved.** Exception messages are removed; model-controlled categories and unrestricted messages remain.                                                                                                      |
| `llm.gemini` and real end-to-end trace                  | **Partially resolved.** Span exists, but its shared handle is concurrency-unsafe; docs correctly admit E2E is mocked/in-process ([OBSERVABILITY.md:224](/docs/OBSERVABILITY.md:224)).                                      |
| Core structurally lacks Firestore package access        | **Documentation resolved; code comment stale.** Architecture correctly says IAM is the guarantee, while `core/src/agent.ts` still claims the package graph is structural ([core agent.ts:1](/agents/core/src/agent.ts:1)). |
| Zod at every boundary                                   | **Partially unresolved.** Gateway consumes Synthesis refusal JSON with a hand-written cast despite having `ReleaseRefusalSchema` ([gateway server.ts:562](/agents/gateway/src/server.ts:562)).                             |
| Deployment verification used wrong endpoints            | **Regressed.** Smoke schema and internal-ingress expectations are wrong.                                                                                                                                                   |
| Computation index described Python/post-rehydration     | **Resolved.** However, ARCHITECTURE still lists the old three-field receipt instead of five fields ([ARCHITECTURE.md:245](/docs/ARCHITECTURE.md:245)).                                                                     |

Additional documentation contradictions:

- DEPLOY still says logs are correlated by `session_id` ([DEPLOY.md:766](/docs/DEPLOY.md:766)).
- ARCHITECTURE says the inbound `X-Request-ID` is “echoed” while code ignores it and returns the server-generated ID ([ARCHITECTURE.md:38](/docs/ARCHITECTURE.md:38)).
- ARCHITECTURE says every refusal persists a draft ([ARCHITECTURE.md:202](/docs/ARCHITECTURE.md:202)); vault-missing and generation-mismatch throw before any evidence document exists.
- The evidence store claims its application expiry prevents serving past `stale_after`, but it computes a later expiry at persistence time.

## 5. Updated submission gate

### Must pass before submission

1. **Do not persist rejected Core text.**
2. **Move all refusal checks before rehydration.**
3. **Produce valid attester/computation hashes inside the production image; never machine-confirm `unavailable`.**
4. **Fix source URLs and make replay verify every digest.**
5. **Constrain logged categories to closed enums and eliminate unrestricted log messages.**
6. **Fix `just smoke` and `just verify-auth`.**
7. **Run and capture one real deployment proof:** public Gateway → private Gemma extraction → private Core A2A/Gemini → private Synthesis/Gemma → Firestore evidence.
8. **Capture a real Cloud Trace waterfall and validate that Core has no Firestore IAM role.**

### Nice-to-have after the gate

- Propagate cancellation through the full deadline.
- Fix Core span concurrency.
- Distinguish missing versus expired vault state.
- Align evidence expiry exactly with vault expiry.
- Put the fleet on a Terraform-owned VPC.
- Replace per-instance rate limiting with Cloud Armor or a shared quota.
- Add signed/KMS-backed attestation only if the simpler digest path is already correct.

### Cut from the 4-minute demo unless repaired

- Do not demonstrate `verify-answer` while it ignores the computation and attester digests.
- Do not run the current `verify-auth`; its expected results are wrong.
- Do not describe Synthesis’s acknowledgement-only A2A surface as orchestration.
- Do not claim “raw PII is never persisted,” “all gates run before rehydration,” or generic “machine-confirmed” trust until the P0 items are fixed.

## Verification performed

- `git status`: clean; `HEAD` is `0619c5d`.
- `just test` in the Nix dev shell: **424/424 passed**.
- `just typecheck`: passed.
- `just tf-validate`: passed.
- `just web-e2e`: **16/16 passed**.
- No tracked files were changed.
