#!/usr/bin/env python3
"""apply_answers.py — push answers from open-questions.md into profile.json.

The other half of collect_questions.py. Without this the candidate's answers
sit in a markdown file nothing reads, and the same question blocks the same way
on the next run.

  ./apply_answers.py            apply every filled Answer: line
  ./apply_answers.py --dry-run  show what would change, write nothing

Each answer lands in profile.json -> application_questions under a slug derived
from the question, alongside a `_source_<slug>` note holding the question text
verbatim, so a later reader can tell what the value actually answers.

profile.json is written atomically: a batch run reads this file between
postings and must never see a half-written one. An existing key is never
silently overwritten -- a changed answer is reported and skipped unless
--overwrite is passed, because profile.json is hand-curated and a generated
key clobbering a curated one is the failure mode worth preventing.
"""
import argparse
import json
import os
import re
import sys
import tempfile

BASE = os.path.dirname(os.path.abspath(__file__))
QFILE = os.path.join(BASE, 'open-questions.md')
PROFILE = os.path.join(BASE, 'profile.json')

# Answers that mean "leave the field empty", which is a real answer: it tells
# the run to stop treating the question as unresolved and blocking on it.
BLANK = {'none', 'n/a', 'na', '-', 'blank', 'leave blank', 'skip', 'nothing'}


def slugify(q):
    s = re.sub(r'\[follow-up to [^\]]*\]', '', q, flags=re.I)
    s = re.sub(r'[^a-z0-9]+', '_', s.lower()).strip('_')
    return s[:64] or 'question'


def parse():
    if not os.path.exists(QFILE):
        sys.exit(f'apply_answers: no {QFILE} — run ./collect_questions.py first')
    out, q = [], None
    for line in open(QFILE):
        m = re.match(r'^###\s+(.*)', line)
        if m:
            q = m.group(1).strip()
        elif q and line.lower().startswith('answer:'):
            val = line.split(':', 1)[1].strip()
            if val and val != '_(unanswered)_':
                out.append((q, val))
            q = None
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--dry-run', action='store_true')
    ap.add_argument('--overwrite', action='store_true',
                    help='replace a key that already holds a different value')
    a = ap.parse_args()

    answers = parse()
    if not answers:
        print('apply_answers: nothing filled in yet — no Answer: lines have values')
        return 0

    p = json.load(open(PROFILE))
    aq = p.setdefault('application_questions', {})
    added, skipped, changed = [], [], []

    for q, val in answers:
        key = slugify(q)
        new = '' if val.strip().lower() in BLANK else val
        if key in aq and aq[key] != new:
            if not a.overwrite:
                skipped.append((key, aq[key], new))
                continue
            changed.append(key)
        elif key in aq:
            continue
        else:
            added.append(key)
        aq[key] = new
        aq[f'_source_{key}'] = f'answers the form question: "{q}" (from open-questions.md)'

    for k in added:
        print(f'  + {k} = {aq[k]!r}')
    for k in changed:
        print(f'  ~ {k} = {aq[k]!r} (overwritten)')
    for k, old, new in skipped:
        print(f'  ! {k} already = {old!r}, open-questions.md says {new!r} '
              f'— left alone; pass --overwrite to replace')

    if a.dry_run:
        print(f'\ndry run: {len(added)} would be added, {len(changed)} overwritten, '
              f'{len(skipped)} conflict(s)')
        return 0
    if not added and not changed:
        print('nothing to write')
        return 0

    fd, tmp = tempfile.mkstemp(dir=BASE, suffix='.tmp')
    with os.fdopen(fd, 'w') as fh:
        json.dump(p, fh, indent=2, ensure_ascii=False)
    os.replace(tmp, PROFILE)          # atomic: a batch run reads this file
    os.chmod(PROFILE, 0o600)
    print(f'\nwrote profile.json: {len(added)} added, {len(changed)} overwritten. '
          f'Re-run ./collect_questions.py to drop them from open-questions.md.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
