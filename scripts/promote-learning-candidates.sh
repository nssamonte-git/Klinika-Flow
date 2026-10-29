#!/bin/sh
set -eu
# Documentation and relationship data remain at the repository root.
repo_root=$(CDPATH= cd "$(dirname "$0")/../.." && pwd)
cd "$repo_root"
echo "Promotion candidates requiring human review (report only)"
found=0
for file in learning-inbox/*.txt; do
  [ -f "$file" ] || continue
  grep -qx 'promote_candidate: yes' "$file" || continue
  grep -qx 'privacy_reviewed: yes' "$file" || continue
  if sh project/scripts/sanitize-learning-log.sh "$file" >/dev/null; then
    echo "$file"
    found=1
  fi
done
[ "$found" -eq 1 ] || echo "none"
