#!/usr/bin/env python3
"""linkedin_relink.py — swap linkedin.com/jobs/view links in the pipeline for
the employer's own apply URL.

New rows arrive pre-resolved (Webscrapper/linkedin_scan_parser.py resolves
before emitting), so this is the migration for rows already in
data/pipeline.md, plus a repair pass for any row whose link could not be
resolved at scan time (Easy-Apply-only when it was scanned, cookie expired,
rate limit hit mid-run).

Order matters, because a row's identity in data/pipeline.csv is its URL:
  1. resolve each linkedin.com URL to the employer URL (link cache, then the
     Voyager API);
  2. rewrite the `url` column of the affected pipeline.csv rows IN PLACE, so the
     user's applied/processed ticks — which sync_pipeline_csv.py carries forward
     by URL job-id — stay attached to the row when the id changes;
  3. rewrite the URLs in pipeline.md (the source of truth);
  4. record the new URL in scan-history.tsv so a later scan of the employer's own
     ATS board does not re-add the same posting as new;
  5. re-sync the CSV and verify no ticks were lost.

Easy Apply postings have no employer URL and keep their linkedin.com link —
that IS the apply route for them, so those rows are correct as they stand.

Usage:
  .venv-jobspy/bin/python linkedin_relink.py --dry-run
  .venv-jobspy/bin/python linkedin_relink.py
  .venv-jobspy/bin/python linkedin_relink.py --limit 60      # bounded run
  .venv-jobspy/bin/python linkedin_relink.py --refresh-links # retry Easy Apply
"""
import csv
import os
import re
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import linkedin_apply as la  # noqa: E402

PIPE = os.path.join(HERE, "data/pipeline.md")
CSV_PATH = os.path.join(HERE, "data/pipeline.csv")
HIST = os.path.join(HERE, "data/scan-history.tsv")
LI_URL = re.compile(r"https?://(?:[\w-]+\.)?linkedin\.com/jobs/view/[^\s|)\]]+")


def pipeline_linkedin_urls():
    """Every distinct linkedin.com job URL in pipeline.md, in file order.

    Both URL shapes the pipeline has collected are matched: the bare
    `/jobs/view/4447272742` a scraped card produces and the
    `/jobs/view/{slug}-4296873399` a WebSearch hit produces."""
    urls, seen = [], set()
    for line in open(PIPE, encoding="utf-8"):
        if not line.strip().startswith("- ["):
            continue
        for m in LI_URL.finditer(line):
            url = m.group(0)
            if url not in seen:
                seen.add(url)
                urls.append(url)
    return urls


def arg_int(flag, default):
    args = sys.argv
    return int(args[args.index(flag) + 1]) if flag in args else default


def main():
    dry = "--dry-run" in sys.argv
    limit = arg_int("--limit", None)
    cookie = la.load_cookie()
    if not cookie:
        sys.exit("no LINKEDIN_COOKIE — run: .venv-jobspy/bin/python linkedin_login.py")

    urls = pipeline_linkedin_urls()
    print(f"linkedin.com links in pipeline.md: {len(urls)}")
    if not urls:
        return

    jobs = [{"url": u} for u in urls]
    la.resolve_apply_links(jobs, cookie, refresh="--refresh-links" in sys.argv,
                           budget=limit)
    mapping = {j["linkedin_url"]: j["url"] for j in jobs if j.get("linkedin_url")}
    print(f"resolved to an employer URL: {len(mapping)}; "
          f"keeping linkedin.com: {len(urls) - len(mapping)}")
    if not mapping:
        return
    for old, new in list(mapping.items())[:5]:
        print(f"  {old[:60]}\n    -> {new[:90]}")
    if dry:
        print("\n(dry run — nothing written)")
        return

    # 1. pipeline.csv first: move the ticks with the row before the id changes.
    with open(CSV_PATH, newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        cols, rows = reader.fieldnames, list(reader)
    ticks_before = sum(1 for r in rows if r["applied"] == "TRUE")
    proc_before = sum(1 for r in rows if r["processed"] == "TRUE")
    moved = 0
    for r in rows:
        new = mapping.get(r["url"])
        if new:
            r["url"] = new
            moved += 1
    with open(CSV_PATH, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=cols)
        w.writeheader()
        w.writerows(rows)
    print(f"pipeline.csv: rewrote {moved} url(s), ticks preserved in place")

    # 2. pipeline.md. Longest URL first: `.../view/4447272742` is a prefix of
    #    `.../view/4447272742/`, and both shapes occur in the file — replacing
    #    the short one first would leave a stray slash on the rewritten link.
    text = open(PIPE, encoding="utf-8").read()
    for old in sorted(mapping, key=len, reverse=True):
        text = text.replace(old, mapping[old])
    open(PIPE, "w", encoding="utf-8").write(text)
    print(f"pipeline.md: rewrote {len(mapping)} url(s)")

    # 3. scan-history: keep the linkedin row (so that URL is never re-added) and
    #    add the employer URL, so an ATS scan of the same posting dedups.
    hist = open(HIST, encoding="utf-8").read().rstrip("\n").split("\n")
    known = {l.split("\t")[0] for l in hist}
    added = []
    for old, new in mapping.items():
        if new in known:
            continue
        row = next((l.split("\t") for l in hist if l.split("\t")[0] == old), None)
        if row and len(row) >= 6:
            row = list(row)
            row[0] = new
            added.append("\t".join(row))
            known.add(new)
    if added:
        with open(HIST, "a", encoding="utf-8") as f:
            f.write("\n".join(added) + "\n")
    print(f"scan-history: recorded {len(added)} employer URL(s)")

    # 4. resync and confirm nothing was dropped
    subprocess.run([sys.executable, os.path.join(HERE, "sync_pipeline_csv.py")],
                   check=True, cwd=HERE)
    with open(CSV_PATH, newline="", encoding="utf-8") as f:
        after = list(csv.DictReader(f))
    ticks_after = sum(1 for r in after if r["applied"] == "TRUE")
    proc_after = sum(1 for r in after if r["processed"] == "TRUE")
    print(f"applied ticks: {ticks_before} before -> {ticks_after} after")
    print(f"processed ticks: {proc_before} before -> {proc_after} after")
    if ticks_after < ticks_before or proc_after < proc_before:
        print("WARNING: ticks were lost — investigate before scanning again")
    left = sum(1 for r in after if "linkedin.com" in r["url"])
    print(f"linkedin.com links remaining in pipeline.csv: {left} "
          f"(Easy Apply postings legitimately stay)")


if __name__ == "__main__":
    main()
