#!/usr/bin/env python3
"""experience_gate.py — drop pipeline offers whose JD requires more experience
than portals.yml experience_filter.max_required_years (default 1).

Fetches JD text zero-token via ATS JSON APIs (Greenhouse, Lever, Ashby,
Workday, amazon.jobs, Workable, LinkedIn guest endpoint; generic HTML strip
for custom domains), regexes the minimum years-of-experience requirement,
and removes blocked entries from data/pipeline.md (scan-history status →
`skipped_experience`).

A new-grad/intern marker in the *title* no longer passes a row unfetched; only
the marker in the fetched JD body does. Already-applied rows are never removed,
but their JD is fetched anyway so it is cached for later use. Net effect: every
pending row except title-blocked ones (ADC, level-II+) ends up with a JD on disk
under Job_applicator/jd/{slugify(company, title)}.txt.

Usage:
  python3 experience_gate.py --date 2026-07-05   # gate entries added that day
  python3 experience_gate.py --all-pending       # gate every pending entry
  python3 experience_gate.py --date ... --dry-run

Run after every scan, before evaluating the pipeline. Read-only unless
entries get blocked. Unfetchable JDs are kept and listed as UNVERIFIED.
"""
import argparse, html, json, re, sys, time, urllib.request

# JD fetching for every source lives in one place now; this module keeps
# only the gating rules. jd_extract also caches each JD it pulls, so a gate
# run doubles as the JD extraction pass instead of fetching twice.
import jd_extract as JD
from jd_extract import fetch, strip_html, jd_text

ROOT = "/home/hunter/projects/career-ops"
PIPE = f"{ROOT}/data/pipeline.md"
HIST = f"{ROOT}/data/scan-history.tsv"
UA = {"User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36"}

# "non-internship" must NOT count as a new-grad marker. Amazon's standard Basic
# Qualifications open with "3+ years of non-internship professional software
# development experience" — the phrase appears in every experienced SDE posting
# they run, and matching it here passed the row on a marker that means the exact
# opposite. That is how "Software Development Engineer, Amazon Lists" (3+ years)
# reached the applicator on 2026-08-09. The lookbehinds cover "non-internship",
# "non internship" and "noninternship".
NEWGRAD_PASS = re.compile(
    r"new\s*grad|(?<!non-)(?<!non\s)(?<!non)intern(ship)?\b|university\s*grad|"
    r"early\s*career|entry[\s-]*level|recent\s*graduate|campus\b", re.I)

# Leveled titles: Roman numerals (Amazon convention: "Data Engineer II" = L5,
# experienced), explicit "Level N"/"LN" for N >= 2 (Snap convention:
# "ML Engineer, Level 4"), and a bare trailing digit >= 2 ("Machine Learning
# Engineer 3", slipped through 2026-07-12) — blocked without fetching the JD.
#
# The digit clause was anchored to end-of-title until 2026-08-08, which missed
# any level carrying a scope suffix — "Software Engineer 3, Atlas Search
# Systems" (MongoDB) sailed through. Now \b-terminated instead of $-terminated.
# \b (not \s) after the digit is what keeps "3D Vision" and "Summer 2026" out:
# in both, the digit is followed by a word character, so no boundary exists.
LEVELED_TITLE = re.compile(r"\b(?:II|III|IV)\b|\bL(?:evel\s*)?[2-9]\b|\s[2-9]\b", re.I)

# House rule 2026-07-14 (modes/_custom.md): Amazon Dedicated Cloud / ADC roles
# are air-gapped US-gov-cloud (TS/SCI + citizenship) — blocked on title alone,
# recorded as skipped_clearance. Bare "ADC" only counts for Amazon entities.
ADC_TITLE = re.compile(r"amazon\s+dedicated\s+cloud", re.I)
ADC_WORD = re.compile(r"\bADC\b")

# --- Work authorization / clearance, JD-body level (2026-08-10) ---
# Candidate is F-1 OPT with no clearance (portals.yml, modes/_custom.md). The
# title-level negative list in portals.yml only catches aggregator feeds that
# put "TS/SCI" or "US Citizen" in the title; the requirement usually lives in
# the body. Johnson Controls "Software Engineer - Data Center Engineering"
# (Workday, 2026-08-08) reached the pipeline with "No H1B U.S. Citizen Only"
# and "Must be authorized to work in the U.S.; no sponsorship available" in
# the JD — nothing in the title said so.
#
# Three independent families, any one of which is disqualifying:
CITIZEN_ONLY = re.compile(r"""
    (?:u\.?\s?s\.?|united\s+states)\s+citizen(?:ship)?s?\s*
        (?:only|required|is\s+required|status\s+required)
  | must\s+be\s+(?:a\s+|an\s+)?(?:u\.?\s?s\.?|united\s+states)\s+citizen
  | citizenship\s+is\s+required
""", re.I | re.X)

# "No H1B" used to live in CITIZEN_ONLY and therefore blocked. It is not a
# citizenship requirement — it is JobRight's tag for "this employer does not
# sponsor H1B", which is the NO_SPONSORSHIP category, and that category is
# deliberately non-blocking (candidate's decision 2026-08-10: OPT + STEM OPT
# authorize ~3 years with no sponsorship at all). Misfiled here it removed 64
# perfectly applicable roles in one pass — Trovy, AEG, CoStar and others — on a
# tag that means the opposite of "citizens only". A posting that says BOTH (
# Protolabs: "No H1B U.S. Citizen Only") still blocks on the citizenship half.
NO_H1B_TAG = re.compile(r"\bno\s+h-?1-?b\b", re.I)

CLEARANCE_REQ = re.compile(r"""
    security\s+clearance
  | \bTS\s*/\s*SCI\b | \btop\s+secret\b | \bsecret\s+clearance\b
  # "Employee Polygraph Protection Act" is EEO footer boilerplate on every
  # Qualcomm/Workday posting, not a clearance requirement.
  | \bpolygraph\b(?!\s+protection) | \bpublic\s+trust\b
  | \bITAR\b
  | export\s+control[^.]{0,200}?(?:u\.?\s?s\.?\s+(?:citizen|person|national)|
                                  green\s+card|permanent\s+resident)
""", re.I | re.X | re.S)

# "No security clearance required" / "clearance is not required" must not block.
CLEARANCE_NEGATED = re.compile(
    r"(?:no|not|without|does\s+not\s+require)\s+(?:\w+\s+){0,3}?clearance"
    r"|clearance\s+(?:is\s+)?not\s+(?:required|needed)", re.I)

NO_SPONSORSHIP = re.compile(r"""
    (?:will\s+not|cannot|can\s?not|are\s+not\s+able\s+to|unable\s+to|
       do\s+not|does\s+not)\s+(?:currently\s+|presently\s+)?
       (?:offer\s+|provide\s+|consider\s+)?sponsor
  | no\s+(?:visa\s+|immigration\s+)?sponsorship
  | sponsorship\s+(?:is\s+)?not\s+(?:available|provided|offered)
  | not\s+(?:be\s+)?eligible\s+for\s+(?:visa\s+)?sponsorship
  | without\s+(?:the\s+need\s+for\s+)?(?:current\s+or\s+future\s+)?
       (?:visa\s+|immigration\s+|employment\s+)?sponsorship
""", re.I | re.X)

# JobRight prepends a *positive* sponsorship blurb — "has a track record of
# offering H1B sponsorships. Please note that this does not guarantee
# sponsorship for this specific role" — to hundreds of JDs. Matching it as a
# refusal would have blocked most of the ByteDance/Amazon new-grad pipeline.
NO_SPONSORSHIP_FP = re.compile(
    r"does\s+not\s+guarantee\s+sponsorship|track\s+record\s+of\s+offering", re.I)


def work_auth_block(text):
    """Reason string if the JD is closed to an F-1 OPT candidate, else None.

    "Will not sponsor" is deliberately NOT disqualifying (candidate's decision,
    2026-08-10). An F-1 OPT holder with the STEM extension is work-authorized
    for ~3 years without anyone sponsoring anything, so an employer that does
    not sponsor can still hire him for that period — and the sponsorship
    question on those applications is answered "No" for exactly that reason
    (see Job_applicator/CLAUDE.md). What genuinely closes a role is a
    citizenship or clearance requirement, which no amount of work authorization
    satisfies. NO_SPONSORSHIP is still evaluated so the reason can be reported,
    but it never blocks.
    """
    if CITIZEN_ONLY.search(text):
        return "citizen-only"
    m = CLEARANCE_REQ.search(text)
    if m and not CLEARANCE_NEGATED.search(text[max(0, m.start() - 60):m.end() + 60]):
        return "clearance"
    return None


def mentions_no_sponsorship(text):
    """Informational only — see work_auth_block. Never blocks a row."""
    if NO_H1B_TAG.search(text):
        return True
    for m in NO_SPONSORSHIP.finditer(text):
        if not NO_SPONSORSHIP_FP.search(text[max(0, m.start() - 120):m.end() + 120]):
            return True
    return False

# Off-domain roles (2026-08-08). Deliberately NARROW: it blocks titles whose own
# subject is a non-technical function, not every title that names a business
# domain. "Data Scientist, Sales AI" and "Applied Scientist, Marketing Science"
# are real applied-ML roles that happen to sit in a business org and must pass —
# at Amazon that is a large share of Applied Scientist openings. What gets
# blocked is the role that is not an engineering/DS job at all: a Tax systems
# role, a Financial Analyst, a People/Recruiting researcher.
#
# Title-only, so no JD fetch: the function word in the title is decisive.
OFFDOMAIN_TITLE = re.compile(
    r"\btax\b|"
    r"\bfinanc(?:e|ial)\s+(?:analyst|systems?)\b|"
    r"\b(?:people|talent|recruiting)\s+(?:research|scientist|analyst|partner|operations|ops)\b|"
    r"\brecruit(?:er|ing)\b|"
    r"\b(?:payroll|procurement|underwrit\w*|actuar\w*)\b",
    re.I)

YEARS = [
    re.compile(r"(?:at\s+least|minimum\s+(?:of\s+)?|min\.?\s*)(\d{1,2})\s*\+?\s*(?:years?|yrs?)", re.I),
    re.compile(r"(\d{1,2})\s*(?:\+|-|–|—|\s+to\s+)\s*\d{0,2}\s*\+?\s*(?:years?|yrs?)", re.I),
    re.compile(r"(\d{1,2})\s*\+?\s*(?:years?|yrs?)", re.I),
]
CONTEXT = re.compile(r"experience|exp\b|professional|industry|relevant|working|"
                     r"background|track record|hands[\s-]*on", re.I)
NOT_EXP = re.compile(r"of\s+age|years?\s+old|per\s+year|/\s*year|a\s+year", re.I)


def min_required_years(text, conjunctive=False, require_context=True):
    """Years-of-experience figure stated near experience wording, or None.

    Over a whole JD the smallest figure is the right answer: the body mixes
    binding minimums with preferred-qualification numbers, and taking the min
    keeps a "preferred: 5+ years" from blocking a role open to a new grad.

    Inside a Basic/Minimum Qualifications block the bullets are conjunctive —
    ALL of them must hold — so the binding requirement is the LARGEST. Amazon
    lists "3+ years of non-internship professional software development … 2+
    years of design or architecture … 1+ years of Object Oriented Design"; min()
    read that as 1 year and passed a 3-year role. Callers that have scoped the
    text to such a block pass conjunctive=True.

    require_context=False drops the "experience"-adjacency requirement. Inside a
    required-qualifications block every "N+ years" IS a requirement, whether or
    not the word "experience" sits next to it. Amazon's SDE-II basic qual reads
    "Bachelor's degree or equivalent - 4+ years of full software development
    life cycle, including coding standards, code reviews, source control ...":
    no CONTEXT word in the window, so the gate found no year figure at all and
    passed the role (Annapurna Labs "ML Software Engineer, Data Plane",
    2026-08-07). The NOT_EXP guard still applies, which is what keeps Amazon's
    "Must be 18 years of age or older" bullet out.
    """
    # YEARS is ordered most-specific first, and a later pattern re-matching text
    # a earlier one already consumed is always the wrong reading: in "1-3 years"
    # the range pattern yields the binding 1, then the bare-number pattern finds
    # "3 years" inside it. Under conjunctive=True max() then picked the range's
    # UPPER bound and blocked new-grad-friendly "1-2 years" / "1-3 years" roles
    # (Hayden AI Deep Learning Engineer, Cresta Data Scientist). Claiming spans
    # keeps one figure per stated requirement.
    found, claimed = [], []
    for pat in YEARS:
        for m in pat.finditer(text):
            if any(m.start() < ce and cs < m.end() for cs, ce in claimed):
                continue
            window = text[max(0, m.start() - 90):m.end() + 90]
            if NOT_EXP.search(text[max(0, m.start() - 20):m.end() + 20]):
                continue
            if require_context and not CONTEXT.search(window):
                continue
            n = int(m.group(1))
            if 1 <= n <= 20:
                claimed.append((m.start(), m.end()))
                found.append(n)
    if not found:
        return None
    return max(found) if conjunctive else min(found)


# Degree ladders are DISJUNCTIVE: "Master's degree and 2+ years OR Bachelor's
# degree and 6+ years OR 10+ years of related experience" is satisfied by any
# one branch, so the conjunctive max() reading (10) is wrong — the candidate
# holds an MS, so the MS branch is the binding one. Boeing writes every
# engineering req this way, including "Entry-Level Software Engineer"
# (Master's + 0 years), which max() would have blocked at 8 years.
MS_LADDER = re.compile(
    r"master'?s?(?:\s+degree)?\s*(?:\([^)]*\)\s*)?(?:and|with|plus|\+)\s*"
    r"(\d{1,2})\s*\+?\s*(?:years?|yrs?)", re.I)

SECTION_HEADS = ("basic qualifications", "minimum qualifications",
                 "required qualifications")


# Candidate's highest degree is a Master's (MS CS, Oregon State) — used to
# resolve "PhD, or Master's degree and N+ years" alternatives.
def required_years_for_ms(text):
    """Effective requirement for an MS holder, from the Basic/Minimum
    Qualifications section when present.

    Returns (years|None, phd_only, from_required_block). The third value tells
    the caller the figure came from a hard-requirement block rather than from
    loose body prose, so a stray new-grad marker elsewhere in the page must not
    override it.
    """
    low = text.lower()
    start = max(low.find(h) for h in SECTION_HEADS)
    if start < 0:
        return min_required_years(text), False, False
    end = low.find("preferred qualifications", start)
    section = text[start:end if end > 0 else start + 800]
    m = re.search(r"ph\.?d.{0,30}?or.{0,15}?master'?s\s+degree\s+and\s+(\d{1,2})\s*\+?\s*years?",
                  section, re.I | re.S)
    if m:
        return int(m.group(1)), False, True
    ladder = [int(x) for x in MS_LADDER.findall(section)]
    if ladder:
        return min(ladder), False, True
    if re.search(r"ph\.?d", section, re.I) and not re.search(r"master|bachelor|\bms\b|\bbs\b|equivalent",
                                                             section, re.I):
        return None, True, True
    yrs = min_required_years(section, conjunctive=True, require_context=False)
    if yrs is not None:
        return yrs, False, True
    return min_required_years(text), False, False


def applied_urls():
    """URLs already marked applied in data/pipeline.csv.

    The gate exists to stop the candidate applying to roles demanding more
    experience than they have — moot once the application is out, and the row is
    the only record that it happened. Retro-running with --all-pending removed 9
    already-applied rows on 2026-08-05 (DoorDash, Whatnot, Anthropic …) before
    this guard existed; deleting an application record is never the right call.
    """
    import csv as _csv
    urls = set()
    try:
        with open(f"{ROOT}/data/pipeline.csv", newline="", encoding="utf-8") as f:
            for row in _csv.DictReader(f):
                if row.get("applied", "").strip().upper() == "TRUE" and row.get("url"):
                    urls.add(row["url"].strip())
    except OSError:
        pass
    return urls


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--date")
    ap.add_argument("--all-pending", action="store_true")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()
    if not args.date and not args.all_pending:
        ap.error("pass --date YYYY-MM-DD or --all-pending")

    try:
        import yaml
        cfg = yaml.safe_load(open(f"{ROOT}/portals.yml", encoding="utf-8"))
        max_years = int((cfg.get("experience_filter") or {}).get("max_required_years", 1))
    except Exception:
        max_years = 1

    already_applied = applied_urls()
    lines = open(PIPE, encoding="utf-8").read().splitlines()
    kept, blocked, unverified = [], {}, []
    hist_status = {}  # url -> scan-history status when not skipped_experience
    out = []
    for l in lines:
        # Date is field 4; scan.mjs may append extra fields after it
        # (e.g. "| posted: 2026-07-15") — accept and preserve them.
        m = re.match(r"^- \[ \] (\S+) \| ([^|]+?) \| ([^|]+?) \| (\d{4}-\d{2}-\d{2})(?:\s*\|[^|]*)*\s*$", l)
        if not m or (not args.all_pending and m.group(4) != args.date):
            out.append(l)
            continue
        url, company, title = m.group(1), m.group(2).strip(), m.group(3).strip()
        is_applied = url in already_applied

        # Title-only blocks stay title-only: an ADC or level-II+ role is
        # unreachable whatever its JD says, so there is nothing to gain from
        # caching the text. Applied rows skip even these — see applied_urls().
        if not is_applied:
            if ADC_TITLE.search(title) or (ADC_WORD.search(title)
                                           and "amazon" in company.lower()):
                blocked[url] = "ADC"
                hist_status[url] = "skipped_clearance"
                print(f"  BLOCK clearance (ADC)  {company} | {title}")
                continue
            if LEVELED_TITLE.search(title):
                blocked[url] = "II+"
                print(f"  BLOCK level-II+ title  {company} | {title}")
                continue
            if OFFDOMAIN_TITLE.search(title):
                blocked[url] = "off-domain"
                hist_status[url] = "skipped_offdomain"
                print(f"  BLOCK off-domain  {company} | {title}")
                continue

        # Everything that survives gets its JD fetched and cached, including
        # new-grad-titled and already-applied rows. A "New Grad" title is no
        # longer an automatic pass — the body decides — and applied rows are
        # fetched purely so the JD is on disk for later use.
        _, text = JD.extract(url, JD.slugify(company, title))
        time.sleep(0.2)

        if is_applied:
            out.append(l)
            kept.append((company, title, "already applied — never gate-removed"))
            continue

        if text is None or len(text) < 200:
            out.append(l); unverified.append((company, title)); continue

        # Work authorization outranks everything else: a citizen-only or
        # cleared role is unreachable on an F-1 no matter how junior it is, so
        # this runs before the new-grad pass. A role that merely declines to
        # sponsor is NOT in that category — see work_auth_block.
        wa = work_auth_block(text)
        if wa:
            blocked[url] = wa
            hist_status[url] = "skipped_clearance"
            print(f"  BLOCK work-auth ({wa})  {company} | {title}")
            continue

        yrs, phd_only, from_required = required_years_for_ms(text)

        # A new-grad marker no longer rescues a role whose REQUIRED-qualifications
        # block states more years than the threshold. Amazon and Boeing pages
        # carry "Entry Level" / "Early Career" in job-category chrome and
        # JobRight tag strips while the basic quals demand 3-10 years; that
        # marker used to pass the row unconditionally.
        hard = (phd_only or (yrs is not None and yrs > max_years)) and from_required
        if not hard and NEWGRAD_PASS.search(text):
            out.append(l); kept.append((company, title, "new-grad marker in JD")); continue

        if phd_only:
            blocked[url] = "PhD"
            print(f"  BLOCK PhD-required  {company} | {title}")
        elif yrs is not None and yrs > max_years:
            blocked[url] = yrs
            print(f"  BLOCK {yrs}+yrs  {company} | {title}")
        else:
            out.append(l)
            kept.append((company, title, f"{yrs or 0} yrs min"))

    print(f"\nchecked entries: kept={len(kept)} blocked={len(blocked)} "
          f"unverified-kept={len(unverified)} (threshold: >{max_years} yrs)")
    for co, t in unverified:
        print(f"  UNVERIFIED (kept) {co} | {t}")

    if args.dry_run or not blocked:
        return
    open(PIPE, "w", encoding="utf-8").write("\n".join(out) + "\n")
    hist = open(HIST, encoding="utf-8").read().splitlines()
    new_hist = []
    for l in hist:
        c = l.split("\t")
        if len(c) >= 6 and c[0] in blocked and c[5] == "added":
            c[5] = hist_status.get(c[0], "skipped_experience")
            new_hist.append("\t".join(c))
        else:
            new_hist.append(l)
    open(HIST, "w", encoding="utf-8").write("\n".join(new_hist) + "\n")
    print("pipeline.md updated; run: python3 sync_pipeline_csv.py")


if __name__ == "__main__":
    main()
