# Recipes for the developer toolchain (Nix devShell / lefthook / gitleaks /
# pinact / actionlint). Imported from the root justfile via
# `import '.just/tooling.just'`.

# Install the Git hooks (lefthook). Also runs automatically on devShell entry
hooks:
    lefthook install

# Scan the entire Git history for secrets
secrets-scan:
    gitleaks detect --redact --config .gitleaks.toml

# Scan the working tree, including uncommitted changes, for secrets
secrets-scan-tree:
    gitleaks detect --no-git --redact --config .gitleaks.toml

# Pin every GitHub Actions `uses:` to a full commit SHA
pin:
    pinact run

# Verify pinned SHAs match their version comments (no rewriting)
pin-verify:
    # Why the token fallback: unauthenticated GitHub API calls are capped at
    # 60/h, which pinact exhausts on a workflow with this many pinned actions.
    GITHUB_TOKEN="${GITHUB_TOKEN:-$(gh auth token 2>/dev/null || true)}" pinact run --verify --check

# Statically check the GitHub Actions workflows
lint-actions:
    actionlint

# Format every justfile in place (root + .just modules)
fmt-just:
    just --fmt --unstable
    just --fmt --unstable --justfile .just/tooling.just
    just --fmt --unstable --justfile .just/logs.just
    just --fmt --unstable --justfile .just/deploy.just

# Detect formatting drift in every justfile
fmt-just-check:
    just --fmt --unstable --check
    just --fmt --unstable --check --justfile .just/tooling.just
    just --fmt --unstable --check --justfile .just/logs.just
    just --fmt --unstable --check --justfile .just/deploy.just

# Fail when a recipe is missing its doc comment
check-recipe-docs:
    ./.just/check-recipe-docs.sh

# Format flake.nix
fmt-nix:
    nixfmt flake.nix

# Detect formatting drift in flake.nix
fmt-nix-check:
    nixfmt --check flake.nix

# Check that standalone scripts carry PEP 723 inline metadata
lint-pep723:
    #!/usr/bin/env bash
    set -euo pipefail
    files=$(find clients knowledge/references -name '*.py' 2>/dev/null || true)
    if [ -z "$files" ]; then
      echo "No standalone scripts to check"
      exit 0
    fi
    # shellcheck disable=SC2086
    ./.just/check-pep723.sh $files

# Lint the standalone Python scripts with ruff
lint-python:
    #!/usr/bin/env bash
    set -euo pipefail
    # Python survives only as standalone clients; uvx keeps ruff out of the
    # workspace so no Python project metadata is required.
    if [ ! -d clients ]; then
      echo "No clients/ directory; skipping"
      exit 0
    fi
    uvx ruff check clients/

# Format the standalone Python scripts with ruff
fmt-python:
    uvx ruff format clients/

# Detect formatting drift in the standalone Python scripts
fmt-python-check:
    #!/usr/bin/env bash
    set -euo pipefail
    if [ ! -d clients ]; then
      echo "No clients/ directory; skipping"
      exit 0
    fi
    uvx ruff format --check clients/

# Run the vitest suites across the workspace (root projects config)
test *args:
    pnpm exec vitest run {{ args }}

# Run the vitest suites with coverage, enforcing the per-package thresholds
test-coverage *args:
    pnpm exec vitest run --coverage {{ args }}

# Drive the real Codex CLI against the deployed fleet in a PTY (heavy; final pre-submission check only)
#
# Not part of routine verification — use `just codex-smoke` for that. This drives
# the unmodified CLI, which prepends ~147 KB of instructions to every turn. On the
# single-GPU deployment masking that much input can exceed the 150 s request
# deadline on a cold fleet: a known capacity limit, documented in
# `tests/codex/README.md`, not a regression in the fleet's logic.
codex-e2e *scenarios:
    #!/usr/bin/env bash
    set -euo pipefail
    # Why a nonce: pgw-masking asserts a per-run token round-trips, so a cached
    # or hallucinated answer cannot pass. pitty resolves ${PGW_NONCE} through its
    # parent-environment fallback, so exporting it here is enough.
    #
    # Why letters rather than the obvious timestamp-and-$RANDOM: a long run of
    # digits is what a card number looks like, so the numeric form was detected
    # as CREDIT_CARD, masked, and — since CREDIT_CARD is a withheld category —
    # never rehydrated, failing the assertion on a fleet that was working
    # correctly. A nonce must not be indistinguishable from the PII being masked.
    export PGW_NONCE="PGW$(LC_ALL=C tr -dc 'A-Z' </dev/urandom | head -c 10)"
    # Why the exact tag: pitty's scenario format is SemVer-stable but the tool is
    # explicitly not production ready, so its README asks dependents to pin.
    # First run builds pitty from source (a few minutes); later runs hit the
    # Nix store and start instantly.
    #
    # The two CLI scenarios are named rather than passing the directory: it also
    # holds `pgw-responses.yaml`, which is `codex-smoke`'s and does not need the
    # CLI at all. `pitty run` takes one path per invocation, so they are looped
    # rather than passed together.
    targets=({{ if scenarios == '' { 'tests/codex/pgw-smoke.yaml tests/codex/pgw-masking.yaml' } else { scenarios } }})
    # Each scenario is rendered with the nonce substituted before pitty sees it:
    # pitty does not expand variables inside an `expect`, so only a rendered file
    # can carry the literal nonce on the assertion side. See render-scenario.sh.
    render_dir=$(mktemp -d)
    trap 'rm -rf "$render_dir"' EXIT
    for scenario in "${targets[@]}"; do
      echo "==> ${scenario}"
      rendered=$(./.just/render-scenario.sh "$scenario" "$render_dir")
      nix run github:kexi/pitty/v1.2.2 -- run "$rendered"
    done

# Lint the TypeScript workspace with oxlint
lint-ts *args:
    ./.just/web-check.sh lint {{ args }}

# Detect TypeScript formatting drift with oxfmt
fmt-ts-check *args:
    ./.just/web-check.sh fmt-check {{ args }}

# Format the TypeScript workspace with oxfmt
fmt-ts *args:
    ./.just/web-check.sh fmt {{ args }}

# Type-check the TypeScript workspace (tsc --noEmit, per package)
typecheck *packages:
    ./.just/web-check.sh typecheck {{ packages }}

# --- combined entry points --------------------------------------------------
# The narrow `*-ts` / `*-just` / `*-nix` / `*-python` recipes above stay
# available for targeted runs; these three are the surface docs and CI use.

# Lint everything: TypeScript, standalone Python, Terraform, GitHub Actions
lint: lint-ts lint-python lint-pep723 tf-lint lint-actions

# Format everything in place: TypeScript, justfiles, flake.nix, Python, Terraform
fmt: fmt-ts fmt-just fmt-nix fmt-python tf-fmt

# Detect formatting drift everywhere (oxfmt + justfiles + flake.nix + Python + Terraform)
fmt-check: fmt-ts-check fmt-just-check fmt-nix-check fmt-python-check tf-fmt-check

# Run the full local check suite (equivalent to CI)
check: fmt-check check-recipe-docs lint lint-okf-tags tf-validate typecheck pin-verify secrets-scan test

# Run the pre-commit hooks against all files
check-hooks:
    lefthook run pre-commit --all-files

# Verify OKF tags against the controlled vocabulary in knowledge/tags.yml
lint-okf-tags:
    ./.just/check-okf-tags.sh

# Sync the judging Basic-auth secret from 1Password into the macOS keychain
sync-judge-secret:
    #!/usr/bin/env bash
    set -euo pipefail
    # 1Password is the durable home; the keychain is what operator commands
    # read (gcloud env injection, curl checks), so the secret never lands in a
    # file or in this repository. Requires `op signin` first.
    pw="$(op item get 'Privacy Gateway Judge Access' --fields password --reveal)"
    security add-generic-password -a judge -s privacy-gateway-basic-auth -w "$pw" -U
    echo "==> keychain updated (service=privacy-gateway-basic-auth, account=judge)"
