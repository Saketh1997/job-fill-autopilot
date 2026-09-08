#!/bin/bash
set -uo pipefail

# linkedin-draft.sh -- headless "contacto" mode: find the hiring manager /
# recruiter / peer for a posting via WebSearch and draft a <=300-char LinkedIn
# connection note. NEVER sends anything -- this script has no send-capable
# tool in its allowlist. Output is a queue entry with status pending_approval
# (or needs_review if no confident contact was found); linkedin-send.sh is a
# separate script that requires status approved before it will touch a
# browser.
#
#   linkedin-draft.sh <slug> <company> <role> <jd_url>
#
# Writes:
#   answers/{slug}-linkedin.json      raw model result (debugging)
#   data/linkedin-outreach-queue.json upserted entry (via linkedin_queue.py)
#
# Prints the final queue entry JSON to stdout -- an n8n Execute Command node
# can capture this directly and post it to Discord for approval.

SLUG="${1:-}"
COMPANY="${2:-}"
ROLE="${3:-}"
JD_URL="${4:-}"

cd /home/hunter/projects/career-ops/Job_applicator
export PATH="/home/hunter/.local/bin:/home/hunter/.nvm/versions/node/v20.20.2/bin:$PATH"
source ./claude_retry.sh

ROOT="/home/hunter/projects/career-ops"
CV="$ROOT/cv.md"
PROFILE="$ROOT/config/profile.yml"

die() { echo "{\"slug\": \"$SLUG\", \"error\": \"$*\"}" >&2; exit 1; }

[ -n "$SLUG" ]    || die "usage: linkedin-draft.sh <slug> <company> <role> <jd_url>"
[ -n "$COMPANY" ] || die "usage: linkedin-draft.sh <slug> <company> <role> <jd_url>"
[ -n "$ROLE" ]    || die "usage: linkedin-draft.sh <slug> <company> <role> <jd_url>"
[ -n "$JD_URL" ]  || die "usage: linkedin-draft.sh <slug> <company> <role> <jd_url>"

# ABSOLUTE, not relative. The prompt tells the model to write this path, and a
# relative one resolves against whatever cwd the model's own runtime happens to
# use: Claude Code inherits this script's cwd (Job_applicator) and lands it
# correctly, agy resolved it against the repo root and then against $HOME. On
# 2026-08-26 that silently sent 14 redrafts to career-ops/answers/ and
# /home/hunter/answers/ -- the research all succeeded, every one was reported as
# "draft failed", and the work was only found by reading the transcript.
JOBAPP_ANSWERS="/home/hunter/projects/career-ops/Job_applicator/answers"
RESULT="$JOBAPP_ANSWERS/$SLUG-linkedin.json"
LOG="logs/$SLUG-linkedin-draft.log"
mkdir -p answers logs
rm -f "$RESULT"
: > "$LOG"

# Who is already spoken for at this employer. Two things this must get right,
# and the previous substring compare got both wrong:
#
#   - one employer wearing several legal names is one employer. "Amazon" and
#     "Amazon.com Services LLC" compared as different companies, and Amit
#     Bawaskar was messaged under both.
#   - a short company name must not swallow a longer one. `"zip" in "zipline"`
#     is true, which would silently exclude Zipline's contacts from a Zip draft.
#
# So both sides are normalised to a comparable key and matched on EQUALITY.
ALREADY_CONTACTED=$(python3 - "$ROOT/data/linkedin-outreach-queue.json" "$COMPANY" <<'PY' 2>/dev/null || echo "None"
import json, os, re, sys

def co_key(s):
    s = (s or "").lower().replace(".", " ").replace(",", " ")
    s = re.sub(r"\b(inc|llc|ltd|corp|corporation|co|company|gmbh|plc|sa|nv|ag|holdings"
               r"|group|labs|technologies|technology|services|solutions|systems"
               r"|international|global|usa|us|web services|com)\b", " ", s)
    return re.sub(r"[^a-z0-9]+", "", s)

path, company = sys.argv[1], sys.argv[2]
q = json.load(open(path)) if os.path.exists(path) else []
want = co_key(company)
# Anyone reached or queued to be reached is off limits. A rejected or failed
# draft is not: that person was never actually contacted.
SPOKEN = {"sent", "approved", "connected", "pending_approval"}
out = []
for r in q:
    if not want or co_key(r.get("company")) != want:
        continue
    if str(r.get("status")) not in SPOKEN:
        continue
    name = r.get("contact_name")
    if name:
        out.append(f'{name} ({r.get("contact_profile_url") or "no url"}, status: {r.get("status")})')
print("; ".join(out) if out else "None")
PY
)

PROMPT=$(cat <<EOF
Draft LinkedIn outreach for this job application. Never invent a person, a
title, or a profile URL -- if WebSearch does not turn up a confident match,
leave the contact fields null rather than guessing.

Company: $COMPANY
Role: $ROLE
Job posting: $JD_URL
Previously contacted/queued at this company: $ALREADY_CONTACTED

Steps:
1. Read $CV for the candidate's proof points (MS in CS with Minor in AI from Oregon State University, COMPLETED on June 10, 2026; candidate is a graduate/alumnus, NOT currently pursuing or a current student).
2. Find the best contact at $COMPANY, working DOWN this preference ladder and
   stopping at the first tier that yields a real, currently-employed person:
     Tier 1. An Oregon State University (OSU) alumnus/alumna on or next to the
             team that owns $ROLE. Search:
             site:linkedin.com/in/ "$COMPANY" "Oregon State University" OR "Oregon State"
     Tier 2. An OSU alumnus/alumna anywhere at $COMPANY.
     Tier 3. A non-alumni in-house recruiter, engineering manager, tech lead or
             team peer who owns or sits next to $ROLE.
   COMMIT TO A CONTACT. Tiers 2 and 3 are real answers, not failure modes. A
   draft that comes back with contact_name null because no OSU alumnus could be
   confirmed is the WORST outcome available: it means nobody is contacted for
   this posting at all. Only return null when the search genuinely surfaced no
   named, currently-employed person at $COMPANY — and if you found people good
   enough to list in alt_targets, then by definition you found a contact, so
   promote the best one instead of listing it.
   Say which tier you used, and why that person over the alternatives, in
   "selection_rationale".
   CRITICAL EXCLUSION: anyone listed under 'Previously contacted/queued at this
   company' is off limits. Pick someone else. This is checked mechanically after
   you answer and a repeat will be rejected, so selecting one wastes the run.
   Record the evidence for the alumni claim (degree and years as their profile states them)
   in "alumni_evidence". No evidence means is_alumni is false, whatever the search summary implied.
   Never invent a person, a title or a profile URL. A contact you cannot link to
   a real linkedin.com/in/ URL is not a contact.
3. Classify the chosen contact as one of: recruiter, hiring_manager, peer, interviewer.
4. Judge "referral_power" -- can THIS person actually put a name forward for $ROLE?
   - "high": an engineer, engineering manager, tech lead, director or in-house recruiter
     at $COMPANY, on or next to the team that owns $ROLE, currently employed there.
     These are the people whose referral reaches the hiring team.
   - "low": at $COMPANY but far from this role (different function, different
     product, very junior, or an intern), so a referral would carry little weight.
   - "none": no longer at $COMPANY, or a third-party/agency recruiter.
   Say why in one sentence in "referral_rationale". Do not inflate this: a wrong
   "high" spends a finite InMail credit on someone who cannot help.
4b. CHOOSE THE ASK FROM THE CONTACT TYPE. Referrals are an employee-to-employee
   favour, so asking the wrong person for one reads as though the candidate does
   not understand how hiring works. Match the ask to the person:
   - contact_type "recruiter": DO NOT ask for a referral. This person owns the
     requisition; referring is not a thing they do. Ask them to take a look at the
     application that is already in, or for a short conversation about the role and
     what they are screening for. Example shape: "I applied for $ROLE last week --
     would you be open to taking a look, or to a quick chat about what the team needs?"
   - contact_type "hiring_manager": DO NOT ask for a referral either. They are the
     person who would interview him, not refer him. Ask for a brief conversation
     about the role or the team.
   - contact_type "peer" or "interviewer" (an engineer, tech lead or IC on or beside
     the team): a referral ask IS appropriate. Ask it plainly, e.g. "would you be
     open to referring me?"
   Whatever the type, the ask must be one clear sentence and easy to say yes to.
   Put the ask you chose, verbatim, in "ask_used" so it can be checked.
4c. VERIFY CURRENT EMPLOYMENT BEFORE YOU COMMIT TO A CONTACT. The person must be
   working at $COMPANY RIGHT NOW. Their LinkedIn headline or current-position entry
   must show $COMPANY with no end date. If the profile shows they have moved on, if
   the most recent role is at a different employer, or if you cannot establish it
   either way, DISCARD that person and go to the next candidate. Do not soften this
   by writing the note as though they were still there. State the evidence for
   current employment in one sentence in "current_employment_evidence"; if you have
   no such evidence, that person is not a valid contact.
5. Choose the channel:
   - "inmail" ONLY when is_alumni is true AND referral_power is "high". This spends
     one of a limited number of Premium InMail credits, so it must earn it.
   - "connect" in every other case.
6. Draft BOTH of these, always, whichever channel you chose:
   a. "message" -- the <=300-character connection note. If is_alumni is true it
      opens on the shared OSU connection; if is_alumni is FALSE it must NOT
      imply a shared school, a shared employer or any other tie that does not
      exist -- open on the role and the work instead. Either way it mentions
      having completed his MS in CS at Oregon State on June 10th (or recently finished MS in CS), names $ROLE and says the application is already in, gives ONE
      concrete proof point from $CV, and makes THE ASK THAT FITS THE CONTACT TYPE
      (see step 4b -- do NOT ask a recruiter or a hiring manager to refer you).
      HARD LIMIT 300 characters,
      counted exactly. No corporate-speak, no em dashes. NEVER state he is currently a student or pursuing a degree.
   b. "inmail_subject" and "inmail_body" -- the full mail, for the InMail channel.
      - Subject: <=200 characters, specific, names the role and the OSU tie.
        Not "Hello" and not a subject line that could be sent to anyone.
      - Body: 900-1600 characters, plain text, in the candidate's own voice
        (natural and direct, no em dashes, no corporate filler). Structure it:
        greeting by first name; the OSU connection mentioning MS in CS completed June 10, 2026;
        one sentence on what the candidate applied to and when; two or three
        sentences of the most relevant proof from $CV for THIS role, concrete
        and quantified where $CV supports it; an explicit, easy-to-say-yes-to
        ask CHOSEN BY CONTACT TYPE per step 4b; a thank-you and the candidate's name. Offer to send
        the resume rather than pasting it. Every factual claim must come from
        $CV -- invent nothing about either person.
7. Also list 2-3 alternative targets (name + role, one-line justification)
   as a fallback if the primary contact doesn't respond.

Write $RESULT as JSON with EXACTLY these keys:
{
  "slug": "$SLUG", "company": "$COMPANY", "role": "$ROLE", "jd_url": "$JD_URL",
  "contact_name": string|null, "contact_title": string|null,
  "contact_type": "recruiter"|"hiring_manager"|"peer"|"interviewer"|null,
  "contact_profile_url": string|null,
  "is_alumni": true|false,
  "alumni_evidence": string,
  "selection_tier": 1|2|3|null,
  "selection_rationale": string,
  "referral_power": "high"|"low"|"none",
  "ask_used": string,
  "current_employment_evidence": string,
  "referral_rationale": string,
  "channel": "inmail"|"connect",
  "message": string (empty string if no contact found),
  "inmail_subject": string (empty string if no contact found),
  "inmail_body": string (empty string if no contact found),
  "alt_targets": [{"name": string, "role": string, "why": string}, ...]
}
Write this file in every case, even when contact fields are null.
EOF
)

run_claude "$LOG" -p "$PROMPT" \
  --model "${LINKEDIN_MODEL:-claude-sonnet-5}" \
  --output-format json \
  --allowedTools "WebSearch,Read,Write" \
  --max-turns 20

if [ ! -s "$RESULT" ]; then
  SID=$(last_session_id "$LOG")
  if [ -n "$SID" ]; then
    run_claude "$LOG" --resume "$SID" \
      -p "You stopped before writing $RESULT. Write it now with the keys already specified, using null fields if you genuinely found nothing." \
      --model "${LINKEDIN_MODEL:-claude-sonnet-5}" \
      --output-format json \
      --allowedTools "WebSearch,Read,Write" \
      --max-turns 8
  fi
fi

if [ ! -s "$RESULT" ]; then
  die "no result file after retry, check $LOG"
fi

python3 -c "import json; json.load(open('$RESULT'))" 2>/dev/null || die "result file is not valid JSON: $RESULT"

python3 linkedin_queue.py ingest "$RESULT"
