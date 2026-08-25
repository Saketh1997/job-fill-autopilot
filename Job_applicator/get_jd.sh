#!/bin/bash
set -uo pipefail

# get_jd.sh — STAGE 1 of 3. Slug in, jd/{slug}.txt out.
#
#   get_jd.sh <slug> [--force]
#
# n8n pipeline:
#   1. get_jd.sh          <slug>          -> jd/{slug}.txt
#   2. tailor_resume.sh   <slug> [role]   -> resumes/{slug}.pdf
#   3. drive_application.sh <slug> [role] -> fills and submits
#
# Each stage takes the SAME slug and no other identifier. Stage 3 refuses to run
# if stage 1 or 2 did not produce its file, so a broken stage stops the chain
# instead of silently applying with a missing or generic artefact.
#
# The real work is jd_extract.py, which is the canonical extractor: it hits the
# Greenhouse / Lever / Ashby / Workday / amazon.jobs / Workable / LinkedIn JSON
# APIs where they exist and falls back to an HTML strip, then caches the result.
# This wrapper exists only to turn a slug into the URL that extractor needs.
#
# Exit: 0 JD present   1 lookup or extraction failed   2 bad usage

SLUG=""; FORCE=""
for a in "$@"; do
  case "$a" in
    --force) FORCE="--force" ;;
    -*) echo "unknown flag: $a" >&2; exit 2 ;;
    *) [ -z "$SLUG" ] && SLUG="$a" ;;
  esac
done

ROOT="/home/hunter/projects/career-ops"
JOBAPP="$ROOT/Job_applicator"
cd "$JOBAPP"
export PATH="/home/hunter/.local/bin:/home/hunter/.nvm/versions/node/v20.20.2/bin:$PATH"

die() { echo "JD_ERR: $*" >&2; exit "${2:-1}"; }
[ -n "$SLUG" ] || die "usage: get_jd.sh <slug> [--force]" 2
[ "$SLUG" = "$(basename "$SLUG")" ] || die "bad slug: $SLUG" 2

JD="$JOBAPP/jd/$SLUG.txt"

if [ -s "$JD" ] && [ -z "$FORCE" ]; then
  echo "JD_OK: $JD (cached, $(wc -c <"$JD") bytes)"
  exit 0
fi

URL=$(python3 resolve_slug.py "$SLUG") || die "slug not found in data/pipeline.csv"

# jd_extract caches under jd/{slug}.txt itself; --force re-fetches.
(cd "$ROOT" && python3 jd_extract.py "$URL" "$SLUG" $FORCE) >/dev/null 2>&1

[ -s "$JD" ] || die "jd_extract produced nothing for $URL (JS-rendered page or dead posting?)"

# A JD under a few hundred bytes is a cookie wall or an error page, not a posting.
BYTES=$(wc -c <"$JD")
if [ "$BYTES" -lt 400 ]; then
  echo "JD_WARN: only $BYTES bytes — likely a consent wall, not the posting. Check $JD" >&2
  exit 1
fi

echo "JD_OK: $JD ($BYTES bytes)"
