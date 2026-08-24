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
    pinact run --verify --check

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
check: fmt-check check-recipe-docs lint tf-validate typecheck pin-verify secrets-scan test

# Run the pre-commit hooks against all files
check-hooks:
    lefthook run pre-commit --all-files
