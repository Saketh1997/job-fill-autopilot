#!/bin/bash
set -uo pipefail

# close_tabs.sh — close the tabs a run left behind, over CDP.
#
#   close_tabs.sh <url-or-host> [--dry-run] [--verbose] [--host-wide]
#
# The shared job browser is persistent (job-browser.service), so every run that
# ends without cleanup leaks a tab. After a few days that is dozens of live
# Workday sessions eating memory and, worse, a later run can attach to a stale
# tab of the same tenant and think it is already signed in.
#
# Matching is by POSTING, via samePosting() from posting-identity.mjs (changed
# 2026-08-29). It used to reduce the argument to its host and close every page
# target on it. Nearly every posting in the queue lives on
# job-boards.greenhouse.io, and the embed form's URL is identical for every
# posting except the `token` query param, so the first posting to finish without
# a blocked_on closed every OTHER posting's parked form. One run logged
# "closed 8/8 tab(s) on boards.greenhouse.io" and destroyed six filled forms
# waiting to be reviewed. Tab cleanup was host-scoped while form parking is
# posting-scoped, and the batch quietly ate its own work.
#
# posting-identity.mjs was written for exactly this failure and prime_page.mjs,
# readback.mjs and ats_submit.mjs already share it; this script was the last
# holdout still comparing hosts. Callers that disagree about which tab belongs
# to which posting are what produced the bug, so identity is computed in one
# place for all four.
#
# An unidentifiable URL matches nothing (samePosting is false for an empty key),
# which leaks a tab rather than closing someone else's. The two errors are not
# symmetric: a leaked tab costs memory, an over-match destroys a filled
# application.
#
# --host-wide restores the old behaviour for a deliberate sweep of stale tabs on
# one host. Nothing in the pipeline passes it; it is for a human cleaning up.
#
# Only `page` targets are touched; devtools, service workers and extension
# targets are left alone.
#
# Chrome exits when its last tab closes, which would take the whole persistent
# browser down. So if the closures would leave zero pages, a blank tab is opened
# first.
#
# Env: CDP_ENDPOINT   default http://localhost:9226
#
# Exit: 0 always — cleanup never fails a run that already succeeded.

BASE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

ARG=""; DRY=0; VERBOSE=0; HOSTWIDE=0
for a in "$@"; do
  case "$a" in
    --dry-run) DRY=1 ;;
    --verbose) VERBOSE=1 ;;
    --host-wide) HOSTWIDE=1 ;;
    -*) echo "close_tabs: unknown flag: $a" >&2; exit 0 ;;
    *) [ -z "$ARG" ] && ARG="$a" ;;
  esac
done

CDP="${CDP_ENDPOINT:-http://localhost:9226}"
[ -n "$ARG" ] || { echo "close_tabs: usage: close_tabs.sh <url-or-host> [--dry-run] [--host-wide]" >&2; exit 0; }

# host out of a URL, or the argument itself when it is already a bare host
HOST=$(printf '%s' "$ARG" | sed -E 's#^[a-zA-Z]+://##; s#[/?].*$##; s#^[^@]*@##; s#:[0-9]+$##')
[ -n "$HOST" ] || { echo "close_tabs: could not parse a host from '$ARG'" >&2; exit 0; }

LIST=$(curl -s -m 10 "$CDP/json/list" 2>/dev/null) || LIST=""
if [ -z "$LIST" ]; then
  echo "close_tabs: no CDP at $CDP, nothing to clean" >&2
  exit 0
fi

# stdout: one "id<TAB>url" line per matching page target
# stderr: "<total pages> <hits> <scope>"
read -r -d '' SELECT <<'JS' || true
import { readFileSync } from 'node:fs';
const [, base, arg, hostWide] = process.argv;
const { samePosting, postingKey, hostOf } =
  await import(new URL('posting-identity.mjs', `file://${base}/`).href);

let targets = [];
try { targets = JSON.parse(readFileSync(0, 'utf8')); } catch { process.exit(0); }

const bare = String(arg).replace(/^[a-zA-Z]+:\/\//, '').replace(/[/?].*$/, '');
const host = hostOf(arg) || bare;
const pages = targets.filter((t) => t && t.type === 'page');
const onHost = pages.filter((t) => (t.url || '').includes(host));

let hits, scope;
if (hostWide === '1') {
  hits = onHost;
  scope = 'host-wide';
} else {
  hits = onHost.filter((t) => samePosting(arg, t.url || ''));
  scope = postingKey(arg) || 'unidentifiable-url';
}

console.error(`${pages.length} ${hits.length} ${scope}`);
for (const t of hits) console.log(`${t.id}\t${(t.url || '').slice(0, 120)}`);
JS

run_select() { printf '%s' "$LIST" | node --input-type=module -e "$SELECT" "$BASE" "$ARG" "$HOSTWIDE"; }
COUNTS=$(run_select 2>&1 >/dev/null)
HITS=$(run_select 2>/dev/null)
TOTAL_PAGES=$(printf '%s' "$COUNTS" | awk '{print $1}')
HIT_COUNT=$(printf '%s' "$COUNTS" | awk '{print $2}')
SCOPE=$(printf '%s' "$COUNTS" | cut -d' ' -f3-)
: "${TOTAL_PAGES:=0}" "${HIT_COUNT:=0}" "${SCOPE:=?}"

# A non-numeric count means node failed (missing module, bad JSON). Closing
# nothing is the safe outcome.
case "$HIT_COUNT" in
  ''|*[!0-9]*) echo "close_tabs: could not identify tabs, closing nothing — $COUNTS" >&2; exit 0 ;;
esac

if [ "$HIT_COUNT" -eq 0 ]; then
  [ "$VERBOSE" -eq 1 ] && echo "close_tabs: no tab for $SCOPE on $HOST" >&2
  exit 0
fi

if [ "$DRY" -eq 1 ]; then
  echo "close_tabs: would close $HIT_COUNT tab(s) on $HOST [$SCOPE]:" >&2
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

echo "close_tabs: closed $CLOSED/$HIT_COUNT tab(s) on $HOST [$SCOPE]" >&2
exit 0
