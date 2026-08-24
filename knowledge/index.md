---
okf_version: '0.2'
---

# Privacy gateway knowledge bundle

Knowledge for the privacy-preserving multi-agent gateway: the masking policy the fleet
enforces, and the attested computation that gates every response.

- [Policies](/policies/index.md) — what must be masked, and what a response must satisfy.
- [Computations](/computations/index.md) — sanctioned, attestable checks.
- [References](/references/index.md) — executors and deterministic attesters.
- [Bundle history](/log.md)

Per-request answers (`type: Gateway Answer`) are produced by the Synthesis Agent at
runtime and stored in Firestore, keyed by request id. They are not part of this bundle:
they are per-request artifacts with their own `stale_after`, tied to the Token Vault
expiry, and they hold only masked text. Replay one with
`just verify-answer <request_id>`.
