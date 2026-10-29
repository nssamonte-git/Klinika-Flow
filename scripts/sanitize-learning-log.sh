#!/bin/sh
set -eu
# Documentation and relationship data remain at the repository root.
repo_root=$(CDPATH= cd "$(dirname "$0")/../.." && pwd)
cd "$repo_root"
[ "$#" -eq 1 ] && [ -f "$1" ] || { echo "Usage: sh project/scripts/sanitize-learning-log.sh learning-inbox/file.txt" >&2; exit 2; }
case "$1" in learning-inbox/*.txt) ;; *) echo "Only local learning-inbox .txt candidates are accepted" >&2; exit 2 ;; esac
if grep -Ein '([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}|/Users/|/home/|https?://|(api[_-]?key|secret|token|password)[[:space:]]*[:=][[:space:]]*[^[:space:]]+|BEGIN [A-Z ]*PRIVATE KEY)' "$1"; then
  echo "Potential private content found; edit and rerun. This is a heuristic, not a privacy approval." >&2
  exit 1
fi
echo "No heuristic private-content match. Human privacy review is still required."
