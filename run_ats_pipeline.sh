#!/usr/bin/env bash
# run_ats_pipeline.sh -- one invocation, full serial chain:
#   scan -> fill each new ATS posting (no submit) -> draft its LinkedIn
#   message (queued, never sent).
#
# This is a thin, flock-guarded wrapper around batch-ats-fill.mjs, which does
# the actual work (see the flow comment at the top of that file). Safe for
# cron/n8n: non-zero exit on failure, flock prevents overlapping runs.
#
# Sending the drafted LinkedIn messages is a SEPARATE, later step, gated on
# human approval -- see Job_applicator/linkedin-approve.sh and
# Job_applicator/linkedin-send.sh. This script never sends anything.
#
# Usage:
#   ./run_ats_pipeline.sh [--submit] [--days N] [--dry-run] [--limit N]
#
#   --submit   also submits each filled application (default: fill only,
#              left for the human to review and submit). Off by default on
#              purpose -- see AGENTS.md "Ethical Use".
#
# Stop a running batch cleanly: touch Job_applicator/STOP-ATS-BATCH
set -euo pipefail
cd "$(dirname "$0")"

export PATH="$HOME/.nvm/versions/node/v20.20.2/bin:/usr/local/bin:/usr/bin:/bin"

mkdir -p output
LOG=output/ats-pipeline-cron.log
exec > >(tee -a "$LOG") 2>&1

echo "=== run_ats_pipeline start $(date -Is) ==="

(
  flock -n 201 || { echo "another run_ats_pipeline.sh is already running -- exiting"; exit 200; }
  node batch-ats-fill.mjs "$@"
) 201>/tmp/.run_ats_pipeline.lock

echo "=== run_ats_pipeline done $(date -Is) ==="
