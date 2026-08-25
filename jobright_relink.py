#!/usr/bin/env python3
"""jobright_relink.py — swap jobright.ai links in the pipeline for the
employer's own apply URL.

New rows arrive pre-resolved (jobright_scan_parser.py resolves before emitting),
so this is the one-off migration for rows already in data/pipeline.md, plus a
repair pass for any row whose link could not be resolved at scan time.

Order matters, because a row's identity in data/pipeline.csv is its URL:
  1. resolve each jobright.ai URL to the employer URL (link cache, then fetch);
  2. rewrite the `url` column of the affected pipeline.csv rows IN PLACE, so the
     user's applied/processed ticks — which sync_pipeline_csv.py carries forward
     by URL job-id — stay attached to the row when the id changes;
  3. rewrite the URLs in pipeline.md (the source of truth);
  4. record the new URL in scan-history.tsv so a later scan of the employer's own
     ATS board does not re-add the same posting as new;
  5. re-sync the CSV and verify no ticks were lost.

Usage:
  .venv-jobspy/bin/python jobright_relink.py --dry-run
  .venv-jobspy/bin/python jobright_relink.py
"""
import csv
import os
import re
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import jobright_scan_parser as jp  # noqa: E402
import scan_common as sc  # noqa: E402

PIPE = os.path.join(HERE, "data/pipeline.md")
CSV_PATH = os.path.join(HERE, "data/pipeline.csv")
HIST = os.path.join(HERE, "data/scan-history.tsv")
JR_URL = re.compile(r"https?://(?:www\.)?jobright\.ai/jobs/info/[0-9a-f]+[^\s|]*")


def pipeline_jobright_urls():
    urls = []
    for line in open(PIPE, encoding="utf-8"):
        if not line.strip().startswith("- ["):
            continue
        m = JR_URL.search(line)
        if m:
            urls.append(m.group(0))
    return urls


def main():
    dry = "--dry-run" in sys.argv
    cookie = jp.load_cookie()
    if not cookie:
        sys.exit("no JOBRIGHT_COOKIE — run: .venv-jobspy/bin/python jobright_login.py")

    urls = pipeline_jobright_urls()
    print(f"jobright.ai links in pipeline.md: {len(urls)}")

    jobs = [{"url": u} for u in urls]
    jp.resolve_apply_links(jobs, cookie, refresh="--refresh-links" in sys.argv)
    mapping = {j["jobright_url"]: j["url"] for j in jobs if j.get("jobright_url")}
    print(f"resolved to an employer URL: {len(mapping)}; "
          f"keeping jobright.ai: {len(urls) - len(mapping)}")
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

    # 2. pipeline.md
    text = open(PIPE, encoding="utf-8").read()
    for old, new in mapping.items():
        text = text.replace(old, new)
    open(PIPE, "w", encoding="utf-8").write(text)
    print(f"pipeline.md: rewrote {len(mapping)} url(s)")

    # 3. scan-history: keep the jobright row (so that URL is never re-added) and
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
    print(f"applied ticks: {ticks_before} before -> {ticks_after} after")
    if ticks_after < ticks_before:
        print("WARNING: ticks were lost — investigate before scanning again")
    left = sum(1 for r in after if "jobright.ai" in r["url"])
    print(f"jobright.ai links remaining in pipeline.csv: {left}")


if __name__ == "__main__":
    main()
