# Attesters

Deterministic verdict code. No LLM, no network calls, safe to run consumer-side.

- `leak_check.ts` — exposes `verify(receipt)` for
  [the leak-check computation](/computations/leak-check.md). Re-derives findings from the
  response text rather than trusting the runner's list.

## Where the file lives

The attester source is `packages/common/src/attesters/leak_check.ts`, published from the
workspace as `@privacy-gateway/common/attesters/leak-check`. The bundle references it by
that path rather than holding a second copy: the Synthesis Agent imports the very module
this concept names, so a drift between the sanctioned attester and the one that actually
runs cannot occur. SPEC §6.2 permits a `resource` outside the bundle for exactly this
reason.

A consumer outside the fleet can run the file standalone — it depends only on
`node:crypto` and holds no reference to the token vault.
