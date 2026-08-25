#!/bin/bash
# run_all_phases.sh — unattended: greenhouse+ashby batch, then amazon, then non-ATS.
# One posting at a time throughout; the job browser is a single shared unit.
# Stop cleanly: touch Job_applicator/STOP-ALL-PHASES
set -uo pipefail
cd /home/hunter/projects/career-ops/Job_applicator
export PATH="/home/hunter/.local/bin:/home/hunter/.nvm/versions/node/v20.20.2/bin:$PATH"
export CDP_ENDPOINT="http://localhost:9226"

STOP=/home/hunter/projects/career-ops/Job_applicator/STOP-ALL-PHASES
LOG=logs/all-phases.log
say() { echo "[$(date +%H:%M:%S)] $*" | tee -a "$LOG"; }
stopped() { [ -f "$STOP" ] && { say "STOP-ALL-PHASES present — halting"; return 0; } || return 1; }

DAYS="${DAYS:-14}"
NONATS_LIMIT="${NONATS_LIMIT:-15}"
# Deterministic ATS drivers only. All three (greenhouse/lever/ashby) are built on
# the same ats_apply_common.mjs + ats_questions.mjs pair, so run_ats_batch.mjs
# handles them identically.
ATS_LIST="${ATS_LIST:-greenhouse,ashby,lever}"
# SKIP_NONATS=1 stops after phase 2. Phase 3 is the agentic browser drive, which
# costs ~5-25 min per posting and is where the quota runs out; the ATS phases are
# deterministic and cheap, so it is worth being able to run them alone.
SKIP_NONATS="${SKIP_NONATS:-0}"

# ---------------------------------------------------------------- phase 1
say "PHASE 1 — ${ATS_LIST} via run_ats_batch.mjs --submit (${DAYS}d window)"
node run_ats_batch.mjs --days "$DAYS" --ats "$ATS_LIST" --submit 2>&1 | tee -a "$LOG"
say "PHASE 1 exit ${PIPESTATUS[0]}"
stopped && exit 130

# ---------------------------------------------------------------- phase 2
say "PHASE 2 — amazon.jobs via drive_application.sh"
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
    print('submitted' if d.get('submitted') else (str(d.get('blocked_on') or ['no status'])[:120]))
except Exception: print('no status file')" 2>/dev/null))"
done

# ---------------------------------------------------------------- phase 3
if [ "$SKIP_NONATS" = "1" ]; then
  say "PHASE 3 — SKIPPED (SKIP_NONATS=1)"
  say "ALL PHASES DONE"
  exit 0
fi
say "PHASE 3 — non-ATS via drive_application.sh (limit $NONATS_LIMIT)"
mapfile -t OTH < <(python3 select_slugs.py --non-ats --days "$DAYS" --limit "$NONATS_LIMIT")
say "non-ATS queue: ${#OTH[@]}"
for slug in "${OTH[@]}"; do
  stopped && exit 130
  [ -z "$slug" ] && continue
  if [ -s "answers/$slug.drive.json" ] && grep -q '"submitted": *true' "answers/$slug.drive.json"; then
    say "  skip (already submitted): $slug"; continue
  fi
  say "OTH $slug"
  [ -s "jd/$slug.txt" ]      || ./get_jd.sh "$slug"        >>"logs/$slug-phase.log" 2>&1
  [ -s "jd/$slug.txt" ]      || { say "  no JD — skip";  continue; }
  [ -s "resumes/$slug.pdf" ] || ./tailor_resume.sh "$slug" >>"logs/$slug-phase.log" 2>&1
  [ -s "resumes/$slug.pdf" ] || { say "  no resume — skip"; continue; }
  timeout 2400 ./drive_application.sh "$slug" >>"logs/$slug-phase.log" 2>&1
  say "  drive exit $? ($(python3 -c "
import json,sys
try:
    d=json.load(open('answers/$slug.drive.json'))
    print('submitted' if d.get('submitted') else (str(d.get('blocked_on') or ['no status'])[:120]))
except Exception: print('no status file')" 2>/dev/null))"
done

say "ALL PHASES DONE"
