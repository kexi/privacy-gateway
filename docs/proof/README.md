# Deployment proof

Evidence captured from the live deployment at **https://privacy-gateway.kexi.dev**,
project `all-thinkgs`, region `us-central1`. The core exchange, the OpenAI-compatible
surface and the fleet/IAM state were re-captured on **2026-08-30**; each file below names
its own capture date. A Japanese version is at [README.ja.md](./README.ja.md).

Everything here is **masked**. The rehydrated answer contains real PII, is returned in a
single API response and is never stored — so it was stripped before these files were
written. Only placeholders (`⟦PERSON_1⟧`, `⟦EMAIL_1⟧`, `⟦PHONE_1⟧`, …), digests and
category counts survive.

## Resolved postmortems

Two defects were found while capturing the earlier evidence, were recorded here as open,
and are **now fixed**. They were real — not misreadings — and the history below is kept
deliberately, because a proof directory that quietly deletes its own failures is worth
less than one that shows them being closed.

### 1. The advisory judge's flag was not terminal — **fixed**

The Gemma judge is advisory and may only veto, never vouch. That asymmetry was undermined
by a re-roll: a flagged verdict could be re-asked and the second answer used.

**Now:** the flag is terminal. `leak: true` **always** refuses with `judge_flagged`
(HTTP 422). A second judge call may run **only** to name categories for the refusal
record; its `leak` value is discarded outright and only the categories it names are
adopted. No second call can turn a flag into a release. `attestation.judge_retries` now
counts those category-enrichment attempts, not verdict re-rolls.

Documented in `docs/ARCHITECTURE.md`. The separate placeholder-veto defect — the judge
flagging answers for containing its own `⟦TYPE_N⟧` placeholders — was fixed by stripping
well-formed placeholders before the judge sees them; see the addendum in
[`openai-compat.md`](./openai-compat.md).

### 2. The kill switch never capped the GPU — **fixed**

The old mechanism set `template.scaling.maxInstanceCount = 0` on `gemma-serving`. That was
a **no-op**: Cloud Run's maximum starts at 1, and `RevisionScaling.maxInstanceCount` is a
plain proto3 `int32` with no presence tracking, so a `0` was not serialised at all and the
server read the field as "no maximum". The limit was _removed_, not set to zero. The old
success check then read that same absent field back and called it proof — a check that
could only ever agree with itself.

**Now:** the switch holds `gemma-serving` at zero instances using Cloud Run **manual
scaling** — `scaling.scalingMode = MANUAL` with `scaling.manualInstanceCount = 0`, which
is the documented zero-instance mechanism and whose field _is_ `proto3_optional`, so an
explicit `0` survives serialisation. It additionally revokes the gateway's and synthesis's
`run.invoker` on `gemma-serving`. Success is verified by explicitly **reading back** mode
and count, never inferred from an absent field.

Documented in `docs/DEPLOY.md`; the live fire is in
[`kill-switch.md`](./kill-switch.md).

---

## The proof run

Captured 2026-08-30. Full response in [`gateway-answer.json`](./gateway-answer.json),
walked through in [`demo-sample.md`](./demo-sample.md).

| Field         | Value                                                                |
| ------------- | -------------------------------------------------------------------- |
| `request_id`  | `01a05302-656b-735f-88ed-2e3dd5225497`                               |
| `trace_id`    | `c057cdb3782dd239bbb772aa0ee268e9`                                   |
| `trust_tier`  | `machine-confirmed`                                                  |
| `status`      | `stable`                                                             |
| `core_actor`  | `core_agent/gemini-3.5-flash`                                        |
| masked counts | `PERSON: 1, EMAIL: 1, PHONE: 1, CREDIT_CARD: 1, API_KEY: 1, IPV4: 1` |
| `withheld`    | `API_KEY`, `CREDIT_CARD`                                             |

The cleartext prompt is not reproduced — it is the one artifact this repository never
stores. Masked before it left the trust boundary:

> Draft a short reply to ⟦PERSON_1⟧ (⟦EMAIL_1⟧, ⟦PHONE_1⟧) confirming his order. His card
> ⟦CREDIT_CARD_1⟧ and API key ⟦API_KEY_1⟧ were on file, from ⟦IPV4_1⟧.

## Files

| File                                     | Captured   | What it shows                                                                                         |
| ---------------------------------------- | ---------- | ----------------------------------------------------------------------------------------------------- |
| `gateway-answer.json`                    | 2026-08-30 | The full API response with `answer` removed. Masked prompt, attestation, consistency, stats.          |
| `gateway-answer.okf.md`                  | 2026-08-30 | The OKF v0.2 `Gateway Answer` document, whose body holds the **masked** answer.                       |
| [`demo-sample.md`](./demo-sample.md)     | 2026-08-30 | The same exchange walked end to end: masked prompt, Core's tokenized reply, withholding, attestation. |
| [`openai-compat.md`](./openai-compat.md) | 2026-08-30 | `/v1/models` and `/v1/chat/completions` against production, plus the fixed judge defect as history.   |
| `sa-core-iam.txt`                        | 2026-08-30 | Core's service account roles — **no Firestore role**.                                                 |
| `fleet-state.txt`                        | 2026-08-30 | Ingress, scaling, service accounts, and the attached GPU.                                             |
| [`kill-switch.md`](./kill-switch.md)     | 2026-08-30 | A **live** kill-switch fire under the fixed manual-scaling mechanism.                                 |
| [`mcp.md`](./mcp.md)                     | 2026-08-30 | The MCP stdio server driven against production: `pgw_ask` / `pgw_evidence` / `pgw_verify`.            |
| `logs-request.jsonl`                     | 2026-08-30 | Structured logs for the proof request: 12 events, all three agents on one id.                         |
| `trace-spans.json`                       | 2026-08-30 | The Cloud Trace trace for the same request: 16 spans.                                                 |

Both were re-exported for the current request `01a05302-656b-735f-88ed-2e3dd5225497`:
`logs-request.jsonl` via `gcloud logging read 'jsonPayload.request_id="…"'`, and
`trace-spans.json` from the Cloud Trace v1 API for trace
`c057cdb3782dd239bbb772aa0ee268e9`.

One honest caveat on the trace: it holds **16** spans, and they cover Synthesis
(`synthesize`, `attest.leak_check`, `judge.gemma`, `okf.build`, `rehydrate`, `persist`),
the Firestore round trips, and the inbound HTTP handlers (`/v1/synthesize`,
`/.well-known/agent-card.json`, `/v1/chat/completions`). The Gateway's own top-level
`request` and `a2a.core` spans are **not** in the exported trace, though the same steps are
present in `logs-request.jsonl` with the matching `trace_id`. The earlier 2026-08-27
capture did include them (24 spans), so this is an export gap in this particular run, not a
change in instrumentation. It is recorded rather than papered over.

## What the evidence establishes

**The masking is real.** `stats.counts_by_category` records six identifiers across six
categories, and `masked_prompt` shows the placeholders that replaced them. This is
**pseudonymization, not anonymization**: the placeholders still disclose category and
equality, and surviving quasi-identifiers permit contextual re-identification.

**Withholding is enforced, not negotiated.** `CREDIT_CARD` and `API_KEY` stayed masked in
the released answer — `attestation.withheld` names both, and the placeholders survive
verbatim in the text the caller received. A secret the caller already holds is not echoed
back through a frontier-model round trip.

**The leak check is machine-decided.** `verified[].by` is
`process:leak-check@8b427a667e64` — a TypeScript regex attester, never an LLM actor.
`dimensions.review_identity` is `none`, because the public gateway authenticates nobody and
so nothing can name a human reviewer. `trust_tier: machine-confirmed` means leak-policy only;
it is **not** a factual validation of the answer.

**Core is structurally blind to the vault.** `sa-core-iam.txt` lists only
`roles/aiplatform.user`, `roles/cloudtrace.agent` and `roles/logging.logWriter`. The absence
of any `roles/datastore.*` line is the guarantee — enforced by IAM, not by the package graph.

**One request, one trace, three agents.** `logs-request.jsonl` shows `gateway-agent`,
`core-agent` and `synthesis-agent` all logging 12 events under the same `request_id`
(`request.start` → `mask.done` → `a2a.core.send` → `a2a.receive` → `a2a.core.recv` →
`attest.verdict` → `judge.gemma` → `release.ok` → `okf.persist` → `request.end`), and
`trace-spans.json` is a single trace carrying the same id across those steps.

## Known gaps

- **No `llm.gemini` span.** The trace records the `a2a.core` hop, but Core's internal Gemini
  call is not exported as its own span, so the Gemini latency is not separately visible.
- **`just verify-auth` and `just verify-auth-internal` did not complete.** See
  "Deviations" in the deploy report; the boundary was instead confirmed by direct probes
  (every private service refuses a request from outside the VPC) and by the `internal`
  ingress settings in `fleet-state.txt`.
- **The exported trace is missing the Gateway's own spans.** See the note under _Files_.
