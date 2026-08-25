#!/usr/bin/env python3
"""post_scan_normalize.py — deterministic post-scan cleanup of data/pipeline.md.

scan.mjs appends new offers at the BOTTOM of the Pending/Pendientes section
with field 4 = location. House rules (modes/_custom.md) require:
  1. field 4 rewritten to the scan date (`| YYYY-MM-DD`) — sync_pipeline_csv.py
     reads field 4 as the date;
  2. new entries moved to the TOP of the Pending section, newest scan first.

An entry counts as a fresh scan append ONLY when all of these hold:
  - unchecked checkbox `- [ ]` (evaluated `[x]` and flagged `[!]` rows are
    other formats and are never touched);
  - first field is a URL (evaluated rows start with `#NNN` instead);
  - neither field 4 nor the last field is a YYYY-MM-DD date (legacy rows,
    e.g. `URL | Co | Title | Location | 2026-06-15`, end with a date).
Fresh entries get field 4 set to the scan date (3-field rows get it
appended); fields beyond the 4th (e.g. compensation) are preserved.
Idempotent: a second run finds nothing to do.

Usage:
  python3 post_scan_normalize.py                 # date = today
  python3 post_scan_normalize.py --date 2026-07-15
  python3 post_scan_normalize.py --dry-run
"""
import argparse
import datetime
import os
import re
import sys

ROOT = os.path.dirname(os.path.abspath(__file__))
PIPE = os.path.join(ROOT, "data/pipeline.md")

PENDING_MARKERS = ("## Pending", "## Pendientes")
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
ANY_ENTRY_RE = re.compile(r"^- \[.\] ")
FRESH_ENTRY_RE = re.compile(r"^- \[ \] https?://")
# Split on unescaped pipes only, so titles containing "\|" stay intact.
FIELD_SPLIT = re.compile(r"(?<!\\)\|")


def normalize(text, date):
    lines = text.split("\n")

    start = next((i for i, l in enumerate(lines)
                  if l.strip() in PENDING_MARKERS), None)
    if start is None:
        return text, []
    end = next((i for i in range(start + 1, len(lines))
                if lines[i].startswith("## ")), len(lines))

    new_entries, kept = [], []
    for i in range(start + 1, end):
        line = lines[i]
        if not FRESH_ENTRY_RE.match(line.strip()):
            kept.append(line)
            continue
        fields = [f.strip() for f in FIELD_SPLIT.split(line)]
        already_dated = (
            (len(fields) >= 4 and DATE_RE.match(fields[3]))
            or DATE_RE.match(fields[-1])
        )
        if already_dated or len(fields) < 3:
            kept.append(line)  # normalized, legacy, or malformed — untouched
            continue
        if len(fields) == 3:
            fields.append(date)
        else:
            fields[3] = date  # location -> scan date, extras preserved
        new_entries.append(" | ".join(fields))

    if not new_entries:
        return text, []

    first_kept_entry = next((j for j, l in enumerate(kept)
                             if ANY_ENTRY_RE.match(l.strip())), len(kept))
    section = (kept[:first_kept_entry] + new_entries + kept[first_kept_entry:])
    lines[start + 1:end] = section
    return "\n".join(lines), new_entries


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--date", default=datetime.date.today().isoformat())
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    if not DATE_RE.match(args.date):
        sys.exit(f"invalid --date {args.date!r}, expected YYYY-MM-DD")

    with open(PIPE, encoding="utf-8") as f:
        text = f.read()
    out, moved = normalize(text, args.date)

    if not moved:
        print("post_scan_normalize: 0 new entries, pipeline.md unchanged")
        return
    for e in moved:
        print(("DRY " if args.dry_run else "") + "normalized: " + e)
    if not args.dry_run:
        with open(PIPE, "w", encoding="utf-8") as f:
            f.write(out)
    print(f"post_scan_normalize: {len(moved)} entr"
          f"{'y' if len(moved) == 1 else 'ies'} dated {args.date}, "
          "moved to top of Pending")


if __name__ == "__main__":
    main()
