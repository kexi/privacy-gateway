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
ask text session="":
    #!/usr/bin/env bash
    set -euo pipefail
    if [ -n "{{ session }}" ]; then
      uv run clients/python/pgw.py ask "{{ text }}" --session "{{ session }}"
    else
      uv run clients/python/pgw.py ask "{{ text }}"
    fi

# Fetch the stored OKF answer document for a session
answer session:
    uv run clients/python/pgw.py answer {{ session }}

# Add a human approval to a session's answer, raising it to human-reviewed
approve session by="human:kei":
    uv run clients/python/pgw.py approve {{ session }} --by {{ by }}

# --- deploy -----------------------------------------------------------------
# Terraform-backed. See .just/deploy.just and docs/DEPLOY.md.

import '.just/tooling.just'
import '.just/deploy.just'
import '.just/logs.just'
