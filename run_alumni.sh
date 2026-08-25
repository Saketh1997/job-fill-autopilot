#!/usr/bin/env bash
# run_alumni.sh -- Oregon State alumni referral outreach, split into the three
# stages n8n drives separately. Thin, flock-guarded wrapper around
# alumni-referrals.mjs.
#
#   ./run_alumni.sh find    [--days 7] [--limit 15] [--only <company>] [--loose]
#         Reads the OSU alumni directory for the companies in data/pipeline.csv,
#         appends new people to data/alumni-contacts.tsv, and writes one draft
#         per person to output/referral-drafts/. Contacts nobody.
#
#   ./run_alumni.sh queue
#         Prints every draft as JSON (id, name, company, profile_url, chars,
#         status, message) on stdout. This is what n8n posts for approval.
#
#   ./run_alumni.sh approve <draft-id>...   |  ./run_alumni.sh approve --all
#   ./run_alumni.sh reject  <draft-id>...
#         Flips the draft's `**Send:**` line. n8n calls this off the Discord
#         reaction.
#
#   ./run_alumni.sh send    [--delay 120] [--max 15] [--dry-run]
#         Sends the approved drafts only, one at a time, --delay seconds apart,
#         --max per run, never twice to the same profile (data/alumni-sent.tsv
#         is append-only and written before the pause).
#
# Requires the shared logged-in Chrome for `find` and `send`:
#   systemctl --user start job-browser.service     # CDP on :9226
#
# LinkedIn's User Agreement (8.2) prohibits automated messaging and enforcement
# is account-level. The pacing here lowers the odds of tripping a volume limit;
# it does not make automation undetectable. Keep --max small and edit the drafts.
#
# Stop a running send cleanly: touch STOP-ALUMNI
#
# Exit: passes through alumni-referrals.mjs · 200 another run holds the lock
set -uo pipefail
cd "$(dirname "$0")"

export PATH="$HOME/.nvm/versions/node/v20.20.2/bin:/usr/local/bin:/usr/bin:/bin"
export CDP_ENDPOINT="${CDP_ENDPOINT:-http://localhost:9226}"

CMD="${1:-}"
shift 2>/dev/null || true

usage() {
  echo "usage: run_alumni.sh <find|queue|approve|reject|send|list> [flags]" >&2
  exit 2
}
[ -n "$CMD" ] || usage

# queue/approve/reject/list are local file operations: no browser, no lock, no
# log file. queue's stdout is JSON that n8n parses, so nothing may pollute it.
case "$CMD" in
  queue|approve|reject|list)
    exec node alumni-referrals.mjs "$CMD" "$@"
    ;;
esac

mkdir -p output
LOG=output/alumni-cron.log
exec > >(tee -a "$LOG") 2>&1

echo "=== run_alumni $CMD start $(date -Is) ==="

run_locked() {
  (
    flock -n 203 || { echo "another run_alumni.sh is already running -- exiting"; exit 200; }
    "$@"
  ) 203>/tmp/.run_alumni.lock
}

case "$CMD" in
  find)
    # scan then drafts: one trigger, because a contact with no draft is not
    # actionable and n8n would just have to call back for it.
    run_locked bash -c '
      set -e
      node alumni-referrals.mjs scan "$@"
      node alumni-referrals.mjs drafts
    ' _ "$@"
    ;;
  send)
    run_locked node alumni-referrals.mjs send "$@"
    ;;
  *)
    usage
    ;;
esac
rc=$?

echo "=== run_alumni $CMD done rc=$rc $(date -Is) ==="
exit "$rc"
