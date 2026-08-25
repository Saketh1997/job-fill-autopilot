"""
make_plan.py — build plans/{slug}.json for the fill step.

  python make_plan.py <slug> [--schema PATH] [--jd PATH] [--dry-run]

Sits between the JD fetchers and the fill step:

  {ats}_jd.py  ->  schema/{slug}.json      (JD comes from ../jd_extract.py)
  make_plan.py ->  plans/{slug}.json  (+ plans/{slug}.blocked.json)
  {ats}_fill_mcp.py

Three passes, in this order and for a reason:

  1. DETERMINISTIC. Every structured field (name, contact, links, work auth,
     relocation, EEO, salary) is resolved from profile.json by matching the
     field's label. No model sees these, so none of them can be invented.
     On this repo's Greenhouse forms that is ~70% of the fields.

  2. CACHE. Free-text answers written on earlier runs are stored in
     profile.json under "cached_answers" and replayed here, so a question you
     have already answered costs nothing on every later application. Reuse is
     scoped (see CACHE SCOPING below) so a company-specific answer can never
     leak into a different company's form.

  3. ONE MODEL CALL, for whatever pass 2 could not supply. Structured outputs
     force a parseable response, and an empty string is the model's way of
     saying it cannot answer truthfully from the sources. Empty answers are
     routed to blocked_on, never shipped as a blank.

CACHE SCOPING — the part that matters. "Additional Information" is the same
answer at every company; "Why Anthropic?" is not, and replaying it into
Stripe's form would be worse than leaving it blank. So global reuse is
opt-in via the GENERIC_QUESTIONS allowlist below, and everything else is keyed
to the company. Unrecognised questions are cached per-company, never globally.

The cache doubles as the manual-answer channel: hand-write an entry for a
question that came back blocked, and every later application fills it
deterministically with no model call.

Fail-open: if the model call fails for any reason, the deterministic fields
still get written and the free-text fields land in blocked_on. A missing API
key degrades this to a deterministic-only run rather than an error.

Sources are exactly the ones CLAUDE.md authorizes: profile.json for structured
facts, data/*.txt for free-text background. Nothing else is read.

Routing: OmniRoute by default, like every other model caller here — base URL and
model both default to it below. Only the token comes from the environment
(ANTHROPIC_AUTH_TOKEN or ANTHROPIC_API_KEY), and the callers that run this
(run_ats_batch.mjs, drive_application.sh) set it from claude_retry.sh, which is
the one file that knows it. Run standalone from a bare shell and there is no
token, so the fail-open below yields a deterministic-only plan; source
claude_retry.sh first. Override with ANTHROPIC_BASE_URL + PLAN_MODEL to go
somewhere else, and move both together — a first-party model id will not
resolve on OmniRoute and the alias will not resolve on api.anthropic.com.
"""

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from datetime import date
from html import unescape
from pathlib import Path

HERE = Path(__file__).resolve().parent
PROFILE = HERE / "profile.json"
DATA_DIR = HERE / "data"

# The call goes through the `claude` CLI (see ask_model), which authenticates
# with its own stored credentials, so this is a FIRST-PARTY model id rather than
# an OmniRoute alias. OmniRoute is gone and reaching api.anthropic.com directly
# would need an API key this box does not have.
MODEL = os.environ.get("PLAN_MODEL", "claude-sonnet-5")
MAX_TOKENS = 4096
# $ per 1M tokens (input, output). Used only for the cost line; unknown models
# print token counts without a price.
PRICES = {
    "claude-haiku-4-5": (1.00, 5.00),
    "claude-sonnet-5": (3.00, 15.00),
    "claude-opus-5": (5.00, 25.00),
}

# Free-text answers get these background files by default; the topic map adds
# more when the question or JD calls for them. Loading all of data/ would work
# but triples the input tokens for no gain.
BASE_CONTEXT = ["about_me", "career_goals", "work_experience",
                "technical_skills", "education"]
TOPIC_CONTEXT = {
    "postgresql_research": r"postgres|database|query|sql|optimizer|research|vldb",
    "integrated_portfolio_chatbot": r"rag|chatbot|llm|retrieval|embedding",
    "homelab": r"infra|devops|kubernetes|docker|self-host|homelab|platform",
    "current_projects": r"project|building|side project|portfolio",
    "suitability_ml": r"machine learning|\bml\b|deep learning|model training",
    "suitability_swe": r"software engineer|backend|full.?stack|swe",
    "suitability_robotics": r"robot|ros2|gazebo|nav2|autonomy",
    "job_appliaction_pipeline": r"automation|agent|pipeline|tooling",
}


# ── sources ──────────────────────────────────────────────────────────────────

def load_profile():
    with open(PROFILE) as f:
        return json.load(f)


def strip_html(html):
    text = re.sub(r"<(script|style)[^>]*>.*?</\1>", " ", html, flags=re.S | re.I)
    text = re.sub(r"<[^>]+>", " ", text)
    return re.sub(r"\s+", " ", unescape(text)).strip()


def load_context(labels, jd_text):
    """Background files for the free-text pass, chosen by topic."""
    haystack = (" ".join(labels) + " " + jd_text).lower()
    names = list(BASE_CONTEXT)
    for name, pattern in TOPIC_CONTEXT.items():
        if re.search(pattern, haystack) and name not in names:
            names.append(name)
    out = []
    for name in names:
        path = DATA_DIR / f"{name}.txt"
        if path.exists():
            out.append(f"=== data/{name}.txt ===\n{path.read_text().strip()}")
    return "\n\n".join(out)


# ── pass 1: deterministic resolution ─────────────────────────────────────────

SKIP = object()      # field is optional and we have no data — leave it blank
BLOCKED = object()   # field needs an answer we cannot source — record it

# Jurisdiction context, set from the JD in main(). Work authorization and salary
# are the two answers that are only true in one country: an F-1 OPT EAD
# authorizes US work and nothing else, and the salary target is a US figure.
# Answering "Yes" to a Copenhagen posting's authorization question is a false
# statement on a real application, so positive non-US evidence blocks both.
CTX = {"non_us": False, "where": ""}

NON_US = re.compile(
    r"\b(copenhagen|denmark|danish|stockholm|sweden|oslo|norway|helsinki|finland"
    r"|nordics?|iceland|london|united kingdom|\buk\b|england|ireland|dublin"
    r"|germany|german|munich|münchen|berlin|hamburg|france|paris|spain|madrid"
    r"|barcelona|portugal|lisbon|netherlands|amsterdam|belgium|brussels"
    r"|switzerland|zurich|zürich|austria|vienna|poland|warsaw|czech|prague"
    r"|italy|milan|rome|canada|toronto|vancouver|montreal|mexico|brazil"
    r"|india|bangalore|bengaluru|hyderabad|pune|singapore|japan|tokyo"
    r"|australia|sydney|melbourne|new zealand|israel|tel aviv|dubai|\buae\b)\b",
    re.I)
US_HINT = re.compile(
    r"\b(united states|u\.s\.a?\.?|\busa\b|remote\s*[-–—]?\s*us\b"
    r"|new york|san francisco|bay area|seattle|boston|austin|chicago|denver"
    r"|atlanta|los angeles|san diego|portland|philadelphia|washington,? d\.?c)\b",
    re.I)

def _address(p):
    a = p.get("address", {})
    return ", ".join(x for x in (a.get("street"), a.get("city"),
                                 a.get("state"), a.get("zip")) if x)


def _salary(p):
    if CTX["non_us"]:            # a USD full-time figure is wrong abroad
        return BLOCKED
    s = p.get("salary_expectation", {})
    return str(s.get("default", "")) or BLOCKED


def _work_authorized(p):
    """Only the US can be answered from profile.json (F-1 OPT with EAD)."""
    return BLOCKED if CTX["non_us"] else "Yes"


def _start_date(p):
    """"Immediately" — the candidate's own answer (2026-08-11).

    What this rule is really for is ORDER: it sits above the /in.?office/ rule
    so that "Ideal start date in office*" stops being answered "Yes". A yes/no
    in a date box fills, verifies and audits as complete, because nothing
    downstream can tell that a non-empty field holds the wrong kind of answer.

    profile.json's available_start_date (2026-08-25) stays the fallback for a
    control that will only accept a real date.
    """
    return "Immediately"


# Standard ATS field keys resolve by key; everything else resolves by label,
# because Greenhouse question IDs (question_17928445008) are per-posting.
KEY_RULES = {
    "first_name": lambda p: p["first_name"],
    "last_name": lambda p: p["last_name"],
    "name": lambda p: f"{p['first_name']} {p['last_name']}",
    "email": lambda p: p["email"],
    "phone": lambda p: p["phone"],
    "org": lambda p: SKIP,
    "resume": lambda p: p["resume_path"],
    "resume_text": lambda p: SKIP,
    "cover_letter": lambda p: SKIP,
    # Greenhouse offers the cover letter as both an upload and a textarea.
    # Skip the textarea rather than letting the model write one unprompted.
    "cover_letter_text": lambda p: SKIP,
}

# Ordered — first match wins, so put the specific patterns above the general.
LABEL_RULES = [
    (r"^preferred (first )?name|^nickname", lambda p: p["first_name"]),
    (r"^first name", lambda p: p["first_name"]),
    (r"^last name|surname", lambda p: p["last_name"]),
    (r"^(full )?name$", lambda p: f"{p['first_name']} {p['last_name']}"),
    (r"e-?mail", lambda p: p["email"]),
    # "mobile" alone is not a phone field. DoorDash asks "Do you have interest
    # and experience in a mobile role?" — a Yes/No question that this rule
    # answered with the phone number, which then blocked the run. Only the
    # phrasings that actually denote a number.
    (r"phone|telephone|^mobile$|mobile (number|no\.?)|cell (number|phone)",
     lambda p: p["phone"]),
    (r"linkedin", lambda p: p["linkedin"]),
    (r"github", lambda p: p["github"]),
    # CLAUDE.md: any personal/portfolio website field gets the portfolio URL.
    (r"website|portfolio|personal site|personal url", lambda p: p["website"]),
    (r"resume|cv\b", lambda p: p["resume_path"]),

    # Work authorization. Two distinct questions that must never be conflated:
    # authorized to work now (yes, F-1 OPT with EAD) vs. needs sponsorship
    # (also yes, H1B in future). Never answer "No" to a sponsorship question.
    (r"require.*(visa|employment).*sponsor|sponsorship.*(now|future|require)",
     lambda p: "Yes"),
    (r"sponsor", lambda p: "Yes"),
    (r"legally authoriz|authorized to work|work authorization|right to work",
     _work_authorized),

    # Logistics. Address rules come FIRST: a work-address question often
    # mentions relocation in passing ("...if you would need to relocate, type
    # 'relocating'"), and a bare /relocate/ rule above these would answer the
    # address box with "Yes".
    # "What is your preferred work location?" is a choice between the
    # employer's offices, not the candidate's street address, and answering it
    # with "622 Churchill Road, ..." blocked a run. Only ask for the address
    # when the field is actually asking for an address.
    (r"preferred work location|which office|work location preference", lambda p: None),
    (r"address|where.*plan on working|home location", lambda p: _address(p)),
    (r"open to relocat|willing to relocat|relocation for this role",
     lambda p: "Yes"),

    # DATE QUESTIONS COME BEFORE THE YES/NO LOGISTICS RULES.
    # Neuralink asks "Ideal start date in office*". That matched the /in.?office/
    # rule below and was answered "Yes" — a yes/no put into a date box, filled,
    # verified and audited as complete, because nothing downstream can tell that
    # a non-empty field holds the wrong KIND of answer. A date question is
    # answered with a date or not at all.
    # A GRADUATION date is not an AVAILABILITY date. "Please select and confirm
    # your graduation date" matched the \bdate\b rule below and was answered
    # "Immediately" on a control offering three graduation windows. Whether it
    # asks for the date or for the window, the fact is the same one and it comes
    # from profile.json, never from the availability rule.
    # GPA. The undergraduate rule comes first: "GPA (Undergraduate)" contains
    # "GPA" and would otherwise collect the master's figure. profile.json holds
    # both — GPA is the Oregon State MS, undergraduate_GPA the B.Tech.
    (r"(undergrad|bachelor|b\.?tech|b\.?s\b).{0,25}gpa|gpa.{0,25}(undergrad|bachelor|b\.?tech)",
     lambda p: p.get("education", {}).get("undergraduate_GPA")),
    (r"\bgpa\b|grade point", lambda p: p.get("education", {}).get("GPA")),

    # Narrow on purpose. A bare /graduat/ also matches "GPA (UNDERGRADUATe)",
    # which then received the graduation date — the same keyword-in-a-longer-
    # word trap as the rest of this file. It must be a graduation DATE.
    (r"graduation (date|year|month)|(date|year|month) of graduation"
     r"|(anticipated|expected|planned) graduation",
     lambda p: p.get("education", {}).get("graduated")),
    (r"\bdate\b|earliest.*(start|begin)|when.*(could|would).*start|"
     r"^availability|notice period", _start_date),

    (r"in.?person|onsite|on-site|in.?office|hybrid", lambda p: "Yes"),
    (r"open to travel|willing to travel", lambda p: "Yes"),
    (r"salary|compensation expect|desired pay|expected pay", _salary),
    (r"non-?compete|\bnda\b|restrictive covenant", lambda p: "None"),

    # AI-usage attestation. Sourced from profile.json like any other structured
    # field; blocks if the key is absent rather than guessing an answer.
    (r"ai policy|use of ai|ai usage|ai assistance",
     lambda p: p.get("ai_policy_agreement") or BLOCKED),

    # EEO — sourced from profile.json, kept out of stdout.
    (r"gender|what is your sex", lambda p: p["gender"]),
    (r"race|ethnic", lambda p: p["race_ethnicity"]),
    (r"veteran", lambda p: p["veteran_status"]),
    (r"disab", lambda p: p["disability_status"]),

    # Known-unanswerable from the authorized sources.
    (r"interviewed.*(before|previously)|applied before|previous application",
     lambda p: BLOCKED),
    (r"deadline|timeline consideration|competing offer", lambda p: BLOCKED),
    (r"referr?al|how did you hear|who referred", lambda p: BLOCKED),
]

# Hispanic/Latino is asked as its own select on the current EEOC form, but no
# ATS API returns it. It is not a second, independent fact: it is already
# answered by profile.json's race_ethnicity, so it is read off that rather than
# guessed or asked of a model. An unrecognised race value blocks.
def _hispanic(p):
    race = (p.get("race_ethnicity") or "").lower()
    if not race:
        return BLOCKED
    return "Yes" if ("hispanic" in race or "latino" in race) else "No"


LABEL_RULES.insert(
    next(i for i, (pat, _) in enumerate(LABEL_RULES) if pat.startswith("race|")),
    (r"hispanic|latino", _hispanic))

_COMPILED = [(re.compile(pat, re.I), fn) for pat, fn in LABEL_RULES]


# A field whose label is a SENTENCE is not a field about the nouns inside it.
# Three of these got through in one day: "Do you have interest and experience in
# a mobile role?" answered with the phone number, "Please select and confirm
# your graduation date" answered "Immediately", and an attestation reading "I
# confirm the information provided in this application, including but not
# limited to my resume ... is true and correct" answered with the resume's file
# PATH, because the rules below match a bare keyword anywhere in the label.
#
# The keyword rules are written for field NAMES ("Phone", "Resume/CV", "Start
# date"). Below they are only allowed to claim a label that reads like one.
_SENTENCE = re.compile(r"^\s*(i |do you|have you|are you|will you|would you|"
                       r"please (confirm|acknowledge|indicate|select)|by (checking|clicking))", re.I)
_KEYWORD_ONLY = re.compile(r"phone|telephone|mobile|resume|cv\b|website|portfolio|"
                           r"\bdate\b|address|e-?mail|linkedin|github", re.I)

# An attestation is the candidate affirming their own application. It is a
# checkbox, it is required on a great many boards, and it is not a question
# about the candidate — so it is answered here rather than sent to a model.
# Deliberately narrow: anything that also touches sponsorship, authorization,
# compensation or restrictive covenants is a substantive question wearing an
# attestation's clothes, and goes to the normal path.
_ATTESTATION = re.compile(
    r"\bi (confirm|certify|acknowledge|agree|consent|understand|declare)\b"
    r"|by (checking|clicking|submitting) (this|the)"
    r"|(privacy (policy|notice)|terms (and conditions|of use)|data (processing|protection))", re.I)
_NOT_ATTESTATION = re.compile(
    r"sponsor|visa|work authoriz|authorized to work|right to work|salary|compensation|"
    r"non-?compete|restrictive covenant|notice period|criminal|background check", re.I)


def is_attestation(label, field=None):
    """True for a truth/consent checkbox the candidate would tick themselves."""
    if not _ATTESTATION.search(label or ""):
        return False
    if _NOT_ATTESTATION.search(label or ""):
        return False
    if field is not None:
        kind = str(field.get("kind", "")).lower()
        opts = [str(o).strip().lower() for o in (field.get("options") or [])]
        # A checkbox, or a two-option control whose options are an agreement.
        if kind and kind not in ("checkbox", "boolean", "select", "radio"):
            return False
        if opts and not set(opts) <= {"yes", "no", "i agree", "agree", "on", "true", "false", ""}:
            return False
    return True


def resolve(field, profile):
    """Deterministic value for one field, or SKIP / BLOCKED / None (=free text)."""
    key, label = field.get("key", ""), field.get("label", "") or ""
    if key in KEY_RULES:
        return KEY_RULES[key](profile)
    if is_attestation(label, field):
        return "Yes"
    sentence = bool(_SENTENCE.match(label)) or len(label) > 90
    for pattern, fn in _COMPILED:
        if not pattern.search(label):
            continue
        # A sentence-shaped label may only be claimed by a rule that is itself
        # about the question being asked, never by a bare keyword match.
        if sentence and _KEYWORD_ONLY.search(pattern.pattern):
            continue
        return fn(profile)
    return None


_MONTHS = ("january|february|march|april|may|june|july|august|september"
           "|october|november|december")
_DATE_RE = re.compile(rf"^\s*(\d{{4}}-\d{{2}}-\d{{2}}|(?:{_MONTHS})\s+\d{{1,2}},?\s+\d{{4}}"
                      rf"|\d{{1,2}}/\d{{1,2}}/\d{{4}})\s*$", re.I)
# A bucket list names a period rather than a point: "Before September 2025",
# "September 2025 - August 2026", "After January 2027", "By end of Q1".
_RANGE_RE = re.compile(r"\b(before|after|by end of|or later|or earlier|between)\b"
                       rf"|(?:{_MONTHS})\s+\d{{4}}\s*[-–]\s*", re.I)


def looks_like_date(value):
    """A specific calendar date, in any of the shapes profile.json and the
    forms use."""
    return bool(_DATE_RE.match(str(value)))


def options_are_ranges(options):
    """True when the control offers periods, not points — the case where a
    specific date can never be one of the options."""
    return sum(1 for o in options if _RANGE_RE.search(str(o))) >= max(1, len(options) // 2)


def match_option(value, options):
    """Coerce a resolved value onto one of a SELECT's actual option strings."""
    if not options:
        return value
    v = str(value).strip().lower()
    for opt in options:
        if opt.strip().lower() == v:
            return opt
    for opt in options:            # "Yes, I am authorized" matches "yes"
        if opt.strip().lower().startswith(v) or v.startswith(opt.strip().lower()):
            return opt
    return None


def is_free_text(field):
    return field.get("kind") in ("TEXTAREA",) and not field.get("options")


# ── pass 2: the answer cache ─────────────────────────────────────────────────

CACHE_KEY = "cached_answers"

# Questions whose answer is genuinely the same everywhere. ONLY these are
# reused across companies. Anything not listed here is cached per-company, so
# the failure mode of an unrecognised question is a wasted model call, never a
# wrong-company answer in a real form.
GENERIC_QUESTIONS = [
    # Patterns match the NORMALIZED label, which has already had "(optional)",
    # "(required)" and punctuation stripped — so match the bare text.
    r"^additional information$",
    r"^personal preferences$",
    r"anything else.*(know|share|add)",
    r"deadline|timeline consideration",
    r"how did you hear",
    r"questions for us",
    r"pronouns",
]
_GENERIC = [re.compile(p, re.I) for p in GENERIC_QUESTIONS]


def normalize_label(label):
    """Collapse a form label to a stable cache key fragment."""
    s = (label or "").lower()
    s = re.sub(r"\(optional\)|\(required\)|\*", " ", s)
    s = re.sub(r"[^a-z0-9 ]+", " ", s)
    return re.sub(r"\s+", " ", s).strip()


def cache_key(label, company):
    norm = normalize_label(label)
    if any(p.search(norm) for p in _GENERIC):
        return f"global:{norm}"
    return f"{company}:{norm}"


def load_cache(profile):
    cache = profile.get(CACHE_KEY) or {}
    return cache if isinstance(cache, dict) else {}


def _render_block(cache, indent):
    """cached_answers rendered at the file's own indent level."""
    body = json.dumps(cache, indent=4, ensure_ascii=False, sort_keys=True)
    lines = body.split("\n")
    out = [f'{indent}"{CACHE_KEY}": {lines[0]}']
    out += [indent + ln for ln in lines[1:]]
    return "\n".join(out)


def _locate_block(text, key):
    """(start, end, indent) of a top-level "key": { ... } block, brace-matched."""
    m = re.search(r'^([ \t]*)"' + re.escape(key) + r'"\s*:\s*\{', text, re.M)
    if not m:
        return None
    i = text.index("{", m.end() - 1)
    depth, in_str, esc = 0, False, False
    for j in range(i, len(text)):
        c = text[j]
        if in_str:
            if esc:
                esc = False
            elif c == "\\":
                esc = True
            elif c == '"':
                in_str = False
            continue
        if c == '"':
            in_str = True
        elif c == "{":
            depth += 1
        elif c == "}":
            depth -= 1
            if depth == 0:
                return m.start(), j + 1, m.group(1)
    return None


def save_cache(cache):
    """Splice cached_answers into profile.json, leaving every other byte alone.

    profile.json is hand-maintained and holds credentials, so this never
    round-trips the whole file through json.dumps — that would reformat the
    author's alignment. Writes to a temp file and renames, so an interrupted
    write cannot truncate the file.
    """
    text = PROFILE.read_text()
    found = _locate_block(text, CACHE_KEY)
    if found:
        start, end, indent = found
        new = text[:start] + _render_block(cache, indent) + text[end:]
    else:
        m = re.search(r'^([ \t]+)"', text, re.M)
        indent = m.group(1) if m else "    "
        close = text.rindex("}")
        head = text[:close].rstrip()
        if not head.endswith(","):
            head += ","
        new = head + "\n" + _render_block(cache, indent) + "\n" + text[close:]

    json.loads(new)                       # never write a file that won't parse
    tmp = PROFILE.with_suffix(".json.tmp")
    tmp.write_text(new)
    tmp.replace(PROFILE)


# ── pass 3: the single model call ────────────────────────────────────────────

SYSTEM = """You write job-application answers for one candidate. You are given \
that candidate's own background notes and the job description. Every factual \
claim you make must be traceable to the background notes.

Hard rules:
- Never invent or embellish experience, employers, titles, metrics, or interest \
in a domain the notes do not mention.
- Never claim the candidate built a tool, library, or framework they only used.
- If a question cannot be answered truthfully and specifically from the notes, \
return an EMPTY STRING for it. An empty answer is correct and expected; a \
plausible-sounding invented answer is a serious failure.
- Natural, direct voice. No em dashes. No corporate filler.
- 100-180 words unless the question asks for more.
- Do not overstate: no deep computer vision work, beginner CUDA only, no \
terabyte-scale pipeline claims. The VLDB paper was submitted and is under revision.
- ROS2/Gazebo/Nav2/ESP32 exposure is coursework and self-study, not professional \
robotics work.
- The homelab and portfolio chatbot are real running systems and may be described \
as production-grade self-hosted infrastructure.
- Never claim the open-source career-ops framework as the candidate's own work."""


def build_answer_schema(fields):
    return {
        "type": "object",
        "properties": {f["key"]: {"type": "string"} for f in fields},
        "required": [f["key"] for f in fields],
        "additionalProperties": False,
    }


def build_prompt(fields, jd_text, context, profile):
    questions = "\n".join(
        f'- {f["key"]}: {f["label"]}'
        f'{"  [REQUIRED]" if f.get("required") else "  [optional]"}'
        for f in fields
    )
    return f"""CANDIDATE BACKGROUND NOTES
{context}

CANDIDATE FACTS
Name: {profile['first_name']} {profile['last_name']}
Education: {json.dumps(profile.get('education', {}))}
Work authorization: {profile.get('work_authorization', '')}

JOB DESCRIPTION
{jd_text}

QUESTIONS
Answer each of these. Return one JSON string per key. Return "" for any question \
you cannot answer truthfully and specifically from the background notes above.

{questions}

OUTPUT FORMAT
Return ONLY a JSON object, no prose before or after it and no code fence, with \
exactly these keys: {", ".join(f["key"] for f in fields)}
Every value is a string. Use "" for anything you cannot answer."""


def ask_model(fields, jd_text, context, profile, dry_run):
    prompt = build_prompt(fields, jd_text, context, profile)
    approx_in = (len(SYSTEM) + len(prompt)) // 3.5

    if dry_run:
        print(f"\n--- dry run: {len(fields)} free-text field(s), "
              f"~{approx_in:,.0f} input tokens ---")
        rate = PRICES.get(MODEL)
        if rate:
            est = approx_in / 1e6 * rate[0] + 400 / 1e6 * rate[1]
            print(f"--- estimated cost on {MODEL}: ${est:.4f} ---")
        print(prompt[:1500] + ("..." if len(prompt) > 1500 else ""))
        return {}, None

    # The schema is stated in the prompt rather than sent as output_config:
    # the CLI has no structured-output mode, and parse_answer_json() below was
    # already the thing making the contract hold (OmniRoute dropped the param
    # in transit too, so this path was never truly schema-enforced).
    schema_note = ("Reply with ONLY a JSON object matching this schema, "
                   "no prose and no code fence:\n"
                   + json.dumps(build_answer_schema(fields)) + "\n\n")
    try:
        text, cost = call_claude_cli(SYSTEM, schema_note + prompt)
    except Exception as e:                      # fail open, never fail closed
        print(f"! model call failed ({type(e).__name__}: {e}); "
              "free-text fields go to blocked_on", file=sys.stderr)
        return {}, None

    parsed = parse_answer_json(text)
    if parsed is None:
        print("! model returned unparseable JSON; free-text fields go to "
              "blocked_on", file=sys.stderr)
        return {}, CliUsage(cost)
    return parsed, CliUsage(cost)


class CliUsage:
    """What the CLI reports back is a dollar cost, not token counts.

    report_cost() wants .input_tokens/.output_tokens, so they are zeroed and the
    real figure is carried in .cost_usd, which report_cost prefers when set.
    """

    def __init__(self, cost_usd):
        self.input_tokens = 0
        self.output_tokens = 0
        self.cost_usd = cost_usd


def call_claude_cli(system, user):
    """One model call through the `claude` CLI. Returns (text, cost_usd).

    Same mechanism as ats_questions.mjs and cli_model.mjs: the prompt goes in a
    FILE (a large argv dies with E2BIG), the call is wrapped by claude_retry.sh
    which owns retry/backoff and the routing decision, and it runs from an empty
    cwd with tools and MCP off so career-ops's own CLAUDE.md is not pulled into
    a prompt that needs none of it.
    """
    sandbox = tempfile.mkdtemp(prefix="make-plan-")
    prompt_file = os.path.join(sandbox, "prompt.txt")
    log = os.path.join(sandbox, "out.log")
    with open(prompt_file, "w") as fh:
        fh.write(f"{system}\n\n{user}")

    script = ('source "$1" >/dev/null 2>&1 || exit 3; '
              'run_claude "$2" -p --model "$3" --output-format json '
              '--allowedTools "" --disallowedTools '
              '"Bash,Read,Write,Edit,Glob,Grep,WebFetch,WebSearch,Task,NotebookEdit" '
              '--max-turns 4 --strict-mcp-config --mcp-config \'{"mcpServers":{}}\'')
    env = dict(os.environ, CLAUDE_PROMPT_FILE=prompt_file)
    try:
        subprocess.run(
            ["bash", "-c", script, "plan", str(HERE / "claude_retry.sh"), log, MODEL],
            cwd=sandbox, env=env, timeout=600,
            stdout=subprocess.DEVNULL, stderr=None, check=False)
        with open(log) as fh:
            lines = [l for l in fh if '"type":"result"' in l]
        if not lines:
            raise RuntimeError("no result line from the claude CLI")
        env_json = json.loads(lines[-1])
        if env_json.get("is_error"):
            raise RuntimeError(str(env_json.get("result"))[:200])
        return str(env_json.get("result", "")), float(env_json.get("total_cost_usd") or 0)
    finally:
        shutil.rmtree(sandbox, ignore_errors=True)


def parse_answer_json(text):
    """Best-effort JSON out of a model reply, or None.

    output_config's json_schema is not honoured end to end: OmniRoute normalises
    the request into an OpenAI chat-completions shape, which has no slot for the
    Anthropic-only param, so it is dropped in transit and the reply comes back
    as prose (verified 2026-08-12). The schema stays on the request for the day
    that changes; this is what makes the contract hold meanwhile, together with
    the OUTPUT FORMAT block in the prompt. Handles a bare object, a fenced
    block, and an object with commentary around it.
    """
    for candidate in (text, _strip_fence(text), _slice_braces(text)):
        if not candidate:
            continue
        try:
            parsed = json.loads(candidate)
        except (json.JSONDecodeError, TypeError):
            continue
        if isinstance(parsed, dict):
            return parsed
    return None


def _strip_fence(text):
    m = re.search(r"```(?:json)?\s*(.+?)\s*```", text, re.S)
    return m.group(1) if m else ""


def _slice_braces(text):
    start, end = text.find("{"), text.rfind("}")
    return text[start:end + 1] if 0 <= start < end else ""


def report_cost(usage):
    if usage is not None and getattr(usage, "cost_usd", None):
        print(f"cost: ${usage.cost_usd:.4f} on {MODEL}", file=sys.stderr)
        return
    if not usage:
        return
    rate = PRICES.get(MODEL)
    line = f"tokens: {usage.input_tokens:,} in / {usage.output_tokens:,} out"
    if rate:
        cost = (usage.input_tokens / 1e6 * rate[0]
                + usage.output_tokens / 1e6 * rate[1])
        line += f"  ->  ${cost:.4f} on {MODEL}"
    print(line)


# ── main ─────────────────────────────────────────────────────────────────────

EEO = re.compile(r"gender|race|ethnic|veteran|disab", re.I)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("slug")
    ap.add_argument("--schema", help="default: schema/{slug}.json")
    ap.add_argument("--jd", help="default: jd/{slug}.html")
    ap.add_argument("--company",
                    help="cache scope for company-specific answers "
                         "(default: the slug up to the first '-')")
    ap.add_argument("--no-cache", action="store_true",
                    help="ignore cached answers and ask the model fresh")
    ap.add_argument("--resume",
                    help="resume PDF to attach (default: resumes/{slug}.pdf from "
                         "stage 2, falling back to profile.json resume_path)")
    ap.add_argument("--dry-run", action="store_true",
                    help="print the prompt and cost estimate, call nothing")
    args = ap.parse_args()

    slug = args.slug
    if slug != os.path.basename(slug) or slug in (".", ".."):
        raise SystemExit(f"bad slug: {slug!r}")

    schema_path = Path(args.schema) if args.schema else HERE / "schema" / f"{slug}.json"
    if args.jd:
        jd_path = Path(args.jd)
    else:
        # jd_extract.py writes .txt; older ATS-only runs left .html behind.
        cands = [HERE / "jd" / f"{slug}.txt", HERE / "jd" / f"{slug}.html"]
        jd_path = next((p for p in cands if p.exists()), cands[0])
    if not schema_path.exists():
        raise SystemExit(f"no schema at {schema_path}")

    fields = json.loads(schema_path.read_text())
    profile = load_profile()

    # Stage 2 writes resumes/{slug}.pdf. Prefer it over profile.json's generic
    # resume, and say which one is going on the form: the submit gate in
    # CLAUDE.md blocks a run that attaches the generic resume when a tailored
    # one was expected, so this has to be visible, not implicit.
    tailored = HERE / "resumes" / f"{slug}.pdf"
    if args.resume:
        resume_path, resume_kind = Path(args.resume), "explicit"
    elif tailored.exists() and tailored.stat().st_size:
        resume_path, resume_kind = tailored, "tailored"
    else:
        resume_path, resume_kind = Path(profile["resume_path"]), "generic"
    if not resume_path.exists():
        raise SystemExit(f"no resume at {resume_path}")
    profile["resume_path"] = str(resume_path)
    print(f"resume: {resume_path}  ({resume_kind})")

    jd_text = strip_html(jd_path.read_text()) if jd_path.exists() else ""
    if not jd_text:
        print(f"! no JD at {jd_path}; free-text answers will be generic",
              file=sys.stderr)

    head = jd_text[:4000]
    if NON_US.search(head) and not US_HINT.search(head):
        CTX["non_us"] = True
        CTX["where"] = NON_US.search(head).group(0)
        print(f"! JD looks non-US ({CTX['where']}): work authorization and "
              f"salary will block rather than assert a US answer", file=sys.stderr)

    company = (args.company or slug.split("-")[0]).lower()
    cache = load_cache(profile)
    cache_hits = 0

    plan, blocked, free_text, rows = {}, [], [], []

    for f in fields:
        key, label = f["key"], f.get("label", "")
        if f.get("source") == "page":
            blocked.append({"key": key, "label": label,
                            "required": f.get("required", False),
                            "reason": "not exposed by the API; discover on the page"})
            continue

        value = resolve(f, profile)

        if value is None:
            if is_free_text(f):
                hit = None if args.no_cache else cache.get(cache_key(label, company))
                if hit and (hit.get("answer") or "").strip():
                    plan[key] = hit["answer"].strip()
                    rows.append((key, label, "cache",
                                 f'{hit.get("saved_at", "?")} '
                                 f'{hit["answer"].strip()[:32]}...'))
                    cache_hits += 1
                else:
                    free_text.append(f)
                    rows.append((key, label, "model", "..."))
            else:
                blocked.append({"key": key, "label": label,
                                "required": f.get("required", False),
                                "reason": "no rule and no profile.json value"})
                rows.append((key, label, "BLOCKED", "unmapped"))
            continue
        if value is SKIP:
            rows.append((key, label, "skip", ""))
            continue
        if value is BLOCKED:
            blocked.append({"key": key, "label": label,
                            "required": f.get("required", False),
                            "reason": "not answerable from profile.json"})
            rows.append((key, label, "BLOCKED", "no source"))
            continue

        if f.get("options"):
            picked = match_option(value, f["options"])
            # A specific date against a control that offers RANGES never maps,
            # and passing it through guarantees a blocked run: DoorDash's
            # "What is your earliest available start date?" offers three
            # windows, profile.json holds 2026-08-25, and the driver reported
            # 'no option "August 25, 2026"'. Leave it unplanned instead — the
            # question pass reads the live options and picks the window that
            # contains the date, which is the answer the form can accept.
            if picked is None and options_are_ranges(f["options"]):
                rows.append((key, label, "page", "value vs ranges -> answered at fill time"))
                continue
            if picked is None:
                # Not a block. The API's option list is a copy — the authority
                # is the control on the live page, and the *_apply.mjs drivers
                # match there (including the EEOC self-ID phrasings, where
                # profile.json says "not a veteran" and the form says "I am not
                # a protected veteran"). Pass the profile value through; the
                # driver blocks with the real option list if it cannot map it.
                rows.append((key, label, "profile", "unmapped -> match at fill time"))
                plan[key] = value
                continue
            value = picked

        plan[key] = value
        shown = "•••" if EEO.search(label) else str(value)
        rows.append((key, label, "profile", shown[:48]))

    usage = None
    if free_text:
        context = load_context([f.get("label", "") for f in free_text], jd_text)
        answers, usage = ask_model(free_text, jd_text, context, profile, args.dry_run)
        saved = 0
        for f in free_text:
            text = (answers.get(f["key"]) or "").strip()
            if text:
                plan[f["key"]] = text
                # Cache it for later applications. An abstention is never
                # cached — a blank must be re-asked, not made permanent.
                cache[cache_key(f.get("label", ""), company)] = {
                    "answer": text,
                    "question": f.get("label", ""),
                    "source": f"model:{MODEL}",
                    "saved_at": date.today().isoformat(),
                }
                saved += 1
            else:
                blocked.append({"key": f["key"], "label": f.get("label", ""),
                                "required": f.get("required", False),
                                "reason": "model could not answer from the "
                                          "authorized sources"})
        if saved:
            try:
                save_cache(cache)
                print(f"cached {saved} answer(s) -> profile.json:{CACHE_KEY}")
            except Exception as e:      # a cache failure must not lose the plan
                print(f"! could not write cache ({type(e).__name__}: {e})",
                      file=sys.stderr)

    if args.dry_run:
        print("\n(dry run: nothing written)")
        return

    out_dir = HERE / "plans"
    out_dir.mkdir(exist_ok=True)
    plan_path = out_dir / f"{slug}.json"
    blocked_path = out_dir / f"{slug}.blocked.json"
    plan_path.write_text(json.dumps(plan, indent=2) + "\n")
    blocked_path.write_text(json.dumps(blocked, indent=2) + "\n")

    width = min(max((len(label) for _, label, _, _ in rows), default=10), 58)
    for _, label, src, val in rows:
        print(f"  {label[:width]:<{width}}  {src:<8} {val}")
    for b in blocked:
        if b["key"] not in {r[0] for r in rows}:
            print(f"  {b['label'][:width]:<{width}}  {'BLOCKED':<8} {b['reason']}")

    print(f"\n{len(plan)} filled ({cache_hits} from cache), {len(blocked)} blocked "
          f"({sum(1 for b in blocked if b['required'])} of them required)")
    report_cost(usage)
    print(f"-> {plan_path}")
    print(f"-> {blocked_path}")
    print("\nReview both files before running the fill step. Nothing submits.")


if __name__ == "__main__":
    main()
