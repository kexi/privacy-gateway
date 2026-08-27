# Using the Privacy Gateway as a client agent

For any AI agent (Claude Code, Codex, antigravity-cli, or your own tool) that must
process text containing real PII or secrets: do not paste that text into an external
LLM prompt. Route it through the Privacy Gateway instead — the fleet masks it, lets
Gemini reason over placeholders, verifies the output, and returns the rehydrated
answer with an audit document.

## When to reach for this

- The task text contains names, emails, phone numbers, card numbers, API keys,
  tokens, or Japanese My Numbers that must not leave the machine/organization.
- You are about to summarize, draft a reply for, or generate code from customer
  data. Send the raw text to the gateway, not to your own model context, when the
  policy of the surrounding task demands it.
- You need an auditable record that a given answer passed a leak check.

## Endpoints (Gateway is the only public surface)

Resolve the base URL: locally `http://localhost:8081` (`just dev`); deployed, run
`just urls` in the repo, or ask the maintainer. All bodies are JSON.

| Call                                                                  | Meaning                                                                                                                                                             |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /v1/ask` `{"text": "..."}`                                      | The whole flow. Returns `answer` (rehydrated, ephemeral), `masked_prompt`, `okf` (audit document), `trust_tier`, `status`, `attestation`, `request_id`, `trace_id`. |
| `GET /v1/requests/<request_id>`                                       | Stored masked evidence (OKF markdown). Never contains raw PII.                                                                                                      |
| `GET /v1/requests/<request_id>/masked-prompt.md` / `core-response.md` | The two masked source artifacts the OKF document cites.                                                                                                             |
| `GET /healthz`                                                        | Liveness.                                                                                                                                                           |

Notes:

- `session_id` is not accepted; the server mints one id per request.
- The literal characters `⟦` / `⟦` in input are rejected (400) — never construct
  placeholder syntax yourself.
- High-risk categories (API keys, cards, JWTs, My Number) are never rehydrated;
  they come back as placeholders and are listed in `attestation.withheld`.

## CLI (no Node required)

```
uv run clients/python/pgw.py ask "..." [--gateway URL]
uv run clients/python/pgw.py evidence <request_id> [--gateway URL]
uv run clients/python/pgw.py verify <request_id> [--gateway URL]
```

`verify` replays the leak-check attestation from the stored artifacts and compares
every recorded SHA-256 — use it when you need to prove the check happened without
trusting the gateway.

## Reading the response

- `status: stable` + `trust_tier: machine-confirmed` — leak policy passed. The
  badge means "leak-policy only": it is not factual verification of the answer.
- `status: draft` — a gate refused. The body is withheld; `attestation.findings`
  carries category names only. Do not retry with tweaked input to "get around" a
  refusal; report it.
- HTTP 400 = placeholder syntax in input; 409/410 = vault missing/expired
  (re-`ask`, do not reuse old ids); 422 = leak check refused; 502 = a safety
  dependency was unavailable (fail-closed).

## Rules for agents

1. Never echo raw PII from the task into your own logs, commit messages, or
   reports — quote the `masked_prompt` form instead.
2. Persist only `request_id` / `trace_id` as references; the rehydrated `answer`
   exists only in the response you received.
3. For debugging a failed request, use the `pgw-logs` skill with the `request_id`.
4. The OKF document in `okf` follows the `okf` skill's conventions; parse the
   frontmatter rather than scraping the body.
