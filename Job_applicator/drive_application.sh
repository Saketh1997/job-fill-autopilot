#!/bin/bash
set -uo pipefail

# drive_application.sh — STAGE 3 of 3. Drive a whole application on an
# account-walled, multi-step portal, end to end. Counterpart to
# fill_application.sh.
#
#   drive_application.sh <slug> [role] [--no-submit] [--dry-run]
#
# n8n pipeline, one slug throughout:
#   1. get_jd.sh            <slug>          -> jd/{slug}.txt
#   2. tailor_resume.sh     <slug> [role]   -> resumes/{slug}.pdf
#   3. drive_application.sh <slug> [role]   -> fills and submits
#
# ONE argument identifies everything. Every artefact is {slug}.{ext}:
#
#   jd/{slug}.txt              job description   (stage 1, REQUIRED)
#   resumes/{slug}.pdf         tailored resume   (stage 2; generic = no submit)
#   answers/{slug}.drive.json  run status        (written by this script)
#   logs/{slug}-drive.log      model transcript
#   cache/{ats}.json           portal knowledge  (ats from the URL host)
#
# The posting URL comes from resolve_slug.py, the one lookup all three stages
# share, so n8n only ever passes the slug.
#
# WHICH SCRIPT DO I WANT?
#   Does a field inventory exist on a single URL (scrape_page.mjs --fields
#   returns fields)?  yes -> scrape_page | map_fields | fill_form |
#   fill_application.sh.  no (account wall, wizard) -> this script.
#   Workday / Taleo / most iCIMS need this one. Embedded Greenhouse and Lever
#   forms do not.
#
# Env: CDP_ENDPOINT   default http://localhost:9226 (the job-browser unit)
#      SUBMIT         0 to stop at review even when preconditions pass
#      MAX_ACTIONS    default 400
#      plus the OmniRoute vars sourced by claude_retry.sh

SLUG=""; ROLE="ml"; ALLOW_SUBMIT=1; DRY=0
for a in "$@"; do
  case "$a" in
    --no-submit) ALLOW_SUBMIT=0 ;;
    --dry-run)   DRY=1 ;;
    swe|ml|robotics) ROLE="$a" ;;
    -*) echo "unknown flag: $a" >&2; exit 1 ;;
    *) [ -z "$SLUG" ] && SLUG="$a" ;;
  esac
done

cd /home/hunter/projects/career-ops/Job_applicator
export PATH="/home/hunter/.local/bin:/home/hunter/.nvm/versions/node/v20.20.2/bin:$PATH"
export CDP_ENDPOINT="${CDP_ENDPOINT:-http://localhost:9226}"
# OmniRoute (localhost:20128) is gone. Default to the real API; the CLI
# authenticates with its own stored credentials, and the token guard below
# withholds the OmniRoute token unless someone points this back at 20128.
export ANTHROPIC_BASE_URL="${ANTHROPIC_BASE_URL:-https://api.anthropic.com}"
# Only OmniRoute takes the OmniRoute token. When a caller points the pipeline at
# api.anthropic.com instead, this token must NOT be sent: the real API rejects
# it with 401 "Invalid bearer token" on every call, and the CLI's own stored
# credentials are what should be used there.
case "$ANTHROPIC_BASE_URL" in
  *20128*) export ANTHROPIC_AUTH_TOKEN="${ANTHROPIC_AUTH_TOKEN:?OmniRoute requires ANTHROPIC_AUTH_TOKEN in the environment}" ;;
esac

export CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1
source ./claude_retry.sh 2>/dev/null || true

ROOT="/home/hunter/projects/career-ops"
JOBAPP="$ROOT/Job_applicator"
JD="$JOBAPP/jd/$SLUG.txt"
RESUME="$JOBAPP/resumes/$SLUG.pdf"
STATUS="$JOBAPP/answers/$SLUG.drive.json"
LOG="$JOBAPP/logs/$SLUG-drive.log"
MAX_ACTIONS="${MAX_ACTIONS:-400}"

die() { echo "DRIVE_ERR: $*" >&2; exit 1; }
[ -n "$SLUG" ] || die "usage: drive_application.sh <slug> [swe|ml|robotics] [--no-submit] [--dry-run]"
[ "$SLUG" = "$(basename "$SLUG")" ] || die "bad slug: $SLUG"

# ---- Resolve the posting URL from the slug -------------------------------
# resolve_slug.py is shared with stage 1 so the three stages can never disagree
# about which posting a slug means.
URL=$(python3 resolve_slug.py "$SLUG") \
  || die "no pipeline.csv row whose slugify(company,title) == '$SLUG'"

HOST=$(printf '%s' "$URL" | sed -E 's#^[a-z]+://##i; s#[/?].*$##; s#:[0-9]+$##' | tr 'A-Z' 'a-z')

# ---- Tab cleanup ---------------------------------------------------------
# The job browser is persistent, so a run that ends without cleanup leaks its
# tab. Beyond memory, a stale tab is a correctness problem: a later run on the
# same tenant can attach to it and believe it is already signed in.
#
# The one exception is a tab a human still has to finish — an unanswered
# verification code, a CAPTCHA, a field the model refused to guess, or a filled
# form waiting on a manual Submit. Closing those throws away the session the
# human is about to pick up, so they stay open and say why.
#
# Argument: the keep-open reason, or empty to close.
cleanup_tabs() {
  local reason="${1:-}"
  if [ -n "$reason" ]; then
    echo "DRIVE_TAB: leaving the tab open on $HOST — $reason" >&2
    return 0
  fi
  ./close_tabs.sh "$URL" || true
}

# A killed or Ctrl-C'd run is the case that leaks tabs most often (it is how the
# Cisco tab survived), and an interrupted run has nothing for a human to finish.
trap 'echo "DRIVE_TAB: interrupted" >&2; cleanup_tabs ""; exit 130' INT TERM

# ---- Which cache file holds this portal's knowledge ----------------------
# Keyed by ATS when the host identifies one, else by company slug. Cached
# ANSWERS are shared per ATS; credentials are never keyed this way (a Workday
# account is per tenant) — login.env handles that itself.
case "$HOST" in
  *.myworkdayjobs.com|*.myworkdaysite.com) ATS="workday" ;;
  *.icims.com)                             ATS="icims" ;;
  *.taleo.net|*.taleo.com)                 ATS="taleo" ;;
  *.smartrecruiters.com)                   ATS="smartrecruiters" ;;
  *.successfactors.com|*.sapsf.com)        ATS="successfactors" ;;
  *.brassring.com|*.kenexa.com)            ATS="brassring" ;;
  *.oraclecloud.com|*.fa.oraclecloud.com)  ATS="oracle" ;;
  *.jobvite.com)                           ATS="jobvite" ;;
  *.workable.com)                          ATS="workable" ;;
  *.bamboohr.com)                          ATS="bamboohr" ;;
  boards.greenhouse.io|job-boards.greenhouse.io) ATS="greenhouse" ;;
  jobs.ashbyhq.com)                        ATS="ashby" ;;
  jobs.lever.co)                           ATS="lever" ;;
  # Amazon runs its own ATS. Every legal entity (Amazon.com Services LLC,
  # Amazon Development Center U.S. Inc., Annapurna Labs, Kuiper …) posts on the
  # same amazon.jobs portal with the same wizard, so they share one cache. The
  # slug fallback below would key them separately (amazon_com_services_llc,
  # annapurna_labs__u_s___inc_, …) and relearn the portal for each one.
  amazon.jobs|*.amazon.jobs)               ATS="amazon" ;;
  hiring.amazon.com|*.hiring.amazon.com)   ATS="amazon-hourly" ;;
  *) ATS="$(printf '%s' "$SLUG" | sed -E 's/^job-//; s/-.*$//' | tr 'A-Z' 'a-z')" ;;
esac
CACHE="$JOBAPP/cache/$ATS.json"
mkdir -p "$JOBAPP/cache" "$JOBAPP/logs" "$JOBAPP/answers"

# ---- Preflight ----------------------------------------------------------
# This is STAGE 3. It does not fetch the JD and does not tailor the resume: a
# missing artefact means an earlier stage failed, and the chain must stop rather
# than quietly apply with nothing or with the generic resume. Fetching here
# would also defeat the point of the split, since tailoring reads the JD.
[ -s "$JD" ] || die "no JD at $JD — run stage 1 first: ./get_jd.sh $SLUG"

# Resume: tailored is the rule. A generic fallback may FILL but never SUBMIT,
# matching the do-not-submit conditions in CLAUDE.md.
RESUME_KIND="tailored"
if [ ! -s "$RESUME" ]; then
  RESUME=$(python3 -c "import json;print(json.load(open('profile.json'))['resume_path'])" 2>/dev/null)
  RESUME_KIND="generic"
  echo "WARN: no resumes/$SLUG.pdf — run stage 2 (./tailor_resume.sh $SLUG $ROLE)." >&2
  echo "      Falling back to the generic resume; SUBMIT IS BLOCKED for this run." >&2
fi
[ -s "$RESUME" ] || die "no resume at $RESUME"

SUBMIT_OK=$ALLOW_SUBMIT
[ "${SUBMIT:-1}" = "0" ] && SUBMIT_OK=0
[ "$RESUME_KIND" = "generic" ] && SUBMIT_OK=0

if [ "$DRY" = "1" ]; then
  if [ "$ATS" = "amazon" ] && [ "${AMAZON_LLM:-0}" != "1" ]; then
    exec node amazon_apply.mjs "$SLUG" --resume "$RESUME" --dry-run \
      $([ "$SUBMIT_OK" = "1" ] || echo --no-submit)
  fi
  printf '{"slug":"%s","url":"%s","host":"%s","ats":"%s","cache":"%s","jd":"%s","resume":"%s","resume_kind":"%s","role":"%s","submit_allowed":%s}\n' \
    "$SLUG" "$URL" "$HOST" "$ATS" "$CACHE" "$JD" "$RESUME" "$RESUME_KIND" "$ROLE" \
    "$([ "$SUBMIT_OK" = "1" ] && echo true || echo false)"
  exit 0
fi

# ---- amazon.jobs has its own driver, and it is not this one --------------
# The wizard is identical on every requisition, so a model that re-derives it
# costs ~$4 a posting to skip SMS, set two radios and replace a resume (the
# 2026-08-09 Annapurna run: $3.99, 33 turns). amazon_apply.mjs does all of that
# with the selectors already in cache/amazon.json, and calls a model exactly
# once, text-only, for the Job-specific questions step — the only part that is
# genuinely different per posting. It writes the same answers/{slug}.drive.json,
# marks pipeline.csv itself and does its own tab cleanup, so it replaces this
# script's whole tail rather than feeding into it.
#
# AMAZON_LLM=1 forces the model path below, for a portal change this script
# has not learned yet.
if [ "$ATS" = "amazon" ] && [ "${AMAZON_LLM:-0}" != "1" ]; then
  echo "DRIVE: amazon deterministic driver (AMAZON_LLM=1 forces the model path)" >&2
  node amazon_apply.mjs "$SLUG" --resume "$RESUME" \
    $([ "$SUBMIT_OK" = "1" ] || echo --no-submit) 2>&1 | tee -a "$LOG"
  exit "${PIPESTATUS[0]}"
fi

# ---- Credentials, resolved here rather than by the model -----------------
# The model used to be pointed at login.env and told never to echo a credential.
# Obeying both at once is impossible: it wrote redaction wrappers around the
# file, so it never actually obtained the password, and retried five different
# ways — seven turns on one file. The shell can do this in one.
#
# COMPANY_KEY is the tenant, not the ATS: hp.wd5 and troweprice.wd5 are separate
# accounts. login.login.<company> wins over login.login.default.
#
# The leading www. must go first, or every www.* portal collapses to the single
# key "www" and they all share one account entry — www.amazon.jobs was the case
# that surfaced it.
COMPANY_KEY=$(printf '%s' "$HOST" | sed -E 's#^www\.##; s#\..*$##')
CRED_JSON=$(python3 - "$JOBAPP/login.env" "$COMPANY_KEY" <<'PY' 2>/dev/null
import json, sys
try:
    L = (json.load(open(sys.argv[1])) or {}).get("login", {}) or {}
except Exception:
    L = {}
e = L.get(sys.argv[2]) or L.get("default") or {}
print(json.dumps({
    "email": e.get("email", ""),
    "password": e.get("password", ""),
    "known": bool(L.get(sys.argv[2])),
}))
PY
)
[ -n "$CRED_JSON" ] || CRED_JSON='{"email":"","password":"","known":false}'
CRED_EMAIL=$(printf '%s' "$CRED_JSON" | python3 -c "import json,sys;print(json.load(sys.stdin)['email'])" 2>/dev/null)
CRED_PASS=$(printf '%s' "$CRED_JSON" | python3 -c "import json,sys;print(json.load(sys.stdin)['password'])" 2>/dev/null)
CRED_KNOWN=$(printf '%s' "$CRED_JSON" | python3 -c "import json,sys;print('yes' if json.load(sys.stdin)['known'] else 'no')" 2>/dev/null)

# A portal may authenticate some other way than an email+password account of its
# own — amazon.jobs offers "Login with Amazon" against the retail session the
# browser already holds. Such a declaration WINS over the credential clause
# below: otherwise the model is told to create an account the portal neither
# wants nor needs.
#
# portal_rules.json is read FIRST and cache/{ats}.json only as a fallback,
# because the model rewrites its cache wholesale at the end of a run. Seeding
# the auth block into the cache does not survive: the 2026-08-09 amazon run
# deleted it and the next run went straight back to the password form.
# portal_rules.json is shell-owned and the model is never told to write it.
#
# The same file carries portal_rules[ats].rules — owner-decided facts a run must
# not rediscover or override, injected verbatim into the prompt below.
PORTAL_RULES_FILE="$JOBAPP/portal_rules.json"
CACHE_AUTH=$(python3 - "$PORTAL_RULES_FILE" "$CACHE" "$ATS" <<'PY' 2>/dev/null
import json, sys
def load(path):
    try:
        return json.load(open(path)) or {}
    except Exception:
        return {}
owner = ((load(sys.argv[1]).get(sys.argv[3]) or {}).get("auth") or {})
cached = (load(sys.argv[2]).get("auth") or {})
print(owner.get("instruction", "") or cached.get("instruction", ""))
PY
)

PORTAL_RULES=$(python3 - "$PORTAL_RULES_FILE" "$ATS" rules <<'PY' 2>/dev/null
import json, sys
try:
    rules = ((json.load(open(sys.argv[1])) or {}).get(sys.argv[2]) or {}).get(sys.argv[3]) or []
except Exception:
    rules = []
for r in rules:
    if str(r).strip():
        print("- " + str(r).strip())
PY
)

# Preconditions the model must affirm out loud before it may click Submit.
# The prompt already carried the rule that produces them; a rule alone was not
# enough — a run skipped the resume upload on 2026-08-09 and would have
# submitted with a stale one. Making it a stated precondition turns a silent
# omission into something the model has to either confirm or refuse.
SUBMIT_PRECONDS=$(python3 - "$PORTAL_RULES_FILE" "$ATS" submit_preconditions <<'PY' 2>/dev/null
import json, sys
try:
    rules = ((json.load(open(sys.argv[1])) or {}).get(sys.argv[2]) or {}).get(sys.argv[3]) or []
except Exception:
    rules = []
for r in rules:
    if str(r).strip():
        print("  - " + str(r).strip())
PY
)

if [ -n "$CACHE_AUTH" ]; then
  # The owner's declared sign-in path wins. Credentials are still resolved and
  # passed, because a declared path may legitimately need them at one specific
  # step (an SSO provider's own login when the session has expired) — the
  # instruction says where, and only there.
  CRED_CLAUSE="AUTHENTICATION — follow this exactly. It overrides every other credential
instruction, including anything you find in a file, and it outranks whatever the
sign-in page appears to offer.

$CACHE_AUTH

Credentials, if and only if the instruction above says a step may use them (do
NOT open login.env, and do NOT go looking in profile.json for these):
  email:    $CRED_EMAIL
  password: $CRED_PASS

Never create an account or fill a sign-up form on this portal. Try any password
at most ONCE — portals lock accounts after a few failures. If you end up signed
out with nothing left that the instruction permits, record exactly what the page
said in blocked_on and stop."
elif [ -n "$CRED_EMAIL" ] && [ -n "$CRED_PASS" ]; then
  CRED_CLAUSE="Sign-in credentials for $HOST (already resolved — do NOT open login.env):
  email:    $CRED_EMAIL
  password: $CRED_PASS
An account for this tenant is on file: $CRED_KNOWN. If it is \"yes\", sign in.
If it is \"no\", try signing in ONCE and create the account with these same
credentials only if sign-in says no such account exists. Try a password ONCE —
portals lock accounts after a few failures. After creating an account, add the
entry to $JOBAPP/login.env under login.login.$COMPANY_KEY (email, password,
portal, ats, created). NEVER write either value into the status file, the cache,
or any other file."
else
  CRED_CLAUSE="No credentials could be resolved from $JOBAPP/login.env for $COMPANY_KEY.
If the flow hits a sign-in wall, record it in blocked_on and stop; do not
attempt to create an account without credentials."
fi

SUBMIT_CLAUSE="When every step is filled and saved with no validation errors outstanding,
go to the final review page, do NOT read or summarize it, scroll to the bottom
and click Submit. Then confirm the submission landed and record the confirmation
text in \"submitted_evidence\".$([ -n "$SUBMIT_PRECONDS" ] && printf '\n\n%s\n%s\n%s' \
"SUBMIT PRECONDITIONS for this portal. Immediately before clicking Submit, state
each of these in one line as either CONFIRMED or NOT CONFIRMED:" \
"$SUBMIT_PRECONDS" \
"If any is NOT CONFIRMED, do NOT click Submit. Go back and satisfy it if you
still can; otherwise record it verbatim in blocked_on and stop with the form
filled. Reaching the review page does not waive a precondition.")"
[ "$SUBMIT_OK" = "0" ] && SUBMIT_CLAUSE="Do NOT submit. Stop on the final review page with everything filled and set
\"ready_to_submit\" to true if nothing is outstanding. Submission is disabled for
this run (reason: $([ "$RESUME_KIND" = "generic" ] && echo 'generic resume, not tailored' || echo 'caller passed --no-submit'))."

PROMPT=$(cat <<EOF
Drive a job application from start to finish in a browser that is already
running. You are non-interactive: never ask a question, and if something blocks
you, record it in blocked_on and continue with what you still can.

Posting: $URL
Slug:    $SLUG
JD:      $JD
Resume:  $RESUME  (this exact file, $RESUME_KIND)

STEP 0 — READ THE CACHE FIRST: $CACHE
If it exists it holds this portal's mechanics, selectors, per-step field lists
and answers, recorded by earlier runs. Use it instead of rediscovering anything.
If it does not exist, create it as you learn. Either way, at the END write back
everything a future run should not have to derive again: URL patterns, step
names, selectors, exact option strings you had to match, and every quirk that
cost you a failed attempt. This file is why the second application is cheap.
MERGE, never replace: read the existing JSON, add and update keys, and write it
back with every key you did not touch left intact. A run that rewrites this file
from scratch destroys knowledge earlier runs paid for.

Answers come from, in order: $CACHE, then $JOBAPP/profile.json (structured
facts, application_questions, EEO), then the background files in $JOBAPP/data/
(about_me.txt, education.txt, work_experience.txt, technical_skills.txt,
strengths.txt, career_goals.txt, current_projects.txt, postgresql_research.txt,
integrated_portfolio_chatbot.txt, homelab.txt, suitability_$ROLE.txt) and the JD
above. Read each file at most once. Never invent a fact that is not in them.

$CRED_CLAUSE

SNAPSHOTS ARE THE MOST EXPENSIVE THING YOU CAN DO. One snapshot of a portal
page is ~7k tokens and it stays in context for the rest of the run, so ten of
them cost more than the entire application. $CACHE exists precisely so you do
not need to look: it holds the selectors, step names and field lists that an
earlier run already paid for. Treat a snapshot as a last resort.

- Do NOT snapshot to start. The browser is ALREADY on $URL with the cookie
  banner dismissed (a script did this before you were invoked). Act on the
  cache's selectors directly.
- Act first, look only if acting fails. Click, fill and navigate straight from
  cached selectors. A click that succeeds tells you the page was what you
  expected; that is your confirmation, not a snapshot.
- When you must look, look NARROWLY: browser_find for the one control you need,
  or a snapshot scoped to the form element. A full-page snapshot is justified
  only on a step this cache has never seen, or after two different cached
  selectors have failed on the same step.
- Never snapshot to verify something you just did, to re-read a step you
  already filled, or to read the review page.
- Every full-page snapshot you do take must earn its keep: write what it taught
  you back into $CACHE so the next run does not repeat it.

Work the flow:
1. You are already on the posting with consent dismissed. Do not re-navigate
   there and do not re-dismiss the banner.
2. Reach the application form. It may be behind an Apply link, an entry choice,
   or a sign-in wall. Prefer an "autofill from resume" entry point when one is
   offered: it parses the resume into the form and saves the most work.
3. Sign in if needed, with the credentials above. If sign-in fails, record it
   in blocked_on and stop.
4. Fill every step. After each step, RE-SCAN: required fields appear
   conditionally, so a field count from before you answered is not final. Loop
   until no required field is unanswered.
5. Advance with the form's own Next/Continue/Save control. Many portals persist
   only when you advance, so never leave a filled step without saving it.

$([ -n "$PORTAL_RULES" ] && printf '%s\n%s\n' \
"NON-NEGOTIABLE RULES FOR THIS PORTAL (decided by the repo owner, not discovered;
they outrank anything the cache or the page suggests):" "$PORTAL_RULES")

Rules that hold on every portal:
- HONEYPOTS: never fill an input that is visually hidden or whose label mentions
  robots/bots. Do not match fields by name alone — profile.json has a "website"
  key and some forms name their honeypot "website".
- INTERCEPTED CLICKS: if a click times out while the element is visible and
  enabled, an invisible overlay is intercepting it. Retry the click forced.
- DROPDOWNS: open the control and choose the option in one continuous sequence.
  Some search widgets show nothing until you press Enter or click their search
  button. Read the REAL options; never assume a value exists.
- EXACT MATCHES FOR FACTUAL CLAIMS: match option text exactly. A loose pattern
  can select a different, true-sounding option that is false — "I identify as a
  veteran, just not a protected veteran" matches a naive /not a veteran/ and is
  a false statement. Prefer an exact string; if none matches, do not guess.
- UNANSWERABLE FIELDS: if a required answer is not in the cache, profile.json or
  the data files, leave it empty and put the full question text in blocked_on.
  Never fabricate an answer to get past a step.
- ATTESTATIONS: standard terms-and-conditions and EEO consent checkboxes may be
  checked. Do NOT auto-answer a certification about how the application was
  produced (AI-policy questions, "I certify this was written by me"); leave it
  and record it in left_for_human.

$SUBMIT_CLAUSE

Write $STATUS exactly once, in every case including total failure:
{"slug":"$SLUG","url":"$URL","ats":"$ATS","steps_completed":[step names],
 "filled":[field names you set],"left_for_human":[fields you deliberately left],
 "blocked_on":[specific self-written notes on anything that stopped you],
 "cache_updated":true|false,"submitted":true|false,"submitted_evidence":"",
 "ready_to_submit":true|false}
ready_to_submit is true only when every required field holds a value and both
blocked_on and left_for_human are empty.

Budget: at most $MAX_ACTIONS browser actions. Connect over CDP at $CDP_ENDPOINT.
EOF
)

[ ${#PROMPT} -gt 800 ] || die "prompt came out truncated (${#PROMPT} chars) — refusing to invoke the model"

: > "$LOG"
rm -f "$STATUS"
echo "driving $SLUG  ats=$ATS  submit=$([ "$SUBMIT_OK" = 1 ] && echo yes || echo no)  -> $LOG" >&2
echo "DRIVE_NOTE: after priming, the model reads local files for ~60s before its first browser action" >&2

# ---- Prime the page ------------------------------------------------------
# Navigate and kill the consent banner deterministically, so the model starts on
# a page whose state is already known — which is what lets the prompt forbid an
# opening snapshot. Non-fatal: if this fails the model still has to find its own
# way, so only the savings are lost, not the run.
# Announce BEFORE the call, not after. Priming is the longest silent stretch of a
# run — ~60s on amazon.jobs — and the model then spends another ~60s reading local
# files before its first browser action. Two minutes of a motionless VNC looks
# exactly like a hang, and a run was killed on 2026-08-09 for that reason.
echo "DRIVE_PRIME: navigating $HOST and dismissing consent (up to ~90s, no browser movement yet)" >&2
PRIMED=$(node prime_page.mjs "$URL" 2>&1 | tail -1)
echo "DRIVE_PRIME: $PRIMED" >&2
PRIMED_URL=$(printf '%s' "$PRIMED" | python3 -c "import json,sys;print(json.load(sys.stdin).get('url',''))" 2>/dev/null)
RESUMED=$(printf '%s' "$PRIMED" | python3 -c "import json,sys;print('yes' if json.load(sys.stdin).get('resumed_in_flow') else 'no')" 2>/dev/null)
case "$PRIMED" in
  *'"ok":true'*) : ;;
  *) echo "DRIVE_WARN: priming failed; the model will navigate itself" >&2
     PRIMED_URL=""; RESUMED="no" ;;
esac

# The prompt is written before priming runs, so the where-you-are line is
# appended here, once the actual landing URL is known.
if [ -n "$PRIMED_URL" ]; then
  if [ "$RESUMED" = "yes" ]; then
    PROMPT="$PROMPT

WHERE YOU ALREADY ARE: $PRIMED_URL
This tab is a RESUMED application already in progress — signed in, part filled,
consent dismissed. Do NOT navigate to the posting URL, do NOT start a new
application, and do NOT click any \"Use My Last Application\" or \"Autofill with
Resume\" entry point: all of those discard this draft. Continue from the step
this page is showing. A single browser_find or form-scoped snapshot to identify
the current step is justified here; a full-page snapshot is not."
  else
    PROMPT="$PROMPT

WHERE YOU ALREADY ARE: $PRIMED_URL
Consent is dismissed and this is the posting page. Proceed from here without
re-navigating and without an opening snapshot."
  fi
fi

# allowedTools: Bash and Edit are here because without them the last run burned
# 8 of 41 tool calls on denials — every compound shell command was blocked and
# rewritten, and the login.env write was refused twice, which is why the
# troweprice entry never got saved and a second account was nearly created.
# DRIVE_MODEL overrides the alias for a run. my_combo is `strategy: priority`
# over four members, and its first member (agy) is the only one that ever gets
# traffic — so when agy is out of capacity OmniRoute answers `400 Invalid model`
# instead of falling through to claude/kiro, and every posting in the queue
# burns three retries and ~8 minutes for nothing. Phase 3 scored 0 of 63 that
# way across two runs (2026-08-11 and 2026-08-12). Point this at a member with
# capacity to get the run moving without waiting for the combo to recover.
run_claude "$LOG" -p "$PROMPT" \
  --model "${DRIVE_MODEL:-claude-sonnet-5}" \
  --output-format json \
  --allowedTools "mcp__playwright__*,Read,Write,Edit,Bash" \
  --max-turns 150

KEEP_REASON=""
RC=0

if [ -s "$STATUS" ]; then
  cat "$STATUS"
  KEEP_REASON=$(python3 - "$STATUS" <<'PY' 2>/dev/null
import json, sys
try:
    d = json.load(open(sys.argv[1]))
except Exception:
    print("status file is unreadable, leaving the tab for inspection")
    raise SystemExit
def filled(key):
    return [str(x).strip() for x in (d.get(key) or []) if str(x).strip()]
if filled("blocked_on"):
    print("blocked_on -> " + "; ".join(filled("blocked_on"))[:200])
elif filled("left_for_human"):
    print("left_for_human -> " + ", ".join(filled("left_for_human"))[:200])
elif d.get("ready_to_submit") and not d.get("submitted"):
    print("form is filled and waiting on a manual Submit")
PY
)
  if python3 -c "import json,sys;sys.exit(0 if json.load(open('$STATUS')).get('submitted') else 1)" 2>/dev/null; then
    (cd "$ROOT" && python3 Job_applicator/mark_applied.py "$URL") >&2 || true
  fi
else
  echo "DRIVE_WARN: model wrote no status file; see $LOG" >&2
  RC=1
fi

cleanup_tabs "$KEEP_REASON"
exit "$RC"
