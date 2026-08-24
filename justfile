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
pull-gemma model="gemma3:12b":
    ollama pull {{ model }}

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
