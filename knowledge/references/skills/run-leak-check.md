---
type: Skill
title: Run the leak check
description: Run instructions for the leak-check Attested Computation. Produces the receipt the deterministic attester inspects.
tags: [pii, security, executor]
status: stable
generated: { by: gateway_fleet/bootstrap, at: 2026-08-24T00:00:00Z }
---

# Purpose

Execute [the leak-check computation](/computations/leak-check.md) over a core agent's
still-tokenized response and return a receipt. Run it **before** any rehydration. A failing verdict stops the release entirely: no answer body is returned, and only masked artifacts are persisted.

The runner does not decide whether the response is safe; it only produces evidence. The
verdict comes from the attester.

# Inputs

Supply values for the declared parameters only. Do not edit the computation.

| Parameter       | Type   | Required |
| --------------- | ------ | -------- |
| `request_id`    | string | yes      |
| `masked_prompt` | string | yes      |
| `response`      | string | yes      |

# Steps

1. Import the scanner from the bundle attester:

   ```typescript
   import { responseHash, scan, verify } from '@privacy-gateway/common/attesters/leak-check';
   ```

   That specifier resolves to `/references/attesters/leak_check.ts`; a consumer outside
   the fleet imports the file directly.

2. Build the receipt:

   ```typescript
   const receipt = {
     request_id: requestId,
     masked_prompt_hash: responseHash(maskedPrompt),
     response_hash: responseHash(response),
     findings: scan(response),
     response,
   };
   ```

3. Hand the receipt to `verify()` from the same module. Do not interpret `findings`
   yourself — a runner that decides its own verdict defeats the point of the attestation.

# Output

The receipt above. All five fields are declared in `executor.receipt`, and the attester
exports the same list as `RECEIPT_FIELDS`, so the contract and the check cannot drift.
`response` is carried so the attester can re-derive the findings independently instead of
trusting the runner; `masked_prompt_hash` binds the verdict to one exchange.

# Constraints

- No LLM may be involved in producing the receipt. The Gemma judge runs as a separate,
  advisory signal and its opinion never enters the receipt.
- No network calls.
- The receipt is a runtime artifact. It is never written into the bundle.
