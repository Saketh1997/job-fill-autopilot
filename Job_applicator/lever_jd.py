"""
Lever form fetcher.  Public v0 postings API, no auth.

  python lever_jd.py https://jobs.lever.co/company/uuid company-swe
  -> writes schema/{slug}.json

Reality check: Lever's public JSON reliably gives the standard hosted-form
fields, but custom application questions are inconsistently exposed. So this
emits the always-present Lever fields from the API, reads custom questions when
present, and marks the rest source="page" for the fill step to discover from the
live form. Do not trust Lever's JSON to be complete.

This script owns the form schema ONLY. The JD is fetched by stage 1 of the
pipeline (./get_jd.sh -> ../jd_extract.py -> jd/{slug}.txt), so nothing here
touches jd/.
"""
import sys, re, json, urllib.request
from ats_common import (Field, dump_fields, slug_paths, fetch_json,
                        TEXT, TEXTAREA, SELECT, MULTISELECT, FILE, TYPEAHEAD)

POST = "https://api.lever.co/v0/postings/{site}/{pid}?mode=json"

# Lever's hosted form always has these personal-info fields.
STANDARD = [
    Field("name",     TEXT,     "Full name",         True),
    Field("email",    TEXT,     "Email",             True),
    Field("phone",    TEXT,     "Phone",             False),
    Field("org",      TEXT,     "Current company",   False),
    Field("urls[LinkedIn]", TEXT, "LinkedIn URL",    False),
    Field("urls[GitHub]",   TEXT, "GitHub URL",      False),
    Field("resume",   FILE,     "Resume/CV",         True),
    Field("comments", TEXTAREA, "Additional information", False),
]

# Lever custom-question field types -> normalized kind
KIND = {
    "text": TEXT, "textarea": TEXTAREA, "multiple-choice": SELECT,
    "multiple-select": MULTISELECT, "dropdown": SELECT, "file": FILE,
    "yes-no": SELECT,
}


def parse_url(url):
    m = re.search(r"lever\.co/([^/]+)/([0-9a-f-]{8,})", url)
    if not m:
        raise SystemExit("not a lever posting url")
    return m.group(1), m.group(2)


def fetch(site, pid):
    return fetch_json(POST.format(site=site, pid=pid))


def normalize(posting) -> list[Field]:
    out = list(STANDARD)
    # Custom questions, when Lever exposes them, arrive as an array of forms.
    forms = posting.get("customQuestions") or posting.get("cards") or []
    if not forms:
        out.append(Field("__custom__", TEXT, "(discover custom questions on page)",
                          False, source="page"))
        return out
    for form in forms:
        for f in form.get("fields", []):
            kind = KIND.get(f.get("type"), TEXT)
            opts = [o.get("text") or o for o in (f.get("options") or [])]
            out.append(Field(
                key=f.get("id") or f.get("name") or f.get("text", "")[:40],
                kind=kind, label=f.get("text", ""),
                required=bool(f.get("required")), options=opts, source="api"))
    return out


if __name__ == "__main__":
    if len(sys.argv) < 3:
        raise SystemExit("usage: lever_jd.py <url> <slug>")
    schema_path, _ = slug_paths(sys.argv[2])
    site, pid = parse_url(sys.argv[1])
    posting = fetch(site, pid)
    fields = normalize(posting)
    dump_fields(fields, schema_path)
    disc = sum(f.source == "page" for f in fields)
    print(f"# {posting.get('text')}  ({len(fields)} fields, {disc} to discover) -> {schema_path}")
