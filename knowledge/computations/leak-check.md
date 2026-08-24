---
type: Attested Computation
title: Leak check on a gateway response
description: Sanctioned deterministic check that a core agent's tokenized response carries no raw PII or secrets before it is rehydrated, per the repository PII masking policy.
tags: [pii, security, attested]
status: stable
runtime: typescript
parameters:
  - { name: session_id, type: string, required: true }
  - { name: response, type: string, required: true }
executor:
  resource: /references/skills/run-leak-check.md
  receipt: [session_id, response_hash, findings]
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

/** Return the receipt declared by `executor.receipt`, plus the scanned text. */
export function leakCheck(sessionId: string, response: string) {
  return {
    session_id: sessionId,
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

# What the attester checks

`/references/attesters/leak_check.ts` receives the receipt and verifies three things:

1. **Shape:** the receipt carries `session_id`, `response_hash` and `findings`, plus the
   `response` text the attester needs to re-derive the verdict independently.
2. **Fidelity:** `response_hash` equals the SHA-256 of the `response` the attester is
   about to scan, so the runner cannot report a hash for one text and hand over another.
3. **Provenance:** the attester re-runs the scan itself and compares against the runner's
   `findings`. A runner that under-reports fails the check rather than passing silently.

A response with any finding is unattested; the consumer MUST NOT present it as verified,
and MUST NOT rehydrate it. The Synthesis Agent instead marks the answer `status: draft`,
omits `verified`, and records the failure in the answer's `# Attestation` section.

# Freshness

`stale_after` is deliberately absent: the check is a pure function of the response text
and carries no reference data that ages. The _answers_ it attests carry their own
`stale_after`, set to the Token Vault expiry for the session.

[^pii-policy]: PII masking policy
