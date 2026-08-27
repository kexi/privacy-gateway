---
type: Gateway Answer
title: Gateway answer for request 01a043e6-afe3-7552-8c20-1f0b7f0a1831
description: Masked evidence for one gateway exchange. The rehydrated answer is returned to the caller in the response body only and is not stored here.
tags:
  - gateway
  - pii
  - attested
request_id: 01a043e6-afe3-7552-8c20-1f0b7f0a1831
status: stable
generated:
  by: synthesis_agent/0.1.0
  at: 2026-08-27T15:46:34Z
stale_after: 2026-08-27T16:46:28Z
sources:
  - id: masked-prompt
    resource: /v1/requests/01a043e6-afe3-7552-8c20-1f0b7f0a1831/masked-prompt.md
    title: Masked prompt sent to the core agent
    author: gateway_agent/tokenizer
    last_modified: 2026-08-27T15:46:34Z
  - id: core-response
    resource: /v1/requests/01a043e6-afe3-7552-8c20-1f0b7f0a1831/core-response.md
    title: Tokenized response returned by the core agent
    author: core_agent/gemini-2.5-flash
    last_modified: 2026-08-27T15:46:34Z
  - id: pii-policy
    resource: /policies/pii-masking.md
    title: PII masking policy
    author: human:kei
attestation:
  computation: /computations/leak-check.md
  computation_sha256: efa7e03c46f5158efed2641a4988cb7f49a32792a67d563826be070946d6cdbc
  attester_sha256: 8b427a667e6426be7061777d8c7952e57a816b8fbcd0410fdafea2e737529ce9
  masked_prompt_sha256: ebb7229d566b1e6fcefeab0d7f3ab44cfe632d9c57af528fcaf9e282bb161ea9
  core_response_sha256: 62845b6b985114823052ccb32550ad7e155e06d7eaabb08031260a7b647f380e
  verdict: pass
  checked_at: 2026-08-27T15:46:33Z
  request_id: 01a043e6-afe3-7552-8c20-1f0b7f0a1831
  trace_id: 8a3a4d14714ea9699a77fe46466b1e36
trace_id: 8a3a4d14714ea9699a77fe46466b1e36
verified:
  - by: process:leak-check@8b427a667e64
    at: 2026-08-27T15:46:33Z
---

# Answer (masked)

Subject: Your Order Has Shipped!

Dear ⟦PERSON_1⟧,

We're pleased to let you know that your recent order has shipped and is on its way! You will receive a separate email with tracking information shortly.

Thank you for your business.

Sincerely,
[Your Company Name]

Customer details:
Email: ⟦EMAIL_1⟧
Phone: ⟦PHONE_1⟧

The rehydrated form of this answer was returned to the caller in the API response and is
deliberately not stored. Only the masked text above, the hashes below, and the category
counts are retained.

# Attestation

Leak-policy check passed. It confirms only that the core agent's tokenized
response carried no raw identifier of its own; it is not a factual validation of the
answer. The verdict was decided by the deterministic attester named in
`attestation.attester_sha256`, following
[the leak-check computation](/computations/leak-check.md), over the masked prompt and
core response whose digests are recorded in the `attestation` block.

Findings:

- (no findings)

Replay it with `just verify-answer 01a043e6-afe3-7552-8c20-1f0b7f0a1831`.

The answer was produced from a masked prompt in which every detected identifier was
replaced by an opaque placeholder before it left the trust boundary.[^masked-prompt] The
core agent's tokenized response is the input the check ran over.[^core-response] Masking
follows the repository PII masking policy.[^pii-policy]

[^masked-prompt]: Masked prompt sent to the core agent
[^core-response]: Tokenized response returned by the core agent
[^pii-policy]: PII masking policy
