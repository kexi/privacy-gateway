# Attesters

Deterministic verdict code. No LLM, no network calls, safe to run consumer-side.

- `leak_check.ts` — exposes `verify(receipt)` for
  [the leak-check computation](/computations/leak-check.md). Re-derives findings from the
  response text rather than trusting the runner's list, and exports `RECEIPT_FIELDS` so
  the receipt contract and the check cannot drift.

## Where the file lives

`leak_check.ts` sits here in the bundle so `attester.resource` resolves and a judge can
execute this Attested Computation without cloning the workspace. It is a **byte-identical
copy** of `packages/common/src/attesters/leak_check.ts`, which is what the Synthesis Agent
imports (published as `@privacy-gateway/common/attesters/leak-check`).

Why a copy rather than only the workspace path: a bundle whose `attester.resource` does
not resolve cannot be replayed, and TypeScript's `rootDir` will not let the workspace
package compile a source file from outside its own tree. Why not only the copy: Synthesis
must import the very module this concept sanctions.

The two are held together by a test — `packages/common/test/attester_bundle.test.ts` —
that fails when their SHA-256 digests differ. Every `Gateway Answer` also records
`attestation.attester_sha256`, so a reader can confirm which bytes produced their verdict.

A consumer outside the fleet can run the file standalone: it depends only on
`node:crypto` and holds no reference to the token vault.
