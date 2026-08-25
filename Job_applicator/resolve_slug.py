#!/usr/bin/env python3
"""resolve_slug.py — slug -> posting URL, the one lookup every stage shares.

n8n passes only a slug. Each stage needs the URL behind it, and all of them must
agree on the answer, so the lookup lives here rather than being re-implemented
per script.

  python3 resolve_slug.py <slug>            # prints the URL, exit 0
  python3 resolve_slug.py <slug> --json     # {"slug":…,"url":…,"company":…,"title":…,"applied":…}

Exit: 0 found   1 no matching row   2 bad usage

Matching is jd_extract.slugify(company, title) == slug over data/pipeline.csv.
slugify trims, so the CSV's padded company cell (sync_pipeline_csv.pad_company
writes one leading space by preference) resolves correctly.
"""
import csv
import re, json, os, re, sys

ROOT = "/home/hunter/projects/career-ops"
sys.path.insert(0, ROOT)
from jd_extract import slugify  # noqa: E402

PIPE = os.path.join(ROOT, "data", "pipeline.csv")


def _raw_slugify(company, title):
    """The UNTRIMMED form: what n8n actually produces.

    jd_extract.slugify trims both cells, so " Amazon.com Services LLC" gives
    job-Amazon_com_… . The n8n expression does not trim, so the same row gives
    job-_Amazon_com_… — sync_pipeline_csv.pad_company() writes one leading space
    by preference, and that space becomes a leading underscore.

    Both names are in use on disk (jd/, resumes/), so this lookup accepts either
    rather than making one writer's files unreachable. The slug the caller passed
    is the one echoed back, so every downstream artefact for a run keeps a single
    consistent name.
    """
    return re.sub(r"[^a-zA-Z0-9-]", "_", f"job-{company or ''}-{title or ''}")



# Ashby publishes the same posting under two URL shapes:
#   jobs.ashbyhq.com/{org}/{uuid}          the real page
#   jobs.ashbyhq.com/{org}?ashby_jid={uuid} a redirect the scanner sometimes catches
# The second renders nothing without JS, so stage 1 came back empty and the whole
# posting failed at "jd_extract produced nothing". Same posting, so normalise it
# here, in the one lookup every stage shares, rather than in each stage.
_ASHBY_JID = re.compile(
    r"^(https://jobs\.ashbyhq\.com/[^/?#]+)/?\?(?:.*&)?ashby_jid=([0-9a-f-]{16,})", re.I)


def canonical_url(url):
    m = _ASHBY_JID.match((url or "").strip())
    return f"{m.group(1)}/{m.group(2)}" if m else (url or "").strip()

def lookup(slug):
    """First row whose slug matches, trimmed or untrimmed. Returns dict or None."""
    with open(PIPE, newline="", encoding="utf-8") as f:
        for r in csv.DictReader(f):
            raw_c, raw_t = r.get("company") or "", r.get("title") or ""
            c, t = raw_c.strip(), raw_t.strip()
            if not (c or t):
                continue
            if slug not in (slugify(c, t), _raw_slugify(raw_c, raw_t)):
                continue
            return {"slug": slug, "url": canonical_url(r.get("url")),
                    "company": c, "title": t,
                    "applied": (r.get("applied") or "").strip().upper() == "TRUE",
                    "status": (r.get("status") or "").strip()}
    return None


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    if len(args) != 1:
        print("usage: resolve_slug.py <slug> [--json]", file=sys.stderr)
        return 2
    row = lookup(args[0])
    if not row:
        print(f"no pipeline.csv row whose slugify(company,title) == {args[0]!r}",
              file=sys.stderr)
        return 1
    if not row["url"]:
        print(f"row for {args[0]!r} has no url", file=sys.stderr)
        return 1
    print(json.dumps(row) if "--json" in sys.argv else row["url"])
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
