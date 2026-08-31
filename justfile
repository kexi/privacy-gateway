# Privacy-Preserving Multi-Agent Gateway — dev tasks
# See README.md / docs/ARCHITECTURE.md for the full picture.
#
# lint / fmt / typecheck / check live in `.just/tooling.just`.
# This file holds only app-specific setup, run and deploy recipes.

set dotenv-load

# List every available recipe (the default target)
default:
    @just --list

# --- setup ------------------------------------------------------------------

# Resolve the pnpm workspace dependencies
setup:
    pnpm install

# Download the Chromium build Playwright drives (skip under Nix, which supplies it)
setup-browsers:
    pnpm -C web exec playwright install chromium

# --- local dev --------------------------------------------------------------

# Run Gateway, Core, Synthesis and the web dev server together (in-memory vault + local Ollama)
dev:
    #!/usr/bin/env bash
    set -euo pipefail
    export VAULT_BACKEND=memory
    trap 'kill 0' EXIT
    pnpm --filter @privacy-gateway/synthesis dev &
    pnpm --filter @privacy-gateway/core dev &
    pnpm --filter @privacy-gateway/gateway dev &
    pnpm --filter web dev &
    wait

# Run only the Gateway (port 8081)
dev-gateway:
    VAULT_BACKEND=memory pnpm --filter @privacy-gateway/gateway dev

# Run only the Core agent (port 8082)
dev-core:
    pnpm --filter @privacy-gateway/core dev

# Run only the Synthesis agent (port 8083)
dev-synthesis:
    VAULT_BACKEND=memory pnpm --filter @privacy-gateway/synthesis dev

# Pull the Gemma model into the local Ollama
pull-gemma model="gemma4:12b":
    ollama pull {{ model }}

# Inspect Gemma's raw span-extraction output on a Codex-shaped payload (needs a local ollama)
#
# The one place a failing chunk's raw model output can be read: production must
# not log it, because the answer echoes the input it was asked about. Local only,
# never in CI — it makes real model calls against `just pull-gemma`'s model.
# An empty `model` lets the script fall back to the tag config.ts defines.
extraction-lab bytes="60000" model="":
    pnpm --filter @privacy-gateway/gateway exec tsx tools/extraction-lab.ts {{ bytes }} {{ model }}

# --- web --------------------------------------------------------------------

# Start the Vite dev server (proxies /v1 to the Gateway)
web-dev:
    pnpm --filter web dev

# Build web/dist, which the Gateway serves statically
web-build:
    pnpm -r build

# Run the Playwright browser tests (boots the fleet with Core and Gemma mocked)
web-e2e *args:
    pnpm -C web exec playwright test {{ args }}

# Open the last Playwright HTML report
web-e2e-report:
    pnpm -C web exec playwright show-report

# Record the deterministic English browser demo at 1920x1080
demo-video-web:
    ./.just/record-demo.sh web

# Render narration and captions onto the existing browser recording
demo-video-web-render:
    ./.just/record-demo.sh web-render

# Record and combine the English browser and Codex demos into one 1920x1080 submission video
demo-video:
    ./.just/record-demo.sh submission

# Combine existing narrated browser and Codex recordings
demo-video-combine:
    ./.just/record-demo.sh combine

# Capture Codex CLI against the local production-path fleet and render an English 1920x1080 video
demo-video-codex:
    ./.just/record-demo.sh codex

# Capture only the local Codex PTY session
demo-video-codex-capture:
    ./.just/record-demo.sh codex-capture

# Capture Codex against the deployed fleet (sends local CLI context and may incur GPU cost)
demo-video-codex-live-capture:
    ./.just/record-demo.sh codex-live-capture

# Render the existing Codex PTY capture without calling the deployed fleet
demo-video-codex-render:
    ./.just/record-demo.sh codex-render

# --- clients ----------------------------------------------------------------

# Send a request through the Python client example
ask text:
    uv run clients/python/pgw.py ask "{{ text }}"

# Fetch the stored masked OKF evidence document for a request
evidence request_id:
    uv run clients/python/pgw.py evidence {{ request_id }}

# Re-run the attester over a stored answer's masked artifacts and compare every hash
#
# Fetches /v1/requests/<id> plus the two masked sources it names, re-derives the
# leak-check verdict with the bundle attester, and reports whether the recorded
# `attestation` digests still match. This is the replay the OKF document promises:
# it trusts nothing the fleet asserts except the bytes it serves.
verify-answer request_id base="http://localhost:8081":
    uv run clients/python/pgw.py verify {{ request_id }} --base {{ base }}

# --- deploy -----------------------------------------------------------------
# Terraform-backed. See .just/deploy.just and docs/DEPLOY.md.

import '.just/tooling.just'
import '.just/deploy.just'
import '.just/logs.just'
