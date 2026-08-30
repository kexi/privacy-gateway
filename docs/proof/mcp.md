# MCP server against production

Captured **2026-08-30**. The stdio MCP server in `clients/mcp` was run locally with
`PGW_GATEWAY_URL=https://privacy-gateway.kexi.dev`, driven by the official
`@modelcontextprotocol/sdk` client (1.30.0) over a real stdio transport — the same way an
MCP host (Claude Desktop, an IDE) would launch it.

The sample PII is synthetic and allow-listed in `.gitleaks.toml`. Nothing here is real.

Server banner on start (stderr — stdout is the JSON-RPC channel and carries nothing else):

```
privacy-gateway MCP server ready (gateway: https://privacy-gateway.kexi.dev)
```

## `tools/list`

```json
["pgw_ask", "pgw_evidence", "pgw_verify"]
```

## `tools/call` — `pgw_ask`

Arguments:

```json
{
  "text": "Draft a reply to the customer at hanako.sato@example.co.jp / 090-1234-5678 confirming her refund."
}
```

Result:

```json
{
  "refused": false,
  "answer": "Here are drafts for both email and SMS formats … **To:** hanako.sato@example.co.jp … **To:** 090-1234-5678 …",
  "masked_prompt": "Draft a reply to the customer at ⟦EMAIL_1⟧ / ⟦PHONE_1⟧ confirming her refund.",
  "trust_tier": "machine-confirmed",
  "status": "stable",
  "request_id": "01a05312-28ec-71bf-b180-ef9e31682775",
  "trace_id": "97cf2b4642881628550357bcb647abb1",
  "leak_check": "pass",
  "withheld": [],
  "findings": []
}
```

The `answer` is elided above only for length; the two identifiers really are present in it,
rehydrated, because `EMAIL` and `PHONE` are not withheld categories.

`masked_prompt` is the point of the whole exercise: what Gemini actually received was
`⟦EMAIL_1⟧` and `⟦PHONE_1⟧`. The tool hands that back to the calling model deliberately, so
an agent can show its user that the boundary held rather than asking them to trust it.

## `tools/call` — `pgw_evidence`

Arguments: `{"request_id": "01a05312-28ec-71bf-b180-ef9e31682775"}`.

Returns the stored OKF v0.2 document, whose body holds the **masked** answer — the
rehydrated text above was returned once, to the caller, and is never persisted. The
frontmatter records:

| Field                           | Value                                                              |
| ------------------------------- | ------------------------------------------------------------------ |
| `type`                          | `Gateway Answer`                                                   |
| `generated.by`                  | `synthesis_agent/0.1.0`                                            |
| `generated.at`                  | `2026-08-30T14:28:22Z`                                             |
| `sources[core-response].author` | `core_agent/gemini-3.5-flash`                                      |
| `attestation.verdict`           | `pass`                                                             |
| `verified[].by`                 | `process:leak-check@8b427a667e64`                                  |
| `masked_prompt_sha256`          | `c06a24db18cae0f7f9e63b63191f6d1ad77424bde6366c9b62794a7b49dee570` |
| `core_response_sha256`          | `3d93ce8f3f3500ced6d7c8be6f1d38a7bf63e8fa5f9b8fdea8fe77e656f8b576` |

Where the released answer says `hanako.sato@example.co.jp`, the stored document says
`⟦EMAIL_1⟧`. That difference between what the caller received and what the audit record
retains is the design, visible in one pair of artifacts.

## `tools/call` — `pgw_verify`

Arguments: `{"request_id": "01a05312-28ec-71bf-b180-ef9e31682775"}`.

Result:

```json
{
  "refused": false,
  "request_id": "01a05312-28ec-71bf-b180-ef9e31682775",
  "ok": true,
  "checks": [
    {
      "name": "masked_prompt_sha256 is a sha256 digest",
      "ok": true,
      "value": "c06a24db18cae0f7f9e63b63191f6d1ad77424bde6366c9b62794a7b49dee570"
    },
    {
      "name": "core_response_sha256 is a sha256 digest",
      "ok": true,
      "value": "3d93ce8f3f3500ced6d7c8be6f1d38a7bf63e8fa5f9b8fdea8fe77e656f8b576"
    },
    {
      "name": "attester_sha256 is a sha256 digest",
      "ok": true,
      "value": "8b427a667e6426be7061777d8c7952e57a816b8fbcd0410fdafea2e737529ce9"
    },
    {
      "name": "computation_sha256 is a sha256 digest",
      "ok": true,
      "value": "efa7e03c46f5158efed2641a4988cb7f49a32792a67d563826be070946d6cdbc"
    },
    {
      "name": "masked_prompt_sha256 matches the served prompt",
      "ok": true,
      "value": "c06a24db18cae0f7f9e63b63191f6d1ad77424bde6366c9b62794a7b49dee570"
    },
    {
      "name": "core_response_sha256 matches the served response",
      "ok": true,
      "value": "3d93ce8f3f3500ced6d7c8be6f1d38a7bf63e8fa5f9b8fdea8fe77e656f8b576"
    },
    {
      "name": "request_id matches the document",
      "ok": true,
      "value": "01a05312-28ec-71bf-b180-ef9e31682775"
    },
    { "name": "verdict matches the independently derived findings", "ok": true, "value": "pass" }
  ],
  "independently_derived_findings": [],
  "trust_tier": "machine-confirmed",
  "not_checked": [
    "attester_sha256 and computation_sha256 name files in the fleet repository; this client hashes only the artifacts the gateway serves. Run `uv run clients/python/pgw.py verify <id>` from a checkout to compare those two."
  ]
}
```

All eight checks pass. The two digest-match checks are the substantive ones: the client
re-fetched the masked prompt and the core response the gateway serves, re-hashed them
itself, and got the digests the document claims. It then re-derived the verdict with its
own transcribed copy of the scanner rather than trusting the fleet's, and reached the same
`pass`.

The client also states plainly what it **cannot** check: `attester_sha256` and
`computation_sha256` name files inside the fleet repository, so from outside a checkout
they are reported as not-checked rather than quietly counted as passed. A verifier that
claimed full verification here would be overstating what it did.

The digests are real 64-hex values, not the `unavailable` placeholder that an earlier
packaging bug produced — the property `just image-test` exists to guard.

## What this establishes

- The MCP server speaks real MCP over stdio: `initialize`, `tools/list`, `tools/call`.
- All three tools are exposed, and **all three** were called against the live production
  gateway at `https://privacy-gateway.kexi.dev` in one session.
- The masked prompt crosses the MCP boundary alongside the answer, so a calling agent can
  evidence the boundary rather than assert it.
- `pgw_verify` re-derives digests independently, returns `ok: true` for a released answer,
  and reports its own limits instead of overclaiming.

## Anti-retry guidance on refusals

Every tool result carries, when a gate refuses, a `guidance` string:

```
"A fail-closed gate refused this request. Explain the refusal to the user; do not retry
 or rephrase to get around it."
```

This run was not refused, so the field is absent from the results above — it was observed
on earlier refused calls against this same deployment. It is worth noting on its own: a
fail-closed gate is only as good as the agent's reaction to it, and an LLM's default
reaction to a refusal is to try again with softer wording. Putting that instruction in the
tool result is the fleet defending its own boundary at the point where an agent would
otherwise erode it.

## Historical note (2026-08-27)

An earlier capture of this same transcript, against the pre-custom-domain URL
`https://gateway-agent-turszib42q-uc.a.run.app`, recorded `pgw_ask` refused with
`judge_flagged` (422) and `pgw_verify` returning `ok: false` — the correct answer for a
refused request, since a refusal persists no Core body to rehash. That refusal was the
placeholder-veto defect since fixed; see [openai-compat.md](./openai-compat.md) and
[README.md](./README.md#resolved-postmortems).
