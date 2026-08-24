---
name: pgw-logs
description: Investigate logs, traces and audit records of the Privacy Gateway fleet (gateway-agent / core-agent / synthesis-agent / gemma-serving on Cloud Run project all-thinkgs, or local just dev). Use when debugging a request by request_id / trace_id / session_id, a failed attestation or leak check, A2A/IAM errors between services, Gemma or Gemini call failures, deploy problems, or when asked where logs are, which Cloud Logging / Cloud Trace / Firestore URLs or endpoints to check, or which gcloud logging queries to run.
---

# Privacy Gateway log investigation

Shared body: `skills/pgw-logs/LOGS.md` (repo root; shared by Claude Code and Codex).

1. Read `skills/pgw-logs/LOGS.md` first — it lists where logs live (local ports, Cloud Run service names, Firestore collections), endpoints, console URLs, `gcloud logging read` queries, the expected span tree, event names and error codes.
2. Start from `request_id`, widen to `session_id`, then time window. Never paste raw PII or vault contents into findings.
3. For the canonical event/error tables see `docs/OBSERVABILITY.md` (+ `.ja.md`).
