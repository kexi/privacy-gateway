# `@privacy-gateway/mcp`

An [MCP](https://modelcontextprotocol.io) stdio server that exposes the
Privacy-Preserving Gateway as three tools, so an agent can send a request across
the trust boundary, read the audit document it produced, and independently verify
that document — without ever holding the raw PII itself.

Japanese version: [README.ja.md](README.ja.md).

## Tools

| tool           | input          | returns                                                                                                           |
| -------------- | -------------- | ----------------------------------------------------------------------------------------------------------------- |
| `pgw_ask`      | `{text}`       | `answer`, `masked_prompt`, `trust_tier`, `status`, `request_id`, `trace_id`, `leak_check`, `withheld`, `findings` |
| `pgw_evidence` | `{request_id}` | the stored **masked** OKF v0.2 document, plus the tier derived from it                                            |
| `pgw_verify`   | `{request_id}` | a replayed attestation: `ok`, a per-digest `checks[]` list, `independently_derived_findings`, `not_checked`       |

### Refusals are results, not errors

Every gate in this fleet fails closed, and a refusal means the system worked. The
tools therefore return a structured payload:

```json
{
  "refused": true,
  "status": 422,
  "error": "outbound_guard_refused",
  "message": "raw PII survived masking",
  "categories": ["EMAIL", "PHONE"],
  "guidance": "A fail-closed gate refused this request. Explain the refusal to the user; do not retry or rephrase to get around it."
}
```

rather than throwing. A thrown MCP error reads to a model as a transient fault
worth retrying — and retrying around a privacy gate is another attempt to move
the same data across the same boundary. Every tool description says so too.

### What `pgw_verify` actually checks

It re-hashes the two masked artifacts the gateway serves, checks that every
recorded digest is 64 lowercase hex characters, confirms the document binds
itself to the request id, and re-derives the leak-check verdict with a
**transcribed** copy of the scanner. Transcribed, not imported: replaying the
check with the fleet's own code would only prove the fleet agrees with itself.

`attester_sha256` and `computation_sha256` name files in the fleet repository,
which this server does not have. They are reported under `not_checked` — never as
passing. To compare those two, run `uv run clients/python/pgw.py verify <id>`
from a checkout.

## Install

```sh
pnpm -r build          # or: pnpm --filter @privacy-gateway/mcp build
```

The package declares a `pgw-mcp` bin, so `node clients/mcp/dist/index.js` and
`npx pgw-mcp` both start the server.

## Configuration

| variable          | default                 | meaning                |
| ----------------- | ----------------------- | ---------------------- |
| `PGW_GATEWAY_URL` | `http://localhost:8081` | the gateway's base URL |

### Claude Desktop

`claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "privacy-gateway": {
      "command": "node",
      "args": ["/absolute/path/to/all-things-agentic-hackathon/clients/mcp/dist/index.js"],
      "env": {
        "PGW_GATEWAY_URL": "http://localhost:8081"
      }
    }
  }
}
```

### Claude Code

```sh
claude mcp add privacy-gateway \
  --env PGW_GATEWAY_URL=http://localhost:8081 \
  -- node /absolute/path/to/clients/mcp/dist/index.js
```

Then `claude mcp list` should show `privacy-gateway`, and the three `pgw_*` tools
become available in the session.

### Codex

In `~/.codex/config.toml`:

```toml
[mcp_servers.privacy-gateway]
command = "node"
args = ["/absolute/path/to/clients/mcp/dist/index.js"]
env = { PGW_GATEWAY_URL = "http://localhost:8081" }
```

## Notes

- **No credential channel yet.** When the deployment enables the Basic-auth gate
  (`BASIC_AUTH_CREDENTIALS`, see `skills/pgw-client/CLIENT.md` §0), this server
  cannot authenticate: there is no header option, and Node's `fetch` rejects a
  `user:pass@` URL in `PGW_GATEWAY_URL` outright. Point it at a local
  (`http://localhost:8081`) or ungated deployment instead.
- **stdout is the protocol channel.** Nothing in this package writes to stdout;
  the one startup line goes to stderr.
- **No request text is ever logged.** The gateway exists to keep raw PII inside
  the boundary; a client that echoed prompts to its own logs would reintroduce
  exactly that leak. Diagnostics carry the request id and nothing else.
- The masking is **pseudonymization, not anonymization**: placeholders disclose
  category and equality, and surviving quasi-identifiers permit contextual
  re-identification.

## Development

```sh
pnpm --filter @privacy-gateway/mcp test        # vitest, gateway mocked at the fetch layer
pnpm --filter @privacy-gateway/mcp typecheck
pnpm --filter @privacy-gateway/mcp lint
```
