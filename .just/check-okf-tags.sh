#!/usr/bin/env bash
# Verify every OKF `tags:` entry (knowledge/ frontmatter and the runtime
# document builder) appears in the controlled vocabulary knowledge/tags.yml.
set -euo pipefail
vocab=$(awk '/^tags:/{f=1;next} f && /^ +[a-z0-9_-]+:/{sub(/^ +/,"");sub(/:.*/,"");print}' knowledge/tags.yml)
fail=0
check() { # $1=tag $2=where
  if ! grep -qx "$1" <<<"$vocab"; then
    echo "unknown OKF tag '$1' in $2 (add it to knowledge/tags.yml with a description first)"
    fail=1
  fi
}
while IFS= read -r line; do
  file=${line%%:*}; tags=${line#*tags:}
  for t in $(tr -d '[]' <<<"$tags" | tr ',' ' '); do check "$t" "$file"; done
done < <(grep -rH '^tags:' knowledge --include='*.md' || true)
# Runtime builder: the literal tag array in okf.ts.
for t in $(grep -oE "tags: \[[^]]*\]" packages/common/src/okf.ts | tr -d "[]'" | sed 's/tags: //' | tr ',' ' '); do
  check "$t" "packages/common/src/okf.ts"
done
[ "$fail" -eq 0 ] && echo "OKF tags: all in vocabulary"
exit "$fail"
