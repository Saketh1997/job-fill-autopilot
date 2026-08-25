#!/bin/bash
set -uo pipefail

# fill_application.sh — model fallback for the fields the deterministic pass missed.
#
# No ATS routing (removed 2026-08-08): this fills whatever URL it is handed.
# n8n decides which postings reach it and which go to the deterministic
# {greenhouse,ashby,lever}_fill_mcp.py fillers instead. Sending a Greenhouse,
# Ashby or Lever posting here still works — it is just more expensive than the
# dedicated script, so keep that branch in the n8n flow.
#
#   fill_application.sh <slug> <fill_report.json> [role]
#
# <fill_report.json> is fill_form.mjs's stdout captured to a file. Both the page
# URL and the list of fields to work on are read from it — fill_form.mjs writes
# .url, .unfilled_required[] and .mismatches[].name.
#
# Env: CDP_ENDPOINT (the shared browser fill_form left open), plus the OmniRoute
#      vars sourced by the caller (ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN).
#      DRY_RUN=1 prints what would be sent and exits without calling the model.

SLUG="${1:-}"
REPORT="${2:-}"
ROLE="${3:-ml}"

cd /home/hunter/projects/career-ops/Job_applicator
export PATH="/home/hunter/.local/bin:/home/hunter/.nvm/versions/node/v20.20.2/bin:$PATH"
export CDP_ENDPOINT="${CDP_ENDPOINT:-http://localhost:9222}"
source ./claude_retry.sh 2>/dev/null || true

JOBAPP="/home/hunter/projects/career-ops/Job_applicator"
SCRAPE="$JOBAPP/scrapes/$SLUG.json"
STATUS="$JOBAPP/answers/$SLUG.backup.json"
LOG="$JOBAPP/logs/$SLUG-backup.log"

die() { echo "FILL_ERR: $*" >&2; exit 1; }

[ -n "$SLUG" ]   || die "usage: fill_application.sh <slug> <fill_report.json> [role]"
[ -n "$REPORT" ] || die "usage: fill_application.sh <slug> <fill_report.json> [role]"
[ -s "$REPORT" ] || die "fill report not found or empty: $REPORT (tee fill_form.mjs stdout to it)"
case "$ROLE" in
  swe|ml|robotics) ;;
  *) die "role must be one of: swe ml robotics (got '$ROLE')" ;;
esac

# ---- Read the page URL and the work list out of fill_form's report -----------
# These two were referenced but never assigned before 2026-08-08. Because the
# prompt was built in a $( ) subshell, `set -u` killed the SUBSHELL and left
# PROMPT empty while the parent sailed on and invoked the model with -p "" —
# every run died with "Input must be provided", so nothing was ever filled.
URL=$(jq -r '.url // empty' "$REPORT")
if [ -z "$URL" ] && [ -s "$SCRAPE" ]; then
  URL=$(jq -r '.final_url // .requested // empty' "$SCRAPE")
fi
[ -n "$URL" ] || die "no .url in $REPORT and no fallback in $SCRAPE"

TARGETS=$(jq -r '
  ((.unfilled_required // []) + [(.mismatches // [])[].name])
  | map(select(. != null and . != "")) | unique | .[] | "  - " + .
' "$REPORT")

if [ -z "$TARGETS" ]; then
  # Nothing unfilled and nothing mismatched means fill_form.mjs completed the
  # form on its own — complete and unblocked, so ready_to_submit is true.
  echo "{\"slug\": \"$SLUG\", \"url\": \"$URL\", \"filled_now\": [], \"left_for_human\": [], \"blocked_on\": [], \"ready_to_submit\": true, \"note\": \"nothing left for the backup pass; fill_form completed every required field\"}" | tee "$STATUS"
  exit 0
fi

# ---- The one field class the backup must NOT auto-answer --------------------
# An "AI policy / consent / certify / acknowledge" field is an attestation. On
# an AI-assisted application, auto-answering it can certify something false, and
# it is the one thing that can actually hurt the applicant. The backup flags it
# for the human at review instead of guessing. Everything else, it fills.
PROMPT=$(cat <<EOF
You are finishing a job application form that a deterministic script has ALREADY
mostly filled. The form is open in the browser you are connected to. Do NOT open
a new page, do NOT reload, and do NOT touch or re-fill any field that already has
a value. Sign in to nothing and create no accounts. You are non-interactive:
never ask a question; if something blocks you, record it and continue.

Connect to the existing browser (CDP at $CDP_ENDPOINT) and work on the page that
is already open at:
  $URL

Fill ONLY these specific fields, which the deterministic pass could not complete:
$TARGETS

To answer them, read only the background files a given question needs, from:
  $JOBAPP/data/about_me.txt, education.txt, work_experience.txt,
  technical_skills.txt, strengths.txt, career_goals.txt, current_projects.txt,
  postgresql_research.txt, integrated_portfolio_chatbot.txt, homelab.txt,
  suitability_$ROLE.txt
and the job description at $JOBAPP/jd/$SLUG.txt. Read each file at most once.
Never invent facts that are not in these files.

This is not a Greenhouse, Ashby or Lever board — it is a Workday, iCIMS,
SmartRecruiters, Taleo or custom career page. Expect multi-step wizards, fields
inside iframes, and controls that are not plain inputs. Work only on the step
that is currently on screen. If advancing to a later step is the only way to
reach a listed field, you may click Next / Continue / Save and Continue, but
never Submit.

For a field that is a dropdown / select, open it, read the real options, and
pick the one that matches the truthful answer. For free text, answer in the
applicant's own voice, grounded in the files.

EXCEPTION — do not auto-answer, leave it for the human: any field that is an
"AI policy", consent, certification, acknowledgement, or attestation (for
example a field whose label mentions AI policy, "I certify", "I agree",
"I acknowledge"). For each such field, do nothing to it and add an entry to
blocked_on naming the field and its options, so the reviewer answers it.

Do NOT click Submit / Submit application. Stop at the review state.

When done (form filled as far as you can, or blocked), write $STATUS exactly once:
{"slug": "$SLUG", "url": "$URL", "filled_now": [field names you filled this pass],
 "left_for_human": [field names you deliberately left, e.g. attestations],
 "blocked_on": [specific, self-written notes on anything that stopped you],
 "ready_to_submit": true or false}

Set ready_to_submit TRUE when every field listed above now holds a value and
both blocked_on and left_for_human are empty — the form is complete.
Set it FALSE if anything at all is blocked, left for the human, still empty, or
you are unsure. When in doubt, false.

ready_to_submit reports form COMPLETENESS, not permission. It is not approval to
submit, and it does not change the rule below: you still never click Submit.
Write this file in every case, including if you could fill nothing. Never end the
run without writing it.
Budget: at most 25 browser actions.
EOF
)

# The bug above was silent because nothing checked the prompt survived. It does now.
[ ${#PROMPT} -gt 400 ] || die "prompt came out empty/truncated (${#PROMPT} chars) — refusing to invoke the model"

# DRY_RUN=1 prints what would be sent and stops — no browser, no model call, no
# form touched. Use it to check the report parsed and the targets came out right.
if [ "${DRY_RUN:-0}" = "1" ]; then
  echo "{\"slug\": \"$SLUG\", \"url\": \"$URL\", \"role\": \"$ROLE\", \"prompt_chars\": ${#PROMPT}, \"targets\": $(printf '%s' "$TARGETS" | grep -c '^  - ')}"
  exit 0
fi

: > "$LOG"
rm -f "$STATUS"

run_claude "$LOG" -p "$PROMPT" \
  --model "${FILL_MODEL:-claude-sonnet-5}" \
  --output-format json \
  --allowedTools "mcp__playwright__*,Read,Write" \
  --max-turns 30

# ---- Report ---------------------------------------------------------------
# Emit the backup status if the model wrote it; otherwise fall back to whatever
# fill_form reported, so the pipeline always has a JSON to consume. Either way,
# ready_to_submit stays false: the human review gate is unchanged.
if [ -s "$STATUS" ]; then
  cat "$STATUS"
else
  echo "BACKUP_WARN: model wrote no status file; see $LOG" >&2
  exit 1
fi
