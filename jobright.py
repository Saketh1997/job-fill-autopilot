"""
Fetch the JobRight new-grad README and append its jobs to a queue CSV.

  python jobright_to_queue.py [out.csv] [readme_url]

Defaults: out.csv = jobs.csv, source = the 2026 SWE New Grad repo README.
Dedupes on url and only appends NEW jobs, so existing rows (and their
applied/processed/score progress) are never touched on a rerun.

Queue columns: status,num,url,company,title,score,pdf,date,applied,processed
"""
import csv, os, re, sys, urllib.request
from datetime import datetime, timedelta

README_URL = ("https://raw.githubusercontent.com/jobright-ai/"
              "2026-Software-Engineer-New-Grad/refs/heads/master/README.md")
COLUMNS = ["status", "num", "url", "company", "title",
           "score", "pdf", "date", "applied", "processed"]
LINK = re.compile(r'\[([^\]]+)\]\(([^)]+)\)')       # [text](url)


def cell(text):
    """(display_text, first_url) from a markdown table cell."""
    text = text.strip().strip("*").strip()
    m = LINK.search(text)
    return (m.group(1).strip(), m.group(2).strip()) if m else (text, "")


def iso_date(s):
    """'Aug 04' -> '2026-08-04'. Falls back to today if unparseable."""
    s = s.strip()
    now = datetime.now()
    for fmt in ("%b %d", "%B %d"):
        try:
            d = datetime.strptime(s, fmt).replace(year=now.year)
            if d - now > timedelta(days=7):        # e.g. 'Dec 15' in an Aug file
                d = d.replace(year=now.year - 1)
            return d.strftime("%Y-%m-%d")
        except ValueError:
            continue
    return now.strftime("%Y-%m-%d")


def parse_readme(text):
    jobs = []
    last_company = ""
    for line in text.splitlines():
        if not line.lstrip().startswith("|"):
            continue
        cells = line.strip().strip("|").split("|")
        if len(cells) < 5:
            continue
        joined = "".join(cells).lower()
        if "job title" in joined or set(joined.strip()) <= set("- :"):
            continue                                # header or |---| separator
        company, _ = cell(cells[0])
        # JobRight collapses repeat listings for one employer to a "↳" marker;
        # carry the last real company forward so the row keeps its employer
        # (a "↳" company matches no blacklist entry and no tracker row).
        if company in ("↳", "->", ""):
            company = last_company
        else:
            last_company = company
        title, apply_url = cell(cells[1])
        location, _ = cell(cells[2])
        jobs.append({"url": apply_url, "company": company, "title": title,
                     "location": location, "date": iso_date(cells[4])})
    return jobs


def existing_urls(path):
    seen = set()
    if os.path.exists(path):
        with open(path, newline="") as f:
            for r in csv.DictReader(f):
                if r.get("url"):
                    seen.add(r["url"].strip())
    return seen


def main():
    out = sys.argv[1] if len(sys.argv) > 1 else "jobs.csv"
    url = sys.argv[2] if len(sys.argv) > 2 else README_URL

    text = urllib.request.urlopen(url, timeout=20).read().decode("utf-8")
    jobs = parse_readme(text)

    seen = existing_urls(out)
    new = [{
        "status": "pending", "num": "", "url": j["url"],
        "company": j["company"], "title": j["title"],
        "score": "", "pdf": "", "date": j["date"],
        "applied": "FALSE", "processed": "FALSE",
    } for j in jobs if j["url"] and j["url"] not in seen]

    write_header = not os.path.exists(out) or os.path.getsize(out) == 0
    with open(out, "a", newline="") as f:
        w = csv.DictWriter(f, fieldnames=COLUMNS)
        if write_header:
            w.writeheader()
        w.writerows(new)

    print(f"parsed {len(jobs)} jobs; added {len(new)} new; "
          f"skipped {len(jobs) - len(new)} already in {out}")


if __name__ == "__main__":
    main()