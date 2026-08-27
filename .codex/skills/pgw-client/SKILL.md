---
name: pgw-client
description: Consume the Privacy Gateway from an AI agent or script: send text containing real PII/secrets through POST /v1/ask instead of pasting it into an external LLM, read masked evidence via /v1/requests/<id>, replay attestation with pgw.py verify. Use when a task involves customer data, credentials, or other sensitive text that must not reach an outside model, or when an auditable leak-checked answer is required.
---

# Privacy Gateway client

Shared body: `skills/pgw-client/CLIENT.md` (repo root; shared by Claude Code and Codex).

1. Read `skills/pgw-client/CLIENT.md` — endpoints, CLI (`uv run clients/python/pgw.py`), response semantics, and the rules (never echo raw PII; persist only request_id/trace_id).
2. Resolve the gateway URL: local `http://localhost:8081`, deployed via `just urls`.
3. On refusals (draft/4xx), report the category findings — do not retry around a safety gate.
