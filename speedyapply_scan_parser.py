#!/usr/bin/env python3
"""speedyapply_scan_parser.py — jobs-json-v1 adapter for SpeedyApply 2027 college job lists.

Scrapes markdown tables from:
  - https://github.com/speedyapply/2027-SWE-College-Jobs (README.md, NEW_GRAD_USA.md)
  - https://github.com/speedyapply/2027-AI-College-Jobs (README.md, NEW_GRAD_USA.md)

Filters to postings that are 1 day or less old (e.g. 1d, 0d, hours).
Registered as a `local_parser` in portals.yml so `node scan.mjs` folds these lists
into every career-ops scan. Emits {"jobs": [{title, url, company, location}]} on stdout;
logs go to stderr.
"""
import html
import json
import os
import re
import sys
import urllib.request

SOURCES = [
    "https://raw.githubusercontent.com/speedyapply/2027-SWE-College-Jobs/main/NEW_GRAD_USA.md",
    "https://raw.githubusercontent.com/speedyapply/2027-SWE-College-Jobs/main/README.md",
    "https://raw.githubusercontent.com/speedyapply/2027-AI-College-Jobs/main/NEW_GRAD_USA.md",
    "https://raw.githubusercontent.com/speedyapply/2027-AI-College-Jobs/main/README.md",
]

def log(msg):
    print(f"[speedyapply-parser] {msg}", file=sys.stderr, flush=True)

def is_one_day_or_less(age_str):
    s = (age_str or "").strip().lower()
    if not s:
        return True
    if re.search(r'\d+\s*(?:h|hr|hour|min|sec)', s) or s in ('0d', '1d', 'today', 'just now'):
        return True
    m = re.search(r'(\d+)\s*d', s)
    if m:
        return int(m.group(1)) <= 1
    return False

def parse_markdown_table(text):
    jobs = []
    row_re = re.compile(r"^\|\s*(.+?)\s*\|\s*(.+?)\s*\|\s*(.+?)\s*\|\s*(.+?)\s*\|\s*(.+?)\s*\|\s*(.+?)\s*\|$")
    link_re = re.compile(r'href=[\'"]([^\'"]+)[\'"]')

    for line in text.splitlines():
        line = line.strip()
        if not line.startswith("|") or "---" in line or "| Company |" in line or "Company | Position" in line:
            continue
        m = row_re.match(line)
        if not m:
            continue
        comp_raw, pos_raw, loc_raw, sal_raw, post_raw, age_raw = m.groups()

        # Filter: only 1d or less old
        age = age_raw.strip()
        if not is_one_day_or_less(age):
            continue

        # Company: strip html tags
        comp = re.sub(r"<[^>]+>", "", comp_raw).strip()
        comp = html.unescape(comp)

        # Position / Title: strip html tags
        title = re.sub(r"<[^>]+>", "", pos_raw).strip()
        title = html.unescape(title)

        # Location: strip html tags
        loc = re.sub(r"<[^>]+>", "", loc_raw).strip()
        loc = html.unescape(loc)

        # URL: extract apply link from posting cell, position cell, or company cell
        post_links = link_re.findall(post_raw)
        if not post_links:
            post_links = link_re.findall(pos_raw)
        if not post_links:
            continue

        url = post_links[0].strip()
        if url and comp and title:
            jobs.append({
                "company": comp,
                "title": title,
                "location": loc,
                "url": url,
            })
    return jobs

def main():
    all_jobs = []
    seen_urls = set()

    for url in SOURCES:
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (X11; Linux x86_64)"})
            content = urllib.request.urlopen(req, timeout=30).read().decode("utf-8")
            parsed = parse_markdown_table(content)
            added = 0
            for j in parsed:
                u = j["url"]
                if u in seen_urls:
                    continue
                seen_urls.add(u)
                all_jobs.append(j)
                added += 1
            repo_file = "/".join(url.split("/")[4:])
            log(f"{added} jobs (<=1d old) extracted from {repo_file}")
        except Exception as e:
            log(f"Error fetching {url}: {e}")

    log(f"Total unique jobs (<=1d old): {len(all_jobs)}")
    json.dump({"jobs": all_jobs}, sys.stdout)

if __name__ == "__main__":
    main()
