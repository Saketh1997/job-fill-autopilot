#!/bin/bash
set -uo pipefail

# close_tabs.sh — close the tabs a run left behind, over CDP.
#
#   close_tabs.sh <url-or-host> [--dry-run] [--verbose]
#
# The shared job browser is persistent (job-browser.service), so every run that
# ends without cleanup leaks a tab. After a few days that is dozens of live
# Workday sessions eating memory and, worse, a later run can attach to a stale
# tab of the same tenant and think it is already signed in.
#
# Matching is by HOST, taken from the argument (a full posting URL is fine — the
# host is extracted from it). Only `page` targets are touched; devtools, service
# workers and extension targets are left alone.
#
# Chrome exits when its last tab closes, which would take the whole persistent
# browser down. So if the closures would leave zero pages, a blank tab is opened
# first.
#
# Env: CDP_ENDPOINT   default http://localhost:9226
#
# Exit: 0 always — cleanup never fails a run that already succeeded.

ARG=""; DRY=0; VERBOSE=0
for a in "$@"; do
  case "$a" in
    --dry-run) DRY=1 ;;
    --verbose) VERBOSE=1 ;;
    -*) echo "close_tabs: unknown flag: $a" >&2; exit 0 ;;
    *) [ -z "$ARG" ] && ARG="$a" ;;
  esac
done

CDP="${CDP_ENDPOINT:-http://localhost:9226}"
[ -n "$ARG" ] || { echo "close_tabs: usage: close_tabs.sh <url-or-host> [--dry-run]" >&2; exit 0; }

# host out of a URL, or the argument itself when it is already a bare host
HOST=$(printf '%s' "$ARG" | sed -E 's#^[a-zA-Z]+://##; s#[/?].*$##; s#^[^@]*@##; s#:[0-9]+$##')
[ -n "$HOST" ] || { echo "close_tabs: could not parse a host from '$ARG'" >&2; exit 0; }

LIST=$(curl -s -m 10 "$CDP/json/list" 2>/dev/null) || LIST=""
if [ -z "$LIST" ]; then
  echo "close_tabs: no CDP at $CDP, nothing to clean" >&2
  exit 0
fi

# stdout: one "id<TAB>url" line per page target on HOST; stderr: total page count
read -r -d '' PARSE <<'PY' || true
import json, sys
host = sys.argv[1]
try:
    targets = json.loads(sys.stdin.read())
except Exception:
    sys.exit(0)
pages = [t for t in targets if t.get("type") == "page"]
hits = [t for t in pages if host in (t.get("url") or "")]
print(len(pages), len(hits), file=sys.stderr)
for t in hits:
    print(f"{t['id']}\t{(t.get('url') or '')[:120]}")
PY

COUNTS=$(printf '%s' "$LIST" | python3 -c "$PARSE" "$HOST" 2>&1 >/dev/null)
HITS=$(printf '%s' "$LIST" | python3 -c "$PARSE" "$HOST" 2>/dev/null)
TOTAL_PAGES=$(printf '%s' "$COUNTS" | awk '{print $1}')
HIT_COUNT=$(printf '%s' "$COUNTS" | awk '{print $2}')
: "${TOTAL_PAGES:=0}" "${HIT_COUNT:=0}"

if [ "$HIT_COUNT" -eq 0 ]; then
  [ "$VERBOSE" -eq 1 ] && echo "close_tabs: no tabs on $HOST" >&2
  exit 0
fi

if [ "$DRY" -eq 1 ]; then
  echo "close_tabs: would close $HIT_COUNT tab(s) on $HOST:" >&2
  printf '%s\n' "$HITS" | while IFS=$'\t' read -r id url; do echo "  $id  $url" >&2; done
  exit 0
fi

# Keep the browser alive: a blank tab before the last page target goes away.
if [ "$HIT_COUNT" -ge "$TOTAL_PAGES" ]; then
  curl -s -m 10 -X PUT "$CDP/json/new?about:blank" >/dev/null 2>&1 \
    || curl -s -m 10 "$CDP/json/new?about:blank" >/dev/null 2>&1
fi

CLOSED=0
while IFS=$'\t' read -r id url; do
  [ -n "$id" ] || continue
  if curl -s -m 10 "$CDP/json/close/$id" >/dev/null 2>&1; then
    CLOSED=$((CLOSED + 1))
    [ "$VERBOSE" -eq 1 ] && echo "close_tabs: closed $url" >&2
  fi
done <<< "$HITS"

echo "close_tabs: closed $CLOSED/$HIT_COUNT tab(s) on $HOST" >&2
exit 0
