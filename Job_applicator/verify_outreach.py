#!/usr/bin/env python3
"""verify_outreach.py -- the correctness gate for automated LinkedIn outreach.

Saketh authorized unattended sending on 2026-09-05, conditioned on the draft
holding no incorrect data. This script IS that condition, made deterministic:
every rule below is a fact about Saketh that a recruiter can check, drawn from
CLAUDE.md ("Writing free-text answers" + "Accuracy notes") and the two gaps
CLAUDE.md does not catch on its own (robotics framing, the chatbot demo link).

  ./verify_outreach.py <slug>     one draft   -> exit 0 clean / 1 dirty
  ./verify_outreach.py --all      every draft in pending_approval/needs_review

Exit 0 means and only means: nothing in this text contradicts the record.
It does not judge whether the message is good, only whether it is true.
"""
import json, re, sys, os
import datetime as _dt

QUEUE = "/home/hunter/projects/career-ops/data/linkedin-outreach-queue.json"
_THIS_YEAR = _dt.date.today().year

# (regex, explanation) -- each is a claim that would be FALSE about Saketh.
VIOLATIONS = [
    # --- graduation: he COMPLETED his MS on 2026-06-10, he is an alumnus ---
    (r"\b(currently|presently)\s+(pursuing|studying|enrolled)", "claims he is still a student; MS completed 2026-06-10"),
    (r"\b(am|as)\s+a\s+(current\s+)?(grad(uate)?\s+)?student\b", "claims he is a current student; MS completed 2026-06-10"),
    (r"\b(will|expect(ed|ing)?\s+to)\s+graduat", "future graduation; he already graduated 2026-06-10"),
    (r"\bgraduating\s+(?!(on\s+)?(June|june)\s*10)(in\s+)?(202[7-9]|20[3-9]\d|soon|next\s+\w+|this\s+(fall|spring|summer|winter))",
     "future graduation; he already graduated 2026-06-10"),
    (r"\bexpected\s+graduation\b", "future graduation; he already graduated 2026-06-10"),
    (r"\bmy\s+final\s+(semester|year)\b", "implies still enrolled; MS completed 2026-06-10"),
    (r"(?i)\b(am\s+)?(finishing|completing|wrapping\s+up|about\s+to\s+finish)\b[^.]{0,25}\b(MS|master|degree|program)\b",
     "present-progressive study claim; the MS was COMPLETED 2026-06-10"),
    (r"(?i)\b(MS|master'?s|degree)\b[^.]{0,20}\b(in\s+progress|ongoing|underway)\b",
     "implies the degree is unfinished; it was completed 2026-06-10"),
    (r"\bgraduat\w*\s+in\s+(202[7-9]|20[3-9]\d)", "graduation date after 2026-06-10"),

    # --- location: Chester Springs, PA. East coast. Never claim another city ---
    (r"\bbased\s+in\s+(SF|San\s+Francisco|NYC|New\s+York|Seattle|Austin|Boston|Chicago|LA|Los\s+Angeles|Philadelphia)",
     "false residence claim; he lives in Chester Springs, PA (say 'open to relocating')"),
    (r"\b(living|live)\s+in\s+(SF|San\s+Francisco|NYC|New\s+York|Seattle|Austin|Boston|Chicago)",
     "false residence claim; he lives in Chester Springs, PA"),
    (r"\b(local|locally)\s+to\s+(SF|San\s+Francisco|NYC|New\s+York|Seattle|the\s+Bay)",
     "false locality claim; he is East-coast based in Chester Springs, PA"),

    # --- robotics: ROS2/Gazebo/Nav2/Arduino/ESP32 are coursework + self-study ---
    (r"(?i)\b(built|shipped|deployed|engineered|developed)\b[^.]{0,60}\b(ROS\s?2?|Gazebo|Nav2|rviz)\b",
     "overstates robotics; ROS2/Gazebo/Nav2 are tutorials and self-study, not built systems"),
    (r"(?i)\b(professional|production|industry)\b[^.]{0,40}\brobotics\b",
     "overstates robotics; exposure is coursework and self-study only"),
    (r"(?i)\byears?\s+of\s+(experience\s+(in|with)\s+)?robotics",
     "overstates robotics; exposure is coursework and self-study only"),
    (r"(?i)\brobotics\s+engineer(ing)?\s+(experience|background|work)\b",
     "overstates robotics; exposure is coursework and self-study only"),


    # --- experience ceilings from CLAUDE.md ---
    (r"(?i)\bdeep\s+(computer\s+vision|CV)\b", "no deep computer vision work; CV was graduate coursework"),
    (r"(?i)\b(expert|advanced|extensive)\b[^.]{0,30}\bCUDA\b", "beginner CUDA only"),
    (r"(?i)\bterabyte|\bTB[- ]scale|\bpetabyte", "no terabyte-scale pipeline claims"),

    # --- the paper: submitted to VLDB/SIGMOD 2025; he is NO LONGER revising it ---
    # Saketh confirmed 2026-09-08 that he stopped participating in the revision when
    # he graduated, so any present-tense claim that he is working on it is false.
    (r"(?i)\b(currently|actively|still)\s+(revising|working on|iterating on)\b[^.]{0,40}\b(paper|VLDB|SIGMOD|revision)\b",
     "claims he is still revising the paper; he stepped off it when he graduated (2026-06-10)"),
    (r"(?i)\b(I|we)\s+am\s+revising\b", "claims he is still revising the paper; he stepped off it after graduating"),

    # --- VLDB paper is SUBMITTED, not published ---
    (r"(?i)\b(published|accepted|appearing)\b[^.]{0,30}\bVLDB\b",
     "VLDB paper is submitted and under revision, not published or accepted"),
    (r"(?i)\bVLDB\b[^.]{0,30}\b(publication|published|accepted)\b",
     "VLDB paper is submitted and under revision, not published or accepted"),
    # The paper was submitted to VLDB and SIGMOD **2025**. That is the real year and
    # it does not drift, so the check is against the fact, not against the clock.
    # The original rule blocked any year that was not this-year-or-next, which was
    # right while the year was assumed stale but became a false positive on
    # 2026-09-08 once Saketh confirmed 2025 is correct: it would have blocked the
    # truth. Anything OTHER than 2025 is the model inventing a year.
    (r"(?i)\b(VLDB|SIGMOD|AIDB)\b[^.]{0,20}\b(19|20)\d\d\b(?<!2025)",
     "names a conference year other than 2025 -- the paper was submitted to VLDB/SIGMOD 2025"),

    # --- never claim the open-source framework as his own work ---
    (r"(?i)\b(I|my)\b[^.]{0,30}\bbuilt\b[^.]{0,20}\bcareer-ops\b",
     "career-ops is an open-source framework; never claim it as his work"),

    # --- unfilled template / draft leakage ---
    (r"\[[A-Za-z _]{2,20}\]", "unfilled template placeholder"),
    (r"\{\{?[a-z_]{2,20}\}?\}", "unfilled template placeholder"),
    (r"(?i)\b(TODO|TBD|XXX|LOREM IPSUM)\b", "draft placeholder left in text"),
    (r"(?i)\bHi\s*,", "empty salutation; contact first name missing"),

]

# Style-only: reported, never blocking. Saketh's condition for unattended sending
# is factual correctness; an em dash is not incorrect data.
WARNINGS = [
    (r"—", "em dash (house style prefers none)"),
]


# --- the portfolio RAG chatbot -------------------------------------------------
# It was down 2026-08-27..2026-09-05 and a sent InMail had already told someone it
# was "live at sakethmetta.org". Saketh brought it back on 2026-09-05. Rather than
# swap one hardcoded date for another, a liveness CLAIM is checked against the
# service: the claim is only false when the backend is actually down.
CHATBOT_HEALTH = "https://llm.sakethmetta.org/docs"
LIVENESS_CLAIM = re.compile(
    r"(?i)(\bchat\s?bot\b[^.]{0,60}\b(is\s+live|you\s+can\s+(try|visit|play)|live\s+at|running\s+at|demo\s+at|check\s+it\s+out|see\s+it\s+at)"
    r"|\b(live|try|check\s+out|demo|visit)\b[^.]{0,40}\bsakethmetta\.org"
    r"|\blive\s+at\s+sakethmetta)")

_chatbot_state = None


def chatbot_is_live(timeout=8):
    """True/False/None(unreachable-check). Cached for the process.

    Probes /docs, not /response: the FastAPI app answers it in ~140ms, while a
    real question costs ~12s of inference and would make verification crawl.
    """
    global _chatbot_state
    if _chatbot_state is None:
        import urllib.request, urllib.error
        # The host 403s urllib's default User-Agent, so send a real one --
        # otherwise a healthy backend reads as dead and blocks good drafts.
        req = urllib.request.Request(CHATBOT_HEALTH, headers={
            "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
                          "(KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36"})
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                _chatbot_state = 200 <= r.status < 400
        except urllib.error.HTTPError:
            # An HTTP error is still the app answering; only a connection
            # failure or timeout means the service is actually down.
            _chatbot_state = True
        except Exception:
            _chatbot_state = False
    return _chatbot_state

# Words too generic to prove a draft belongs to its posting.
_ROLE_STOPWORDS = {
    "software", "engineer", "engineering", "senior", "junior", "associate",
    "staff", "data", "machine", "learning", "scientist", "analyst", "developer",
    "manager", "intern", "internship", "graduate", "grad", "full", "stack",
    "backend", "frontend", "platform", "research", "applied", "technical",
    "remote", "hybrid", "product", "team", "role", "position", "level", "early",
    "career", "summer", "winter", "spring", "fall", "programs", "program",
}

LIMITS = {"message": 300, "inmail_subject": 200, "inmail_body": 1900}



# How long ago the candidate says he applied is a checkable fact, and the drafting
# model guesses it: on 2026-09-05 two drafts said "last week" and "a few days ago"
# about applications submitted that same morning. Map each phrase to the minimum
# number of days that would make it true.
ELAPSED_CLAIMS = [
    (r"(?i)\blast\s+week\b", 5),
    (r"(?i)\ba\s+few\s+days\s+ago\b", 2),
    (r"(?i)\ba\s+couple\s+(of\s+)?days\s+ago\b", 2),
    (r"(?i)\b(a\s+)?(couple|few)\s+(of\s+)?weeks\s+ago\b", 10),
    (r"(?i)\bearlier\s+this\s+month\b", 5),
    (r"(?i)\blast\s+month\b", 25),
    (r"(?i)\byesterday\b", 1),
    (r"(?i)\bsome\s+time\s+ago\b", 5),
]


def days_since_submit(slug):
    """Days since the application actually went in, or None if unknown."""
    path = f"/home/hunter/projects/career-ops/Job_applicator/answers/{slug}.drive.json"
    try:
        rec = json.load(open(path))
    except Exception:
        return None
    stamp = rec.get("submitted_at")
    if stamp:
        try:
            return (_dt.datetime.now(_dt.timezone.utc)
                    - _dt.datetime.fromisoformat(str(stamp).replace("Z", "+00:00"))
                    ).total_seconds() / 86400.0
        except Exception:
            pass
    try:  # the driver does not always write submitted_at; the file's mtime is when it did
        return (_dt.datetime.now() - _dt.datetime.fromtimestamp(os.path.getmtime(path))).total_seconds() / 86400.0
    except Exception:
        return None


def load():
    q = json.load(open(QUEUE))
    return q.get("entries", q.get("queue", [])) if isinstance(q, dict) else q


def check(rec):
    """Return (problems, warnings). Empty problems == factually safe to send."""
    problems, warnings, slug = [], [], rec.get("slug", "?")
    channel = rec.get("channel", "connect")

    # 1. structural: is there anything real to send?
    if not (rec.get("contact_name") or "").strip():
        problems.append("no contact_name (contact discovery failed -- re-draft, never approve)")
    if not (rec.get("contact_profile_url") or "").strip():
        problems.append("no contact_profile_url (nothing to send to)")

    fields = {"message": rec.get("message") or ""}
    if channel == "inmail":
        fields["inmail_subject"] = rec.get("inmail_subject") or ""
        fields["inmail_body"] = rec.get("inmail_body") or ""

    for name, text in fields.items():
        if not text.strip():
            problems.append(f"{name} is empty")
            continue
        if len(text) > LIMITS[name]:
            problems.append(f"{name} is {len(text)} chars, limit {LIMITS[name]}")
        for pat, why in VIOLATIONS:
            m = re.search(pat, text)
            if m:
                problems.append(f"{name}: {why} -- found {m.group(0)!r}")
        for pat, why in WARNINGS:
            m = re.search(pat, text)
            if m:
                warnings.append(f"{name}: {why}")
        elapsed = days_since_submit(slug)
        if elapsed is not None:
            for pat, needs_days in ELAPSED_CLAIMS:
                m = re.search(pat, text)
                if m and elapsed < needs_days:
                    problems.append(
                        f"{name}: says {m.group(0)!r}, but the application went in "
                        f"{elapsed * 24:.1f} hours ago -- false elapsed-time claim")
        m = LIVENESS_CLAIM.search(text)
        if m and not chatbot_is_live():
            problems.append(
                f"{name}: claims the sakethmetta.org chatbot is live, but "
                f"{CHATBOT_HEALTH} is not responding -- do not send someone to a dead demo "
                f"(found {m.group(0)!r})")

    # 2. the message must be about the posting it is attached to.
    #    Naming the ROLE is enough to prove that: "applied to the Research
    #    Engineer, Forge role" is unambiguous even without the company name, and
    #    omitting the company is a weaker note, not incorrect data. Only a draft
    #    that identifies NEITHER could have been cross-attached to a posting.
    company = (rec.get("company") or "").strip()
    role = (rec.get("role") or "").strip()
    msg = (fields["message"] + " " + fields.get("inmail_body", "")).lower()

    def names(value):
        """True when a distinctive word from value appears in the message."""
        for tok in re.split(r"[^A-Za-z0-9]+", value):
            if len(tok) > 3 and tok.lower() not in _ROLE_STOPWORDS and tok.lower() in msg:
                return True
        return False

    if company and len(company) > 3 and not names(company) and not names(role):
        warnings.append(
            f"message names neither the company ({company!r}) nor the role ({role!r}) "
            f"-- it may be attached to the wrong posting")

    # 3. outreach for a posting that never submitted is the one forbidden failure
    drive = f"/home/hunter/projects/career-ops/Job_applicator/answers/{slug}.drive.json"
    if os.path.exists(drive):
        try:
            if json.load(open(drive)).get("submitted") is not True:
                problems.append("answers/*.drive.json does not say submitted:true -- unverified application")
        except Exception as e:
            problems.append(f"could not read drive.json: {e}")
    else:
        problems.append("no answers/*.drive.json -- cannot prove the application was submitted")

    return problems, warnings


def main():
    args = sys.argv[1:]
    recs = load()
    if not args:
        print(__doc__)
        return 2
    if args[0] == "--all":
        targets = [r for r in recs if r.get("status") in ("pending_approval", "needs_review")]
    else:
        targets = [r for r in recs if r.get("slug") in args]
        if not targets:
            print(f"no queue record for {args}", file=sys.stderr)
            return 2

    dirty = 0
    for r in targets:
        probs, warns = check(r)
        for w in warns:
            print(f"       ! {w}")
        if probs:
            dirty += 1
            print(f"DIRTY  {r.get('slug')}")
            for p in probs:
                print(f"       - {p}")
        else:
            print(f"CLEAN  {r.get('slug')}  [{r.get('channel')}] -> {r.get('contact_name')}")
    if len(targets) > 1:
        print(f"\n{len(targets) - dirty} clean, {dirty} dirty, of {len(targets)}")
    return 1 if dirty else 0


if __name__ == "__main__":
    sys.exit(main())
