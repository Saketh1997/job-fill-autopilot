#!/bin/bash
set -uo pipefail

# batch_resumes.sh -- tailor a resume for every PENDING posting, so the ones the
# drivers cannot fill can still be applied to by hand with a real resume rather
# than the generic one.
#
#   ./batch_resumes.sh [--days N] [--limit N] [--only <slug>] [--force] [--dry-run]
#
# It is stages 1 and 2 of the three-stage chain, batched, and deliberately NOT
# stage 3: nothing here opens the shared browser, touches an employer's form or
# submits anything. jd_extract.py fetches over urllib and generate-pdf.mjs
# launches its own headless chromium, so this can run alongside a fill batch or
# a LinkedIn send without fighting over CDP 9226.
#
#   get_jd.sh <slug>        -> jd/{slug}.txt      (cached; skipped when present)
#   tailor_resume.sh <slug> -> resumes/{slug}.pdf (~$0.02, one patch-only call)
#
# A posting that already has resumes/{slug}.pdf is skipped unless --force: the
# whole point is to fill in what is missing, and re-tailoring costs a model call
# for a file that already exists.
#
# Failures never stop the batch -- a dead posting, a 401 board or a JD that will
# not extract is recorded and the run moves on. Everything lands in
# logs/resume-batch-ledger.json so a second pass can pick up only what failed.

cd /home/hunter/projects/career-ops/Job_applicator
export PATH="/home/hunter/.local/bin:/home/hunter/.nvm/versions/node/v20.20.2/bin:$PATH"

DAYS=1
LIMIT=0
ONLY=""
FORCE=0
DRY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --days)    DAYS="$2"; shift 2 ;;
    --limit)   LIMIT="$2"; shift 2 ;;
    --only)    ONLY="$2"; shift 2 ;;
    --force)   FORCE=1; shift ;;
    --dry-run) DRY=1; shift ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

mkdir -p logs jd resumes
LOG=logs/resume-batch.log
LEDGER=logs/resume-batch-ledger.json
log() { echo "[$(date +%H:%M:%S)] $*" | tee -a "$LOG"; }

# Resolve (slug, title, url, role) for every pending row. The role hint is the
# third argument tailor_resume.sh takes -- it picks which suitability_*.txt and
# which content-bank emphasis the local selector uses, so a data-science posting
# does not get the robotics framing.
mapfile -t ROWS < <(DAYS="$DAYS" ONLY="$ONLY" FORCE="$FORCE" python3 - <<'PY'
import csv, os, sys, datetime
sys.path.insert(0, "..")
from jd_extract import slugify

days = int(os.environ.get("DAYS") or 1)
only = os.environ.get("ONLY") or ""
force = os.environ.get("FORCE") == "1"
cutoff = (datetime.date.today() - datetime.timedelta(days=days)).isoformat()

ML = ("machine learning", "ml engineer", " ai ", "ai engineer", "applied scientist",
      "data scien", "deep learning", "nlp", "llm", "research engineer", "mlops")
ROBOTICS = ("robot", "autonom", "perception", "slam", "controls engineer",
            "motion planning", "vehicle", "drone", "flight software")

def role_for(title):
    t = f" {(title or '').lower()} "
    if any(k in t for k in ROBOTICS):
        return "robotics"
    if any(k in t for k in ML):
        return "ml"
    return "swe"

seen = set()
with open("../data/pipeline.csv", newline="") as fh:
    for r in csv.DictReader(fh):
        if (r.get("applied") or "").upper() == "TRUE":
            continue
        if (r.get("processed") or "").upper() == "TRUE":
            continue
        if (r.get("date") or "") < cutoff:
            continue
        company, title, url = r.get("company"), r.get("title"), (r.get("url") or "").strip()
        if not (company and title and url):
            continue
        slug = slugify(company, title)
        if only and slug != only:
            continue
        # pipeline.csv can hold the same posting twice under different URLs
        # (an embed token and its resolved board URL). One resume per slug.
        if slug in seen:
            continue
        seen.add(slug)
        if not force and os.path.exists(f"resumes/{slug}.pdf"):
            continue
        print("\t".join([slug, title.strip(), url, role_for(title)]))
PY
)

TOTAL="${#ROWS[@]}"
if [ "$TOTAL" -eq 0 ]; then
  log "no pending posting needs a resume (everything in range already has one)"
  exit 0
fi
if [ "$LIMIT" -gt 0 ] && [ "$TOTAL" -gt "$LIMIT" ]; then
  ROWS=("${ROWS[@]:0:$LIMIT}")
  TOTAL="$LIMIT"
fi

log "tailoring resumes for $TOTAL pending posting(s) since $(date -d "-$DAYS days" +%F)"
if [ "$DRY" -eq 1 ]; then
  for row in "${ROWS[@]}"; do
    IFS=$'\t' read -r slug title url role <<< "$row"
    printf '  %-8s %s\n' "$role" "$slug"
  done
  exit 0
fi

OK=0; JD_FAIL=0; TAILOR_FAIL=0
: > "$LEDGER.tmp"
i=0
for row in "${ROWS[@]}"; do
  i=$((i + 1))
  IFS=$'\t' read -r slug title url role <<< "$row"
  log "[$i/$TOTAL] $slug ($role)"

  if [ ! -s "jd/$slug.txt" ]; then
    if ! ./get_jd.sh "$slug" >> "$LOG" 2>&1; then
      log "    JD FAILED — no jd/$slug.txt, skipping the tailor step"
      JD_FAIL=$((JD_FAIL + 1))
      printf '%s\t%s\t%s\n' "$slug" "jd_failed" "$role" >> "$LEDGER.tmp"
      continue
    fi
  fi

  if ./tailor_resume.sh "$slug" "$role" >> "$LOG" 2>&1 && [ -s "resumes/$slug.pdf" ]; then
    log "    resumes/$slug.pdf"
    OK=$((OK + 1))
    printf '%s\t%s\t%s\n' "$slug" "ok" "$role" >> "$LEDGER.tmp"
  else
    log "    TAILOR FAILED — see $LOG"
    TAILOR_FAIL=$((TAILOR_FAIL + 1))
    printf '%s\t%s\t%s\n' "$slug" "tailor_failed" "$role" >> "$LEDGER.tmp"
  fi
done

python3 - "$LEDGER.tmp" "$LEDGER" <<'PY'
import json, sys
src, dst = sys.argv[1], sys.argv[2]
rows = []
for line in open(src):
    parts = line.rstrip("\n").split("\t")
    if len(parts) == 3:
        rows.append({"slug": parts[0], "result": parts[1], "role": parts[2]})
json.dump(rows, open(dst, "w"), indent=2)
PY
rm -f "$LEDGER.tmp"

log "done — $OK tailored, $JD_FAIL JD failures, $TAILOR_FAIL tailor failures"
log "ledger: $LEDGER"
echo "Nothing was submitted. The PDFs are in resumes/{slug}.pdf for manual applications."
