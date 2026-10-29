#!/bin/sh
set -eu
# Documentation and relationship data remain at the repository root.
repo_root=$(CDPATH= cd "$(dirname "$0")/../.." && pwd)
cd "$repo_root"
echo "AI context"
sh project/scripts/validate-ai-context.sh
echo "Inactive memory"
sh project/scripts/summarize-learning.sh
echo "Application typecheck, tests, offline evaluation, and build"
npm --prefix project run typecheck
npm --prefix project test
npm --prefix project run eval
npm --prefix project run build
echo "Engineering health: local checks passed; paid calls and human review are separate."
