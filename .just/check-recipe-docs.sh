#!/usr/bin/env bash
# Fail when any just recipe lacks a doc comment (a `# ...` line directly above it).
#
# Why not parse `just --list` output: --list renders descriptions but gives no
# reliable way to tell "no doc comment" from a recipe whose doc is empty, and it
# hides recipes behind [group] attributes. Parsing the sources is exact.
#
# Excluded: private recipes (`_foo`) and any recipe carrying a [private]
# attribute, since neither appears in the public command surface.
set -euo pipefail

shopt -s nullglob
files=(justfile .just/*.just)
shopt -u nullglob

if [ ${#files[@]} -eq 0 ]; then
  echo "No justfiles found"
  exit 0
fi

status=0

for file in "${files[@]}"; do
  [ -f "$file" ] || continue

  # awk walks each line remembering whether the previous non-blank line was a
  # comment or an attribute, which is exactly the doc-comment rule just uses.
  awk -v file="$file" '
    # Track the most recent comment line.
    /^[[:space:]]*#/ { has_doc = 1; next }

    # Attributes sit between the doc comment and the recipe, so they must not
    # reset the flag. Remember [private] separately.
    /^[[:space:]]*\[/ {
      if ($0 ~ /private/) is_private = 1
      next
    }

    # A blank line breaks the association with any preceding comment.
    /^[[:space:]]*$/ { has_doc = 0; is_private = 0; next }

    # Recipe definitions start at column 0 and contain a colon. Exclude
    # assignments (:=), settings (set ...), imports and shebang bodies.
    /^[a-zA-Z_][a-zA-Z0-9_-]*[^:]*:/ {
      if ($0 ~ /:=/)          { has_doc = 0; is_private = 0; next }
      if ($0 ~ /^set[[:space:]]/) { has_doc = 0; is_private = 0; next }

      name = $0
      sub(/[[:space:]]*:.*$/, "", name)
      sub(/[[:space:]].*$/, "", name)

      # Skip private recipes.
      if (name ~ /^_/ || is_private) { has_doc = 0; is_private = 0; next }

      if (!has_doc) {
        printf "%s: recipe `%s` has no doc comment\n", file, name
        rc = 1
      }
      has_doc = 0; is_private = 0; next
    }

    # Any other line (recipe body, etc.) clears the flag.
    { has_doc = 0; is_private = 0 }

    END { exit rc }
  ' "$file" || status=1
done

if [ "$status" -ne 0 ]; then
  echo "" >&2
  echo "Every recipe needs a doc comment on the line directly above it." >&2
  exit 1
fi

echo "All recipes documented"
