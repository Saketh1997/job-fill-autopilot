"""
Greenhouse form fetcher.  Public API, no auth, no browser, no tokens.

  python greenhouse_jd.py https://job-boards.greenhouse.io/togetherai/jobs/5199554007 togetherai-swe
  -> writes schema/{slug}.json (list of normalized Field)

This script owns the form schema ONLY. The JD is fetched by stage 1 of the
pipeline (./get_jd.sh -> ../jd_extract.py -> jd/{slug}.txt), so nothing here
touches jd/.
"""
import sys, re, json, urllib.request
from ats_common import (Field, dump_fields, slug_paths, fetch_json,
                        TEXT, TEXTAREA, SELECT, MULTISELECT, FILE, TYPEAHEAD)

API = "https://boards-api.greenhouse.io/v1/boards/{tok}/jobs/{jid}?questions=true"

# Greenhouse field type -> normalized kind
KIND = {
    "input_text": TEXT, "input_hidden": TEXT, "textarea": TEXTAREA,
    "input_file": FILE,
    "multi_value_single_select": SELECT,
    "multi_value_multi_select": MULTISELECT,
}
TYPEAHEAD_LABELS = ("location", "city")


def parse_url(url):
    m = re.search(r"greenhouse\.io/([^/]+)/jobs/(\d+)", url)
    if not m:
        raise SystemExit("not a greenhouse job url")
    return m.group(1), m.group(2)


def fetch(tok, jid):
    return fetch_json(API.format(tok=tok, jid=jid))


def humanize(label):
    """"DisabilityStatus" -> "Disability Status".

    The EEOC block labels its questions in CamelCase while the rendered form
    spells them out, and the fill step matches a field by its accessible name.
    Without this the four required self-ID selects are never located.
    """
    return re.sub(r"(?<=[a-z])(?=[A-Z])", " ", label)


def _questions(job):
    """Every question on the form, API label -> page label.

    `questions` holds the application questions; the EEOC self-ID block lives
    in `compliance[].questions` and was missed entirely before, which left four
    REQUIRED selects unfilled on every US posting.
    """
    for q in job.get("questions", []):
        yield q, q.get("label", "").strip()
    for block in job.get("compliance") or []:
        for q in block.get("questions") or []:
            yield q, humanize((q.get("label") or "").strip())


def normalize(job) -> list[Field]:
    out = []
    for q, label in _questions(job):
        req = bool(q.get("required"))
        for fld in q.get("fields", []):
            kind = KIND.get(fld.get("type"), TEXT)
            if kind == TEXT and any(m in label.lower() for m in TYPEAHEAD_LABELS):
                kind = TYPEAHEAD
            opts = [v.get("label") for v in (fld.get("values") or []) if v.get("label")]
            out.append(Field(key=fld["name"], kind=kind, label=label,
                             required=req, options=opts, source="api"))

    # The current EEOC form asks Hispanic/Latino as its own select and then
    # narrows Race, but the API only ever returns `race`. Emit the companion so
    # the fill step has something to resolve; its options are read off the live
    # combobox, since the API never describes them.
    if any(f.key == "race" for f in out) and not any(
            f.key == "hispanic_ethnicity" for f in out):
        out.append(Field(key="hispanic_ethnicity", kind=SELECT,
                         label="Are you Hispanic/Latino?", required=True,
                         options=[], source="api"))
    return out


if __name__ == "__main__":
    if len(sys.argv) < 3:
        raise SystemExit("usage: greenhouse_jd.py <url> <slug>")
    schema_path, _ = slug_paths(sys.argv[2])
    tok, jid = parse_url(sys.argv[1])
    job = fetch(tok, jid)
    fields = normalize(job)
    dump_fields(fields, schema_path)
    print(f"# {job.get('title')}  ({len(fields)} fields) -> {schema_path}")
