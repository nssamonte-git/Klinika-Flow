#!/bin/sh
# Canonical handoff entrypoint; preserve the project's existing local validator.
set -eu
# Documentation and relationship data remain at the repository root.
repo_root=$(CDPATH= cd "$(dirname "$0")/../.." && pwd)
cd "$repo_root"
sh project/scripts/validate-ai-context.sh
