#!/bin/sh
set -eu
# Documentation and relationship data remain at the repository root.
repo_root=$(CDPATH= cd "$(dirname "$0")/../.." && pwd)
cd "$repo_root"
edge_file=project-relationships.tsv
map_file=PROJECT_RELATIONSHIP_MAP.md
while [ "$#" -gt 0 ]; do
  case "$1" in
    --edge-file|--map-file)
      [ "$#" -ge 2 ] || { echo "Missing value for $1" >&2; exit 2; }
      if [ "$1" = --edge-file ]; then edge_file=$2; else map_file=$2; fi
      shift 2 ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
done
[ -f "$edge_file" ] && [ -f "$map_file" ] || { echo "Relationship files missing" >&2; exit 1; }
header=$(head -n 1 "$edge_file")
[ "$header" = "$(printf 'source\trelation\ttarget\tnote')" ] || { echo "Invalid TSV header" >&2; exit 1; }
awk -F '\t' '
  NR == 1 { next }
  NF != 4 { print "Invalid column count at line " NR > "/dev/stderr"; fail=1 }
  $1 !~ /^(path|task):/ || $3 !~ /^(path|task):/ { print "Invalid endpoint at line " NR > "/dev/stderr"; fail=1 }
  $2 !~ /^(starts_with|documents|routes_to|loads|validates|produces|delegates_to|uses|informed_by)$/ { print "Invalid relation at line " NR > "/dev/stderr"; fail=1 }
  $0 ~ /(node_modules|\.next|\.sqlite|backend\/eval\/runs|backend\/eval\/audio\/.*\.wav)/ { print "Generated/private endpoint at line " NR > "/dev/stderr"; fail=1 }
  seen[$1 FS $2 FS $3]++ { print "Duplicate edge at line " NR > "/dev/stderr"; fail=1 }
  END { exit fail }
' "$edge_file"
tab=$(printf '\t')
while IFS="$tab" read -r source relation target note; do
  [ "$source" = source ] && continue
  for endpoint in "$source" "$target"; do
    case "$endpoint" in
      path:*) path=${endpoint#path:}; [ -e "$path" ] || { echo "Missing endpoint: $path" >&2; exit 1; } ;;
    esac
  done
done < "$edge_file"
for expected in 'path:AGENTS.md	starts_with	path:HANDOFF.md' 'path:CONTEXT_MANIFEST.md	routes_to	task:general-change' 'task:general-change	loads	path:PROJECT_CONTEXT.md' 'task:project-memory-review	loads	path:LEARNING_INBOX.md' 'task:project-relationship-map	loads	path:PROJECT_RELATIONSHIP_MAP.md'; do
  printf '%s\n' "$expected" | awk '{ gsub(/\\t/, "\t"); print }' | while IFS= read -r needle; do
    grep -F "$needle" "$edge_file" >/dev/null || { echo "Missing required edge: $needle" >&2; exit 1; }
  done
done
sh project/scripts/query-relationship-map.sh --edge-file "$edge_file" --from task:general-change --json | grep -F '"source":"task:general-change"' >/dev/null || { echo "Query smoke test failed" >&2; exit 1; }
echo "Relationship map valid"
