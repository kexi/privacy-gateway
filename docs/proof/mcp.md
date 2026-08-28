# MCP server against production

Captured **2026-08-27**. The stdio MCP server in `clients/mcp` was run locally with
`PGW_GATEWAY_URL=https://gateway-agent-turszib42q-uc.a.run.app`, driven by the official
`@modelcontextprotocol/sdk` client over a real stdio transport — the same way an MCP host
(Claude Desktop, an IDE) would launch it.

Server banner on start:

```
privacy-gateway MCP server ready (gateway: https://gateway-agent-turszib42q-uc.a.run.app)
```

## `tools/list`

```json
["pgw_ask", "pgw_evidence", "pgw_verify"]
```

## `tools/call` — `pgw_ask`

Arguments (synthetic PII, allow-listed in `.gitleaks.toml`):

```json
{
  "text": "Draft a reply to the customer at hanako.sato@example.co.jp / 090-1234-5678 confirming her refund."
}
```

Result:

```json
{
  "refused": true,
  "status": 422,
  "error": "judge_flagged",
  "message": "the advisory judge flagged a possible leak",
  "categories": [],
  "request_id": "01a04597-74bb-7c01-8005-7032f8620d6e",
  "guidance": "A fail-closed gate refused this request. Explain the refusal to the user; do not retry or rephrase to get around it."
}
```

The refusal is the judge issue documented in
[openai-compat.md](./openai-compat.md), not an MCP fault: the transport, the tool
schema, the call and the structured result all worked.

Worth noting on its own: the tool hands the calling model **`guidance` that tells it not
to retry or rephrase around the refusal**. A fail-closed gate is only as good as the
agent's reaction to it, and an LLM's default reaction to a refusal is to try again with
softer wording. Putting that instruction in the tool result is the fleet defending its
own boundary at the point where an agent would otherwise erode it.

## `tools/call` — `pgw_verify`

Arguments: `{"request_id": "01a04597-74bb-7c01-8005-7032f8620d6e"}` (the id `pgw_ask`
returned).

Result:

```json
{
  "refused": false,
  "request_id": "01a04597-74bb-7c01-8005-7032f8620d6e",
  "ok": false,
  "checks": [
    {
      "name": "masked_prompt_sha256 is a sha256 digest",
      "ok": true,
      "value": "c06a24db18cae0f7f9e63b63191f6d1ad77424bde6366c9b62794a7b49dee570"
    },
    {
      "name": "core_response_sha256 is a sha256 digest",
      "ok": true,
      "value": "5ba76799b6da509f463129d69f8ae514d4935d64dbe3cfdc9e86751dbeb2952a"
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
      "ok": false,
      "value": "5ba76799b6da509f463129d69f8ae514d4935d64dbe3cfdc9e86751dbeb2952a"
    },
    {
      "name": "request_id matches the document",
      "ok": true,
      "value": "01a04597-74bb-7c01-8005-7032f8620d6e"
    },
    { "name": "verdict matches the independently derived findings", "ok": false, "value": "fail" }
  ],
  "independently_derived_findings": [],
  "trust_tier": "unverified",
  "not_checked": [
    "attester_sha256 and computation_sha256 name files in the fleet repository; this client hashes only the artifacts the gateway serves. Run `uv run clients/python/pgw.py verify <id>` from a checkout to compare those two."
  ]
}
```

### Why `ok: false` is the correct answer here

This verifies a **refused** request, and the two failing checks are exactly the two that
must fail for a refusal:

- `core_response_sha256 matches the served response` — **false by design.** A refused
  request persists no Core body; the evidence document holds a `content withheld` marker
  instead (`agents/synthesis/src/pipeline.ts`: the rejected text is precisely the text
  that failed policy, so storing it would recreate the leak). There is nothing to rehash,
  so the digest cannot match.
- `verdict matches the independently derived findings` — the document records
  `verdict: fail` while the client's own re-derivation over the served (withheld)
  artifacts produces `independently_derived_findings: []`.

`trust_tier: unverified` is the honest result, and the client says plainly which two
digests it **cannot** check from outside a checkout rather than implying full
verification. A verifier that returned `ok: true` for a refused request would be the
broken one.

The digests are real 64-hex values, not the `unavailable` placeholder that an earlier
packaging bug produced — the property `just image-test` exists to guard.

## What this establishes

- The MCP server speaks real MCP over stdio: `initialize`, `tools/list`, `tools/call`.
- All three tools are exposed, and two were called against the live production gateway.
- Refusals cross the MCP boundary as structured results with anti-retry guidance, not as
  transport errors.
- `pgw_verify` re-derives digests independently and reports its own limits.
