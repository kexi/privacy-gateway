#!/usr/bin/env bash
# Run lint / format-check / type-check for the TypeScript workspace.
#
# The pnpm workspace is defined at the repository root (pnpm-workspace.yaml) and
# the lockfile lives there too.
#
# Why not `|| true` in the lefthook run line: that would swallow genuine lint
# failures as well. This script instead separates the two cases explicitly -
# skip when the workspace is not installed, propagate failure when it is.
set -euo pipefail

mode="$1"
shift || true

# Nothing to check if dependencies were never installed.
if [ ! -f pnpm-lock.yaml ] || [ ! -d node_modules ]; then
  echo "pnpm workspace is not set up; skipping (run 'pnpm install')"
  exit 0
fi

# oxlint / oxfmt are pnpm devDependencies (not Nix packages), so the workspace
# pins one version for everyone. Invoking the binaries directly avoids pnpm's
# pre-run dependency check, which aborts on unapproved build scripts.
oxlint_bin="node_modules/.bin/oxlint"
oxfmt_bin="node_modules/.bin/oxfmt"

case "$mode" in
  lint)
    if [ ! -x "$oxlint_bin" ]; then
      echo "oxlint is not installed; skipping"
      exit 0
    fi
    # With no paths, oxlint walks the repo using .oxlintrc.json at the root.
    "$oxlint_bin" "$@"
    ;;
  fmt-check)
    if [ ! -x "$oxfmt_bin" ]; then
      echo "oxfmt is not installed; skipping"
      exit 0
    fi
    "$oxfmt_bin" --check "$@"
    ;;
  fmt)
    if [ ! -x "$oxfmt_bin" ]; then
      echo "oxfmt is not installed; skipping"
      exit 0
    fi
    "$oxfmt_bin" "$@"
    ;;
  typecheck)
    # tsc runs per package, so delegate to each package's own script. Extra
    # arguments are treated as package names to narrow the run.
    if [ "$#" -gt 0 ]; then
      filters=()
      for pkg in "$@"; do
        filters+=(--filter "$pkg")
      done
      pnpm "${filters[@]}" typecheck
    else
      pnpm -r typecheck
    fi
    ;;
  *)
    echo "Unknown mode: $mode" >&2
    echo "Usage: $0 {lint|fmt|fmt-check|typecheck} [args...]" >&2
    exit 1
    ;;
esac
