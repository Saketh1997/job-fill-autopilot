#!/usr/bin/env python3
"""scan_common.py — career-ops scan filters and job identity, in Python.

`scan.mjs` owns the canonical filters (title / location / blacklist) and applies
them to every provider, including `local_parser` ones. This module mirrors those
semantics so Python-side scrapers (`jobspy_scan_parser.py`,
`jobright_scan_parser.py`) and `dedup_pipeline.py` reach the same verdict when
they run standalone — outside a `node scan.mjs` chain.

Mirrored from scan.mjs (keep in sync if portals.yml semantics change):
  compileKeyword       -> compile_keyword     (2-3 letter acronyms match on word
                                               boundaries, everything else is a
                                               case-insensitive substring)
  buildTitleFilter     -> build_title_filter  (>=1 positive AND 0 negatives)
  buildLocationFilter  -> build_location_filter (always_allow > block > allow;
                                               empty location always passes)
  loadBlacklist        -> load_blacklist      (data/blacklist.md, opt-in)
  normalizeCompany     -> normalize_company   (tracker-utils.mjs)

Also holds the job-identity helpers the dedup pass needs: URL canonicalization
(tracking params stripped), the ATS job-id extractor shared with
`sync_pipeline_csv.py`, and a source ranking so a duplicate collapses onto the
employer's own ATS link rather than an aggregator redirect.
"""
import os
import re
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

ROOT = os.path.dirname(os.path.abspath(__file__))
PORTALS = os.path.join(ROOT, "portals.yml")
BLACKLIST = os.path.join(ROOT, "data/blacklist.md")

_ACRONYM = re.compile(r"^[a-z]{2,3}$")


# ── portals.yml ─────────────────────────────────────────────────────

def load_portals(path=PORTALS, strict=True):
    """portals.yml as a dict.

    Raises by design when PyYAML is missing or the file won't parse: an empty
    config makes every filter a no-op (`title_filter` with no keywords passes
    everything), so failing loudly is the only safe default — a silent {} once
    let a scrape of unrelated jobs through untouched. Pass strict=False only
    where "no config" is genuinely equivalent to "no filtering"."""
    try:
        import yaml
        with open(path, encoding="utf-8") as f:
            return yaml.safe_load(f) or {}
    except Exception as e:
        if strict:
            raise RuntimeError(
                f"cannot load {path} ({type(e).__name__}: {e}) — career-ops "
                "filters would silently pass everything. Install PyYAML in the "
                "interpreter running this script (.venv-jobspy/bin/pip install pyyaml)."
            ) from e
        return {}


def _keywords(value):
    """Normalize a portals.yml keyword list: tolerate a bare string, None, and
    non-string entries; lowercase, trim, drop empties (an empty keyword would
    substring-match everything and silently bypass the filter)."""
    if value is None:
        return []
    if not isinstance(value, list):
        value = [value]
    out = []
    for k in value:
        if isinstance(k, str) and k.strip():
            out.append(k.strip().lower())
    return out


# ── Title filter ────────────────────────────────────────────────────

def compile_keyword(kw):
    """Matcher for one lowercased keyword. Short all-letter acronyms (ROS, SRE)
    match on word boundaries so they don't hit mid-word; everything else keeps
    permissive substring matching (".NET", "Sr ", "Machine Learning")."""
    if _ACRONYM.match(kw):
        rx = re.compile(r"\b%s\b" % re.escape(kw))
        return lambda lower: bool(rx.search(lower))
    return lambda lower: kw in lower


def build_title_filter(title_filter):
    """(title) -> bool. Passes when >=1 positive matches (or no positives are
    configured) AND no negative matches."""
    positive = [compile_keyword(k) for k in _keywords((title_filter or {}).get("positive"))]
    negative = [compile_keyword(k) for k in _keywords((title_filter or {}).get("negative"))]

    def ok(title):
        lower = (title or "").lower()
        has_positive = not positive or any(m(lower) for m in positive)
        return has_positive and not any(m(lower) for m in negative)

    return ok


def matched_title_keywords(title, title_filter):
    """The `title_filter.positive` keywords (as written in portals.yml) that a
    title matched — the scope key for content_filter.by_title_keyword."""
    raw = (title_filter or {}).get("positive")
    raw = raw if isinstance(raw, list) else []
    lower = (title or "").lower()
    out = []
    for k in raw:
        if isinstance(k, str) and k.strip() and compile_keyword(k.strip().lower())(lower):
            out.append(k)
    return out


# ── Content filter ──────────────────────────────────────────────────
# Mirrors scan.mjs buildContentFilter. It exists in Python because
# local-parser.mjs keeps only title/url/company/location from a parser's output
# — scan.mjs never sees a local parser's descriptions, so a description-level
# rule has to be enforced inside the parser that fetched them.

def build_content_filter(content_filter):
    """(description, matched_title_keywords) -> bool.

    An empty description always passes: the rule can only judge text a source
    actually returned, and dropping everything a provider left blank would
    silently gut those feeds.
    """
    if not content_filter:
        return lambda description, matched=(): True
    positive = _keywords(content_filter.get("positive"))
    negative = _keywords(content_filter.get("negative"))

    by_keyword = {}
    raw_by_kw = content_filter.get("by_title_keyword")
    if isinstance(raw_by_kw, dict):
        for kw, rule in raw_by_kw.items():
            if not isinstance(kw, str) or not kw.strip():
                continue
            rule = rule or {}
            by_keyword[kw.strip().lower()] = (
                _keywords(rule.get("positive")), _keywords(rule.get("negative")))

    def ok(description, matched=()):
        if not isinstance(description, str) or not description.strip():
            return True
        lower = description.lower()
        overrides = [by_keyword[k.strip().lower()] for k in matched
                     if isinstance(k, str) and k.strip().lower() in by_keyword]

        def passes(pos, neg):
            if neg and any(k in lower for k in neg):
                return False
            return not pos or any(k in lower for k in pos)

        # A title matching several scoped keywords passes if ANY of their rules
        # passes — same as scan.mjs. Scoped rules replace the global pair.
        if overrides:
            return any(passes(p, n) for p, n in overrides)
        return passes(positive, negative)

    return ok


# ── Location filter ─────────────────────────────────────────────────

def build_location_filter(location_filter):
    """(location) -> bool. Missing/blank location passes (never penalize absent
    provider data). always_allow wins over block; an empty allow list means
    "anything that cleared block"."""
    if not location_filter:
        return lambda location: True
    always_allow = _keywords(location_filter.get("always_allow"))
    allow = _keywords(location_filter.get("allow"))
    block = _keywords(location_filter.get("block"))

    def ok(location):
        if not isinstance(location, str) or not location.strip():
            return True
        lower = location.lower()
        if always_allow and any(k in lower for k in always_allow):
            return True
        if block and any(k in lower for k in block):
            return False
        if not allow:
            return True
        return any(k in lower for k in allow)

    return ok


def stack_gate(jobs, title_of, desc_of, portals=None, log=None):
    """Apply portals.yml `content_filter` to a local parser's jobs.

    @param title_of/desc_of: callables mapping a job to its title / description.
    @returns (kept, [(job, reason)])
    """
    portals = portals if portals is not None else load_portals()
    content = portals.get("content_filter")
    if not content:
        return list(jobs), []
    ok = build_content_filter(content)
    tf = portals.get("title_filter")
    kept, dropped = [], []
    for j in jobs:
        matched = matched_title_keywords(title_of(j), tf)
        if ok(desc_of(j), matched):
            kept.append(j)
        else:
            dropped.append((j, "content_filter (off-stack JD)"))
    if log and dropped:
        log(f"content_filter dropped {len(dropped)} off-stack posting(s)")
    return kept, dropped


def needs_description(title, portals):
    """True when the title matched a `content_filter.by_title_keyword` keyword,
    i.e. the JD text is what decides — the only case worth paying a fetch for."""
    scoped = (portals.get("content_filter") or {}).get("by_title_keyword") or {}
    if not scoped:
        return False
    scoped_keys = {k.strip().lower() for k in scoped if isinstance(k, str)}
    return any(k.strip().lower() in scoped_keys
               for k in matched_title_keywords(title, portals.get("title_filter")))


# ── Company blacklist ───────────────────────────────────────────────

def normalize_company(name):
    """Tracker-wide company key (tracker-utils.mjs normalizeCompany)."""
    return re.sub(r"[^a-z0-9]", "", (name or "").lower())


def load_blacklist(path=BLACKLIST):
    """{normalized company -> reason} from data/blacklist.md. Absent or
    table-less file = {} = no filtering. Never created or written here."""
    entries = {}
    if not os.path.exists(path):
        return entries
    with open(path, encoding="utf-8") as f:
        for line in f:
            if not line.strip().startswith("|"):
                continue
            cells = [c.strip() for c in line.split("|")]
            company = cells[1] if len(cells) > 1 else ""
            if not company or re.fullmatch(r"[-: ]+", company):
                continue                      # separator row
            if company.lower() == "company":
                continue                      # header row
            key = normalize_company(company)
            if key and key not in entries:
                entries[key] = cells[4] if len(cells) > 4 else ""
    return entries


# ── Clearance / citizenship gate (modes/_custom.md house rule) ───────
# F-1 visa, no clearance: these roles are ineligible regardless of title. The
# words live in Webscrapper/config.json (desc_words) so the LinkedIn scraper and
# the JobSpy parser share one list; these are the fallbacks if it can't be read.
CLEARANCE_FALLBACK = [
    "u.s. citizen", "us citizen", "u.s citizenship", "us citizenship",
    "must be a us citizen", "usc only", "citizenship required",
    "security clearance", "active clearance", "clearance required",
    "dod clearance", "secret clearance", "ts/sci", "polygraph",
    "amazon dedicated cloud",
]


def load_clearance_words(config_path=os.path.join(ROOT, "Webscrapper/config.json")):
    import json
    try:
        with open(config_path, encoding="utf-8") as f:
            words = json.load(f).get("desc_words") or []
        words = [w.lower() for w in words if isinstance(w, str) and w.strip()]
        return words or list(CLEARANCE_FALLBACK)
    except Exception:
        return list(CLEARANCE_FALLBACK)


def clearance_blocked(text, words):
    """First blocking phrase found in the description, or None."""
    if not text:
        return None
    lower = text.lower()
    for w in words:
        if w in lower:
            return w
    return None


# ── Job identity ────────────────────────────────────────────────────

# Tracking/campaign params carry no identity — two rows differing only by utm_*
# are the same posting. Stripped before comparing URLs.
_TRACKING_PARAMS = re.compile(
    r"^(utm_|ref$|refid$|src$|source$|trk$|trackingId$|gh_src$|lever-source|"
    r"__jvst|__jvsd|fbclid$|gclid$|mc_cid$|mc_eid$)", re.I)

_ID_PATTERNS = [
    r"/jobs/view/[\w-]*?(\d{6,})",                                        # linkedin
    r"/jobs/(\d+)",                                                       # greenhouse, amazon
    r"gh_jid=(\d+)",                                                      # greenhouse embed
    r"/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})",   # lever, ashby
    r"[?&]jk=([0-9a-f]{10,})",                                            # indeed
    r"/jobs/info/([0-9a-f]{16,})",                                        # jobright
]


def canonical_url(url):
    """URL with tracking params dropped, fragment removed, host lowercased and
    trailing slash trimmed. Identity only — the original string is what gets
    written to the pipeline."""
    url = (url or "").strip()
    if not url:
        return ""
    try:
        parts = urlsplit(url)
    except ValueError:
        return url.rstrip("/").lower()
    query = [(k, v) for k, v in parse_qsl(parts.query, keep_blank_values=True)
             if not _TRACKING_PARAMS.match(k)]
    path = parts.path.rstrip("/") or "/"
    return urlunsplit((parts.scheme.lower(), parts.netloc.lower(), path,
                       urlencode(query), ""))


def job_id(url):
    """Stable posting id when the URL carries one, else the canonical URL.
    Same contract as `jid()` in sync_pipeline_csv.py, with aggregator patterns
    added so an Indeed/JobRight row collapses onto its own earlier copy."""
    for pat in _ID_PATTERNS:
        m = re.search(pat, url or "")
        if m:
            return m.group(1).lower()
    return canonical_url(url)


_TITLE_NOISE = re.compile(
    r"\b(?:remote|hybrid|on-?site|full[- ]?time|part[- ]?time|contract|"
    r"us|usa|united states|new|urgent|hiring|w2|c2c)\b", re.I)
_REQ_ID = re.compile(r"\b(?:req|job|jr|r)[-_ ]?\d{3,}\b", re.I)


def norm_text(s):
    """Lowercase, punctuation- and whitespace-collapsed form for fuzzy keys."""
    return re.sub(r"\s+", " ", re.sub(r"[^a-z0-9]+", " ", (s or "").lower())).strip()


def title_key(title):
    """Title stripped of req ids, parentheticals, and work-arrangement noise, so
    'Data Engineer (Remote) - Req 12345' and 'Data Engineer' collapse."""
    t = re.sub(r"\([^)]*\)", " ", title or "")
    t = _REQ_ID.sub(" ", t)
    t = _TITLE_NOISE.sub(" ", t)
    return norm_text(t)


def company_key(company):
    """Company stripped of legal suffixes so 'Acme, Inc.' == 'Acme'."""
    c = norm_text(company)
    c = re.sub(r"\b(inc|llc|l l c|ltd|limited|corp|corporation|co|company|"
               r"gmbh|plc|sa|llp|lp|group|holdings|technologies|technology|"
               r"labs|ai)\b", " ", c)
    return re.sub(r"\s+", " ", c).strip() or norm_text(company)


def pair_key(company, title):
    """Cross-source identity: the same posting listed on LinkedIn and Indeed has
    two URLs but one (company, title)."""
    c, t = company_key(company), title_key(title)
    return f"{c}|{t}" if c and t else ""


# Lower rank wins when duplicates collapse: keep the employer's own ATS link
# over an aggregator redirect, since that is what the apply flow needs.
_SOURCE_RANK = [
    (re.compile(r"(greenhouse\.io|lever\.co|ashbyhq\.com|myworkdayjobs\.com|"
                r"workable\.com|smartrecruiters\.com|icims\.com|"
                r"successfactors\.com|taleo\.net|jobvite\.com|breezy\.hr|"
                r"recruitee\.com|teamtailor\.com|amazon\.jobs)", re.I), 0),
    (re.compile(r"(careers?\.|jobs\.)", re.I), 1),
    (re.compile(r"linkedin\.com", re.I), 3),
    (re.compile(r"(indeed\.com|glassdoor\.com|ziprecruiter\.com|google\.com)", re.I), 4),
    (re.compile(r"jobright\.ai", re.I), 5),
]


def source_rank(url):
    for rx, rank in _SOURCE_RANK:
        if rx.search(url or ""):
            return rank
    return 2  # unknown company domain — still better than an aggregator
