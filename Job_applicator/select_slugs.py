#!/usr/bin/env python3
"""Print slugs from data/pipeline.csv, one per line, for run_all_phases.sh.

Same filters run_ats_batch.mjs applies (date window, applied, discarded/skip)
and the same slugify, so no stage can disagree about which posting a slug means.

  --host amazon.jobs      only rows whose URL host contains this
  --non-ats               everything that is NOT greenhouse/lever/ashby/amazon,
                          and not a LinkedIn or Indeed aggregator link (those
                          are redirects, not forms drive_application.sh can own)
  --days N / --limit N
"""
import argparse, csv, datetime, os, re, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
from jd_extract import slugify  # noqa: E402

OWNED = ('greenhouse.io', 'lever.co', 'ashbyhq.com', 'amazon.jobs')
AGGREGATOR = ('linkedin.com', 'indeed.com', 'glassdoor.', 'ziprecruiter.',
              'simplify.jobs', 'builtin.com', 'wellfound.com', 'startup.jobs')

ap = argparse.ArgumentParser()
ap.add_argument('--host', default='')
ap.add_argument('--non-ats', action='store_true')
ap.add_argument('--days', type=int, default=14)
ap.add_argument('--limit', type=int, default=0)
a = ap.parse_args()

since = (datetime.date.today() - datetime.timedelta(days=a.days)).isoformat()
out, seen = [], set()
with open(os.path.join(ROOT, 'data', 'pipeline.csv'), newline='') as fh:
    for r in csv.DictReader(fh):
        if (r.get('date') or '') < since:
            continue
        if str(r.get('applied', '')).upper() == 'TRUE':
            continue
        if str(r.get('status', '')).lower() in ('discarded', 'skip'):
            continue
        url = (r.get('url') or '').lower()
        if a.host and a.host not in url:
            continue
        if a.non_ats:
            if any(k in url for k in OWNED) or any(k in url for k in AGGREGATOR):
                continue
        slug = slugify(r.get('company', ''), r.get('title', ''))
        if slug in seen:
            continue
        seen.add(slug)
        out.append((r.get('date') or '', slug))

out.sort(reverse=True)                      # newest postings first
for _, slug in (out[:a.limit] if a.limit else out):
    print(slug)
