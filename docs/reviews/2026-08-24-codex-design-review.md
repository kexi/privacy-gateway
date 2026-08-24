# DESIGN REVIEW

**Review date:** 2026-08-24  
**Submission deadline:** 2026-08-31  
**Category:** Fortified Enterprise Fleet

## Executive verdict

Do not record the final demo from the current deployment configuration.

The repository has 295 passing unit/integration tests, 9 passing Playwright tests, clean TypeScript type-checking, and valid Terraform syntax. Those tests use mocked Core/Gemma endpoints or in-process Synthesis and do not exercise Cloud Run IAM, ID-token refresh, internal ingress, or real cross-service tracing.

As deployed from the current Terraform, three independent defects can break the live request path:

1. Gateway → Synthesis has no Cloud Run ID token.
2. Gateway/Synthesis → Gemma send `Bearer ollama`, not a Google-signed ID token.
3. Internal-ingress Gemma is called through a public `run.app` address while callers route only private ranges through the VPC.

More seriously, the privacy guarantee fails open for names and addresses, failed leak checks do not block release, caller-controlled placeholders can trigger rehydration, and rehydrated PII is persisted indefinitely outside the TTL-protected vault.

## 1. Likely judging score

This estimate assumes judges review the current repository and expect the Terraform deployment to support the recorded behavior.

| Criterion                             | Likely score | Assessment                                                                                                                                                                                                                                                                                                                                            |
| ------------------------------------- | -----------: | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Innovation & Operational Utility      |    **23/40** | The local-Gemma/privacy-broker concept is differentiated, and OKF is relevant to enterprise trust. However, the implementation provides pseudonymization rather than robust de-identification, permits contextual re-identification, and can persist or release data after failed checks. That materially weakens operational utility.                |
| Architectural Discipline & Tech Stack |    **15/30** | Terraform, separate service accounts, ADK, A2A card discovery, Zod, Firestore TTL, structured logging, and tests are credible artifacts. The score is capped by nonfunctional service authentication, incorrect VPC routing, decorative A2A surfaces, missing registry behavior, broad Firestore permissions, and major code/document contradictions. |
| Demo & Production Readiness           |     **8/30** | The UI and mocked test path work, but the deployed path should fail before Synthesis/Gemma. Health checks are shallow, the runbook records GPU quota as pending, the single GPU scales to zero, and no deployed smoke test or operational dashboard exists.                                                                                           |
| **Total**                             |   **46/100** | A reliable live deployment plus fail-closed privacy behavior could move this into roughly the 70–78 range. Documentation or UI polish alone will not.                                                                                                                                                                                                 |

### Fortified Enterprise Fleet fit

- **Registry:** Agent Cards are static discovery metadata, not a registry. Gateway exposes no card, discovers only Core by card, and the Synthesis card advertises a capability its A2A agent does not perform.
- **Runtime:** ADK is present, but the real orchestration is Gateway Express → Core A2A → Synthesis custom HTTP. The claimed all-A2A fleet does not exist.
- **Memory:** Firestore is real, but vault writes race and the “append-only audit log” is a mutable document overwritten by session.
- **Security:** Core’s lack of Firestore IAM is the strongest structural control. Session ownership, approval identity, downstream authentication, egress control, and safe release are not structurally enforced.
- **Observability:** The vocabulary is detailed, but the documented Gemini span is absent and the cross-fleet test does not cross real processes.
- **Scalability:** CPU agents can scale, but Gemma is one scale-to-zero L4 instance with concurrency four. That is a demo topology, not yet a scalable fleet.

## 2. Trust-boundary weaknesses

Effort estimates are engineer-hours and overlap where mitigations share infrastructure.

| Priority    | Weakness and evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Concrete mitigation                                                                                                                                                                                                                                                                                                                           |                                    Effort |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------: |
| **Blocker** | **Private Cloud Run calls cannot authenticate.** Gateway calls Synthesis with plain `fetch` ([server.ts:166–189](/agents/gateway/src/server.ts:166)); answer and approval calls have the same defect. Ollama and the Gemma judge send a static API-key bearer ([ollama_llm.ts:138](/packages/common/src/ollama_llm.ts:138), [agent.ts:94](/agents/synthesis/src/agent.ts:94)), while Terraform requires `run.invoker` ([iam.tf:67](/infra/terraform/iam.tf:67)). The Core A2A helper caches token strings forever and caches transient failures as `undefined` ([a2a.ts:201](/packages/common/src/a2a.ts:201)). | Implement one authenticated HTTP client for Core, Synthesis, and Gemma. Cache `IdTokenClient`, obtain fresh request headers per call, derive `aud` from the service origin, and fail closed for HTTPS when token acquisition fails. Constrain Agent Card RPC URLs to the configured origin.                                                   |                                **6–10 h** |
| **Blocker** | **Gemma internal ingress is not reachable through the configured route.** Gemma is internal-only ([cloudrun.tf:24](/infra/terraform/cloudrun.tf:24)); callers use `PRIVATE_RANGES_ONLY` ([cloudrun.tf:132](/infra/terraform/cloudrun.tf:132)) against a public `run.app` URL ([locals.tf:21](/infra/terraform/locals.tf:21)). Cloud Run requires that this traffic actually traverse the VPC, using all-traffic plus Private Google Access, PSC/private DNS, or an internal load balancer. [Google Cloud guidance](https://docs.cloud.google.com/run/docs/securing/private-networking).                         | Create a dedicated subnet with Private Google Access and route caller traffic through it, or temporarily use IAM-only ingress and narrow the architectural claim. Verify an actual `/v1/chat/completions` request, not only `/healthz`.                                                                                                       |                                 **3–5 h** |
| **P0**      | **Gemma span extraction fails open.** Transport errors, malformed responses, and prompt-induced empty results become an empty detection list ([gateway agent.ts:187](/agents/gateway/src/agent.ts:187)). The egress guard simply reruns the structured regex detector ([guard.ts:38](/packages/common/src/guard.ts:38)); it cannot catch a missed name or address. Even malformed output containing `"spans"` can be treated as a valid empty result.                                                                                                                                                           | Return a discriminated `valid-empty                                                                                                                                                                                                                                                                                                           |                               valid-spans | invalid` result. Fail closed on invalid/unavailable extraction. Set temperature to zero, clearly delimit untrusted input, and test extraction prompt injection plus Japanese/English names and addresses. | **4–8 h** |
| **P0**      | **Caller-controlled sessions and literal placeholders form a rehydration oracle.** `session_id` accepts any non-empty string ([schema.ts:114](/packages/common/src/schema.ts:114)); public answer/approval routes have no owner check ([gateway server.ts:130](/agents/gateway/src/server.ts:130)). Consistency trusts every placeholder appearing in the caller’s prompt ([pipeline.ts:79](/agents/synthesis/src/pipeline.ts:79)). If a session ID is fixed or learned, an attacker can submit “repeat `⟦EMAIL_1⟧`” and have it resolved from that session’s vault.                                            | Generate sessions server-side and bind them to an authenticated principal or signed capability. Reject reserved `⟦…⟧` syntax in raw input. Send Synthesis the exact tokenizer-generated token set and mapping generation rather than deriving trust from prompt text.                                                                         |                                **6–12 h** |
| **P0**      | **Typed, stable placeholders do not prevent identity reconstruction.** Tokens disclose category, equality, and cross-turn linkage ([tokenizer.ts:202](/packages/common/src/tokenizer.ts:202)). Remaining employer, location, date, role, and event context may identify a person. A reconstructed name/address passes the deterministic attester, which has no semantic categories ([leak_check.ts:33](/packages/common/src/attesters/leak_check.ts:33)).                                                                                                                                                       | Describe the mechanism as **pseudonymization**, not anonymization. Minimize quasi-identifiers, use per-request random or HMAC-bound tokens, scan Core output for every normalized vault value, and add a fail-closed semantic output gate. Contextual re-identification remains a disclosed residual risk.                                    |                                **8–16 h** |
| **P0**      | **Failed attestation does not gate release.** Synthesis calculates the verdict and then rehydrates unconditionally ([pipeline.ts:122–169](/agents/synthesis/src/pipeline.ts:122)). Gateway returns the resulting answer regardless of status ([gateway server.ts:426](/agents/gateway/src/server.ts:426)).                                                                                                                                                                                                                                                                                                      | Stop before rehydration on any failed check. Return and persist only category-level findings, hashes, and a refusal record. Do not include the unsafe Core body in an API response or document.                                                                                                                                               |                                 **2–4 h** |
| **P0**      | **Vault concurrency and expiry can cross-wire identities.** Firestore performs an unprotected read-modify-write ([vault.ts:132](/packages/common/src/vault.ts:132)). Concurrent requests can allocate the same numbered token to different values. After expiry, numbering restarts; a delayed old answer can resolve against a new generation.                                                                                                                                                                                                                                                                 | The deadline-safe solution is to cut shared/multi-turn sessions and use one server-generated session per request. Otherwise use Firestore transactions, random collision-resistant token IDs, a generation/version field, and an exact generation check in Synthesis. Refuse work when remaining TTL is shorter than the downstream deadline. | **Cut feature: 2–3 h; fully fix: 8–12 h** |
| **P0**      | **Missing or expired vault data can still produce `stable`, machine-confirmed output.** Missing mappings become `{}`, unresolved tokens are only recorded, and verification may still be added ([pipeline.ts:114](/agents/synthesis/src/pipeline.ts:114), [pipeline.ts:209](/agents/synthesis/src/pipeline.ts:209)).                                                                                                                                                                                                                                                                                            | Missing vault, generation mismatch, insufficient remaining TTL, or any unresolved token must return 409/410 and no final answer.                                                                                                                                                                                                              |                                 **2–3 h** |
| **P0**      | **The Gemma judge is nondeterministic and security-inert.** A positive leak verdict or judge failure explicitly leaves the deterministic pass intact ([pipeline test.ts:140](/agents/synthesis/test/pipeline.test.ts:140)). The UI can therefore show “PASS” and “Gemma flagged” simultaneously.                                                                                                                                                                                                                                                                                                                | Do not let a Gemma negative verdict upgrade trust. Either remove the judge from the security claim, or use an asymmetric policy: `leak=true` or unavailable ⇒ block; `leak=false` ⇒ no additional trust. Label it probabilistic and set deterministic generation parameters.                                                                  |                                 **2–5 h** |
| **P0**      | **Rehydrated PII and secrets are persisted indefinitely.** The final OKF embeds the rehydrated answer ([okf.ts:235](/packages/common/src/okf.ts:235)) and stores it in `gateway_answers` ([store.ts:64](/agents/synthesis/src/store.ts:64)). Terraform applies TTL only to `token_vault` ([main.tf:64](/infra/terraform/main.tf:64)) and deliberately abandons the database. This directly contradicts the no-raw-PII persistence rule ([AGENTS.md:27](/AGENTS.md:27)).                                                                                                                                         | Persist only the masked Core answer and non-PII evidence, keyed by `request_id`. Rehydrate ephemerally for the authorized request while the exact vault generation is live. If stored retrieval remains, add owner authorization, encryption, `expires_at`, TTL, and application-side expiry enforcement.                                     |                                **5–10 h** |
| **P0**      | **“Human-reviewed” is forgeable.** Synthesis accepts an arbitrary `approver` and prefixes `human:` ([synthesis server.ts:177](/agents/synthesis/src/server.ts:177)). It can approve draft or stale documents, and the public Gateway proxies the request.                                                                                                                                                                                                                                                                                                                                                       | Remove approval from the submission. If retained, derive the reviewer exclusively from verified IAP/OIDC claims, bind approval to the answer hash, and store a separate immutable review event.                                                                                                                                               |         **Remove: 1–2 h; secure: 8–16 h** |
| **P1**      | **Logs and traces can contain unstructured PII.** Logging only applies the regex tokenizer, while caller-controlled `session_id` is explicitly unmasked ([logging.ts:31](/packages/common/src/logging.ts:31)). OpenTelemetry records raw exceptions and exception messages ([telemetry.ts:169](/packages/common/src/telemetry.ts:169)). Ollama errors may include 500 characters of response text.                                                                                                                                                                                                              | Replace recursive “scrubbing” with a typed allowlist of safe event fields. Log hashes, counts, enums, and internal UUIDs only. Record error class/code in spans, never the original message or body.                                                                                                                                          |                                 **3–6 h** |
| **P1**      | **There is no output disclosure policy.** `rehydrate()` replaces every matching token, including cards, JWTs, and API keys ([tokenizer.ts:304](/packages/common/src/tokenizer.ts:304)).                                                                                                                                                                                                                                                                                                                                                                                                                         | Never rehydrate secret, API-key, JWT, card, or My Number categories by default. Require an explicit authorized purpose for higher-risk categories.                                                                                                                                                                                            |                                 **3–6 h** |

The public 10 MB request limit and absence of authentication/rate limiting also permit cost and storage abuse: one request can trigger two Gemma calls plus Gemini ([gateway server.ts:111](/agents/gateway/src/server.ts:111)). Reduce the limit, add a single end-to-end deadline, and apply demo-grade quotas.

## 3. OKF v0.2 assessment

### Verdict

The implementation is close to the OKF v0.2 shape, but the trust semantics are not currently sound enough for the claims made in the UI and architecture.

The sound parts are:

- Bundle-level `okf_version: "0.2"`.
- Separate `type: Attested Computation`.
- Absolute UTC `stale_after`.
- `sources` IDs connected to footnotes.
- Trust tier derived rather than persisted.
- Bare `verified` mappings normalized.
- Unknown frontmatter keys preserved.
- Failed attestation represented as `status: draft` and described rather than silently dropped.

The material defects are:

1. **Generator attribution is wrong.** Core supplies the tokenized prose, but Synthesis rehydrates and assembles the actual concept. `generated.by` nevertheless names Core ([okf.ts:192](/packages/common/src/okf.ts:192)). Use Synthesis as document generator and represent the Core invocation as provenance.

2. **Verifier attribution is wrong.** `verified.by` names `synthesis_agent/<Gemma model>`, although TypeScript regex code decides the pass and Gemma is advisory ([synthesis pipeline.ts:128](/agents/synthesis/src/pipeline.ts:128)). Use an actor such as `process:leak-check@<digest>`. “Machine-confirmed” must be labeled specifically as “leak-policy confirmed,” not factual validation of the answer.

3. **Human trust has no evidence.** The tier derivation is technically correct, but unauthenticated creation of `human:*` makes the resulting tier meaningless.

4. **Provenance is dangling.** `/sessions/<id>/masked-prompt.md` is emitted as a source but is never stored or served ([okf.ts:188](/packages/common/src/okf.ts:188)).

5. **The attester is not resolvable from the bundle.** `attester.resource` points to `/references/attesters/leak_check.ts` ([leak-check.md:14](/knowledge/computations/leak-check.md:14)), but that file does not exist there. Broken links are tolerated by OKF, but a judge cannot execute this Attested Computation.

6. **The receipt contract is incomplete.** Frontmatter declares `[session_id, response_hash, findings]`, while `verify()` refuses to run without an undeclared `response` field ([leak_check.ts:138](/packages/common/src/attesters/leak_check.ts:138)). Nothing binds the supplied response to the actual Core invocation, masked prompt, displayed answer, or attester version.

7. **The persisted answer lacks machine-readable evidence.** The API returns a receipt summary, but the stored OKF retains neither a structured receipt nor an immutable receipt URI.

8. **Malformed trust metadata fails open.** Any object in `verified`, including `{}`, becomes machine-confirmed; an invalid `stale_after` is interpreted as not stale ([okf.ts:96](/packages/common/src/okf.ts:96)). Preserve malformed data, but derive `unverified` and `freshness: unknown`.

9. **The artifact is not signed.** Synthesis calls it a “signed audit artifact” ([agent.ts:2](/agents/synthesis/src/agent.ts:2)); no signature or MAC exists.

10. **The bundle has visible drift.** [`knowledge/computations/index.md:6`](/knowledge/computations/index.md:6) still says Python and post-rehydration. [`knowledge/log.md:22`](/knowledge/log.md:22) uses `## 2026-08-24 (bootstrap)` rather than the reserved exact date heading.

### How to make OKF compelling

For the demo, make each persisted record masked, immutable, and independently inspectable:

```yaml
generated:
  by: synthesis_agent/0.1.0
sources:
  - id: masked-prompt
    resource: /requests/<request_id>/masked-prompt.md
  - id: core-response
    resource: /requests/<request_id>/core-response.md
    author: core_agent/gemini-3.5-flash
verified:
  - by: process:leak-check@<attester-sha256>
attestation:
  computation: /computations/leak-check.md
  computation_sha256: ...
  attester_sha256: ...
  masked_prompt_sha256: ...
  core_response_sha256: ...
  verdict: pass
  checked_at: ...
  trace_id: ...
```

Then:

- Store the two masked source artifacts or use real immutable URIs.
- Include the actual receipt contract, attester/computation digests, and request/generation identifiers.
- Provide a replayable `just verify-answer <request_id>` command.
- Display four separate dimensions: **policy verdict**, **document status**, **freshness**, and **review identity**. Do not collapse them into one trust badge.
- A Cloud KMS signature is useful but optional for the deadline. Accurate actors, resolvable evidence, and replayability are mandatory.

## 4. Prioritized remaining-week plan

### Must-have

| Order | Work                                                  | Exit criterion                                                                                                                                                         | Effort |
| ----: | ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -----: |
|     1 | Repair Cloud Run authentication and Gemma routing.    | One public Gateway request reaches real Gemma, Core, and Synthesis. Unauthenticated direct calls return 403; authenticated calls return 200.                           | 8–14 h |
|     2 | Make every safety gate fail closed.                   | Extraction failure, positive leak, missing vault, unresolved token, invented token, or generation mismatch returns no rehydrated answer and persists no unsafe body.   | 6–10 h |
|     3 | Eliminate session/token attacks by simplifying scope. | Server generates one session per request; literal placeholders are rejected; public answer and approval routes are removed or capability-protected.                    |  4–6 h |
|     4 | Stop raw-answer persistence.                          | Firestore contains only masked prompt/answer plus hashes and metadata, keyed per request.                                                                              |  5–8 h |
|     5 | Repair OKF evidence and wording.                      | Correct actors, resolvable sources/attester, complete receipt, no “signed,” no false machine-verification scope.                                                       |  4–6 h |
|     6 | Add adversarial tests.                                | Tests cover extraction prompt injection, semantic name/address leakage, literal placeholders, concurrent/expired mappings, failed release, and HTTPS ID-token headers. | 6–10 h |
|     7 | Prove the real fleet.                                 | Capture one real three-service trace, correlated logs, Core IAM without Firestore, and stored masked evidence.                                                         |  4–8 h |
|     8 | Stabilize filming.                                    | Pin a known image/model, set Gemma concurrency to 1, set `min_instance_count=1` only while recording, warm it, and record a backup take.                               |  2–4 h |

The full secure multi-turn design does not fit comfortably into the remaining week. The one-request/session simplification is the correct submission trade-off.

### Four-minute demo

- **0:00–0:25:** Show the boundary and the four deployed services.
- **0:25–1:10:** Submit one realistic request. Show raw input → Gemma detections → masked prompt.
- **1:10–1:45:** Show the exact tokenized Core response, not only the masked input.
- **1:45–2:25:** Show the ephemeral final answer and the masked, replayable OKF evidence.
- **2:25–2:55:** Run one adversarial failure—literal placeholder or Core-introduced PII—and show that no answer is rehydrated.
- **2:55–3:35:** Show Cloud Trace plus IAM proof that Core has no Firestore role and unauthenticated private access returns 403.
- **3:35–4:00:** State the exact guarantee and limitation: structured + self-hosted semantic pseudonymization, fail-closed release, residual contextual re-identification risk.

### Nice-to-have

- Cloud KMS-signed attestation envelopes.
- A small fleet/card inventory and health panel.
- One latency/error/blocked-request dashboard and alert.
- Digest-pinned container images.
- Broader multilingual precision/recall evaluation.
- Dedicated audit writer with hash chaining.
- Authenticated human review after the submission.

### Cut

- The unauthenticated human approval button.
- Caller-provided and multi-turn shared sessions.
- Claims that every agent/hop uses A2A.
- The no-op Synthesis A2A surface unless it executes the advertised skill.
- “Signed,” “append-only,” “never leaks,” and “all PII” language.
- Model Garden fallback in the main demo; it weakens the self-hosted trust-boundary claim.
- Multi-region, HA, dynamic registry, and further UI polish until the live path passes.

## 5. Code/document contradictions

| Documented claim                                                                                                                                                              | Implementation                                                                                                                                                                                   |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| All three agents are connected through A2A ([ARCHITECTURE.md:13](/docs/ARCHITECTURE.md:13)).                                                                                  | Only Gateway → Core uses A2A. Gateway → Synthesis is custom HTTP. Gateway has no Agent Card.                                                                                                     |
| Gateway discovers Core and Synthesis by Agent Card ([ARCHITECTURE.md:45](/docs/ARCHITECTURE.md:45)).                                                                          | Only Core’s card is fetched ([gateway server.ts:148](/agents/gateway/src/server.ts:148)).                                                                                                        |
| Synthesis’s A2A skill verifies and rehydrates.                                                                                                                                | Its A2A LLM only returns `{"acknowledged": true}` ([synthesis agent.ts:20](/agents/synthesis/src/agent.ts:20)); the actual pipeline is a separate HTTP route.                                    |
| IAM-only service authentication protects every edge ([ARCHITECTURE.md:48](/docs/ARCHITECTURE.md:48)).                                                                         | Synthesis and Gemma calls lack Google ID tokens; the Core token cache does not refresh.                                                                                                          |
| Direct VPC `PRIVATE_RANGES_ONLY` makes internal Gemma reachable ([DEPLOY.md:327](/docs/DEPLOY.md:327)).                                                                       | The target is a public `run.app` address and no private DNS, PSC, internal LB, all-traffic routing, or Private Google Access is configured.                                                      |
| The egress guard catches a Gemma-missed span ([guard.ts:1](/packages/common/src/guard.ts:1), [pii-masking.md:46](/knowledge/policies/pii-masking.md:46)).                     | It repeats only deterministic structured regexes and cannot detect names or addresses.                                                                                                           |
| Response verification is regex plus Gemma judge ([ARCHITECTURE.md:19](/docs/ARCHITECTURE.md:19)).                                                                             | Gemma is advisory and its positive finding is deliberately ignored.                                                                                                                              |
| A failed computation must not be rehydrated ([leak-check.md:66](/knowledge/computations/leak-check.md:66)).                                                                   | Synthesis rehydrates, returns, and persists after failure.                                                                                                                                       |
| Memory includes an append-only Audit Log ([ARCHITECTURE.md:47](/docs/ARCHITECTURE.md:47)).                                                                                    | `doc(sessionId).set(...)` overwrites the prior answer; approval overwrites it again.                                                                                                             |
| Raw PII is never persisted ([AGENTS.md:27](/AGENTS.md:27)).                                                                                                                   | Rehydrated OKF Markdown containing PII is stored without TTL.                                                                                                                                    |
| `stale_after` tracks a usable vault mapping.                                                                                                                                  | Missing mappings can yield immediately stale but `stable`, machine-confirmed documents.                                                                                                          |
| Every log string is safely masked and span attributes never carry PII ([OBSERVABILITY.md:78](/docs/OBSERVABILITY.md:78), [OBSERVABILITY.md:148](/docs/OBSERVABILITY.md:148)). | Names/addresses survive the regex scrubber; caller session IDs bypass it; raw exceptions enter spans.                                                                                            |
| The expected trace contains `llm.gemini` and is covered by E2E ([OBSERVABILITY.md:133](/docs/OBSERVABILITY.md:133)).                                                          | No Gemini span/event exists. The test mocks Core and runs Synthesis in-process ([e2e.test.ts:93](/agents/gateway/test/e2e.test.ts:93), [e2e.test.ts:398](/agents/gateway/test/e2e.test.ts:398)). |
| Core’s package depends on nothing that can reach Firestore ([ARCHITECTURE.md:18](/docs/ARCHITECTURE.md:18)).                                                                  | Core installs the whole common package, whose dependencies include Firestore and whose root export exposes the vault. IAM—not the package graph—is the actual structural guarantee.              |
| Zod validates every boundary ([AGENTS.md:57](/AGENTS.md:57)).                                                                                                                 | Synthesis approval casts its request body, and Gateway casts the approval response instead of parsing a shared schema.                                                                           |
| Deployment verification uses the implemented API and standard card path.                                                                                                      | The runbook uses `/v1/query` instead of `/v1/ask` and checks the obsolete `/.well-known/agent.json` path ([DEPLOY.md:609](/docs/DEPLOY.md:609), [DEPLOY.md:658](/docs/DEPLOY.md:658)).           |
| The computation index describes the current attester.                                                                                                                         | It says Python and rehydrated response; the implementation is TypeScript and pre-rehydration.                                                                                                    |

## Submission gate

Record the final video only after all five statements are demonstrably true:

1. A public Cloud Run `/v1/ask` request reaches real Gemma, Gemini, and Synthesis.
2. Private endpoints return 403 without an ID token and succeed with the correct service identity.
3. Extraction, attestation, vault, and placeholder failures return no rehydrated answer.
4. Firestore contains no rehydrated PII—only masked per-request evidence.
5. One real Cloud Trace waterfall and its correlated logs match the request and OKF identifiers.

No repository files were changed.
