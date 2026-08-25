#!/bin/bash
set -uo pipefail

# linkedin-send.sh -- thin wrapper around linkedin_send.py. Call this from
# n8n AFTER a human has approved the drafted message (Discord reaction ->
# `linkedin-approve.sh <slug> approve`). linkedin_send.py independently
# refuses to send anything whose queue status isn't "approved", so this
# wrapper's only jobs are cwd + CDP_ENDPOINT + a stable exit code.
#
#   linkedin-send.sh <slug>

SLUG="${1:-}"
[ -n "$SLUG" ] || { echo '{"sent": false, "error": "usage: linkedin-send.sh <slug>"}' >&2; exit 2; }

cd /home/hunter/projects/career-ops/Job_applicator
export CDP_ENDPOINT="${CDP_ENDPOINT:-http://localhost:9226}"

if [ -f "/home/hunter/projects/career-ops/.venv-jobspy/bin/activate" ]; then
  source /home/hunter/projects/career-ops/.venv-jobspy/bin/activate
fi

python3 linkedin_send.py "$SLUG"
