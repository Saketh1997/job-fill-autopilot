#!/usr/bin/env bash
# run_agy_fill.sh — everything in the application loop that does NOT need
# judgement, for a queue of postings, unattended.
#
#   ./run_agy_fill.sh [--limit N] [--days N] [--role ml] [--slug S]... [--dry-run]
#
# Per posting, serially:
#   1. get_jd.sh          zero-LLM JD fetch (usually already cached by the scan)
#   2. tailor_resume.sh   near-zero-LLM tailoring, gated by verify-cv-facts.mjs
#   3. agy_step.sh fill   agy (gemini-3.7-flash) fills the form. CANNOT submit.
#   4. readback.mjs       deterministic triage of the live form -> a short sheet
#
# It stops there, every time. Step 5 is Claude reading the sheets and writing
# each posting's corrections.json, and step 6 is agy_step.sh fix/submit. Neither
# belongs in an unattended batch: the whole point of the split is that the thing
# which decides an answer is right is not the thing that typed it.
#
# Output per posting, all small enough to read as a batch:
#   Job_applicator/answers/{slug}.readback.json   full sheet
#   output/agy-fill/{slug}.review.txt             triaged, for the planner
#   output/agy-fill/ledger.json                   what has been filled already
#
# A posting already in the ledger as filled is skipped, so a run that dies
# halfway restarts where it stopped instead of re-filling forms that are done.
#
# Stop cleanly: touch Job_applicator/STOP-ATS-BATCH
#
# Exit: 0 queue worked through · 1 setup failure · 130 stopped by file
#       200 another run holds the lock
set -uo pipefail
cd "$(dirname "$0")"
ROOT="$PWD"
JA="$ROOT/Job_applicator"
export PATH="/home/hunter/.local/bin:$HOME/.nvm/versions/node/v20.20.2/bin:/usr/local/bin:/usr/bin:/bin"
export CDP_ENDPOINT="${CDP_ENDPOINT:-http://localhost:9226}"

OUT="$ROOT/output/agy-fill"
LEDGER="$OUT/ledger.json"
STOP="$JA/STOP-ATS-BATCH"
mkdir -p "$OUT"
[ -s "$LEDGER" ] || echo '{}' > "$LEDGER"

LIMIT=0; DAYS=0; ROLE="ml"; DRY=0; SLUGS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --limit) LIMIT="${2:-0}"; shift 2 ;;
    --days)  DAYS="${2:-0}";  shift 2 ;;
    --role)  ROLE="${2:-ml}"; shift 2 ;;
    --slug)  SLUGS+=("${2:-}"); shift 2 ;;
    --dry-run) DRY=1; shift ;;
    *) echo "unknown flag: $1" >&2; exit 1 ;;
  esac
done

LOG="$ROOT/output/agy-fill.log"
exec > >(tee -a "$LOG") 2>&1
echo "=== run_agy_fill start $(date -Is) ==="

# ---------------------------------------------------------------- the queue
# Straight out of pipeline.csv: not applied, an ATS this loop can drive, and
# not already filled in the ledger. Nothing here writes to the CSV — applied is
# marked by ats_submit.mjs / mark_applied.py at the far end of the loop.
if [ "${#SLUGS[@]}" -eq 0 ]; then
  mapfile -t SLUGS < <(python3 - "$ROOT" "$DAYS" "$LIMIT" "$LEDGER" <<'PY'
import csv, json, os, sys, datetime
root, days, limit, ledger = sys.argv[1], int(sys.argv[2]), int(sys.argv[3]), sys.argv[4]
sys.path.insert(0, root)
from jd_extract import slugify
try:
    done = json.load(open(ledger))
except Exception:
    done = {}
ATS = ("greenhouse", "lever.co", "ashbyhq")
cutoff = None
if days:
    cutoff = (datetime.date.today() - datetime.timedelta(days=days)).isoformat()
out = []
for r in csv.DictReader(open(os.path.join(root, "data", "pipeline.csv"))):
    if (r.get("applied") or "").strip().upper() != "FALSE":
        continue
    url = r.get("url") or ""
    if not any(k in url for k in ATS):
        continue
    if cutoff and (r.get("date") or "") < cutoff:
        continue
    s = slugify(r.get("company"), r.get("title"))
    rec = done.get(s, {})
    if rec.get("filled"):
        continue
    # An ineligible posting (clearance/ITAR/enrollment the candidate cannot meet)
    # stays out of the queue for good. Without this the marker was documentation
    # only: the skip above tests "filled", so a posting marked ineligible but
    # never filled came back on every run.
    if rec.get("ineligible") or rec.get("do_not_refill") or rec.get("dead_posting"):
        continue
    out.append(s)
    if limit and len(out) >= limit:
        break
print("\n".join(out))
PY
)
fi

[ "${#SLUGS[@]}" -gt 0 ] || { echo "queue is empty — nothing to fill"; exit 0; }
echo "queue: ${#SLUGS[@]} posting(s)"
if [ "$DRY" = "1" ]; then printf '  %s\n' "${SLUGS[@]}"; exit 0; fi

note() { # slug key value  -> record it in the ledger, atomically
  python3 - "$LEDGER" "$1" "$2" "$3" <<'PY'
import json, os, sys, tempfile
path, slug, key, val = sys.argv[1:5]
try: d = json.load(open(path))
except Exception: d = {}
if val in ("true", "false"): val = val == "true"
d.setdefault(slug, {})[key] = val
fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path))
with os.fdopen(fd, "w") as fh: json.dump(d, fh, indent=2)
os.replace(tmp, path)
PY
}

(
  flock -n 203 || { echo "another run_agy_fill.sh holds the lock — exiting"; exit 200; }

  n=0; ok=0; failed=0
  for SLUG in "${SLUGS[@]}"; do
    [ -n "$SLUG" ] || continue
    if [ -f "$STOP" ]; then echo "STOP file present — ending cleanly after $n posting(s)"; exit 130; fi
    n=$((n + 1))
    echo ""
    echo "--- [$n/${#SLUGS[@]}] $SLUG ---"

    # 1. JD. experience_gate.py already cached most of these during the scan,
    #    so this is usually a no-op that costs one stat call.
    if [ ! -s "$JA/jd/$SLUG.txt" ]; then
      if ! "$JA/get_jd.sh" "$SLUG" >/dev/null 2>&1; then
        echo "  SKIP: no JD (dead posting, or JS-rendered and unextractable)"
        note "$SLUG" error "no JD"; failed=$((failed + 1)); continue
      fi
    fi
    echo "  jd: ok"

    # 2. Resume. A generic resume is allowed to FILL but drive_application.sh
    #    blocks its submit, so a tailoring failure degrades rather than stops.
    if [ ! -s "$JA/resumes/$SLUG.pdf" ]; then
      if "$JA/tailor_resume.sh" "$SLUG" "$ROLE" >/dev/null 2>&1; then
        echo "  resume: tailored"
      else
        echo "  resume: TAILORING FAILED — filling with the generic resume, submit will be blocked"
        note "$SLUG" resume "generic"
      fi
    else
      echo "  resume: already tailored"
    fi

    # 3. agy fills. --no-submit is inside agy_step.sh fill and is not overridable
    #    from here on purpose.
    if "$JA/agy_step.sh" fill "$SLUG" "$ROLE" >"$OUT/$SLUG.fill.log" 2>&1; then
      echo "  fill: agy finished"
    else
      echo "  fill: agy returned non-zero (see $OUT/$SLUG.fill.log) — reading the form back anyway"
    fi
    note "$SLUG" filled true
    note "$SLUG" filled_at "$(date -Is)"

    # 4. Read the form back. This runs even when the fill reported failure: a
    #    partly filled form is still reviewable, and the sheet is how anyone
    #    finds out what actually landed.
    if node "$JA/readback.mjs" "$SLUG" > "$OUT/$SLUG.review.txt" 2>"$OUT/$SLUG.readback.err"; then
      echo "  readback: $(grep -m1 '^triage:' "$OUT/$SLUG.review.txt" || echo 'written')"
      ok=$((ok + 1))
    else
      echo "  readback: FAILED — $(tail -1 "$OUT/$SLUG.readback.err" 2>/dev/null)"
      note "$SLUG" error "readback failed"; failed=$((failed + 1))
    fi
  done

  echo ""
  echo "filled and read back: $ok · failed: $failed · of $n attempted"
  echo "review sheets: $OUT/*.review.txt"
) 203>/tmp/.run_agy_fill.lock
rc=$?

echo "=== run_agy_fill done rc=$rc $(date -Is) ==="
exit "$rc"
