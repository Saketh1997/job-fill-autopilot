#!/usr/bin/env python3
"""Isolated test of dedup_pipeline: duplicate collapse, survivor choice, and
applied/processed carry-over. Runs against temp files, never the real pipeline."""
import csv, os, sys, tempfile

sys.path.insert(0, "/home/hunter/projects/career-ops")
import dedup_pipeline as dp

TMP = tempfile.mkdtemp()
PIPE = os.path.join(TMP, "pipeline.md")
CSV_P = os.path.join(TMP, "pipeline.csv")
HIST = os.path.join(TMP, "scan-history.tsv")

PIPE_TEXT = """# Pipeline

## Pendientes
- [ ] https://www.linkedin.com/jobs/view/4448290187/ | Acme AI | Machine Learning Engineer | 2026-08-05
- [ ] https://job-boards.greenhouse.io/acme/jobs/12345 | Acme AI, Inc. | Machine Learning Engineer (Remote) | 2026-08-04
- [ ] https://www.indeed.com/viewjob?jk=abc123def456 | Acme AI | Machine Learning Engineer | 2026-08-03
- [ ] https://jobright.ai/jobs/info/6a53347b8576ec69c014efea?utm_campaign=X | Beta Corp | Data Engineer | 2026-08-05
- [ ] https://jobright.ai/jobs/info/6a53347b8576ec69c014efea?utm_campaign=Y | Beta Corp | Data Engineer | 2026-08-05
- [x] #101 | https://jobs.lever.co/gamma/11111111-2222-3333-4444-555555555555 | Gamma | Data Scientist | 4.5 | ✅ | 2026-07-01
- [ ] https://www.linkedin.com/jobs/view/4400000001/ | Gamma | Data Scientist | 2026-07-02
- [ ] https://www.linkedin.com/jobs/view/4400000002/ | Delta | Backend Engineer | 2026-08-05
- [ ] https://www.linkedin.com/jobs/view/4400000003/ | Delta | Backend Engineer | 2026-01-05
"""

CSV_ROWS = [
    # url, applied, processed
    ("https://www.linkedin.com/jobs/view/4448290187/", "TRUE", "TRUE"),
    ("https://job-boards.greenhouse.io/acme/jobs/12345", "FALSE", "FALSE"),
    ("https://www.indeed.com/viewjob?jk=abc123def456", "FALSE", "FALSE"),
    ("https://jobright.ai/jobs/info/6a53347b8576ec69c014efea?utm_campaign=X", "TRUE", "FALSE"),
    ("https://jobright.ai/jobs/info/6a53347b8576ec69c014efea?utm_campaign=Y", "FALSE", "FALSE"),
    ("https://jobs.lever.co/gamma/11111111-2222-3333-4444-555555555555", "FALSE", "FALSE"),
    ("https://www.linkedin.com/jobs/view/4400000001/", "FALSE", "TRUE"),
    ("https://www.linkedin.com/jobs/view/4400000002/", "FALSE", "FALSE"),
    ("https://www.linkedin.com/jobs/view/4400000003/", "FALSE", "FALSE"),
]

open(PIPE, "w").write(PIPE_TEXT)
with open(CSV_P, "w", newline="") as f:
    w = csv.writer(f)
    w.writerow(["status", "num", "url", "company", "title", "score", "pdf", "date",
                "applied", "processed"])
    for url, ap, pr in CSV_ROWS:
        w.writerow(["pending", "", url, "", "", "", "", "2026-08-05", ap, pr])
open(HIST, "w").write("url\tfirst_seen\tportal\ttitle\tcompany\tstatus\n" +
                      "".join(f"{u}\t2026-08-05\tx\tt\tc\tadded\n" for u, _, _ in CSV_ROWS))

dp.PIPE, dp.CSV_PATH, dp.HIST = PIPE, CSV_P, HIST
sys.argv = ["dedup_pipeline.py", "--no-sync", "--verbose"]
dp.main()

kept = [l for l in open(PIPE).read().splitlines() if l.startswith("- [")]
print("\n--- surviving entries ---")
for l in kept:
    print("  ", l)

rows = {r["url"]: r for r in csv.DictReader(open(CSV_P, newline=""))}
gh = rows["https://job-boards.greenhouse.io/acme/jobs/12345"]
jr = rows["https://jobright.ai/jobs/info/6a53347b8576ec69c014efea?utm_campaign=X"]
lever = rows["https://jobs.lever.co/gamma/11111111-2222-3333-4444-555555555555"]

fails = []
if len(kept) != 5:
    fails.append(f"expected 5 survivors (Acme, Beta, Gamma report, Delta x2 far apart), got {len(kept)}")
if not any("greenhouse" in l for l in kept):
    fails.append("Acme should survive on its Greenhouse URL, not LinkedIn/Indeed")
if not any("#101" in l for l in kept):
    fails.append("the evaluated Gamma row (#101) must survive")
if sum(1 for l in kept if "4400000003" in l or "4400000002" in l) != 2:
    fails.append("Delta rows 7 months apart must both survive (--window)")
if (gh["applied"], gh["processed"]) != ("TRUE", "TRUE"):
    fails.append(f"Acme ticks not carried to Greenhouse row: {gh['applied']}/{gh['processed']}")
if jr["applied"] != "TRUE":
    fails.append("Beta applied tick lost between utm variants")
if lever["processed"] != "TRUE":
    fails.append("Gamma processed tick not carried to the evaluated row")
hist_dupes = sum(1 for l in open(HIST) if l.strip().endswith("duplicate"))
if hist_dupes != 3:
    fails.append(f"expected 3 scan-history rows marked duplicate (the utm twin shares the survivor's canonical URL, so it is left alone — its own `added` row already dedups it), got {hist_dupes}")

print("\n--- result ---")
print("FAIL:\n  " + "\n  ".join(fails) if fails else "all assertions passed")
sys.exit(1 if fails else 0)
