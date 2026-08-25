#!/usr/bin/env python3
import csv
import os
import shutil
import sys
import tempfile

PIPELINE = "/home/hunter/projects/career-ops/data/pipeline.csv"

def mark_applied(url, pipeline_path=PIPELINE):
    tmp_fd, tmp_path = tempfile.mkstemp(dir=os.path.dirname(pipeline_path))
    matched = False
    try:
        with open(pipeline_path, newline="", encoding="utf-8") as infile, \
             os.fdopen(tmp_fd, "w", newline="", encoding="utf-8") as outfile:
            reader = csv.DictReader(infile)
            writer = csv.DictWriter(outfile, fieldnames=reader.fieldnames)
            writer.writeheader()
            for row in reader:
                if row.get("url", "").strip().rstrip("/") == url.strip().rstrip("/"):
                    row["applied"] = "TRUE"
                    matched = True
                writer.writerow(row)
    except Exception:
        os.remove(tmp_path)
        raise
    if not matched:
        os.remove(tmp_path)
        print(f"ERROR: no row matched url {url}", file=sys.stderr)
        sys.exit(1)
    shutil.move(tmp_path, pipeline_path)
    print(f"OK: applied=TRUE for {url}")

if __name__ == "__main__":
    if len(sys.argv) != 2:
        print("usage: mark_applied.py <url>", file=sys.stderr)
        sys.exit(2)
    mark_applied(sys.argv[1])