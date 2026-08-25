#!/usr/bin/env python3
"""jd_extract.py — one JD text extractor for every posting URL, and the cache
it writes to.

  python3 jd_extract.py <url> [slug]        # extract one posting
  python3 jd_extract.py --all-pending       # extract every pending pipeline row

Previously JD text was pulled in two unrelated places: the three
Job_applicator/*_jd.py fetchers each pulled `descriptionHtml` out of their own
ATS response, and experience_gate.py had its own `jd_text()` covering seven
more sources. That left the ~80% of pipeline rows that are neither Greenhouse,
Ashby, nor Lever with no JD on disk at all.

This module is now the single path. Every posting URL goes through `jd_text()`,
which tries the site's JSON API where one exists and falls back to stripping
the page HTML, and every successful extraction is written to
Job_applicator/jd/{slug}.txt. Callers that used to fetch their own JD import
from here instead.

Extraction chain, in order:
  JobRight desc cache -> Greenhouse API -> Lever API -> LinkedIn (CSV cache,
  then guest endpoint) -> Workday CXS -> Workable API -> generic HTML strip.

The generic branch is what makes "every page" work: Ashby, custom career sites,
and anything else server-rendered land there. Genuinely JS-only pages return
too little text and are reported as unextractable rather than silently saved
as an empty file.
"""
import argparse
import csv
import html
import json
import os
import re
import sys
import time
import urllib.request

ROOT = os.path.dirname(os.path.abspath(__file__))
PIPE = os.path.join(ROOT, "data/pipeline.md")
JD_DIR = os.path.join(ROOT, "Job_applicator/jd")

UA = {"User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36"}

# Below this many characters the "JD" is a nav shell or an authwall, not a
# posting. Same threshold experience_gate.py already used to mark UNVERIFIED.
MIN_JD_CHARS = 200


def fetch(url, data=None, headers=None, timeout=20):
    try:
        req = urllib.request.Request(url, data=data, headers={**UA, **(headers or {})})
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.read().decode("utf-8", "replace")
    except Exception:
        # some hosts (amazon.jobs) 406 python's TLS fingerprint; curl passes
        import subprocess
        r = subprocess.run(
            ["curl", "-sL", "--max-time", str(timeout), "-A", UA["User-Agent"], url],
            capture_output=True, text=True, timeout=timeout + 5)
        if r.returncode != 0 or not r.stdout:
            raise
        return r.stdout


def strip_html(s):
    s = re.sub(r"<(script|style)[^>]*>.*?</\1>", " ", s, flags=re.S | re.I)
    s = re.sub(r"<[^>]+>", " ", s)
    return html.unescape(s)


def collapse(s):
    """Readable plaintext: keep paragraph breaks, drop runs of blank space."""
    s = re.sub(r"[ \t\xa0]+", " ", s)
    s = re.sub(r"\n\s*\n\s*\n+", "\n\n", s)
    return s.strip()


_LINKEDIN_CACHE = None


def _linkedin_cache():
    """JD text by job id from the Webscrapper CSVs. The scraper stores the full
    rendered description; the guest jobPostings endpoint often serves a thinner
    page (or authwalls), which made the gate miss stated year requirements —
    prefer the cache whenever the id is present."""
    global _LINKEDIN_CACHE
    if _LINKEDIN_CACHE is None:
        _LINKEDIN_CACHE = {}
        for name in ("linkedin_jobs.csv", "linkedin_jobs_filtered.csv"):
            try:
                with open(f"{ROOT}/Webscrapper/{name}", newline="", encoding="utf-8") as f:
                    for row in csv.DictReader(f):
                        m = re.search(r"/jobs/view/[\w-]*?(\d{6,})", row.get("job_url", ""))
                        jd = row.get("job_description", "") or ""
                        if m and len(jd) > MIN_JD_CHARS:
                            _LINKEDIN_CACHE[m.group(1)] = jd
            except OSError:
                pass
    return _LINKEDIN_CACHE


_JOBRIGHT_CACHE = None


def _jobright_cache():
    """JD text keyed by the EMPLOYER url, for postings that came via JobRight.

    jobright_scan_parser.py rewrites those rows to the employer's own apply URL
    — better for applying, worse for extraction, because many of those ATSs
    (Workday, ADP, Paycom, RippleHire) are SPAs that serve no JD to a plain
    fetch. The parser already downloaded the JD when it resolved the link, so
    pair the two caches by job id and use it instead of re-fetching."""
    global _JOBRIGHT_CACHE
    if _JOBRIGHT_CACHE is None:
        _JOBRIGHT_CACHE = {}
        try:
            links = json.load(open(f"{ROOT}/jobright_apply_cache.json", encoding="utf-8"))
            descs = json.load(open(f"{ROOT}/jobright_desc_cache.json", encoding="utf-8"))
            for jid, employer_url in links.items():
                text = descs.get(jid, "")
                if employer_url and len(text) > MIN_JD_CHARS:
                    _JOBRIGHT_CACHE[employer_url.rstrip("/").lower()] = text
        except Exception:
            pass
    return _JOBRIGHT_CACHE


def jd_text(url):
    """Return JD plain text or None if unfetchable. Never raises."""
    cached = _jobright_cache().get((url or "").rstrip("/").lower())
    if cached:
        return cached
    try:
        m = re.match(r"https?://(?:job-)?boards(\.eu)?\.greenhouse\.io/([^/]+)/jobs/(\d+)", url)
        if m:
            eu, board, jid = m.group(1) or "", m.group(2), m.group(3)
            api = f"https://boards-api{eu}.greenhouse.io/v1/boards/{board}/jobs/{jid}"
            return strip_html(json.loads(fetch(api)).get("content", ""))
        m = re.match(r"https?://jobs\.lever\.co/([^/]+)/([0-9a-f-]{36})", url)
        if m:
            d = json.loads(fetch(f"https://api.lever.co/v0/postings/{m.group(1)}/{m.group(2)}"))
            parts = [d.get("descriptionPlain", "")]
            for lst in d.get("lists", []):
                parts.append(lst.get("text", "") + " " + strip_html(lst.get("content", "")))
            parts.append(d.get("additionalPlain", ""))
            return " ".join(parts)
        # Ashby: the per-posting endpoint is auth-gated for some orgs, but the
        # board list is public and carries descriptionPlain for every posting.
        m = re.match(r"https?://jobs\.ashbyhq\.com/([^/]+)/([0-9a-f-]{36})", url)
        if m:
            org, pid = m.group(1), m.group(2)
            board = json.loads(fetch(
                f"https://api.ashbyhq.com/posting-api/job-board/{org}"))
            for job in board.get("jobs", []):
                if job.get("id") == pid:
                    return (job.get("descriptionPlain")
                            or strip_html(job.get("descriptionHtml", "")))
        # amazon.jobs: the .json API now serves the SPA shell; the page HTML is
        # server-rendered with the full JD, so fall through to the generic
        # HTML fetch below (curl fallback handles amazon's fingerprinting).
        m = re.search(r"linkedin\.com/jobs/view/[\w-]*?(\d{6,})", url)
        if m:
            jid = m.group(1)
            cached = _linkedin_cache().get(jid)
            if cached:
                return cached
            # The jobs-guest endpoint stopped serving JD markup (it now returns
            # a ~110KB CSS/JS shell for every id, which strips to plausible-
            # looking text and silently poisons anything downstream). Only
            # accept a response that actually contains a JD container.
            for candidate in (
                    f"https://www.linkedin.com/jobs-guest/jobs/api/jobPostings/{jid}",
                    f"https://www.linkedin.com/jobs/view/{jid}/"):
                try:
                    page = fetch(candidate)
                except Exception:
                    continue
                if "authwall" in page[:2000]:
                    continue
                mk = re.search(
                    r'class="[^"]*(?:show-more-less-html__markup|description__text'
                    r'|jobs-description)[^"]*"[^>]*>(.*?)</(?:div|section)>',
                    page, re.S | re.I)
                if mk:
                    return strip_html(mk.group(1))
            return None
        # Capture the tenant's own wd pod. Hardcoding wd5 (as the original did)
        # 404s every tenant on wd1/wd2/wd3 — RELX, Cadence and friends.
        m = re.match(r"https?://([a-z0-9-]+)\.(wd\d+)\.myworkdayjobs\.com/"
                     r"(?:[a-z]{2}-[A-Z]{2}/)?([^/]+)(/job/.+?)(?:\?|$)", url)
        if m:
            tenant, pod, site, path = m.groups()
            d = json.loads(fetch(
                f"https://{tenant}.{pod}.myworkdayjobs.com/wday/cxs/{tenant}/{site}{path}",
                headers={"Accept": "application/json"}))
            return strip_html(d.get("jobPostingInfo", {}).get("jobDescription", ""))
        m = re.match(r"https?://apply\.workable\.com/([^/]+)/j/([^/]+)", url)
        if m:
            d = json.loads(fetch(
                f"https://apply.workable.com/api/v2/accounts/{m.group(1)}/jobs/{m.group(2)}"))
            return strip_html(str(d.get("description", "")) + str(d.get("requirements", "")))
        # custom career sites and anything else server-rendered
        return strip_html(fetch(url))
    except Exception:
        return None


# ── the cache on disk ────────────────────────────────────────────────────────

def slugify(company, title):
    # Must stay byte-identical to the n8n workflow's expression, which names the
    # JD files it drops into this same cache dir:
    #   ('job-' + company + '-' + title).replace(/[^a-zA-Z0-9-]/g,'_')
    # Any divergence means n8n-fetched JDs miss the cache and get re-fetched.
    # Note: no lowercasing, no run-collapsing, no length cap — matching exactly
    # is what keeps the two writers pointed at the same file.
    # Trim first: sync_pipeline_csv.pad_company() writes company with one leading
    # space by preference, so a CSV-driven caller passes " Anthropic" where a
    # pipeline.md-driven caller passes "Anthropic". Untrimmed, those spell
    # job-_Anthropic-… and job-Anthropic-… — two cache entries for one posting.
    # The n8n expression must call .trim() on both fields to stay in step.
    company = (company or "").strip()
    title = (title or "").strip()
    return re.sub(r"[^a-zA-Z0-9-]", "_", f"job-{company}-{title}")


def jd_path(slug):
    return os.path.join(JD_DIR, f"{slug}.txt")


def save_jd(slug, text):
    os.makedirs(JD_DIR, exist_ok=True)
    path = jd_path(slug)
    with open(path, "w", encoding="utf-8") as f:
        f.write(collapse(text))
    return path


# A stripped CSS/JS bundle reads as thousands of characters of "text" and sails
# past a length check. Every JD that fails this guard is reported as a miss
# rather than cached, because a wrong JD is worse than no JD: it feeds the fit
# gate and, downstream, the answers written into real application forms.
_CSS_NOISE = re.compile(r"\{[^{}]{0,120}?(?:display|margin|padding|font-size|"
                        r"line-height|border-radius|z-index)\s*:", re.I)


def looks_like_shell(text):
    if len(text) < MIN_JD_CHARS:
        return True
    if len(_CSS_NOISE.findall(text[:20000])) > 20:
        return True
    low = text[:2000].lower()
    return "authwall" in low or "enable javascript" in low


def extract(url, slug, force=False):
    """Fetch + cache one posting. Returns (path, text) or (None, None)."""
    path = jd_path(slug)
    if not force and os.path.exists(path):
        text = open(path, encoding="utf-8").read()
        if not looks_like_shell(text):
            return path, text
    text = jd_text(url)
    if not text:
        return None, None
    text = collapse(text)
    if looks_like_shell(text):
        return None, None
    return save_jd(slug, text), text


PIPE_ROW = re.compile(
    r"^- \[ \] (\S+) \| ([^|]+?) \| ([^|]+?) \| (\d{4}-\d{2}-\d{2})(?:\s*\|[^|]*)*\s*$")


def pending_rows():
    if not os.path.exists(PIPE):
        return []
    out = []
    for line in open(PIPE, encoding="utf-8").read().splitlines():
        m = PIPE_ROW.match(line)
        if m:
            out.append((m.group(1), m.group(2).strip(), m.group(3).strip()))
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("url", nargs="?")
    ap.add_argument("slug", nargs="?")
    ap.add_argument("--all-pending", action="store_true",
                    help="extract every pending row in data/pipeline.md")
    ap.add_argument("--force", action="store_true", help="re-fetch cached JDs")
    ap.add_argument("--limit", type=int, help="stop after N postings")
    ap.add_argument("--sleep", type=float, default=0.2)
    args = ap.parse_args()

    if args.all_pending:
        rows = pending_rows()
        if args.limit:
            rows = rows[:args.limit]
        ok = failed = cached = 0
        for i, (url, company, title) in enumerate(rows, 1):
            slug = slugify(company, title)
            existed = os.path.exists(jd_path(slug))
            path, text = extract(url, slug, force=args.force)
            if path and existed and not args.force:
                cached += 1
            elif path:
                ok += 1
                time.sleep(args.sleep)
            else:
                failed += 1
                print(f"  MISS {company} | {title[:50]}", file=sys.stderr)
                time.sleep(args.sleep)
            if i % 50 == 0:
                print(f"  ... {i}/{len(rows)}  new={ok} cached={cached} miss={failed}",
                      file=sys.stderr)
        print(f"\n{len(rows)} rows: {ok} extracted, {cached} already cached, "
              f"{failed} unextractable -> {JD_DIR}")
        return

    if not args.url:
        raise SystemExit("usage: jd_extract.py <url> [slug]  |  --all-pending")
    slug = args.slug or slugify("posting", re.sub(r"^https?://", "", args.url))
    path, text = extract(args.url, slug, force=args.force)
    if not path:
        raise SystemExit(f"could not extract a JD from {args.url}")
    print(f"# {len(text):,} chars -> {path}")


if __name__ == "__main__":
    main()
