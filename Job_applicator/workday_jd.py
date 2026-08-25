"""
Workday form fetcher.  *.myworkdayjobs.com

  python workday_jd.py https://gm.wd5.myworkdayjobs.com/en-US/Careers/job/... gm-swe
  -> writes schema/{slug}.json

This script owns the form schema ONLY. The JD is fetched by stage 1 of the
pipeline (./get_jd.sh -> ../jd_extract.py -> jd/{slug}.txt), so nothing here
touches jd/.

Workday exposes no form schema. The wizard is behind an account wall and is
multi-step, so scrape_page.mjs --fields returns [] on both the job page and
/apply (cache/workday.json -> mechanics.account_wall). There is nothing to
fetch, so this emits the same "(discover on page)" marker ashby_jd.py falls
back to and lets workday_apply.mjs read the live wizard.

It is still worth existing rather than being skipped: preflight() in
ats_apply_common.mjs requires schema/{slug}.json, and run_ats_batch.mjs
dispatches the schema step by ATS name. Emitting the marker is what lets a
Workday posting enter the batch at all.

Workday DOES publish the posting's own metadata as JSON — the same URL with an
Accept: application/json header returns the job title and the external apply
path. That is used to confirm the posting is live and to record the canonical
apply URL, not to build a field list.
"""
import sys
import json
import urllib.error
import urllib.parse
import urllib.request

from ats_common import Field, dump_fields, slug_paths, TEXT

UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36"


def parse_url(url):
    """Return (tenant, canonical job url without a trailing /apply)."""
    if "myworkdayjobs.com" not in url and "myworkdaysite.com" not in url:
        raise SystemExit("not a workday posting url")
    tenant = urllib.parse.urlsplit(url).netloc.split(".")[0].lower()
    job = url.split("?")[0].rstrip("/")
    if job.endswith("/apply"):
        job = job[: -len("/apply")]
    return tenant, job


def fetch_meta(job_url):
    """Workday serves the posting as JSON to an Accept: application/json request.

    Best-effort only: tenants sit behind bot filters that answer a bare request
    with 403/404 even for a live posting, so a failure here must not fail the
    schema. It returns {} and the driver confirms liveness from the page.
    """
    req = urllib.request.Request(
        job_url, headers={"Accept": "application/json", "User-Agent": UA})
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            return json.loads(r.read().decode("utf-8", "replace"))
    except (urllib.error.URLError, ValueError, TimeoutError) as e:
        print(f"# posting metadata unavailable ({e}); schema is unaffected",
              file=sys.stderr)
        return {}


def normalize() -> list[Field]:
    # One marker, exactly like ashby_jd.py's degraded path. Required=True so a
    # driver that ignores the wizard and finds nothing is treated as blocked
    # rather than as a complete form.
    return [Field(key="__all__", kind=TEXT, label="(discover on page)",
                  required=True, source="page")]


if __name__ == "__main__":
    if len(sys.argv) < 3:
        raise SystemExit("usage: workday_jd.py <url> <slug>")
    schema_path, _ = slug_paths(sys.argv[2])
    tenant, job = parse_url(sys.argv[1])
    meta = fetch_meta(job)
    info = meta.get("jobPostingInfo") or {}
    fields = normalize()
    dump_fields(fields, schema_path)
    title = info.get("title") or "(title unavailable)"
    print(f"# {title}  (workday tenant {tenant}, whole form discovered on page)"
          f" -> {schema_path}")
