#!/usr/bin/env python3
"""jobspy_scan_parser.py — jobs-json-v1 adapter around the JobSpy library.

Registered as a `local_parser` for the "JobSpy" entry in portals.yml so
`node scan.mjs` scrapes Indeed / Google / ZipRecruiter / Glassdoor / LinkedIn in
every career-ops scan. Emits `{"jobs": [{title, url, company, location}]}` on
stdout; every log line goes to stderr so stdout stays valid JSON.

Where the career-ops filters apply:
  - title_filter, location_filter, data/blacklist.md, scan-history dedup
    -> applied by scan.mjs to whatever this parser emits (same code path as
       every other provider). With --standalone they are applied here instead,
       via scan_common.py, so a manual run filters identically.
  - clearance / citizenship words (modes/_custom.md house rule) -> applied HERE,
    because scan.mjs never sees the description: local-parser.mjs keeps only
    title/url/company/location. JobSpy already fetched the description, so the
    check is free.
  - years of experience -> experience_gate.py, later in the chain (it re-fetches
    each JD from the pipeline).

Cache: if jobspy_jobs.csv is younger than cache_ttl_hours (jobspy_config.json),
its rows are emitted directly — a full scrape takes several minutes and burns
rate-limit budget, so scan retries and back-to-back scans must not re-hit the
boards. Pass --fresh to force a live scrape.

Usage:
  python3 jobspy_scan_parser.py                # jobs-json-v1 on stdout (scan.mjs)
  python3 jobspy_scan_parser.py --fresh        # ignore the cache
  python3 jobspy_scan_parser.py --standalone   # human summary, filters applied
  python3 jobspy_scan_parser.py --limit 2      # only the first 2 searches (smoke test)

JobSpy lives in .venv-jobspy (Debian's python3 is externally managed, PEP 668):
this script re-execs itself with that interpreter when `jobspy` is not importable.
Recreate it with:
  python3 -m venv .venv-jobspy && .venv-jobspy/bin/pip install -U python-jobspy
"""
import csv
import json
import os
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
CONFIG = os.path.join(HERE, "jobspy_config.json")
CACHE = os.path.join(HERE, "jobspy_jobs.csv")
DROPPED = os.path.join(HERE, "jobspy_jobs_filtered.csv")
VENV_DIR = os.path.join(HERE, ".venv-jobspy")
VENV_PY = os.path.join(VENV_DIR, "bin/python")
FIELDS = ["site", "title", "company", "location", "job_url", "date_posted",
          "is_remote", "job_type", "min_amount", "max_amount", "interval",
          "search_term", "description"]

sys.path.insert(0, HERE)


def log(msg):
    print(f"[jobspy-parser] {msg}", file=sys.stderr, flush=True)


def ensure_jobspy():
    """Re-exec under .venv-jobspy when jobspy isn't importable here."""
    try:
        import jobspy  # noqa: F401
        return
    except ImportError:
        pass
    # Compare prefixes, not interpreter paths: a venv's bin/python is a symlink
    # to the system python, so realpath(sys.executable) is identical inside and
    # outside the venv and would make this guard skip the re-exec forever.
    already_in_venv = os.path.realpath(sys.prefix) == os.path.realpath(VENV_DIR)
    if os.path.exists(VENV_PY) and not already_in_venv:
        os.execv(VENV_PY, [VENV_PY, os.path.abspath(__file__)] + sys.argv[1:])
    sys.exit("jobspy is not installed and .venv-jobspy is missing — run:\n"
             "  python3 -m venv .venv-jobspy && .venv-jobspy/bin/pip install -U python-jobspy")


def load_config():
    with open(CONFIG, encoding="utf-8") as f:
        cfg = json.load(f)
    if cfg.get("hours_old") in (None, ""):
        import scan_common
        opts = (scan_common.load_portals().get("scan_options") or {})
        cfg["hours_old"] = opts.get("posted_within_hours") or 24
    return cfg


def cell(row, key):
    """DataFrame cell as a clean string ('' for NaN/None)."""
    v = row.get(key)
    if v is None:
        return ""
    s = str(v).strip()
    return "" if s.lower() in ("nan", "nat", "none") else s


def scrape(cfg, limit=None):
    from jobspy import scrape_jobs

    searches = cfg.get("searches") or []
    if limit:
        searches = searches[:limit]
    delay = float(cfg.get("request_delay_seconds") or 0)
    jobs, seen_urls = [], set()

    for i, s in enumerate(searches, 1):
        sites = s.get("sites") or cfg.get("sites") or ["indeed"]
        term = s.get("search_term", "")
        log(f"search {i}/{len(searches)} on {','.join(sites)}: {term[:70]}")
        params = dict(
            site_name=sites,
            search_term=term,
            location=s.get("location") or "United States",
            results_wanted=int(s.get("results_wanted") or cfg.get("results_wanted") or 20),
            hours_old=int(s.get("hours_old") or cfg.get("hours_old") or 24),
            country_indeed=s.get("country_indeed") or cfg.get("country_indeed") or "USA",
            description_format=cfg.get("description_format") or "markdown",
            linkedin_fetch_description=bool(cfg.get("linkedin_fetch_description")),
            verbose=0,
        )
        if s.get("google_search_term"):
            params["google_search_term"] = s["google_search_term"]
        if s.get("is_remote") is not None:
            params["is_remote"] = bool(s["is_remote"])
        if cfg.get("proxies"):
            params["proxies"] = cfg["proxies"]

        try:
            df = scrape_jobs(**params)
        except Exception as e:                      # one dead board must not kill the scan
            log(f"  search failed ({type(e).__name__}: {e}) — continuing")
            continue

        added = 0
        for _, r in df.iterrows():
            row = {f: cell(r, f) for f in FIELDS}
            row["search_term"] = term
            url = row["job_url"]
            if not url or not row["title"]:
                continue
            if url in seen_urls:                    # same posting from two boards
                continue
            seen_urls.add(url)
            jobs.append(row)
            added += 1
        log(f"  +{added} (running total {len(jobs)})")
        if delay and i < len(searches):
            time.sleep(delay)

    return jobs


def drop_incomplete(jobs):
    """Rows without an employer are unusable: local-parser.mjs falls back to the
    portals.yml entry name, so they would enter the pipeline as company "JobSpy"
    — invisible to the blacklist, unmatchable in the tracker, and undedupable by
    company+title. Applied on the cache path too, so an older cache can't
    reintroduce them."""
    kept = [j for j in jobs if (j.get("company") or "").strip()]
    if len(kept) != len(jobs):
        log(f"dropped {len(jobs) - len(kept)} row(s) with no company")
    return kept


def apply_clearance_gate(jobs):
    """Drop postings whose description requires US citizenship or a clearance
    (modes/_custom.md). Returns (kept, dropped-with-reason)."""
    import scan_common
    words = scan_common.load_clearance_words()
    kept, dropped = [], []
    for j in jobs:
        hit = scan_common.clearance_blocked(
            f"{j.get('title','')}\n{j.get('description','')}", words)
        if hit:
            dropped.append((j, f"clearance/citizenship: {hit}"))
        else:
            kept.append(j)
    return kept, dropped


def apply_stack_gate(jobs):
    """portals.yml content_filter against the JD text JobSpy already fetched.

    Runs HERE for the same reason the clearance gate does: local-parser.mjs
    keeps only title/url/company/location, so scan.mjs cannot apply a
    description rule to a local parser's output. Today this is what stops an
    iOS/Android role posted as plain "Software Engineer" from entering the
    pipeline under the generic SWE title positives."""
    import scan_common
    return scan_common.stack_gate(
        jobs, lambda j: j.get("title", ""), lambda j: j.get("description", ""),
        log=log)


def apply_scan_filters(jobs):
    """title_filter / location_filter / blacklist, as scan.mjs would apply them.
    Only used for --standalone runs; inside a scan, scan.mjs is authoritative."""
    import scan_common
    portals = scan_common.load_portals()
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


def write_csv(path, rows, extra_col=None):
    with open(path, "w", newline="", encoding="utf-8") as f:
        cols = FIELDS + ([extra_col] if extra_col else [])
        w = csv.DictWriter(f, fieldnames=cols, extrasaction="ignore")
        w.writeheader()
        w.writerows(rows)


def jobs_from_cache():
    with open(CACHE, newline="", encoding="utf-8") as f:
        return [dict(r) for r in csv.DictReader(f)]


def emit(jobs):
    json.dump({"jobs": [{
        "title": j.get("title", ""),
        "url": j.get("job_url", ""),
        "company": j.get("company", ""),
        "location": j.get("location", ""),
    } for j in jobs]}, sys.stdout)


def main():
    args = sys.argv[1:]
    standalone = "--standalone" in args
    fresh = "--fresh" in args
    limit = None
    if "--limit" in args:
        limit = int(args[args.index("--limit") + 1])

    cache_fresh = (
        not fresh and not limit
        and os.path.exists(CACHE)
        and (time.time() - os.path.getmtime(CACHE)) < float(load_config().get("cache_ttl_hours") or 6) * 3600
    )

    if cache_fresh:
        age_min = (time.time() - os.path.getmtime(CACHE)) / 60
        log(f"using cache ({age_min:.0f} min old): {CACHE}")
        # Re-gate on the cache path too: the cache keeps descriptions, so a
        # portals.yml edit takes effect on the next scan instead of waiting out
        # the cache TTL.
        jobs, _ = apply_stack_gate(drop_incomplete(jobs_from_cache()))
        dropped = []
    else:
        log("cache stale or missing — live scrape")
        ensure_jobspy()
        cfg = load_config()
        jobs = drop_incomplete(scrape(cfg, limit=limit))
        jobs, dropped = apply_clearance_gate(jobs)
        jobs, off_stack = apply_stack_gate(jobs)
        dropped += off_stack
        if limit:
            # A --limit run covers only the first N searches; writing it to the
            # cache would leave scan.mjs reading a truncated scrape for hours.
            log(f"--limit {limit}: cache left untouched")
        else:
            write_csv(CACHE, jobs)
            write_csv(DROPPED, [dict(j, drop_reason=why) for j, why in dropped],
                      extra_col="drop_reason")
        log(f"scraped {len(jobs) + len(dropped)}; kept {len(jobs)}, "
            f"dropped {len(dropped)} on clearance/citizenship")

    if standalone:
        kept, filtered = apply_scan_filters(jobs)
        log(f"portals.yml filters: {len(kept)} pass, {len(filtered)} dropped")
        for j, why in filtered[:20]:
            log(f"  DROP [{why}] {j.get('company','')} | {j.get('title','')}")
        for j in kept:
            print(f"{j.get('company','')} | {j.get('title','')} | "
                  f"{j.get('location','')} | {j.get('job_url','')}")
        log(f"cache: {CACHE} ({len(jobs)} rows)")
        return

    emit(jobs)


if __name__ == "__main__":
    main()
