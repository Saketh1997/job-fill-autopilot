#!/usr/bin/env python3
"""linkedin_apply.py — resolve a linkedin.com/jobs/view link to the employer's
own apply URL.

The guest job page never reveals it: LinkedIn hides the offsite apply target
behind a sign-in modal, so a scraped card only ever yields
`https://www.linkedin.com/jobs/view/{id}/`. A logged-in session does have it —
the Voyager job-posting API returns `applyMethod.companyApplyUrl` (the ATS URL
the Apply button would send you to). This module turns a LinkedIn session
cookie into that URL, with a disk cache so a posting is looked up once.

Three apply shapes come back, and only the first is worth rewriting:
  OffsiteApply        -> companyApplyUrl (greenhouse/lever/workday/... )
  ComplexOnsiteApply  -> easyApplyUrl, sometimes ALSO companyApplyUrl
  SimpleOnsiteApply   -> Easy Apply only; the LinkedIn link IS the apply link

Misses cache as "" so an Easy Apply posting is not re-fetched every run;
`refresh=True` retries them (a posting can switch to offsite later).

Used by `Webscrapper/linkedin_scan_parser.py` (new rows arrive pre-resolved) and
by `linkedin_relink.py` (rows already in the pipeline). Read-only against
LinkedIn — it fetches job postings, never applies, saves, or messages.

Standalone:
  .venv-jobspy/bin/python linkedin_apply.py https://www.linkedin.com/jobs/view/4408221680/
"""
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import scan_common as sc  # noqa: E402

ENV_FILE = os.path.join(HERE, ".env")
LINK_CACHE = os.path.join(HERE, "linkedin_apply_cache.json")

# WebLightJobPosting carries applyMethod without the full JD payload — a third
# the bytes of the -65 decoration, and applyMethod is all this module wants.
VOYAGER = ("https://www.linkedin.com/voyager/api/jobs/jobPostings/{jid}"
           "?decorationId=com.linkedin.voyager.deco.jobs.web.shared"
           ".WebLightJobPosting-23")

UA = ("Mozilla/5.0 (X11; Ubuntu; Linux x86_64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36")

# The cookies Voyager actually authenticates on. Sending the full 28-cookie jar
# works too, but this keeps the header (and the .env line) small.
COOKIE_KEYS = ("li_at", "JSESSIONID", "liap", "bcookie", "lidc")

JOB_ID_RE = re.compile(r"linkedin\.com/jobs/view/[\w-]*?(\d{6,})", re.I)

# Employer-controlled shorteners worth one extra hop: the target is the real ATS
# URL, which `scan_common.source_rank` ranks above an opaque short domain and
# which dedup can match against a Greenhouse/Lever scan of the same posting.
SHORTENERS = re.compile(r"^https?://(?:grnh\.se|jobs\.lever\.co/l/|bit\.ly)/", re.I)

# Some postings set companyApplyUrl to a LinkedIn page that is not an apply
# route at all — most often the company profile (/company/111556386). Swapping a
# working job link for one of those loses the posting, so anything pointing back
# at linkedin.com is only accepted when it is itself an apply path.
_LINKEDIN_HOST = re.compile(r"^https?://(?:[\w-]+\.)?linkedin\.com/", re.I)
_LINKEDIN_APPLY_PATH = re.compile(r"linkedin\.com/(?:jobs|job-apply)/", re.I)

FETCH_DELAY = float(os.environ.get("LINKEDIN_FETCH_DELAY", "1.5"))


def log(msg):
    print(f"[linkedin-apply] {msg}", file=sys.stderr, flush=True)


def load_cookie():
    """LINKEDIN_COOKIE from the environment, falling back to .env.

    scan.mjs loads .env through dotenv and the parser inherits its environment,
    so inside a scan the variable is already set; the .env read is what makes a
    standalone run behave the same."""
    cookie = os.environ.get("LINKEDIN_COOKIE", "").strip()
    if cookie:
        return cookie
    try:
        for line in open(ENV_FILE, encoding="utf-8"):
            line = line.strip()
            if line.startswith("LINKEDIN_COOKIE="):
                return line.split("=", 1)[1].strip().strip('"').strip("'")
    except OSError:
        pass
    return ""


def csrf_token(cookie):
    """Voyager rejects any request whose csrf-token header does not equal the
    JSESSIONID cookie value (quotes stripped)."""
    m = re.search(r'JSESSIONID="?([^";]+)"?', cookie or "")
    return m.group(1) if m else ""


def linkedin_job_id(url):
    """The numeric posting id in a linkedin.com/jobs/view URL, else ""."""
    m = JOB_ID_RE.search(url or "")
    return m.group(1) if m else ""


def _load_cache(path=LINK_CACHE):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {}


def _save_cache(data, path=LINK_CACHE):
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f)
    os.replace(tmp, path)


class _Stop(Exception):
    """Raised when LinkedIn stops answering — expired cookie or rate limit.

    The run keeps every link it already resolved and leaves the rest as
    linkedin.com URLs; a half-resolved pipeline is fine, a pipeline full of
    cached false misses is not."""


def _fetch(jid, cookie, csrf):
    """The Voyager payload for a posting, or None when it is simply gone (404).

    Raises `_Stop` on 401/403 (cookie expired) and 429 (rate limited) — both
    mean every further lookup this run would fail the same way."""
    req = urllib.request.Request(VOYAGER.format(jid=jid), headers={
        "Cookie": cookie,
        "csrf-token": csrf,
        "Accept": "application/vnd.linkedin.normalized+json+2.1",
        "x-restli-protocol-version": "2.0.0",
        "User-Agent": UA,
        "Referer": f"https://www.linkedin.com/jobs/view/{jid}/",
    })
    try:
        with urllib.request.urlopen(req, timeout=25) as r:
            body = r.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        if e.code in (401, 403):
            raise _Stop("LinkedIn served an unauthenticated response — the cookie "
                        "looks expired. Re-run: .venv-jobspy/bin/python "
                        "linkedin_login.py") from None
        if e.code == 429:
            raise _Stop("LinkedIn rate-limited this run (429) — resolved links are "
                        "cached, re-run later to continue") from None
        return None            # 404: posting pulled. Nothing to resolve, ever.
    except Exception:
        return None
    finally:
        time.sleep(FETCH_DELAY)
    try:
        return json.loads(body)
    except ValueError:
        return None


def _unshorten(url):
    """One redirect hop for employer link shorteners; the original on failure."""
    if not SHORTENERS.match(url or ""):
        return url

    class _NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *a, **k):
            return None

    try:
        opener = urllib.request.build_opener(_NoRedirect)
        opener.open(urllib.request.Request(url, headers={"User-Agent": UA}),
                    timeout=15)
    except urllib.error.HTTPError as e:
        target = e.headers.get("Location") if 300 <= e.code < 400 else None
        if target and target.startswith("http"):
            return target
    except Exception:
        pass
    return url


def extract_apply_url(payload):
    """The employer apply URL from a Voyager payload, tracking params stripped.

    `companyApplyUrl` is the offsite target and wins whenever it is present —
    including on a ComplexOnsiteApply posting, which offers Easy Apply *and* the
    employer's own form. Easy-Apply-only postings return ""."""
    if not isinstance(payload, dict):
        return ""
    apply_method = (payload.get("data") or {}).get("applyMethod") or {}
    url = (apply_method.get("companyApplyUrl") or "").strip()
    if not url or not url.startswith("http"):
        return ""
    if _LINKEDIN_HOST.match(url) and not _LINKEDIN_APPLY_PATH.search(url):
        return ""
    return sc.canonical_url(_unshorten(url))


def resolve_apply_links(jobs, cookie=None, refresh=False, budget=None):
    """Rewrite each job's linkedin.com URL to the employer apply URL in place.

    Every rewritten job keeps its original link in `linkedin_url` — callers that
    rewrite files (linkedin_relink.py) need the old string to find the row, and
    it is the only way back if a resolution ever looks wrong.

    Jobs with no external apply URL (Easy Apply) keep their LinkedIn link: a
    working apply route beats a missing one. `budget` caps network lookups per
    run so an in-scan call cannot blow past the parser's portals.yml timeout —
    cache hits are free and never count against it.

    Returns (jobs, resolved_count).
    """
    cookie = load_cookie() if cookie is None else cookie
    if not cookie:
        log("LINKEDIN_COOKIE not set — keeping linkedin.com links. Run: "
            ".venv-jobspy/bin/python linkedin_login.py")
        return jobs, 0
    csrf = csrf_token(cookie)
    if not csrf:
        log("LINKEDIN_COOKIE has no JSESSIONID — Voyager needs it as the csrf "
            "token. Re-run linkedin_login.py")
        return jobs, 0

    cache = _load_cache()
    left = len(jobs) if budget is None else budget
    resolved = fetched = misses = gone = 0
    stopped = ""

    for j in jobs:
        jid = linkedin_job_id(j.get("url", ""))
        if not jid:
            continue
        if jid in cache and not (refresh and not cache[jid]):
            url = cache[jid]
        elif stopped or left <= 0:
            continue
        else:
            try:
                payload = _fetch(jid, cookie, csrf)
            except _Stop as e:
                stopped = str(e)
                continue
            left -= 1
            if payload is None:
                gone += 1
                continue       # 404 / transient: leave the LinkedIn link alone
            url = cache[jid] = extract_apply_url(payload)
            fetched += 1
            # Flush periodically: a migration run is hundreds of lookups and
            # ~1.5s apart, and losing the lot to a Ctrl-C or a killed cron job
            # means paying LinkedIn for them all over again.
            if fetched % 25 == 0:
                _save_cache(cache)
        if url:
            j["linkedin_url"] = j["url"]
            j["url"] = url
            resolved += 1
        else:
            misses += 1

    if fetched:
        _save_cache(cache)
    if stopped:
        log(stopped)
    log(f"apply links: {resolved} employer URLs, {misses} kept as linkedin.com "
        f"(Easy Apply), {gone} unavailable ({fetched} lookups this run"
        + (f", {left} of budget left" if budget is not None else "") + ")")
    return jobs, resolved


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    if not args:
        sys.exit("usage: linkedin_apply.py <linkedin job url> [...]")
    jobs = [{"url": a} for a in args]
    resolve_apply_links(jobs, refresh="--refresh" in sys.argv)
    for j in jobs:
        print(f"{j.get('linkedin_url', j['url'])}\n  -> {j['url']}")


if __name__ == "__main__":
    main()
