#!/usr/bin/env bash
# run_ats_submit.sh -- submit every application that is filled and waiting.
#
# This is stage 4, and it is the ONLY script in the chain that clicks Submit.
# It is deliberately a separate entrypoint from run_ats_pipeline.sh: filling is
# reversible and submitting is not, so the two never run off one trigger.
#
#   ./run_ats_submit.sh [--limit N] [--dry-run] [--force]
#   ./run_ats_submit.sh <slug> [--dry-run]     # just this one
#
# The approval gate is NOT in here -- n8n owns it. This script assumes whatever
# called it has already gotten a human's yes. What ats_submit.mjs still enforces
# on its own, and what this wrapper cannot override:
#   - a slug already submitted is never submitted again
#   - a form with an empty required field, a validation error, or the generic
#     (non-tailored) resume attached is refused
#   - a posting whose filled tab is gone is refused, not silently refilled
#
# Run `./run_ats_submit.sh --list` first to see what is actually waiting.
#
# Stop a running batch cleanly: touch Job_applicator/STOP-ATS-BATCH
#
# Exit: 0 something submitted (or --list/--dry-run ran) · 1 error
#       2 nothing submitted (all declined/blocked) · 200 another run holds the lock
set -uo pipefail
cd "$(dirname "$0")"

export PATH="$HOME/.nvm/versions/node/v20.20.2/bin:/usr/local/bin:/usr/bin:/bin"
export CDP_ENDPOINT="${CDP_ENDPOINT:-http://localhost:9226}"

mkdir -p output
LOG=output/ats-submit-cron.log
exec > >(tee -a "$LOG") 2>&1

echo "=== run_ats_submit start $(date -Is) ==="

# --list is read-only; no lock, no --all, no --yes.
for a in "$@"; do
  if [ "$a" = "--list" ]; then
    node Job_applicator/ats_submit.mjs --list
    exit $?
  fi
done

# A bare first argument is a slug: submit exactly that one. Otherwise walk the
# whole filled-and-waiting queue.
case "${1:-}" in
  ""|--*) SEL=(--all) ;;
  *)      SEL=("$1"); shift ;;
esac

(
  flock -n 202 || { echo "another run_ats_submit.sh is already running -- exiting"; exit 200; }
  # --yes because the human already said yes upstream in n8n. ats_submit.mjs
  # re-audits each live form regardless and refuses anything that fails.
  node Job_applicator/ats_submit.mjs "${SEL[@]}" --yes "$@"
) 202>/tmp/.run_ats_submit.lock
rc=$?

echo "=== run_ats_submit done rc=$rc $(date -Is) ==="
exit "$rc"
