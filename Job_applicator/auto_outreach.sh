#!/bin/bash
# auto_outreach.sh -- unattended stage 5. Saketh removed the human approval gate
# on 2026-09-05, conditioned on the draft holding no incorrect data.
#
# That condition is enforced by verify_outreach.py, which runs per slug and must
# exit 0 before this script approves anything. Everything else about the safety
# design is UNCHANGED and deliberately so:
#   - linkedin-draft.sh still has no send-capable tool in its allowlist
#   - linkedin_send.py still hard-refuses any status that is not "approved"
#   - sends stay SERIAL, one slug at a time, each result read before the next,
#     because a send is one attempt with no retry (PIPELINE.md 9.3)
# The verifier occupies the approver's seat. It does not remove the seat.
#
#   ./auto_outreach.sh [--limit N] [--dry-run]

set -uo pipefail
cd /home/hunter/projects/career-ops/Job_applicator
export PATH="/home/hunter/.local/bin:/home/hunter/.nvm/versions/node/v20.20.2/bin:$PATH"
export CDP_ENDPOINT="${CDP_ENDPOINT:-http://localhost:9226}"
[ -f ../.venv-jobspy/bin/activate ] && source ../.venv-jobspy/bin/activate

LIMIT=999; DRY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --limit) LIMIT="$2"; shift 2 ;;
    --dry-run) DRY=1; shift ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

# Preflight. A dead cookie BURNS every draft it touches, so check once up front.
echo "== preflight"
CHECK=$(python3 ../linkedin_login.py --check 2>&1 | tail -1)
echo "   $CHECK"
case "$CHECK" in
  *VALID*) ;;
  *) echo "ABORT: LinkedIn session is not valid; sending now would burn every draft." >&2; exit 1 ;;
esac

mapfile -t SLUGS < <(python3 linkedin_queue.py list --status pending_approval 2>/dev/null \
                     | python3 -c 'import json,sys
for r in json.load(sys.stdin):
    if r.get("slug"): print(r["slug"])')

if [ "${#SLUGS[@]}" -eq 0 ]; then echo "== nothing pending_approval"; exit 0; fi
echo "== ${#SLUGS[@]} draft(s) pending"

sent=0; blocked=0; failed=0; n=0
for slug in "${SLUGS[@]}"; do
  [ "$n" -ge "$LIMIT" ] && { echo "== limit $LIMIT reached"; break; }
  n=$((n+1))
  echo
  echo "-- [$n] $slug"

  if ! python3 verify_outreach.py "$slug"; then
    echo "   BLOCKED: left pending_approval for Saketh to look at, nothing sent."
    blocked=$((blocked+1)); continue
  fi

  if [ "$DRY" = "1" ]; then echo "   dry-run: would approve + send"; continue; fi

  ./linkedin-approve.sh "$slug" approve >/dev/null || { echo "   approve failed"; failed=$((failed+1)); continue; }
  RESULT=$(./linkedin-send.sh "$slug" 2>&1); RC=$?
  echo "$RESULT" | tail -3

  # Read THIS result before touching the next slug. linkedin_send.py exits 0
  # only when it has real evidence the message went out, and prints
  # {"sent": true, ...}; require BOTH so a wrapper-level error cannot read as
  # success.
  if [ "$RC" -eq 0 ] && echo "$RESULT" | grep -q '"sent": *true'; then
    sent=$((sent+1))
    sleep $((20 + RANDOM % 25))   # human-ish spacing; LinkedIn rate-limits invites
  else
    failed=$((failed+1))
    echo "   send did not confirm; stopping the run so failures cannot cascade."
    break
  fi
done

echo
echo "== sent=$sent blocked=$blocked failed=$failed"
