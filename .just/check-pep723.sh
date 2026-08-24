#!/usr/bin/env bash
# Verify that standalone Python scripts carry PEP 723 inline metadata.
#
# Why not a strict ast/tomllib parse: the PEP 723 block lives inside comments,
# and all a pre-commit hook needs is to catch a missing header. grep is both
# faster and sufficient for that.
set -euo pipefail

status=0

for file in "$@"; do
  [ -f "$file" ] || continue

  # Files that are part of a package (a sibling __init__.py exists) are not
  # standalone scripts, so they are out of scope.
  if [ -f "$(dirname "$file")/__init__.py" ]; then
    continue
  fi

  if ! grep -qE '^# /// script[[:space:]]*$' "$file"; then
    echo "Missing PEP 723 header: $file" >&2
    echo "  Add the following block at the top of the file:" >&2
    echo "    # /// script" >&2
    echo "    # requires-python = \">=3.13\"" >&2
    echo "    # dependencies = []" >&2
    echo "    # ///" >&2
    status=1
  fi
done

exit "$status"
