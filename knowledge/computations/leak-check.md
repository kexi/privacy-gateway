---
type: Attested Computation
title: Leak check on a gateway response
description: Sanctioned deterministic check that a core agent's tokenized response carries no raw PII or secrets before it is released, per the repository PII masking policy.
tags: [pii, security, attested]
status: stable
runtime: typescript
parameters:
  - { name: request_id, type: string, required: true }
  - { name: masked_prompt, type: string, required: true }
  - { name: response, type: string, required: true }
executor:
  resource: /references/skills/run-leak-check.md
  receipt: [request_id, masked_prompt_hash, response_hash, findings, response, masked_prompt]
attester:
  resource: /references/attesters/leak_check.ts
generated: { by: gateway_fleet/bootstrap, at: 2026-08-24T00:00:00Z }
verified:
  - { by: human:kei, at: 2026-08-24T00:00:00Z }
sources:
  - id: pii-policy
    resource: /policies/pii-masking.md
    title: PII masking policy
    author: human:kei
    last_modified: 2026-08-24T00:00:00Z
---

# Computation

```typescript
import { responseHash, scan } from '@privacy-gateway/common/attesters/leak-check';

/** Return the receipt declared by `executor.receipt`. */
export function leakCheck(requestId: string, maskedPrompt: string, response: string) {
  return {
    request_id: requestId,
    masked_prompt_hash: responseHash(maskedPrompt),
    response_hash: responseHash(response),
    findings: scan(response),
    response,
  };
}
```

The computation binds only the declared `parameters`. `findings` is the sorted set of
PII categories the deterministic scanner detects; an empty list is the only passing
result, because the masking policy forbids any raw identifier in a response that
leaves the fleet.[^pii-policy]

`response` is the core agent's answer **as returned, still tokenized** — the check runs
before rehydration. Running it after rehydration would be meaningless: a correctly
rehydrated answer contains the user's real data by definition and could never pass. The
question this computation answers is narrower and sharper: did the frontier model, which
sits outside the trust boundary, introduce any raw identifier of its own beyond the
opaque placeholders it was given?

`masked_prompt_hash` binds the verdict to the exact prompt that produced the response, so
a receipt from one exchange cannot be replayed as evidence for another.

# What the attester checks

`/references/attesters/leak_check.ts` receives the receipt and verifies four things:

1. **Shape:** every field of `executor.receipt` is present. The list above and the list
   `verify()` demands are the same list; the attester exports it as `RECEIPT_FIELDS`.
2. **Binding:** `masked_prompt_hash` is a non-empty string, tying the verdict to one
   prompt.
3. **Fidelity:** `response_hash` equals the SHA-256 of the `response` the attester is
   about to scan, so the runner cannot report a hash for one text and hand over another.
4. **Provenance:** the attester re-runs the scan itself and compares against the runner's
   `findings`. A runner that under-reports fails the check rather than passing silently.

A response with any finding is unattested. The consumer MUST NOT present it as verified
and MUST NOT release it. The Synthesis Agent stops before any release: it marks the
answer `status: draft`, omits `verified`, records the failure in the answer's
`# Attestation` section, persists only the masked artifacts, and returns no answer body
at all.

# Scope of the claim

This computation confirms one thing: that the tokenized response carries no raw
identifier the deterministic scanner recognizes. It is a **leak-policy check**, not a
validation of the answer's facts, and not a guarantee of anonymity — the placeholders are
pseudonyms, and contextual re-identification from surrounding detail remains possible.

# Replay

Every `Gateway Answer` records `attestation.computation_sha256`, `attestation.attester_sha256`
and the digests of the two masked source artifacts, all of which the gateway serves at
`/v1/requests/<request_id>/masked-prompt.md` and `/v1/requests/<request_id>/core-response.md`.
`just verify-answer <request_id>` fetches them, re-runs this attester, and compares.

# Freshness

`stale_after` is deliberately absent: the check is a pure function of the response text
and carries no reference data that ages. The _answers_ it attests carry their own
`stale_after`, set to the Token Vault expiry for the request.

[^pii-policy]: PII masking policy
