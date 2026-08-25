#!/usr/bin/env python3
"""
Regenerate data/pipeline.csv from data/pipeline.md (single source of truth for links).

Columns: status, num, url, company, title, score, pdf, date, applied, processed
- `applied` is a TRUE/FALSE checkbox (spreadsheet-compatible).
- `applied` is preserved/merged so manual checkbox edits are NEVER lost:
    applied = TRUE  if the row is marked TRUE in the existing pipeline.csv
              OR     the matching tracker row in applications.md has status "Applied".
  Matching is by URL job-id (manual checks) and by report number (tracker status).
- `processed` is a TRUE/FALSE checkbox, defaulting to FALSE for new rows.
  Preserved/merged from the existing pipeline.csv by URL job-id so manual
  edits and Job_applicator/mark_processed.py writes are NEVER lost on resync.

Run this whenever pipeline.md changes (scan adds entries, pipeline processes them).
Usage: python3 sync_pipeline_csv.py
"""
import re, csv, os, sys

ROOT = os.path.dirname(os.path.abspath(__file__))
PIPELINE = os.path.join(ROOT, "data/pipeline.md")
APPS = os.path.join(ROOT, "data/applications.md")
CSV = os.path.join(ROOT, "data/pipeline.csv")


def jid(u):
    for pat in [r"/jobs/view/[\w-]*?(\d{6,})", r"/jobs/(\d+)", r"gh_jid=(\d+)",
                r"/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})"]:
        m = re.search(pat, u)
        if m:
            return m.group(1)
    return u.rstrip("/").lower()


def load_applied_nums():
    """Report numbers whose tracker status is 'Applied'."""
    nums = set()
    if not os.path.exists(APPS):
        return nums
    for l in open(APPS, encoding="utf-8"):
        cells = [c.strip() for c in l.split("|")]
        if len(cells) > 7 and cells[1].isdigit() and cells[6] == "Applied":
            nums.add(int(cells[1]))
    return nums


def load_manual_checks():
    """job-ids the user has manually ticked applied=TRUE in the existing csv."""
    checked = set()
    if not os.path.exists(CSV):
        return checked
    with open(CSV, newline="", encoding="utf-8") as f:
        for row in csv.DictReader(f):
            if (row.get("applied", "").strip().upper() == "TRUE") and row.get("url"):
                checked.add(jid(row["url"]))
    return checked


def load_processed():
    """job-ids marked processed=TRUE in the existing csv (manual edits or
    mark_processed.py writes) — carried forward across regeneration."""
    processed = set()
    if not os.path.exists(CSV):
        return processed
    with open(CSV, newline="", encoding="utf-8") as f:
        for row in csv.DictReader(f):
            if (row.get("processed", "").strip().upper() == "TRUE") and row.get("url"):
                processed.add(jid(row["url"]))
    return processed


def parse(line, checked):
    body = re.sub(r"^- \[[ x!]\]\s*", "", line).strip()
    parts = [p.strip() for p in body.split("|")]
    num = url = company = title = score = pdf = date = ""
    if checked and parts and parts[0].startswith("#"):
        num = parts[0].lstrip("#")
        rest = parts[1:]
        vals = [rest[i] if i < len(rest) else "" for i in range(6)]
        url, company, title, score, pdf, date = vals
    else:
        vals = [parts[i] if i < len(parts) else "" for i in range(4)]
        url, company, title, date = vals
    return num, url, company, title, score, pdf, date


def pad_company(company):
    """Company names are written with ONE leading space (user preference,
    2026-08-05).

    Applied here, at the single point where the CSV is generated, so it survives
    every resync — pipeline.md stays the unpadded source of truth, which also
    makes this idempotent: the padding is added on write, never re-read and
    re-padded. Empty cells stay empty rather than becoming a lone space.
    """
    company = (company or "").strip()
    return f" {company}" if company else ""


def main():
    applied_nums = load_applied_nums()
    manual = load_manual_checks()
    processed_urls = load_processed()

    rows = []
    for l in open(PIPELINE, encoding="utf-8"):
        m = re.match(r"^- \[([ x!])\] ", l)
        if not m or m.group(1) == "!":
            continue
        checked = m.group(1) == "x"
        num, url, company, title, score, pdf, date = parse(l, checked)
        if not url.startswith(("http", "local:")):
            continue
        status = "processed" if checked else "pending"
        is_applied = (num.isdigit() and int(num) in applied_nums) or (jid(url) in manual)
        is_processed = jid(url) in processed_urls
        rows.append([status, num, url, pad_company(company), title, score, pdf, date,
                     "TRUE" if is_applied else "FALSE",
                     "TRUE" if is_processed else "FALSE"])

    with open(CSV, "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["status", "num", "url", "company", "title", "score", "pdf", "date",
                     "applied", "processed"])
        w.writerows(rows)

    applied = sum(1 for r in rows if r[8] == "TRUE")
    print(f"data/pipeline.csv synced: {len(rows)} rows "
          f"({sum(1 for r in rows if r[0]=='pending')} pending, "
          f"{sum(1 for r in rows if r[0]=='processed')} processed, "
          f"{applied} applied)")


if __name__ == "__main__":
    main()
