#!/bin/sh
set -eu
# Documentation and relationship data remain at the repository root.
repo_root=$(CDPATH= cd "$(dirname "$0")/../.." && pwd)
cd "$repo_root"
echo "Inactive learning candidates (report only)"
found=0
for file in learning-inbox/*.txt; do
  [ -f "$file" ] || continue
  found=1
  printf '%s: ' "$file"
  awk -F ': ' '/^(promote_candidate|privacy_reviewed|validation_result):/ { printf "%s=%s ", $1, $2 } END { print "" }' "$file"
done
[ "$found" -eq 1 ] || echo "none"
