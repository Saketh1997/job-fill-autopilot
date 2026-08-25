#!/bin/bash
# run_amazon_phase.sh — phase 2 of run_all_phases.sh on its own, with a settable
# window. Extracted because the 14-day default silently excluded 11 amazon.jobs
# postings that were 15-38 days old: they were never queued, so they have a JD
# and no tailored resume, and nothing in the logs said so. Phases 1 and 3 are
# expensive and unrelated, so re-running the whole file to widen one window is
# the wrong trade.
#
#   DAYS=60 ./run_amazon_phase.sh
#
# Waits for any run in progress first. The job browser is a single shared Chrome
# and two drivers inside it fight over tabs.
set -uo pipefail
cd /home/hunter/projects/career-ops/Job_applicator
export PATH="/home/hunter/.local/bin:/home/hunter/.nvm/versions/node/v20.20.2/bin:$PATH"
export CDP_ENDPOINT="http://localhost:9226"

STOP=/home/hunter/projects/career-ops/Job_applicator/STOP-ALL-PHASES
LOG=logs/amazon-phase.log
DAYS="${DAYS:-60}"
say() { echo "[$(date +%H:%M:%S)] $*" | tee -a "$LOG"; }
stopped() { [ -f "$STOP" ] && { say "STOP-ALL-PHASES present — halting"; return 0; } || return 1; }

# Anything already driving the shared browser has to finish first.
waited=0
while pgrep -f "resubmit_six.sh|run_ats_batch.mjs|drive_application.sh|_apply\.mjs" >/dev/null 2>&1; do
  [ "$waited" -eq 0 ] && say "waiting for the browser to free up"
  waited=$((waited + 20))
  [ "$waited" -gt 5400 ] && { say "still busy after 90m — giving up"; exit 1; }
  sleep 20
done
[ "$waited" -gt 0 ] && say "browser free after ${waited}s"

say "AMAZON PHASE — ${DAYS}d window"
mapfile -t AMZ < <(python3 select_slugs.py --host amazon.jobs --days "$DAYS")
say "amazon queue: ${#AMZ[@]}"
for slug in "${AMZ[@]}"; do
  stopped && exit 130
  [ -z "$slug" ] && continue
  if [ -s "answers/$slug.drive.json" ] && grep -q '"submitted": *true' "answers/$slug.drive.json"; then
    say "  skip (already submitted): $slug"; continue
  fi
  say "AMZ $slug"
  [ -s "jd/$slug.txt" ]      || ./get_jd.sh "$slug"        >>"logs/$slug-phase.log" 2>&1
  [ -s "jd/$slug.txt" ]      || { say "  no JD — skip";  continue; }
  [ -s "resumes/$slug.pdf" ] || ./tailor_resume.sh "$slug" >>"logs/$slug-phase.log" 2>&1
  [ -s "resumes/$slug.pdf" ] || { say "  no resume — skip"; continue; }
  timeout 2400 ./drive_application.sh "$slug" >>"logs/$slug-phase.log" 2>&1
  say "  drive exit $? ($(python3 -c "
import json,sys
try:
    d=json.load(open('answers/$slug.drive.json'))
    if d.get('submitted'):        print('submitted')
    elif d.get('already_applied'): print('already applied on amazon.jobs')
    else:                          print(str(d.get('blocked_on') or ['no status'])[:120])
except Exception: print('no status file')" 2>/dev/null))"
done
say "AMAZON PHASE DONE"
