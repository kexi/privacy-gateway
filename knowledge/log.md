---
type: Log
title: Privacy gateway bundle history
---

# Bundle history

## 2026-08-24

- **Fail-closed release, and evidence that can be replayed.** Answering the Codex design
  review: the receipt contract in `computations/leak-check.md` now lists exactly the
  fields `verify()` demands (`request_id`, `masked_prompt_hash`, `response_hash`,
  `findings`, `response`) and adds `masked_prompt_hash` so a verdict binds to one
  exchange. `attester.resource` resolves: `references/attesters/leak_check.ts` is a
  byte-identical copy of the module Synthesis imports, and a test asserts the two SHA-256
  digests match. The computation index no longer says Python. A failed check now blocks
  the release outright rather than being recorded beside a rehydrated answer.
- **Answers are keyed by request, not session.** Caller-supplied and multi-turn sessions
  were removed: a caller who can name a vault key can make the gateway resolve someone
  else's placeholders, and validating the id does not change that. Each answer's
  `sources` now name `/requests/<id>/masked-prompt.md` and `/requests/<id>/core-response.md`,
  both actually served, and each carries a top-level `attestation` block with the
  digests needed to replay the verdict.

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

## 2026-08-23

- **Bundle bootstrapped** for the All Things Agentic Hackathon. Added
  `policies/pii-masking.md` (authored and verified by `human:kei`) and
  `computations/leak-check.md` (`type: Attested Computation`) with its
  deterministic attester and executor
  instructions at `references/skills/run-leak-check.md`.
- The attester re-derives its findings from the response text rather than trusting the
  runner's `findings` list, so an under-reporting runner fails rather than passes.
