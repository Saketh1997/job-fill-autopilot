#!/bin/bash
# One-off: re-fill and submit the six postings left "ready for approval" by the
# 2026-08-11 batch. Their tabs were closed before anyone approved them, and
# ats_submit.mjs refuses a posting whose filled form is gone, so the only path
# to a submitted application is to fill it again.
#
# Sequential on purpose. These touch real employers' forms, and the browser is
# a single shared Chrome — two drivers in it at once fight over tabs.
cd "$(dirname "$0")" || exit 1
LOG=logs/resubmit-six.log
: > "$LOG"

run() {
  local driver="$1" slug="$2"
  echo "[$(date +%H:%M:%S)] === $slug" >> "$LOG"
  timeout 900 node "$driver" "$slug" >> "$LOG" 2>&1
  echo "[$(date +%H:%M:%S)] --- exit $?" >> "$LOG"
}

run ashby_apply.mjs      job-Mistral-Applied_Scientist
run ashby_apply.mjs      job-AeroVect-Test_Engineer__Autonomous_Vehicles
run ashby_apply.mjs      job-Jerry-Associate_Data_Scientist
run ashby_apply.mjs      job-Cl_op_tre-Software_Engineer__Early_Career
run greenhouse_apply.mjs job-Celonis-Working_Student_Applied_AI_Solution_Consulting__Nordics_
run ashby_apply.mjs      job-Sesame-Research_Scientist

echo "[$(date +%H:%M:%S)] ALL SIX DONE" >> "$LOG"
