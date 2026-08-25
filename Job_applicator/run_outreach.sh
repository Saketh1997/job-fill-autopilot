#!/bin/bash
set -uo pipefail

# run_outreach.sh -- stage 4 of the canonical run order, batched. For every
# posting that actually SUBMITTED, draft a LinkedIn connection note.
#
#   ./run_outreach.sh [--days N] [--only <slug>] [--force]
#
# Nothing here sends anything. linkedin-draft.sh has no send-capable tool in
# its allowlist and every entry lands as pending_approval; linkedin_send.py
# independently refuses any slug whose queue status is not "approved". The
# standing submit authorization (2026-08-08) covers employer application forms
# ONLY, not LinkedIn messages, so the approval step is deliberate and stays.
#
# Approve with:  ./linkedin-approve.sh <slug> approve
# Then send with: ./linkedin-send.sh <slug>

cd /home/hunter/projects/career-ops/Job_applicator
export PATH="/home/hunter/.local/bin:/home/hunter/.nvm/versions/node/v20.20.2/bin:$PATH"

DAYS=1
ONLY=""
FORCE=0
while [ $# -gt 0 ]; do
  case "$1" in
    --days)  DAYS="$2"; shift 2 ;;
    --only)  ONLY="$2"; shift 2 ;;
    --force) FORCE=1; shift ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

# Resolve the (slug, company, role, url) tuples worth drafting for. A posting
# qualifies when its own status file says it submitted -- the ledger is a run
# log and can be stale, but answers/{slug}.drive.json is the posting's record.
mapfile -t ROWS < <(FORCE="$FORCE" ONLY="$ONLY" DAYS="$DAYS" python3 - <<'PY'
import csv, json, os, glob, sys
from datetime import date, timedelta

BASE = os.path.dirname(os.path.abspath("."))
force = os.environ.get("FORCE") == "1"
only = os.environ.get("ONLY") or ""
days = int(os.environ.get("DAYS") or 1)
cutoff = (date.today() - timedelta(days=days)).isoformat()

meta = {}
with open("../data/pipeline.csv", newline="") as fh:
    for r in csv.DictReader(fh):
        # pipeline.csv has no slug column, so key by URL. Index the full URL and
        # the query-stripped form: a Greenhouse row is stored as its original
        # embed/job_app?token=... URL while the driver records the resolved
        # job-boards one, and only source_url still matches the original.
        u = r.get("url") or ""
        meta[u] = r
        meta[u.split("?")[0]] = r

try:
    queued = {e.get("slug") for e in json.load(open("../data/linkedin-outreach-queue.json"))}
except Exception:
    queued = set()

for path in sorted(glob.glob("answers/*.drive.json")):
    slug = os.path.basename(path)[: -len(".drive.json")]
    if only and slug != only:
        continue
    try:
        st = json.load(open(path))
    except Exception:
        continue
    if not st.get("submitted"):
        continue
    if slug in queued and not force:
        continue
    url = (st.get("url") or "").split("?")[0]
    row = {}
    for cand in (st.get("url"), url, st.get("source_url"),
                 (st.get("source_url") or "").split("?")[0]):
        if cand and cand in meta:
            row = meta[cand]
            break
    if not only and row and (row.get("date") or "9999") < cutoff:
        continue
    # Fall back to the slug when the posting has aged out of pipeline.csv.
    # jd_extract.slugify builds it as job-{Company}-{Title} with underscores
    # for spaces, so this recovers both well enough for a contact search.
    guess_company, guess_title = "", ""
    if slug.startswith("job-"):
        parts = slug[len("job-"):].split("-", 1)
        guess_company = parts[0].replace("_", " ").strip()
        if len(parts) > 1:
            guess_title = parts[1].replace("_", " ").strip()

    company = row.get("company") or guess_company or st.get("tenant") or ""
    title = row.get("title") or guess_title or ""
    if not (company and title and url):
        print(f"# skipping {slug}: incomplete metadata", file=sys.stderr)
        continue
    print("\t".join([slug, company, title, url]))
PY
)

if [ "${#ROWS[@]}" -eq 0 ]; then
  echo "no submitted postings need outreach drafts"
  exit 0
fi

echo "drafting LinkedIn outreach for ${#ROWS[@]} submitted posting(s)"
DRAFTED=0
FAILED=0
for row in "${ROWS[@]}"; do
  IFS=$'\t' read -r slug company role url <<< "$row"
  echo "--- $company - $role"
  if ./linkedin-draft.sh "$slug" "$company" "$role" "$url" >/dev/null 2>&1; then
    DRAFTED=$((DRAFTED + 1))
    # Print what the record ACTUALLY says. A draft that found no OSU alumnus
    # lands at needs_review with an empty message, and reporting every draft as
    # "pending_approval" hid that: the batch line looked identical whether the
    # posting had a sendable message or nothing at all.
    echo "    drafted -> $(python3 linkedin_queue.py get "$slug" \
      | python3 -c 'import json,sys; r=json.load(sys.stdin); print(r.get("status","?"), "|", r.get("channel","?"), "|", r.get("contact_name") or "no contact")' 2>/dev/null || echo '?')"
  else
    FAILED=$((FAILED + 1))
    echo "    draft FAILED (see answers/${slug}-linkedin.json)"
  fi
done

echo
echo "done -- $DRAFTED drafted, $FAILED failed."
echo "Nothing was sent. Review the queue, then per slug:"
echo "  ./linkedin-approve.sh <slug> approve && ./linkedin-send.sh <slug>"
