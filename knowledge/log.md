---
type: Log
title: Privacy gateway bundle history
---

# Bundle history

## 2026-08-24

- **Attester ported to TypeScript.** `computations/leak-check.md` now declares
  `runtime: typescript` and points `attester.resource` at
  `references/attesters/leak_check.ts`; the executor skill was updated to match. The
  fleet became all-TypeScript, and keeping the sanctioned attester in a language no
  agent runs would have meant a second implementation drifting from the one that
  actually decides verdicts. The verification logic — receipt shape, hash fidelity, and
  independent re-derivation of findings — is unchanged, and the Python tests were ported
  case for case.
- The attester source lives at `packages/common/src/attesters/leak_check.ts` and is
  referenced from the bundle by that path (SPEC §6.2), rather than duplicated here, so
  Synthesis imports the very module this bundle sanctions.

## 2026-08-24 (bootstrap)

- **Bundle bootstrapped** for the All Things Agentic Hackathon. Added
  `policies/pii-masking.md` (authored and verified by `human:kei`) and
  `computations/leak-check.md` (`type: Attested Computation`) with its
  deterministic attester and executor
  instructions at `references/skills/run-leak-check.md`.
- The attester re-derives its findings from the response text rather than trusting the
  runner's `findings` list, so an under-reporting runner fails rather than passes.
