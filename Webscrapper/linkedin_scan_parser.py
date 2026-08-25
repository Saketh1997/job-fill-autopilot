#!/usr/bin/env python3
"""linkedin_scan_parser.py — jobs-json-v1 adapter around webscrapper.py.

Registered as a `local_parser` for the "LinkedIn" entry in portals.yml so
`node scan.mjs` includes LinkedIn in every career-ops scan. Emits
`{"jobs": [{title, url, company, location}]}` on stdout; all scraper logs
go to stderr so stdout stays valid JSON.

The emitted `url` is the **employer's own apply URL** wherever LinkedIn has one
(see linkedin_apply.py) — applying goes to the ATS directly, and the row dedups
against a Greenhouse/Lever/Workday scan of the same posting. Easy Apply
postings have no such URL and keep their linkedin.com link, which is their real
apply route.

Cache: if Webscrapper/linkedin_jobs.csv is younger than CACHE_TTL_HOURS,
its rows are emitted directly (a live scrape takes ~9 min; scan retries and
back-to-back scans shouldn't re-hit LinkedIn). Pass --fresh to force a live
scrape regardless of cache age.
"""
import csv
import json
import os
import re
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
CACHE = os.path.join(HERE, "linkedin_jobs.csv")
CACHE_TTL_HOURS = 6.0

# Resolving apply links costs one API call per new posting. The whole parser has
# to finish inside the LinkedIn entry's timeout_ms (30 min) and the live scrape
# already eats ~9 of those minutes, so cap the lookups: anything past the budget
# keeps its linkedin.com link and gets picked up by linkedin_relink.py later.
RESOLVE_BUDGET = 200

sys.path.insert(0, HERE)
sys.path.insert(0, ROOT)      # scan_common, linkedin_apply


def apply_stack_gate(jobs):
    """portals.yml `content_filter` over the scraped descriptions.

    Runs here because local-parser.mjs keeps only title/url/company/location —
    scan.mjs never sees this parser's description text. Matters since 2026-08-05,
    when plain "Software Engineer" became a `title_filter.positive` keyword: the
    title no longer says anything about the stack, so the JD has to.
    """
    sys.path.insert(0, os.path.dirname(HERE))
    import scan_common as sc

    kept, dropped = sc.stack_gate(
        jobs, lambda j: j.get("title", ""), lambda j: j.get("description", ""),
        log=lambda m: print(f"[linkedin-parser] {m}"))
    for j in kept:
        j.pop("description", None)   # jobs-json-v1 carries only the four fields
    return kept, dropped


def _seen_linkedin_ids():
    """LinkedIn posting ids scan.mjs would already dedup away.

    Mirrors `loadSeenUrls` in scan.mjs — scan-history.tsv, pipeline.md,
    applications.md — but keys on the posting id instead of the exact URL, so
    the bare `/jobs/view/4447272742` and slugged `/jobs/view/{slug}-4447272742`
    forms of one posting collapse.
    """
    ids = set()
    for path, col0 in ((os.path.join(ROOT, "data/scan-history.tsv"), True),
                       (os.path.join(ROOT, "data/pipeline.md"), False),
                       (os.path.join(ROOT, "data/applications.md"), False)):
        try:
            text = open(path, encoding="utf-8").read()
        except OSError:
            continue
        if col0:
            text = "\n".join(l.split("\t")[0] for l in text.split("\n"))
        for m in re.finditer(r"linkedin\.com/jobs/view/[\w-]*?(\d{6,})", text, re.I):
            ids.add(m.group(1))
    return ids


def resolve_apply_links(jobs):
    """Swap each posting's linkedin.com URL for the employer's apply URL.

    Postings scan.mjs has already seen are dropped *first*, for two reasons: the
    lookups they would cost are wasted, and — because scan.mjs dedups on the URL
    this parser hands it — a resolved employer URL would make a posting scanned
    last week look brand new. Dropping on the LinkedIn id keeps that dedup
    contract intact. Rows that survive have their employer URL written to
    scan-history by scan.mjs, so the next scan dedups on that instead.
    """
    import linkedin_apply as la

    seen = _seen_linkedin_ids()
    fresh = [j for j in jobs if la.linkedin_job_id(j.get("url", "")) not in seen]
    print(f"[linkedin-parser] {len(jobs) - len(fresh)} posting(s) already in "
          f"scan history/pipeline — {len(fresh)} to resolve")
    la.resolve_apply_links(fresh, budget=RESOLVE_BUDGET)
    for j in fresh:
        j.pop("linkedin_url", None)   # jobs-json-v1 carries only the four fields
    return fresh


def jobs_from_cache():
    jobs = []
    with open(CACHE, newline="", encoding="utf-8") as f:
        for row in csv.DictReader(f):
            jobs.append({
                "title": row.get("title", ""),
                "url": row.get("job_url", ""),
                "company": row.get("company", ""),
                "location": row.get("location", ""),
                "description": row.get("job_description", ""),
            })
    return jobs


def jobs_from_live_scrape():
    import webscrapper as ws

    config = ws.load_config(os.path.join(HERE, "config.json"))
    job_list = ws.scrape_cards(config, fetch_descriptions=True, verbose=True)
    kept = ws.remove_irrelevant_jobs(job_list, config)

    # Refresh the CSV cache the same way the standalone CLI does.
    os.chdir(HERE)
    ws.write_csv("linkedin_jobs.csv", kept)
    ws.write_csv("linkedin_jobs_filtered.csv", [j for j in job_list if j not in kept])

    return [{
        "title": j.get("title", ""),
        "url": j.get("job_url", ""),
        "company": j.get("company", ""),
        "location": j.get("location", ""),
        "description": j.get("job_description", ""),
    } for j in kept]


def main():
    real_stdout = sys.stdout
    sys.stdout = sys.stderr  # webscrapper logs via print(); keep JSON stdout clean
    try:
        cache_fresh = (
            "--fresh" not in sys.argv
            and os.path.exists(CACHE)
            and (time.time() - os.path.getmtime(CACHE)) < CACHE_TTL_HOURS * 3600
        )
        if cache_fresh:
            age_min = (time.time() - os.path.getmtime(CACHE)) / 60
            print(f"[linkedin-parser] using cache ({age_min:.0f} min old): {CACHE}")
            jobs = jobs_from_cache()
        else:
            print("[linkedin-parser] cache stale or missing — live scrape (~9 min)")
            jobs = jobs_from_live_scrape()
        jobs, _off_stack = apply_stack_gate(jobs)
        # Last, and only over what survived every gate: an apply-link lookup is
        # a network round trip, so it should never be paid for a row that is
        # about to be filtered out anyway.
        jobs = resolve_apply_links(jobs)
    finally:
        sys.stdout = real_stdout

    json.dump({"jobs": jobs}, sys.stdout)


if __name__ == "__main__":
    main()
