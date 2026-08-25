#!/usr/bin/env bash
# run_scan.sh — full career-ops scan chain, zero-LLM, safe for cron/n8n.
#
#   scan.mjs (ATS APIs + LinkedIn / JobSpy / JobRight local parsers via portals.yml)
#   -> post_scan_normalize.py  (date field + move new entries to top)
#   -> experience_gate.py      (drop 2+ yrs / level-II+ / PhD-only roles;
#                               JD text for every source comes from jd_extract.py,
#                               which caches each one under Job_applicator/jd/)
#   -> jobright_relink.py      (repair pass: any jobright.ai link that reached
#                               the pipeline unresolved -> employer apply URL)
#   -> linkedin_relink.py      (repair pass: any linkedin.com/jobs/view link that
#                               reached the pipeline unresolved -> employer apply
#                               URL. Bounded per run; Easy Apply rows keep their
#                               LinkedIn link, which is their real apply route)
#   -> experience_gate.py --all-pending
#                              (final sweep: re-gate every pending row now that
#                               the relink passes have repaired their URLs, so
#                               the CSV ends the run holding only applicable links)
#   -> dedup_pipeline.py       (collapse duplicate postings, then resync the CSV)
#
# dedup_pipeline.py runs sync_pipeline_csv.py itself and then asserts that
# data/pipeline.csv came out duplicate-free, so it is the last step.
#
# JobSpy and JobRight are local_parser entries in portals.yml, which means they
# go through the SAME gates as every other provider: title_filter,
# location_filter, data/blacklist.md, scan-history dedup, then experience_gate.
# Nothing writes to data/pipeline.csv directly — pipeline.md is the source of
# truth and the CSV is regenerated from it.
#
# Exit code is non-zero if any step fails (set -e), so an n8n Execute
# Command node marks the run failed. All output goes to stdout/stderr for
# n8n to capture, and is also appended to output/scan-cron.log.
set -euo pipefail
cd "$(dirname "$0")"

# n8n/cron often run with a minimal PATH; pin the node install used here.
export PATH="$HOME/.nvm/versions/node/v20.20.2/bin:/usr/local/bin:/usr/bin:/bin"

mkdir -p output
LOG=output/scan-cron.log
exec > >(tee -a "$LOG") 2>&1

SCAN_DATE=$(date +%F)
echo "=== career-ops scan start $(date -Is) ==="

(
  flock -n 200 || exit 200
  node scan.mjs
  python3 post_scan_normalize.py --date "$SCAN_DATE"
  python3 -u experience_gate.py --date "$SCAN_DATE"
  python3 jobright_relink.py || echo "jobright relink skipped (cookie expired?)"
  python3 linkedin_relink.py --limit 60 || echo "linkedin relink skipped (cookie expired?)"
  # Final sweep over EVERY pending row, not just today's. Two reasons it has to
  # run here rather than only above: the relink steps just rewrote LinkedIn and
  # JobRight rows to employer apply URLs, so postings that were unreadable (and
  # therefore kept as UNVERIFIED) during the --date pass are extractable now;
  # and rows banked on earlier days were only ever gated with the rules and
  # extractors of that day. jd_extract caches every JD it pulls under
  # Job_applicator/jd/, so this is one-fetch-per-posting-ever, not per run.
  python3 -u experience_gate.py --all-pending
  python3 dedup_pipeline.py
) 200>data/.scan-cron.lock || {
  rc=$?
  if [ "$rc" -eq 200 ]; then
    echo "another scan run holds the lock — skipping"
    exit 0
  fi
  exit "$rc"
}

echo "--- last scan-runs.tsv entry ---"
tail -1 data/scan-runs.tsv
echo "=== career-ops scan done $(date -Is) ==="
