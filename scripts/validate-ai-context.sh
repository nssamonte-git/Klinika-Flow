#!/bin/sh
set -eu
# Documentation and relationship data remain at the repository root.
repo_root=$(CDPATH= cd "$(dirname "$0")/../.." && pwd)
cd "$repo_root"
for file in AGENTS.md HANDOFF.md CURRENT_TASK.md DECISIONS.md PROJECT_CONTEXT.md CONTEXT_MANIFEST.md LEARN_README.md LEARN_01_PROJECT_MAP.md LEARN_02_ARCHITECTURE.md LEARN_03_DEVELOPMENT_WORKFLOW.md LEARN_04_VALIDATION.md LEARNING_INBOX.md LEARNING_LOG_TEMPLATE.md PROJECT_RELATIONSHIP_MAP.md project-relationships.tsv; do
  [ -f "$file" ] || { echo "Missing $file" >&2; exit 1; }
done
find . -type d \( -name node_modules -o -name .next \) -prune -o -type f -name '*.md' -print | awk 'index(substr($0, 3), "/") > 0 { print "Project Markdown outside root: " $0 > "/dev/stderr"; bad=1 } END { exit bad }'
grep -F 'Read `HANDOFF.md` next' AGENTS.md >/dev/null || { echo "AGENTS startup pointer missing" >&2; exit 1; }
grep -F 'CONTEXT_MANIFEST.md' HANDOFF.md >/dev/null || { echo "Handoff routing pointer missing" >&2; exit 1; }
grep -F 'Project memory review' CONTEXT_MANIFEST.md >/dev/null || { echo "Memory route missing" >&2; exit 1; }
grep -F 'Project relationship map' CONTEXT_MANIFEST.md >/dev/null || { echo "Relationship route missing" >&2; exit 1; }
bytes=$(wc -c < AGENTS.md); bytes=$((bytes + $(wc -c < HANDOFF.md)))
upper_token_estimate=$(((bytes + 2) / 3))
[ "$upper_token_estimate" -le 1300 ] || { echo "Startup budget exceeded: upper estimate $upper_token_estimate > 1300 tokens" >&2; exit 1; }
sh project/scripts/validate-relationship-map.sh
echo "AI context valid: startup $bytes bytes, conservative estimate $upper_token_estimate/1300 tokens"
