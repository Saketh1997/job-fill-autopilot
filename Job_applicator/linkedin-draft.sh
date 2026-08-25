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

RESULT="answers/$SLUG-linkedin.json"
LOG="logs/$SLUG-linkedin-draft.log"
mkdir -p answers logs
rm -f "$RESULT"
: > "$LOG"

ALREADY_CONTACTED=$(python3 -c "
import json, os
q_path = '$ROOT/data/linkedin-outreach-queue.json'
q = json.load(open(q_path)) if os.path.exists(q_path) else []
co = '''$COMPANY'''.strip().lower()
slug_co = '''$SLUG'''.split('-')[1].lower() if '-' in '''$SLUG''' else ''
matches = []
for r in q:
    r_co = (r.get('company') or '').strip().lower()
    r_slug_co = (r.get('slug') or '').split('-')[1].lower() if '-' in (r.get('slug') or '') else ''
    if (r_co and (r_co in co or co in r_co)) or (slug_co and slug_co == r_slug_co):
        name = r.get('contact_name')
        url = r.get('contact_profile_url')
        status = r.get('status')
        if name:
            matches.append(f'{name} ({url or \"no url\"}, status: {status})')
print('; '.join(matches) if matches else 'None')
" 2>/dev/null || echo "None")

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
2. WebSearch EXCLUSIVELY for Oregon State University (OSU) alumni working at $COMPANY.
   Search queries: site:linkedin.com/in/ "$COMPANY" "Oregon State University" OR "Oregon State"
   Look for OSU alumni who are engineering managers, software engineers, data scientists, or recruiters at $COMPANY.
   CRITICAL REQUIREMENT: The contact MUST be an Oregon State University (OSU) alumnus/alumna.
   CRITICAL EXCLUSION: If any persons are listed under 'Previously contacted/queued at this company', DO NOT select them. You MUST find and select a DIFFERENT contact at $COMPANY.
   If NO uncontacted Oregon State University alumni are found at $COMPANY, search for relevant engineering managers/recruiters/peers at $COMPANY (or return null contact fields if none found).
   Record the evidence for the alumni claim (degree and years as their profile states them)
   in "alumni_evidence". No evidence means is_alumni is false, whatever the search summary implied.
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
5. Choose the channel:
   - "inmail" ONLY when is_alumni is true AND referral_power is "high". This spends
     one of a limited number of Premium InMail credits, so it must earn it.
   - "connect" in every other case.
6. Draft BOTH of these, always, whichever channel you chose:
   a. "message" -- the <=300-character connection note. It opens on the shared OSU
      connection, mentions having completed his MS in CS at Oregon State on June 10th (or recently finished MS in CS), names $ROLE and says the application is already in, gives ONE
      concrete proof point from $CV, and ASKS FOR THE REFERRAL in plain words
      (e.g. "would you be open to referring me?"). HARD LIMIT 300 characters,
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
        ask for a referral (or for a short conversation if a referral is not
        theirs to give); a thank-you and the candidate's name. Offer to send
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
  "referral_power": "high"|"low"|"none",
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
