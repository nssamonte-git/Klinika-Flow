#!/bin/sh
set -eu
# Documentation and relationship data remain at the repository root.
repo_root=$(CDPATH= cd "$(dirname "$0")/../.." && pwd)
cd "$repo_root"
edge_file=project-relationships.tsv
from=
to=
relation=
pattern=
json=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --edge-file|--from|--to|--relation|--text)
      [ "$#" -ge 2 ] || { echo "Missing value for $1" >&2; exit 2; }
      case "$1" in
        --edge-file) edge_file=$2 ;;
        --from) from=$2 ;;
        --to) to=$2 ;;
        --relation) relation=$2 ;;
        --text) pattern=$2 ;;
      esac
      shift 2 ;;
    --json) json=1; shift ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
done
[ -f "$edge_file" ] || { echo "Missing edge file: $edge_file" >&2; exit 1; }
awk -F '\t' -v from="$from" -v to="$to" -v relation="$relation" -v pattern="$pattern" -v json="$json" '
  function esc(s) { gsub(/\\/, "\\\\", s); gsub(/"/, "\\\"", s); gsub(/\r/, "\\r", s); gsub(/\n/, "\\n", s); return s }
  BEGIN { if (json) print "[" }
  NR == 1 { if (!json) print; next }
  (from == "" || $1 == from) && (to == "" || $3 == to) &&
  (relation == "" || $2 == relation) &&
  (pattern == "" || index(tolower($0), tolower(pattern)) > 0) {
    if (json) {
      if (count++) print ","
      printf "  {\"source\":\"%s\",\"relation\":\"%s\",\"target\":\"%s\",\"note\":\"%s\"}", esc($1), esc($2), esc($3), esc($4)
    } else print
  }
  END { if (json) { if (count) print ""; print "]" } }
' "$edge_file"
