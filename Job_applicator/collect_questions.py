#!/usr/bin/env python3
"""collect_questions.py — keep open-questions.md current as the batch runs.

A question the run could not answer is recorded in blocked_on and then lost:
the ledger is rewritten by every run, and answers/*.drive.json is per-posting,
so nothing accumulates a list the candidate can sit down and work through. This
does, and it is idempotent — an answer already written into open-questions.md
survives every later regeneration.

  ./collect_questions.py            refresh open-questions.md
  ./collect_questions.py --summary  counts only, write nothing

Questions already answered in profile.json.application_questions are dropped,
so the file shrinks as answers land. Infrastructure failures (CAPTCHA, dead
posting, browser crash) are NOT questions and are filed separately at the
bottom, because mixing them in buries the things a human can actually fix.
"""
import argparse
import collections
import glob
import json
import os
import re
import sys

BASE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(BASE, 'open-questions.md')

# Not questions. These are portal or driver problems and no answer from the
# candidate fixes them, so they never belong in the answerable list.
INFRA = re.compile(
    r'captcha|no #?application-form|posting may be closed|posting is dead|ECONNREFUSED'
    r'|never saw a confirmation|no Submit control|did not take the answer'
    r'|control vanished|the review call failed|filled and clean|filled but not clean'
    r'|emailed a verification code|Login with Amazon|could not check any option'
    r'|is still empty|did not stick|matches none of the form',
    re.I)

# blocked_on carries several shapes for the same underlying gap. Normalise to
# the bare question so "question left blank: X" and "unanswered: X — reason"
# collapse to one entry instead of two.
STRIP = [
    re.compile(r'^question left blank:\s*', re.I),
    re.compile(r'^unanswered:\s*', re.I),
    re.compile(r'^required field\s*', re.I),
]


def normalise(raw):
    q = re.sub(r'\s+', ' ', str(raw)).strip()
    for rx in STRIP:
        q = rx.sub('', q)
    q = re.split(r'\s+—\s+|\s+--\s+', q)[0]          # drop the model's reason
    q = re.sub(r'\s*\([0-9a-f-]{8,}\)\s*$', '', q)   # drop the control id
    q = q.strip().strip('"').strip()
    return q


def answered_keys():
    try:
        aq = json.load(open(os.path.join(BASE, 'profile.json')))['application_questions']
    except (OSError, KeyError, ValueError):
        return set()
    return {re.sub(r'[^a-z0-9]', '', k.lower()) for k in aq if not k.startswith('_')}


def existing_answers():
    """Answers the candidate already typed into open-questions.md, kept verbatim."""
    if not os.path.exists(OUT):
        return {}
    out, q = {}, None
    for line in open(OUT):
        m = re.match(r'^###\s+(.*)', line)
        if m:
            q = m.group(1).strip()
        elif q and line.lower().startswith('answer:'):
            val = line.split(':', 1)[1].strip()
            if val and val != '_(unanswered)_':
                out[q] = val
            q = None
    return out


def collect():
    qs, infra = collections.defaultdict(set), collections.Counter()
    seen_raw = set()

    def feed(items, who):
        for raw in items or []:
            raw = str(raw)
            if raw in seen_raw and INFRA.search(raw):
                continue
            seen_raw.add(raw)
            if INFRA.search(raw):
                infra[re.sub(r'\s+', ' ', raw)[:110]] += 1
                continue
            q = normalise(raw)
            if 2 < len(q) < 300:
                qs[q].add(who)

    led = os.path.join(BASE, 'logs', 'ats-batch-ledger.json')
    if os.path.exists(led):
        for k, v in json.load(open(led)).items():
            feed(v.get('blocked_on'), (v.get('company') or k).strip())
    for f in glob.glob(os.path.join(BASE, 'answers', '*.drive.json')):
        try:
            s = json.load(open(f))
        except (OSError, ValueError):
            continue
        who = os.path.basename(f).replace('.drive.json', '').replace('job-', '')
        who = who.split('-')[0].replace('_', ' ').strip()
        feed(s.get('blocked_on'), who)
        feed(s.get('left_for_human'), who)
    return qs, infra


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--summary', action='store_true')
    a = ap.parse_args()

    qs, infra = collect()
    done = answered_keys()
    prior = existing_answers()

    # Drop anything profile.json now answers. Keyword overlap rather than exact
    # match, because the profile key is a slug and the form asks in prose.
    open_qs = {}
    for q, who in qs.items():
        slug = re.sub(r'[^a-z0-9]', '', q.lower())
        if any(k in slug or slug in k for k in done if len(k) > 12):
            continue
        open_qs[q] = who

    if a.summary:
        print(f'{len(open_qs)} open question(s), {len(prior)} already answered in the file, '
              f'{sum(infra.values())} infrastructure block(s)')
        return 0

    ranked = sorted(open_qs.items(), key=lambda x: (-len(x[1]), x[0].lower()))
    L = []
    L.append('# Open application questions\n')
    L.append('Questions the pipeline could not answer from `profile.json`, `cv.md` or `data/*.txt`,')
    L.append('so it left the field empty and skipped the posting rather than guessing.\n')
    L.append('**Fill in the `Answer:` lines.** Anything you write here is preserved when this file')
    L.append('is regenerated. Then run `./apply_answers.py` to push them into')
    L.append('`profile.json` → `application_questions`, where every future run reads them.\n')
    L.append(f'_Regenerate with `./collect_questions.py`. {len(ranked)} open, '
             f'{len(prior)} answered._\n')
    L.append('---\n')

    for q, who in ranked:
        L.append(f'### {q}')
        askers = ', '.join(sorted(who)[:6]) + (' …' if len(who) > 6 else '')
        L.append(f'_Asked by {len(who)} posting(s): {askers}_\n')
        L.append(f'Answer: {prior.get(q, "_(unanswered)_")}\n')

    if infra:
        L.append('---\n')
        L.append('## Not questions — portal and driver problems\n')
        L.append('No answer from you fixes these. Listed so nothing is silently dropped.\n')
        for msg, n in infra.most_common(30):
            L.append(f'- [{n}x] {msg}')
        L.append('')

    open(OUT, 'w').write('\n'.join(L))
    print(f'wrote {OUT}: {len(ranked)} open question(s), {len(prior)} answer(s) preserved, '
          f'{sum(infra.values())} infrastructure block(s)')
    return 0


if __name__ == '__main__':
    sys.exit(main())
