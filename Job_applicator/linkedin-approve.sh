#!/bin/bash
set -uo pipefail

# linkedin-approve.sh -- n8n calls this after a Discord approval/rejection
# reaction, instead of hand-editing data/linkedin-outreach-queue.json. Wraps
# linkedin_queue.py's atomic (tmp+rename) writer.
#
#   linkedin-approve.sh <slug> approve
#   linkedin-approve.sh <slug> reject [reason text...]

SLUG="${1:-}"
ACTION="${2:-}"
shift 2 2>/dev/null || true
REASON="$*"

cd /home/hunter/projects/career-ops/Job_applicator

case "$ACTION" in
  approve) python3 linkedin_queue.py approve "$SLUG" ;;
  reject)  python3 linkedin_queue.py reject "$SLUG" --reason "$REASON" ;;
  *) echo '{"error": "usage: linkedin-approve.sh <slug> approve|reject [reason]"}' >&2; exit 2 ;;
esac
