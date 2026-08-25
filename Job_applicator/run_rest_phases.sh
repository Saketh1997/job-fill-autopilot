#!/bin/bash
# run_rest_phases.sh — phases 2 and 3 only, for when phase 1 is already done.
#
# run_all_phases.sh always starts at phase 1. Re-running it to reach phases 2-3
# would re-attempt today's Greenhouse/Ashby postings, four of which were just
# submitted by hand and whose ledger entries do not all say "submitted" — so the
# batch's own skip rule would not protect them. This runs the rest and nothing
# else.
#
#   DAYS=1 NONATS_LIMIT=59 ./run_rest_phases.sh
#
# Stop cleanly: touch Job_applicator/STOP-ALL-PHASES (delete it afterwards).
set -uo pipefail
cd /home/hunter/projects/career-ops/Job_applicator
export PATH="/home/hunter/.local/bin:/home/hunter/.nvm/versions/node/v20.20.2/bin:$PATH"
export CDP_ENDPOINT="http://localhost:9226"

STOP=/home/hunter/projects/career-ops/Job_applicator/STOP-ALL-PHASES
LOG=logs/all-phases.log
DAYS="${DAYS:-1}"
NONATS_LIMIT="${NONATS_LIMIT:-59}"
say() { echo "[$(date +%H:%M:%S)] $*" | tee -a "$LOG"; }
stopped() { [ -f "$STOP" ] && { say "STOP-ALL-PHASES present — halting"; return 0; } || return 1; }

drive() {                      # drive <slug> <phase-label>
  local slug="$1" label="$2"
  say "$label $slug"
  [ -s "jd/$slug.txt" ]      || ./get_jd.sh "$slug"        >>"logs/$slug-phase.log" 2>&1
  [ -s "jd/$slug.txt" ]      || { say "  no JD — skip";  return; }
  [ -s "resumes/$slug.pdf" ] || ./tailor_resume.sh "$slug" >>"logs/$slug-phase.log" 2>&1
  [ -s "resumes/$slug.pdf" ] || { say "  no resume — skip"; return; }
  timeout 2400 ./drive_application.sh "$slug" >>"logs/$slug-phase.log" 2>&1
  say "  drive exit $? ($(python3 -c "
import json
try:
    d=json.load(open('answers/$slug.drive.json'))
    if d.get('submitted'):         print('submitted')
    elif d.get('already_applied'): print('already applied on amazon.jobs')
    else:                          print(str(d.get('blocked_on') or ['no status'])[:120])
except Exception: print('no status file')" 2>/dev/null))"
}

# ---------------------------------------------------------------- phase 2
# Serial, always: amazon_apply.mjs closes any amazon.com/ap/ consent tab that is
# not its own, so two of these in one browser kill each other's sign-in.
say "PHASE 2 — amazon.jobs via drive_application.sh (${DAYS}d)"
mapfile -t AMZ < <(python3 select_slugs.py --host amazon.jobs --days "$DAYS")
say "amazon queue: ${#AMZ[@]}"
for slug in "${AMZ[@]}"; do
  stopped && exit 130
  [ -z "$slug" ] && continue
  if [ -s "answers/$slug.drive.json" ] && grep -q '"submitted": *true' "answers/$slug.drive.json"; then
    say "  skip (already submitted): $slug"; continue
  fi
  drive "$slug" "AMZ"
done

# ---------------------------------------------------------------- phase 3
say "PHASE 3 — non-ATS via drive_application.sh (limit $NONATS_LIMIT)"
mapfile -t OTH < <(python3 select_slugs.py --non-ats --days "$DAYS" --limit "$NONATS_LIMIT")
say "non-ATS queue: ${#OTH[@]}"
for slug in "${OTH[@]}"; do
  stopped && exit 130
  [ -z "$slug" ] && continue
  if [ -s "answers/$slug.drive.json" ] && grep -q '"submitted": *true' "answers/$slug.drive.json"; then
    say "  skip (already submitted): $slug"; continue
  fi
  drive "$slug" "OTH"
done
say "REST PHASES DONE"
