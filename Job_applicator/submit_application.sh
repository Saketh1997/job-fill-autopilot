#!/bin/bash
set -uo pipefail

# Final submission stage — only ever invoked after explicit human approval
# (the scoped exception to CLAUDE.md's never-submit rule).
URL="${1:-}"
SLUG="${2:-}"
APPLY_URL="${3:-}"
cd /home/hunter/projects/career-ops/Job_applicator
export PATH="/home/hunter/.local/bin:/home/hunter/.nvm/versions/node/v20.20.2/bin:$PATH"
# OmniRoute (localhost:20128) is gone. Default to the real API; the CLI
# authenticates with its own stored credentials, and the token guard below
# withholds the OmniRoute token unless someone points this back at 20128.
export ANTHROPIC_BASE_URL="${ANTHROPIC_BASE_URL:-https://api.anthropic.com}"
# Only OmniRoute takes the OmniRoute token. Sending it to api.anthropic.com
# returns 401 "Invalid bearer token"; the CLI's own stored credentials are
# what should be used there. Same guard as claude_retry.sh.
case "${ANTHROPIC_BASE_URL:-}" in
  *20128*) export ANTHROPIC_AUTH_TOKEN="${ANTHROPIC_AUTH_TOKEN:?OmniRoute requires ANTHROPIC_AUTH_TOKEN in the environment}" ;;
esac
export CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1
# Playwright MCP cold starts can exceed the default 30s connection
# timeout; give it 2 minutes.
export MCP_TIMEOUT=120000

source ./claude_retry.sh

if [ -z "$URL" ] || [ -z "$SLUG" ] || [ -z "$APPLY_URL" ]; then
  echo "usage: submit_application.sh <url> <slug> <apply_url>" >&2
  exit 2
fi

ANSWERS="/home/hunter/projects/career-ops/Job_applicator/answers/$SLUG.json"
RESULT="/home/hunter/projects/career-ops/Job_applicator/answers/$SLUG-result.json"
LOG="/home/hunter/projects/career-ops/Job_applicator/logs/$SLUG-submit.log"

# CLAUDE.md scoped exception: submission is only permitted when the answers
# file already exists. Enforce it here, before any model is spawned.
if [ ! -s "$ANSWERS" ]; then
  echo '{"submitted": false, "error": "answers file missing, run fill_application.sh first", "slug": "'$SLUG'"}'
  exit 1
fi

# Refuse to submit a run that fill marked as blocked. If the human has since
# resolved the blockers, they can edit ready_to_submit to true in the file.
READY=$(python3 -c "
import json
v = json.load(open('$ANSWERS')).get('ready_to_submit', False)
print('yes' if v is True else 'no')
" 2>/dev/null)
if [ "$READY" != "yes" ]; then
  echo '{"submitted": false, "error": "answers file has ready_to_submit=false; resolve blocked_on items and set it to true before submitting", "slug": "'$SLUG'"}'
  exit 1
fi

rm -f "$RESULT"
: > "$LOG"

PROMPT=$(cat <<EOF
Using playwright, the application at $APPLY_URL was already filled in the
existing browser session by a previous run (most job sites autosave drafts).
Bring that tab into focus or reopen the URL.

Read $ANSWERS and verify the form's current field values match it.
- If the ENTIRE form is empty (the site did not persist the draft), do NOT
  fill it and do NOT submit. Write $RESULT with submitted: false and a note
  in problems, then stop. Re-filling from scratch is fill_application.sh's
  job, not this run's.
- If individual fields are empty or mismatched, refill those fields from
  $ANSWERS and profile.json only. If the correct value is not in those
  files, do not invent one; record it in problems and do not submit.

Then, overriding the never-submit rule in CLAUDE.md for this run only
because explicit human approval has been given, click the final Submit
button. Confirm the submission succeeded by checking for a confirmation
message or URL change.

Write $RESULT with:
{"submitted": true/false, "confirmation": "what you observed",
"problems": [...]}. submitted must be a JSON boolean, and true only if you
actually clicked Submit and saw confirmation. Write this file in every
case before ending the run.
EOF
)

run_claude "$LOG" -p "$PROMPT" \
  --model "${SUBMIT_MODEL:-claude-sonnet-5}" \
  --output-format json \
  --allowedTools "mcp__playwright__*,Read,Write" \
  --max-turns 25

# The model sometimes ends its turn without writing the result file even
# though the API call "succeeded". Nudge the same session once to finish.
if [ ! -s "$RESULT" ]; then
  SID=$(last_session_id "$LOG")
  if [ -n "$SID" ]; then
    run_claude "$LOG" --resume "$SID" \
      -p "You stopped before writing $RESULT. Write it now, reflecting what actually happened: submitted true ONLY if you clicked Submit and saw confirmation, otherwise false with the reason in problems." \
      --model "${SUBMIT_MODEL:-claude-sonnet-5}" \
      --output-format json \
      --allowedTools "mcp__playwright__*,Read,Write" \
      --max-turns 10
  fi
fi

if [ ! -s "$RESULT" ]; then
  echo '{"submitted": false, "error": "no result file, check '$LOG'", "slug": "'$SLUG'"}'
  exit 1
fi

cat "$RESULT"

SUBMITTED=$(python3 -c "
import json
v = json.load(open('$RESULT')).get('submitted', False)
print('yes' if v is True or str(v).lower() == 'true' else 'no')
" 2>/dev/null)
if [ "$SUBMITTED" = "yes" ]; then
  python3 /home/hunter/projects/career-ops/Job_applicator/mark_applied.py "$URL"
fi
