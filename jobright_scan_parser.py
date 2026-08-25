#!/usr/bin/env python3
"""jobright_scan_parser.py — jobs-json-v1 adapter around the JobRight new-grad
GitHub job lists.

Registered as a `local_parser` for the "JobRight" entry in portals.yml so
`node scan.mjs` folds those lists into every career-ops scan. Emits
`{"jobs": [{title, url, company, location}]}` on stdout; logs go to stderr.

Why this replaced the old direct-to-CSV path (jobright.py appending straight to
data/pipeline.csv):
  - pipeline.csv is REGENERATED from data/pipeline.md by sync_pipeline_csv.py,
    so appended rows were wiped on the next sync and re-added on the next run —
    and any `applied` / `processed` tick on them was lost with them.
  - those rows bypassed every career-ops filter (title_filter, location_filter,
    data/blacklist.md, scan-history dedup, experience_gate.py), which is how
    "Quality Assurance Technician (Overnight)" and "Software Engineer - Android"
    ended up in the queue.
Going through scan.mjs fixes both: pipeline.md is the single source of truth and
the filters apply exactly as they do to every other provider.

jobright.py is still usable standalone for a raw dump; it is imported here for
its README table parser so the parsing logic lives in one place.

Usage:
  python3 jobright_scan_parser.py                    # jobs-json-v1 (scan.mjs)
  python3 jobright_scan_parser.py --standalone       # human summary, filters applied
  python3 jobright_scan_parser.py --readme <URL>     # extra list (repeatable)
"""
import html
import json
import os
import re
import sys
import time
import urllib.request
from datetime import date, timedelta

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

DESC_CACHE = os.path.join(HERE, "jobright_desc_cache.json")
LINK_CACHE = os.path.join(HERE, "jobright_apply_cache.json")
ENV_FILE = os.path.join(HERE, ".env")

# The employer's apply URL is server-rendered into the job page as
# "applyLink"/"originalUrl" — but ONLY for a logged-in session. Anonymously the
# page, its jobResult JSON and its JSON-LD all omit it, and the API answers
# {"errorCode":41001,"errorMsg":"Cookie not found"}. So resolution needs the
# user's own session cookie (JOBRIGHT_COOKIE, captured by jobright_login.py).
#
# Reading the page is deliberate: `/swan/job/apply` also returns the link, but
# it is a POST that records an application against the user's JobRight account.
# Reading a link must never write to their tracker.
APPLY_KEYS = re.compile(r'\\?"(?:applyLink|originalUrl)\\?"\s*:\s*\\?"(https?://[^"\\]{10,400})')
# JobRight's own attribution params — stripped so the pipeline stores the clean
# employer URL (and so the same posting from an ATS scan compares equal).
JR_PARAMS = re.compile(r"[?&](utm_source=jobright|jr_id=[0-9a-f]+)", re.I)
# A JobRight page is ~300 KB of HTML for ~4 KB of text, so fetching is the
# expensive part of this parser. The cache is permanent (a posting's text does
# not change) and keyed by job id, so steady-state runs only fetch new rows.
MAX_FETCH = 400  # page loads per run (shared budget); ~1.5 s each
FETCH_DELAY = 0.2
UA = {"User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36"}

# JobRight publishes one repo per track. Both are parsed with the same table
# format; add more with --readme.
READMES = [
    "https://raw.githubusercontent.com/jobright-ai/"
    "2026-Software-Engineer-New-Grad/refs/heads/master/README.md",
    "https://raw.githubusercontent.com/jobright-ai/"
    "2026-Data-Analysis-New-Grad/refs/heads/master/README.md",
]


def log(msg):
    print(f"[jobright-parser] {msg}", file=sys.stderr, flush=True)


def fetch_jobs(urls):
    import jobright

    jobs, seen = [], set()
    for url in urls:
        try:
            text = urllib.request.urlopen(url, timeout=30).read().decode("utf-8")
        except Exception as e:
            log(f"fetch failed ({type(e).__name__}: {e}): {url}")
            continue
        parsed = jobright.parse_readme(text)
        added = 0
        cutoff = (date.today() - timedelta(days=1)).isoformat()
        for j in parsed:
            if not j.get("url") or not j.get("title") or j["url"] in seen:
                continue
            if j.get("date") and j.get("date") < cutoff:
                continue
            seen.add(j["url"])
            jobs.append(j)
            added += 1
        repo = next((p for p in url.split("/") if p.startswith("20")), url)
        log(f"{added} jobs from {repo}")
    return jobs


def _strip_html(s):
    s = re.sub(r"<(script|style)[^>]*>.*?</\1>", " ", s, flags=re.S | re.I)
    return re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", " ", s)))


def _load_cache(path=None):
    try:
        with open(path or DESC_CACHE, encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {}


def _save_cache(path, data):
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f)
    os.replace(tmp, path)


# One page load answers both questions this parser asks of JobRight — the JD
# text (stack gate) and the employer apply URL (logged-in sessions only). They
# used to be fetched separately, which meant two ~400 KB loads for any row that
# needed both. `_budget` caps total loads per run so the parser cannot blow past
# its portals.yml timeout_ms and get killed mid-scan.
_budget = {"left": 0}


def _fetch_job_page(jid, cookie):
    """The JobRight page for a job id, or None. Authenticated when a cookie is
    available, because `applyLink` is only rendered for a logged-in session."""
    if _budget["left"] <= 0:
        return None
    headers = dict(UA, Referer="https://jobright.ai/jobs")
    if cookie:
        headers["Cookie"] = cookie
    try:
        req = urllib.request.Request(f"https://jobright.ai/jobs/info/{jid}",
                                     headers=headers)
        with urllib.request.urlopen(req, timeout=25) as r:
            page = r.read().decode("utf-8", "replace")
    except Exception:
        _budget["left"] -= 1
        time.sleep(FETCH_DELAY)
        return None
    _budget["left"] -= 1
    time.sleep(FETCH_DELAY)
    return page


def fetch_descriptions(jobs, portals):
    """Fill in `description` for the rows whose stack the JD has to settle.

    JobRight's README carries no description, and the title alone cannot tell an
    ML-adjacent "Software Engineer" from an iOS one — so for exactly the titles
    that matched a `content_filter.by_title_keyword` keyword, fetch the JobRight
    page (its JD text is server-rendered) and cache it. Every other row is left
    untouched: a title like "Data Engineer" is decided by the title filter alone
    and never needs the round trip."""
    import scan_common as sc

    cache = _load_cache()
    links = _load_cache(LINK_CACHE)
    cookie = load_cookie()
    # Skip rows the title filter already rejects — no point paying for a JD that
    # scan.mjs will drop on the title anyway ("Software Engineer - Android").
    title_ok = sc.build_title_filter(portals.get("title_filter"))
    todo = [j for j in jobs
            if title_ok(j.get("title", ""))
            and sc.needs_description(j.get("title", ""), portals)]
    hits = fetched = failed = 0
    for j in todo:
        jid = sc.job_id(j.get("url", ""))
        if jid in cache:
            j["description"] = cache[jid]
            hits += 1
            continue
        page = _fetch_job_page(jid, cookie)
        if page is None:
            failed += 1
            continue          # budget spent or fetch failed: no JD = passes the gate
        cache[jid] = _strip_html(page)
        j["description"] = cache[jid]
        # Same page already carries the apply link when authenticated — record it
        # so resolve_apply_links() does not pay for this page a second time.
        if cookie and jid not in links:
            links[jid] = extract_apply_link(page)
        fetched += 1

    if fetched:
        _save_cache(DESC_CACHE, cache)
        _save_cache(LINK_CACHE, links)
    log(f"descriptions: {len(todo)} needed ({hits} cached, {fetched} fetched, "
        f"{failed} skipped/failed)")
    return jobs


def load_cookie():
    """JOBRIGHT_COOKIE from the environment, falling back to .env.

    scan.mjs loads .env through dotenv and the parser inherits its environment,
    so inside a scan the variable is already set; the .env read is what makes a
    standalone `python3 jobright_scan_parser.py` behave the same."""
    cookie = os.environ.get("JOBRIGHT_COOKIE", "").strip()
    if cookie:
        return cookie
    try:
        for line in open(ENV_FILE, encoding="utf-8"):
            line = line.strip()
            if line.startswith("JOBRIGHT_COOKIE="):
                return line.split("=", 1)[1].strip().strip('"').strip("'")
    except OSError:
        pass
    return ""


def extract_apply_link(page_html):
    """The employer's apply URL from a logged-in job page, tracking stripped."""
    m = APPLY_KEYS.search(page_html)
    if not m:
        return ""
    url = m.group(1).replace("\\u0026", "&").replace("&amp;", "&")
    url = JR_PARAMS.sub("", url)
    return url.rstrip("?&")


def resolve_apply_links(jobs, cookie, refresh=False):
    """Replace jobright.ai URLs with the employer's own apply URL where possible.

    One authenticated fetch per posting yields both the apply link and the JD
    text, so this also tops up the description cache the stack gate uses.
    Unresolved rows keep their JobRight link — a working redirect beats no link.
    Misses are cached as "" so they are not retried every run; --refresh-links
    retries them (a posting can gain a link later)."""
    if not cookie:
        log("JOBRIGHT_COOKIE not set — keeping jobright.ai links. Run: "
            ".venv-jobspy/bin/python jobright_login.py")
        return jobs, 0

    cache = _load_cache(LINK_CACHE)
    descs = _load_cache()
    resolved = fetched = misses = failed = 0
    auth_failed = False

    for j in jobs:
        m = re.search(r"/jobs/info/([0-9a-f]+)", j.get("url", ""))
        if not m:
            continue
        jid = m.group(1)
        if jid in cache and not (refresh and not cache[jid]):
            url = cache[jid]
        elif auth_failed:
            continue
        else:
            page = _fetch_job_page(jid, cookie)
            if page is None:
                failed += 1
                continue
            # A logged-out response never carries applyLink; treat a run of them
            # as an expired cookie rather than caching hundreds of false misses.
            url = extract_apply_link(page)
            if not url and "applyLink" not in page and "SIGN IN" in page[:4000]:
                auth_failed = True
                log("JobRight served logged-out pages — the cookie looks expired. "
                    "Re-run jobright_login.py; keeping jobright.ai links this run")
                break
            cache[jid] = url
            descs.setdefault(jid, _strip_html(page))
            fetched += 1
        if url:
            j["jobright_url"] = j["url"]
            j["url"] = url
            resolved += 1
        else:
            misses += 1

    if fetched:
        _save_cache(LINK_CACHE, cache)
        _save_cache(DESC_CACHE, descs)
    log(f"apply links: {resolved} employer URLs, {misses} kept as jobright.ai, "
        f"{failed} fetch failures ({fetched} lookups this run)")
    return jobs, resolved


def apply_stack_gate(jobs, portals):
    """portals.yml content_filter over the fetched JDs — the check that keeps an
    iOS or Salesforce role posted as plain "Software Engineer" out. Rows with no
    description (fetch failed, or never needed one) pass, per the filter's
    missing-data convention."""
    import scan_common
    return scan_common.stack_gate(
        jobs, lambda j: j.get("title", ""), lambda j: j.get("description", ""),
        portals=portals, log=log)


def apply_scan_filters(jobs, portals=None):
    """title_filter / location_filter / blacklist, as scan.mjs applies them.
    Only for --standalone; inside a scan, scan.mjs is authoritative."""
    import scan_common
    portals = portals if portals is not None else scan_common.load_portals()
    title_ok = scan_common.build_title_filter(portals.get("title_filter"))
    loc_ok = scan_common.build_location_filter(portals.get("location_filter"))
    blacklist = scan_common.load_blacklist()
    kept, dropped = [], []
    for j in jobs:
        if not title_ok(j.get("title", "")):
            dropped.append((j, "title_filter"))
        elif not loc_ok(j.get("location", "")):
            dropped.append((j, "location_filter"))
        elif scan_common.normalize_company(j.get("company", "")) in blacklist:
            dropped.append((j, "blacklist"))
        else:
            kept.append(j)
    return kept, dropped


def main():
    args = sys.argv[1:]
    urls = list(READMES)
    extra = [args[i + 1] for i, a in enumerate(args) if a == "--readme" and i + 1 < len(args)]
    if extra:
        urls = extra

    import scan_common
    portals = scan_common.load_portals()

    # Total page loads allowed this run, shared by the description and
    # apply-link phases. At ~1.5 s each, MAX_FETCH keeps the worst case inside
    # the parser's portals.yml timeout_ms with room to spare; a backlog larger
    # than the budget simply finishes on the next run, since both caches persist.
    _budget["left"] = MAX_FETCH

    jobs = fetch_jobs(urls)
    jobs = fetch_descriptions(jobs, portals)
    jobs, _off_stack = apply_stack_gate(jobs, portals)

    # Resolve apply links only for what survives every filter — scan.mjs would
    # discard the rest anyway, and each lookup is an authenticated page fetch.
    # The rows are mutated in place, so `jobs` carries the rewritten URLs too.
    survivors, _ = apply_scan_filters(jobs, portals)
    resolve_apply_links(survivors, load_cookie(), refresh="--refresh-links" in args)

    if "--standalone" in args:
        kept, dropped = apply_scan_filters(jobs, portals)
        log(f"portals.yml filters: {len(kept)} pass, {len(dropped)} dropped")
        for j, why in dropped[:20]:
            log(f"  DROP [{why}] {j.get('company','')} | {j.get('title','')}")
        for j in kept:
            print(f"{j.get('company','')} | {j.get('title','')} | {j.get('url','')}")
        return

    import json
    json.dump({"jobs": [{
        "title": j.get("title", ""),
        "url": j.get("url", ""),
        "company": j.get("company", ""),
        "location": j.get("location", ""),
    } for j in jobs]}, sys.stdout)


if __name__ == "__main__":
    main()
