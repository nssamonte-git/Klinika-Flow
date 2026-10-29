#!/bin/sh
set -eu
# Documentation and relationship data remain at the repository root.
repo_root=$(CDPATH= cd "$(dirname "$0")/../.." && pwd)
cd "$repo_root"
[ "$#" -eq 1 ] || { echo "Usage: sh project/scripts/capture-learning.sh short-topic" >&2; exit 2; }
case "$1" in *[!a-z0-9-]*|'') echo "Use a lowercase hyphenated topic" >&2; exit 2 ;; esac
umask 077
mkdir -p learning-inbox
file="learning-inbox/$(date +%Y%m%d-%H%M%S)-$1.txt"
[ ! -e "$file" ] || { echo "Candidate already exists" >&2; exit 1; }
sed "s/date: YYYY-MM-DD/date: $(date +%F)/" LEARNING_LOG_TEMPLATE.md > "$file"
echo "$file"
