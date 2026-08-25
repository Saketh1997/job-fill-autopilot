#!/usr/bin/env python3
"""dedup_pipeline.py — guarantee no duplicate job lands in data/pipeline.csv.

pipeline.csv is regenerated from data/pipeline.md, so deduplication has to
happen in pipeline.md — that is the only durable fix. This script rewrites
pipeline.md with duplicates removed and then (unless --no-sync) regenerates
pipeline.csv, leaving a queue with one row per real posting.

Three duplicate classes, in the order they are collapsed:
  1. same URL after canonicalization  — jobright.ai/...?utm_campaign=A vs ...?utm_campaign=B
  2. same ATS/board job id            — linkedin.com/jobs/view/4448290187 vs
                                        .../jobs/view/ml-engineer-at-x-4448290187
  3. same company + normalized title  — the SAME posting surfaced by two
                                        sources (Indeed via JobSpy, LinkedIn via
                                        Webscrapper, and the employer's own
                                        Greenhouse board), which classes 1-2
                                        cannot see because the URLs differ.
Class 3 only collapses rows whose dates are within --window days (default 45) of
each other, so a role genuinely reposted months later stays visible — that is
signal detect-reposts.mjs reports on.

Which copy survives:
  1. an evaluated row (`[x]` / has a report number) always beats a pending one —
     never orphan a report link;
  2. else the better source: the employer's own ATS (Greenhouse, Lever, Ashby,
     Workday, amazon.jobs …) > a company careers domain > LinkedIn > aggregators
     (Indeed, ZipRecruiter, Google) > jobright.ai redirects — the apply flow and
     experience_gate.py both work best against the real ATS URL;
  3. else the earliest date, then the earlier position in the file.
Removed rows are recorded in data/scan-history.tsv with status `duplicate`, so a
later scan does not re-add them (loadSeenUrls in scan.mjs reads that file).

Usage:
  python3 dedup_pipeline.py --dry-run     # report only, touch nothing
  python3 dedup_pipeline.py               # rewrite pipeline.md + resync CSV
  python3 dedup_pipeline.py --no-sync     # rewrite pipeline.md only
  python3 dedup_pipeline.py --window 90   # widen the company+title window
"""
import argparse
import csv
import datetime
import os
import re
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import scan_common as sc  # noqa: E402

ROOT = os.path.dirname(os.path.abspath(__file__))
PIPE = os.path.join(ROOT, "data/pipeline.md")
CSV_PATH = os.path.join(ROOT, "data/pipeline.csv")
HIST = os.path.join(ROOT, "data/scan-history.tsv")

ENTRY_RE = re.compile(r"^- \[([ x!])\]\s*(.*)$")
FIELD_SPLIT = re.compile(r"(?<!\\)\|")
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


class Entry:
    """One `- [ ] url | company | title | date` line of pipeline.md."""

    def __init__(self, index, line):
        self.index = index
        self.line = line
        m = ENTRY_RE.match(line.strip())
        self.mark = m.group(1)
        fields = [f.strip() for f in FIELD_SPLIT.split(m.group(2))]
        self.num = ""
        if fields and fields[0].startswith("#"):
            self.num = fields[0].lstrip("#")
            fields = fields[1:]
        self.url = fields[0] if fields else ""
        self.company = fields[1] if len(fields) > 1 else ""
        self.title = fields[2] if len(fields) > 2 else ""
        # Flagged rows carry the skip reason in the title field
        # ("Data Scientist — BLOCKED: ..."); key on the title itself so a fresh
        # pending copy of an already-skipped role still collapses onto it.
        if self.mark == "!":
            self.title = re.split(r"\s+—\s+", self.title)[0]
        self.date = next((f for f in fields[3:] if DATE_RE.match(f)), "")

    @property
    def evaluated(self):
        return self.mark != " " or bool(self.num)

    @property
    def date_value(self):
        try:
            return datetime.date.fromisoformat(self.date)
        except ValueError:
            return datetime.date.max          # undated sorts last, never wins

    def rank(self):
        """Sort key — the smallest tuple is the copy that survives."""
        return (0 if self.evaluated else 1,
                sc.source_rank(self.url),
                self.date_value,
                self.index)


def better(a, b):
    return a if a.rank() <= b.rank() else b


def collapse(entries, key_fn, window_days=None):
    """Drop entries sharing a key. Returns {dropped index -> (kept entry, key)}."""
    best, dropped = {}, {}
    for e in entries:
        if e.index in dropped:
            continue
        key = key_fn(e)
        if not key:
            continue
        prev = best.get(key)
        if prev is None:
            best[key] = e
            continue
        if window_days is not None:
            d1, d2 = prev.date_value, e.date_value
            if datetime.date.max not in (d1, d2) and abs((d1 - d2).days) > window_days:
                continue                       # far-apart repost — keep both
        keep = better(prev, e)
        loser = e if keep is prev else prev
        best[key] = keep
        # Both copies already evaluated: each one owns a report and a tracker
        # row, so removing either would orphan it. Leave them and let the user
        # decide (dedup-tracker.mjs is the tool for the tracker side).
        if loser.evaluated:
            print(f"    kept both (each evaluated): {loser.company} | {loser.title}")
            continue
        dropped[loser.index] = (keep, key)
    return dropped


def parse_pipeline(text):
    entries, lines = [], text.split("\n")
    for i, line in enumerate(lines):
        m = ENTRY_RE.match(line.strip())
        if m and (m.group(2).startswith("http") or m.group(2).startswith("#")
                  or m.group(2).startswith("local:")):
            entries.append(Entry(i, line))
    return lines, entries


def carry_state(pairs, dry_run):
    """Move `applied` / `processed` ticks from a dropped row onto the copy that
    survives, in data/pipeline.csv, BEFORE the resync.

    Those ticks are the user's own record ("I applied to this one") — set by a
    spreadsheet edit or Job_applicator/mark_applied.py, and held nowhere else
    for a row with no report number. sync_pipeline_csv.py carries them forward
    by URL job-id, so a tick on a URL that just left pipeline.md would simply
    evaporate and the surviving twin would read as never applied.

    @param pairs: [(dropped Entry, kept Entry)]
    """
    if not os.path.exists(CSV_PATH) or not pairs:
        return 0
    with open(CSV_PATH, newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        cols, rows = reader.fieldnames, list(reader)
    by_jid = {}
    for r in rows:
        by_jid.setdefault(sc.job_id(r.get("url", "")), r)

    moved = 0
    for loser, keeper in pairs:
        src, dst = by_jid.get(sc.job_id(loser.url)), by_jid.get(sc.job_id(keeper.url))
        if not src or not dst or src is dst:
            continue
        for flag in ("applied", "processed"):
            if src.get(flag, "").strip().upper() == "TRUE" and dst.get(flag) != "TRUE":
                dst[flag] = "TRUE"
                moved += 1
                print(f"    carried {flag}=TRUE  {loser.company} | {loser.title}\n"
                      f"      to {keeper.url}")
    if moved and not dry_run:
        with open(CSV_PATH, "w", newline="", encoding="utf-8") as f:
            w = csv.DictWriter(f, fieldnames=cols)
            w.writeheader()
            w.writerows(rows)
    return moved


def record_duplicates(urls, keep_urls, dry_run):
    """Mark removed URLs `duplicate` in scan-history so they are not re-added.

    Any status other than `added` is dedup'd permanently by scan.mjs
    (shouldDedupScanHistoryRow), which is exactly what a duplicate deserves.
    URLs that only differ from a survivor by a tracking param share its
    canonical form — excluded, or the survivor's own history row would be
    relabelled as a duplicate of itself."""
    if not os.path.exists(HIST) or not urls:
        return 0
    rows = open(HIST, encoding="utf-8").read().splitlines()
    # Compare canonically: scan-history stores the URL as the provider gave it,
    # which can differ from the pipeline copy by a trailing slash or a utm param.
    kept_canon = {sc.canonical_url(u) for u in keep_urls}
    canon = {sc.canonical_url(u) for u in urls} - kept_canon
    out, touched = [], 0
    for line in rows:
        c = line.split("\t")
        if len(c) >= 6 and sc.canonical_url(c[0]) in canon and c[5] in ("added", ""):
            c[5] = "duplicate"
            touched += 1
            out.append("\t".join(c))
        else:
            out.append(line)
    if not dry_run and touched:
        open(HIST, "w", encoding="utf-8").write("\n".join(out) + "\n")
    return touched


def csv_duplicate_report():
    """Duplicates still visible in pipeline.csv — a post-sync assertion that
    catches rows reaching the CSV from anywhere other than pipeline.md.

    Structural keys only (URL, job id). The company+title key is deliberately
    not checked here: entries outside the --window are kept on purpose, and
    flagging them would make the assertion cry wolf on every run."""
    if not os.path.exists(CSV_PATH):
        return []
    seen, dupes = {}, []
    with open(CSV_PATH, newline="", encoding="utf-8") as f:
        for row in csv.DictReader(f):
            for key in (sc.canonical_url(row["url"]), sc.job_id(row["url"])):
                if not key:
                    continue
                if key in seen and seen[key] != row["url"]:
                    dupes.append((seen[key], row["url"], key))
                seen.setdefault(key, row["url"])
    return dupes


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--no-sync", action="store_true",
                    help="rewrite pipeline.md but skip sync_pipeline_csv.py")
    ap.add_argument("--window", type=int, default=45,
                    help="days within which same company+title counts as a duplicate")
    ap.add_argument("--verbose", action="store_true")
    args = ap.parse_args()

    text = open(PIPE, encoding="utf-8").read()
    lines, entries = parse_pipeline(text)
    print(f"pipeline.md: {len(entries)} entries")

    dropped = {}
    for label, key_fn, window in (
        ("same URL", lambda e: sc.canonical_url(e.url), None),
        ("same job id", lambda e: sc.job_id(e.url), None),
        ("same company+title", lambda e: sc.pair_key(e.company, e.title), args.window),
    ):
        live = [e for e in entries if e.index not in dropped]
        found = collapse(live, key_fn, window)
        dropped.update(found)
        print(f"  {label}: {len(found)} duplicate(s)")
        if args.verbose:
            for idx, (keep, key) in sorted(found.items()):
                loser = next(e for e in entries if e.index == idx)
                print(f"    drop {loser.company} | {loser.title} | {loser.url}")
                print(f"      keep {keep.company} | {keep.title} | {keep.url}")

    if not dropped:
        print("no duplicates in pipeline.md")
    else:
        by_index = {e.index: e for e in entries}
        removed_urls = {by_index[i].url for i in dropped}
        # Before anything leaves pipeline.md, move the user's applied/processed
        # ticks onto the copy that stays.
        moved = carry_state([(by_index[i], keep) for i, (keep, _) in dropped.items()],
                            args.dry_run)
        if moved:
            print(f"carried {moved} applied/processed tick(s) to the surviving copy")
        if not args.dry_run:
            out = [l for i, l in enumerate(lines) if i not in dropped]
            open(PIPE, "w", encoding="utf-8").write("\n".join(out))
        kept_urls = {keep.url for keep, _ in dropped.values()}
        touched = record_duplicates(removed_urls, kept_urls, args.dry_run)
        verb = "would remove" if args.dry_run else "removed"
        print(f"{verb} {len(dropped)} duplicate entr"
              f"{'y' if len(dropped) == 1 else 'ies'} from pipeline.md "
              f"({touched} marked `duplicate` in scan-history.tsv)")

    if args.dry_run or args.no_sync:
        return

    # Flush first: this script's own output is block-buffered when the chain
    # pipes into tee (run_scan.sh), while the child writes straight to the fd —
    # without this the sync line lands above the dedup report in the log.
    sys.stdout.flush()
    subprocess.run([sys.executable, os.path.join(ROOT, "sync_pipeline_csv.py")],
                   check=True, cwd=ROOT)

    remaining = csv_duplicate_report()
    if remaining:
        print(f"WARNING: {len(remaining)} duplicate pair(s) still in pipeline.csv "
              "— they did not come from pipeline.md:")
        for a, b, key in remaining[:10]:
            print(f"  {key}\n    {a}\n    {b}")
    else:
        print("pipeline.csv verified: 0 duplicates")


if __name__ == "__main__":
    main()
