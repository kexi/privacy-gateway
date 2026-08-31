---
type: Operational Finding
title: Codex CLI 0.151 request shape exceeds the deployed default with host features enabled
description: Local PTY measurements of the Codex Responses request on 2026-08-31.
tags: [gateway]
sources:
  - id: codex-cli
    resource: https://github.com/openai/codex
    title: OpenAI Codex CLI
generated:
  by: codex/0.151.0
  at: 2026-08-31T17:49:39Z
status: draft
---

# Finding

Codex CLI 0.151.0, launched from this Codex host with its default host features,
sent a Responses request larger than the Gateway's deployed 256 KiB
`MAX_BODY_BYTES`. The local production-path Gateway refused it with HTTP 413
`payload_too_large` before masking. Enabling `skip_host_skill_discovery` alone did
not bring the body under the limit.

The same CLI request completed when the recording command disabled the host-only
`apps`, `browser_use`, `code_mode_host`, `computer_use`, `image_generation`, and
`plugins` features. The Gateway limit was not changed. The returned answer
contained the local Core fixture's `Referenced placeholders:` marker and the
rehydrated synthetic address, which distinguishes it from the echoed command.

This does not yet measure the new `raw_body_bytes` or `forwarded_text_bytes`, and
it does not prove that every non-host Codex installation exceeds 256 KiB. Treat
the prior 141,396-byte measurement as version- and environment-specific until a
live 0.151.0 run records both size fields.[^codex-cli]

# Verification

The submission-video PTY capture performed three local runs against
`http://127.0.0.1:8381/v1`:

1. Default host features: HTTP 413 `payload_too_large`.
2. `skip_host_skill_discovery` only: HTTP 413 `payload_too_large`.
3. Host-only features disabled: exit 0 with the deterministic local Core marker.

The final recording used an asciinema PTY with tmux as the terminal emulator and
`tmux send-keys` for literal interactive input. This matters because a bare inner
PTY does not answer Codex's startup terminal probes and can show only a stalled
composer. The recording used a synthetic address and the in-memory vault. No
request was sent to the deployed fleet.

[^codex-cli]: Source project for the CLI whose version and request behavior were measured.
