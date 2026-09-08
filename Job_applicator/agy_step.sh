#!/usr/bin/env bash
# agy_step.sh — the three browser steps of an application, all driven by agy.
#
#   ./agy_step.sh fill   <slug> [swe|ml|robotics]   fill the form, never submit
#   ./agy_step.sh fix    <slug>                     apply answers/{slug}.corrections.json
#   ./agy_step.sh submit <slug>                     click Submit, nothing else
#
# THE SPLIT THIS FILE EXISTS FOR
#
# agy (gemini-3.7-flash) is the orchestrator: it navigates, clicks, types and
# uploads. It has the quota to do that on sixty postings and it is good at it.
# What it is not good at is deciding whether an answer is RIGHT when the answer
# is not already written down somewhere — reading a graduation-date control and
# knowing "Immediately" cannot be one of its answers, noticing that the option
# it matched says something false about the candidate.
#
# So that judgement is not asked of it. The loop is:
#
#   agy_step.sh fill   -> readback.mjs -> the planner reviews the sheet
#                      -> corrections.json -> agy_step.sh fix -> readback.mjs
#                      -> the planner reviews again -> agy_step.sh submit
#
# Every step here is one agy call with the playwright MCP pointed at the shared
# job browser. `fill` and `fix` are reversible and submit nothing. `submit` is
# the one that is not, and it is a separate subcommand for exactly that reason:
# nothing in this file ever slides from filling into submitting on its own.
#
# Env: AGY_FILL_MODEL   default gemini-3.7-flash-high
#      AGY_CHAIN        full MODEL_CHAIN override (default: 3.7-flash, then
#                       3.6-flash, then agy's sonnet — all on agy's quota, so a
#                       flash outage never silently spends Claude quota)
#      CDP_ENDPOINT     default http://localhost:9226
#
# Exit: 0 done · 1 error · 2 nothing to do (fix with no corrections)
set -uo pipefail

cd "$(dirname "$0")"
JOBAPP="$PWD"
ROOT="$(dirname "$PWD")"
export PATH="/home/hunter/.local/bin:/home/hunter/.nvm/versions/node/v20.20.2/bin:$PATH"
export CDP_ENDPOINT="${CDP_ENDPOINT:-http://localhost:9226}"

AGY_FILL_MODEL="${AGY_FILL_MODEL:-gemini-3.7-flash-high}"
# Falls back within agy rather than out to claude: the whole point of putting
# flash in front is that its quota absorbs the volume, and a chain that quietly
# reaches for Claude on every flash hiccup gives that back.
export MODEL_CHAIN="${AGY_CHAIN:-agy:${AGY_FILL_MODEL},agy:gemini-3.6-flash-high,agy:claude-sonnet-4-6}"

CMD="${1:-}"; SLUG="${2:-}"; ROLE="${3:-ml}"
die() { echo "AGY_STEP_ERR: $*" >&2; exit 1; }
[ -n "$CMD" ] && [ -n "$SLUG" ] || die "usage: agy_step.sh fill|fix|submit <slug> [role]"
[ "$SLUG" = "$(basename "$SLUG")" ] || die "bad slug: $SLUG"

STATUS="$JOBAPP/answers/$SLUG.drive.json"
READBACK="$JOBAPP/answers/$SLUG.readback.json"
CORRECTIONS="$JOBAPP/answers/$SLUG.corrections.json"
mkdir -p "$JOBAPP/logs" "$JOBAPP/answers"

# ------------------------------------------------------------------- fill
# Delegated wholesale to drive_application.sh with --no-submit. That script
# already carries everything a filler needs and has paid for in bugs — the
# portal cache, credential resolution, honeypot and exact-match rules, page
# priming, tab cleanup. Reimplementing a filler here to change which model runs
# it would throw all of that away to set one environment variable.
if [ "$CMD" = "fill" ]; then
  echo "AGY_STEP: fill $SLUG on ${MODEL_CHAIN%%,*} (submit disabled)" >&2
  exec ./drive_application.sh "$SLUG" "$ROLE" --no-submit
fi

[ "$CMD" = "fix" ] || [ "$CMD" = "submit" ] || die "unknown subcommand: $CMD"

source ./claude_retry.sh 2>/dev/null || die "could not source claude_retry.sh"

URL=$(python3 -c "import json,sys;d=json.load(open('$STATUS'));print(d.get('apply_url') or d.get('url') or '')" 2>/dev/null)
[ -n "$URL" ] || URL=$(python3 resolve_slug.py "$SLUG" 2>/dev/null)
[ -n "$URL" ] || die "no URL for $SLUG (no $STATUS, and resolve_slug.py found nothing)"

# ------------------------------------------------------------------- fix
if [ "$CMD" = "fix" ]; then
  [ -s "$CORRECTIONS" ] || die "no $CORRECTIONS — the planner writes it after reading readback.mjs"

  # Rendered by the shell, not by the model, so the model cannot reinterpret
  # which control a correction is for. Each line carries the selector the
  # readback recorded, so the fix targets the same node the review judged.
  LIST=$(python3 - "$CORRECTIONS" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
items = d.get("corrections") or []
if not items:
    sys.exit(9)
for i, c in enumerate(items, 1):
    print(f'{i}. QUESTION: {c.get("question","")}')
    print(f'   SELECTOR: {c.get("selector","")}')
    print(f'   CONTROL:  {c.get("kind","")}')
    print(f'   NOW:      {json.dumps(c.get("current",""))}')
    print(f'   SET TO:   {json.dumps(c.get("new",""))}')
    if c.get("why"): print(f'   REASON:   {c["why"]}')
    print()
PY
)
  rc=$?
  [ "$rc" = "9" ] && { echo "AGY_STEP: $SLUG has no corrections to apply" >&2; exit 2; }
  [ -n "$LIST" ] || die "could not render $CORRECTIONS"

  LOG="$JOBAPP/logs/$SLUG-fix.log"; : > "$LOG"
  FIXOUT="$JOBAPP/answers/$SLUG.fix.json"; rm -f "$FIXOUT"

  PROMPT=$(cat <<EOF
Apply a reviewed list of corrections to a job application form that is ALREADY
FILLED and open in the browser. You are non-interactive: never ask a question.

Posting: $URL
The tab holding the filled form is already open. Do NOT navigate anywhere, do
NOT reload, and do NOT open a new tab — reloading discards the filled form and
the session behind it. Find the existing tab on this posting and work in it.

DO EXACTLY THESE $(printf '%s' "$LIST" | grep -c '^[0-9]*\. QUESTION:') CORRECTIONS AND NOTHING ELSE.
A reviewer read the form back and judged these specific answers wrong. Every
other answer on this form has been reviewed and is correct: changing, clearing
or re-typing any of them is a regression, not an improvement.

$LIST

How to apply each one:
- Use the SELECTOR given. It is the selector the readback recorded for that
  exact control. If it matches nothing, the page re-rendered — find the control
  by its QUESTION text instead, and say so in your report.
- For a choice control (select, radio, checkbox, combobox, buttongroup): open it
  and pick the option whose text matches SET TO exactly. Do NOT settle for a
  near match. A loose match is how "I identify as a veteran, just not a
  protected veteran" gets selected for someone who is not a veteran — a false
  statement on an employer's form. If no option matches SET TO exactly, leave
  the control as it is and record it as failed with the real option list.
- For a text or textarea control: clear it, then type SET TO verbatim. Do not
  paraphrase it, do not improve it, do not extend it.
- After each one, READ THE VALUE BACK off the control and confirm it holds SET
  TO. "I typed it and nothing threw" is not evidence — react-select drops text
  on blur and the field goes back to empty.

DO NOT SUBMIT. Do not click Submit, Apply, Finish or Send. Do not advance past
the last step. Submission is a separate step that runs after this form is read
back and reviewed a second time. If you find yourself on a confirmation page,
something has gone wrong — stop and report it.

Take no snapshot to begin. Act on the selectors above; look only at a control
that failed, and look narrowly (browser_find, or a snapshot scoped to that one
field). A full-page snapshot costs more than this entire task.

Write $FIXOUT exactly once, in every case including total failure:
{"slug":"$SLUG","applied":[{"question":"","set_to":"","verified":true}],
 "failed":[{"question":"","reason":"","options_actually_offered":[]}],
 "touched_nothing_else":true,"submitted":false}

Budget: at most 60 browser actions. Connect over CDP at $CDP_ENDPOINT.
EOF
)
  echo "AGY_STEP: fix $SLUG on ${MODEL_CHAIN%%,*} -> $LOG" >&2
  run_claude "$LOG" -p "$PROMPT" \
    --model "$AGY_FILL_MODEL" --output-format json \
    --allowedTools "mcp__playwright__*,Read,Write" --max-turns 60
  rc=$?
  if [ -s "$FIXOUT" ]; then
    cat "$FIXOUT"
    # A fix step is forbidden to submit, and on 2026-08-26 one did it anyway:
    # agy set the field, then clicked Submit on impact.com and reported
    # "submitted": true in the same breath. The prompt says not to in three
    # places; a prompt is not a control. This cannot be prevented from the shell
    # (the model holds the browser), so it is at least DETECTED and shouted
    # about, and the tracker is corrected, rather than a submitted application
    # sitting untracked because the submitter never ran.
    if python3 -c "import json,sys;sys.exit(0 if (json.load(open('$FIXOUT')) or {}).get('submitted') else 1)" 2>/dev/null; then
      echo "" >&2
      echo "!!! GUARDRAIL BREACH: agy SUBMITTED $SLUG during a fix step." >&2
      echo "!!! The fix prompt forbids submitting. The application is already sent and cannot be recalled." >&2
      echo "!!! Marking it applied so the tracker matches reality, and recording it." >&2
      (cd "$ROOT" && python3 Job_applicator/mark_applied.py "$URL") >&2 || true
      printf '%s\t%s\t%s\n' "$(date -Is)" "$SLUG" "agy submitted during fix step" \
        >> "$JOBAPP/logs/guardrail-breaches.tsv"
      exit 3
    fi
    exit 0
  fi
  echo "AGY_STEP_WARN: agy wrote no $FIXOUT; see $LOG" >&2
  exit "$([ "$rc" = 0 ] && echo 1 || echo "$rc")"
fi

# ------------------------------------------------------------------- submit
# For the three embedded boards, ats_submit.mjs is the submitter and this does
# not second-guess it: it re-audits the live form, refuses an empty required
# field, a validation error or a generic resume, and refuses a slug that already
# submitted. A second submit path for those would be a second chance to send a
# duplicate application, which is the one error here that cannot be taken back.
ATS=$(python3 -c "import json;print((json.load(open('$STATUS')) or {}).get('ats',''))" 2>/dev/null)
case "$ATS" in
  greenhouse|lever|ashby)
    echo "AGY_STEP: submit $SLUG via ats_submit.mjs (re-audits the live form)" >&2
    exec node ats_submit.mjs "$SLUG" --yes
    ;;
esac

[ -s "$READBACK" ] || die "no $READBACK — read the form back and review it before submitting"
# A submit is only ever reached through a readback that reflects the form as it
# stands NOW. A fix that ran after the last readback means the approved sheet
# describes a form that no longer exists, and this is what stops "reviewed the
# form, then agy changed it, then submitted" from being possible at all.
FIXOUT="$JOBAPP/answers/$SLUG.fix.json"
if [ -s "$FIXOUT" ] && [ "$FIXOUT" -nt "$READBACK" ]; then
  die "$FIXOUT is newer than $READBACK — agy changed the form after it was last read back. Re-run readback.mjs and review again before submitting"
fi
VERDICT=$(python3 -c "import json;print((json.load(open('$CORRECTIONS')) or {}).get('verdict',''))" 2>/dev/null || echo "")
[ "$VERDICT" = "submit" ] || die "verdict in $CORRECTIONS is '${VERDICT:-none}', not 'submit' — refusing"

LOG="$JOBAPP/logs/$SLUG-submit.log"; : > "$LOG"
PROMPT=$(cat <<EOF
Submit a job application that is already filled, already read back and already
reviewed. You are non-interactive: never ask a question.

Posting: $URL
The tab holding the filled form is open. Do NOT navigate, do NOT reload, do NOT
open a new tab. Work in the tab that is already there.

Your ONLY job is to submit. Do not change a single answer. Do not re-check a
field. Do not re-upload the resume. Every answer on this form has been reviewed
and approved; touching one now means submitting something different from what
was approved.

1. Advance to the final review page if the form is not already on it.
2. Do NOT read or summarize the review page — it is long and it is not yours to
   judge. Scroll to the bottom.
3. Click Submit.
4. Confirm the submission actually landed: read the confirmation the page shows
   and record its text verbatim. A click that did not throw is not a
   submission — "We couldn't submit your application" renders in place of a
   confirmation and looks like success to anything that does not read it.

If a CAPTCHA, a verification code, or any human check stands between you and
Submit, do NOT attempt to solve or bypass it. Stop, leave the tab open, and
record what it asked for.

Update $STATUS: set "submitted" to true and "submitted_evidence" to the
confirmation text, ONLY if you saw a real confirmation. If you did not, leave
"submitted" false and put what the page said in "blocked_on". Merge into the
existing file; do not rewrite it from scratch.

Budget: at most 40 browser actions. Connect over CDP at $CDP_ENDPOINT.
EOF
)
echo "AGY_STEP: submit $SLUG on ${MODEL_CHAIN%%,*} -> $LOG" >&2
run_claude "$LOG" -p "$PROMPT" \
  --model "$AGY_FILL_MODEL" --output-format json \
  --allowedTools "mcp__playwright__*,Read,Write,Edit" --max-turns 40
rc=$?
if python3 -c "import json,sys;sys.exit(0 if (json.load(open('$STATUS')) or {}).get('submitted') else 1)" 2>/dev/null; then
  (cd "$ROOT" && python3 Job_applicator/mark_applied.py "$URL") >&2 || true
  echo "AGY_STEP: $SLUG submitted" >&2
  exit 0
fi
echo "AGY_STEP_WARN: $SLUG did not confirm a submission; see $LOG" >&2
exit "$([ "$rc" = 0 ] && echo 1 || echo "$rc")"
