"""
Ashby form fetcher.  Public posting API, no auth.

  python ashby_jd.py https://jobs.ashbyhq.com/ramp/1234-5678-uuid ramp-swe
  -> writes schema/{slug}.json

This script owns the form schema ONLY. The JD is fetched by stage 1 of the
pipeline (./get_jd.sh -> ../jd_extract.py -> jd/{slug}.txt), so nothing here
touches jd/.

Ashby returns an applicationFormDefinition per posting. Each field has a
`path` (its key), a type, isRequired, and selectableValues for selects.
The EEO block comes as separate survey forms.

NOTE: the public posting-api response nests the form under a key that has
shifted over time and can arrive as a JSON *string*. This parses defensively
and marks anything it can't read as source="page" so the fill step discovers
it from the live form instead of failing silently.
"""
import sys, re, json, urllib.request, urllib.error
from ats_common import (Field, dump_fields, slug_paths, fetch_json,
                        TEXT, TEXTAREA, SELECT, MULTISELECT, FILE, TYPEAHEAD)

BOARD = "https://api.ashbyhq.com/posting-api/job-board/{org}"          # list
POST  = "https://api.ashbyhq.com/posting-api/job-board/{org}/{pid}"    # single

# Ashby field type -> normalized kind
KIND = {
    "File": FILE, "Boolean": SELECT,
    "ValueSelect": SELECT, "MultiValueSelect": MULTISELECT,
    "Location": TYPEAHEAD, "LongText": TEXTAREA,
    "String": TEXT, "Email": TEXT, "Phone": TEXT,
    "SocialProfileUrl": TEXT, "Number": TEXT, "Score": TEXT,
}


def parse_url(url):
    # jobs.ashbyhq.com/{org}/{postingId}
    m = re.search(r"ashbyhq\.com/([^/]+)/([0-9a-f-]{8,})", url)
    if not m:
        raise SystemExit("not an ashby posting url")
    return m.group(1), m.group(2)


def fetch(org, pid):
    """Single-posting endpoint first; fall back to the public board list.

    Ashby gates /job-board/{org}/{pid} behind auth for some orgs (401/403) while
    /job-board/{org} stays public. The board entry carries descriptionHtml but no
    applicationFormDefinition, so normalize() will mark the whole form
    source="page" and the fill step discovers it live. That is the intended
    degradation — a JD with no schema beats no JD at all.
    """
    try:
        return fetch_json(POST.format(org=org, pid=pid))
    except urllib.error.HTTPError as e:
        if e.code not in (401, 403, 404):
            raise
        print(f"# posting endpoint returned {e.code}; using public board list",
              file=sys.stderr)

    for job in fetch_json(BOARD.format(org=org)).get("jobs", []):
        if job.get("id") == pid:
            return job
    raise SystemExit(f"posting {pid} is not on {org}'s public board")


def _load_form(posting):
    """applicationFormDefinition may be a dict or a JSON string; find & parse it."""
    for k in ("applicationFormDefinition", "applicationForm", "form"):
        v = posting.get(k)
        if isinstance(v, str):
            try:
                return json.loads(v)
            except Exception:
                continue
        if isinstance(v, dict):
            return v
    return None


def normalize(posting) -> list[Field]:
    form = _load_form(posting)
    if not form:
        # Public endpoint didn't expose the form; discover it live.
        return [Field(key="__all__", kind=TEXT, label="(discover on page)",
                      required=True, source="page")]
    out = []
    for sec in form.get("sections", [{"fields": form.get("fields", [])}]):
        for wrap in sec.get("fields", []):
            fld = wrap.get("field", wrap)
            path = fld.get("path") or fld.get("id")
            if not path:
                continue
            kind = KIND.get(fld.get("type"), TEXT)
            opts = [o.get("label") for o in (fld.get("selectableValues") or [])
                    if o.get("label")]
            out.append(Field(
                key=path, kind=kind,
                label=fld.get("title", path),
                required=bool(wrap.get("isRequired") or fld.get("isRequired")),
                options=opts, source="api"))
    return out


if __name__ == "__main__":
    if len(sys.argv) < 3:
        raise SystemExit("usage: ashby_jd.py <url> <slug>")
    schema_path, _ = slug_paths(sys.argv[2])
    org, pid = parse_url(sys.argv[1])
    posting = fetch(org, pid)
    fields = normalize(posting)
    dump_fields(fields, schema_path)
    disc = sum(f.source == "page" for f in fields)
    print(f"# {posting.get('title')}  ({len(fields)} fields, {disc} to discover) -> {schema_path}")
