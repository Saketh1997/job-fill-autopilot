#!/usr/bin/env python3
"""
ATS portal scanner for career-ops.
Hits Greenhouse / Ashby / Lever JSON APIs directly (real-time, active-only),
filters by title_filter from portals.yml, US location (F-1 OPT constraint),
seniority level, and posting date, then dedups against scan history + pipeline.

Usage: python3 scan_ats.py [--since YYYY-MM-DD]
Writes /tmp/scan_candidates.json and prints a grouped summary.
"""
import json, re, sys, os, urllib.request, urllib.error, datetime, time

SINCE = "2026-05-10"  # cover the gap since last scan (2026-05-23) with margin
LINKEDIN = True       # also scrape LinkedIn guest job search (Webscrapper/); --no-linkedin to skip
for i, a in enumerate(sys.argv):
    if a == "--since" and i + 1 < len(sys.argv):
        SINCE = sys.argv[i + 1]
    if a == "--no-linkedin":
        LINKEDIN = False
SINCE_D = datetime.date.fromisoformat(SINCE)

# ---- company -> ATS map (slug). Pulled from portals.yml tracked_companies ----
GREENHOUSE = {
    "Anthropic": "anthropic", "Arize AI": "arizeai", "RunPod": "runpod",
    "PlanetScale": "planetscale", "Hightouch": "hightouch",
    "Vercel": "vercel", "Glean": "gleanwork",
    "Celonis": "celonis", "Verkada": "verkada", "Black Forest Labs": "blackforestlabs",
    "Wayve": "wayve", "PhysicsX": "physicsx", "Isomorphic Labs": "isomorphiclabs",
    "Stability AI": "stabilityai",
}
ASHBY = {
    "Cohere": "cohere", "Aleph Alpha": "AlephAlpha", "LangChain": "langchain",
    "Pinecone": "pinecone", "WorkOS": "workos", "Supabase": "supabase",
    "Perplexity": "perplexity", "n8n": "n8n",
}
LEVER = {"Mistral AI": "mistral", "Palantir": "palantir"}

# ---- title filter (mirrors portals.yml; substring, case-insensitive) ----
import subprocess
def load_portals_filter():
    try:
        import yaml
        cfg = yaml.safe_load(open("portals.yml"))
        tf = cfg["title_filter"]
        return tf["positive"], tf["negative"], tf.get("seniority_boost", [])
    except Exception as e:
        print(f"[warn] could not parse portals.yml ({e}); using inline fallback", file=sys.stderr)
        return ([], [], [])
POS, NEG, BOOST = load_portals_filter()
POS_L = [p.lower() for p in POS]
NEG_L = [n.lower() for n in NEG]

NEWGRAD = ["new grad", "new college grad", "university grad", "university graduate",
           "entry level", "entry-level", "early career", "early-career", "intern",
           "internship", "associate", "junior", "graduate", "campus", "apprentice",
           "rotational", "co-op", "recent grad", "2026", "2025"]
SENIOR = ["senior", "sr.", "sr ", "staff", "principal", " lead", "lead ", "manager",
          "director", "head of", "distinguished", "architect", " iii", " iv", " ii "]

US_STATES = {"AL","AK","AZ","AR","CA","CO","CT","DE","FL","GA","HI","ID","IL","IN","IA",
"KS","KY","LA","ME","MD","MA","MI","MN","MS","MO","MT","NE","NV","NH","NJ","NM","NY","NC",
"ND","OH","OK","OR","PA","RI","SC","SD","TN","TX","UT","VT","VA","WA","WV","WI","WY","DC"}
NONUS = ["united kingdom"," uk","london","england","scotland","ireland","dublin"," ie",
"france","paris","germany","munich","berlin","frankfurt","heidelberg","freiburg","aachen",
"spain","madrid","barcelona","netherlands","amsterdam","belgium","brussels","switzerland",
"zurich","lausanne","geneva","italy","sweden","stockholm","poland","portugal","lisbon",
"canada","toronto","ontario","vancouver","montreal"," can","india","bangalore","bengaluru",
"hyderabad","pune","japan","tokyo","singapore","australia","sydney","melbourne","israel",
"tel aviv","china","shanghai","beijing","korea","seoul","brazil","mexico","apac","emea",
"latam","abu dhabi","dubai","uae","norway","denmark","finland","austria","vienna","greece"]

def fetch(url, timeout=25):
    req = urllib.request.Request(url, headers={"User-Agent": "career-ops-scan/1.0"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8", "replace"))

def title_ok(t):
    tl = t.lower()
    if not any(p in tl for p in POS_L):
        return False
    if any(n in tl for n in NEG_L):
        return False
    return True

def level_of(t):
    tl = " " + t.lower() + " "
    ng = any(k in tl for k in NEWGRAD)
    sr = any(k in tl for k in SENIOR)
    if ng:
        return "newgrad"
    if sr:
        return "senior"
    return "unmarked"

def us_status(loc):
    if not loc:
        return "?"
    ll = loc.lower()
    has_us = ("united states" in ll or "usa" in ll or "u.s." in ll or
              "remote - us" in ll or "remote, us" in ll or "us remote" in ll or
              "remote-friendly, united states" in ll)
    # state-code segments
    for seg in re.split(r"[;|/]", loc):
        m = re.findall(r",\s*([A-Z]{2})\b", seg)
        if any(c in US_STATES for c in m):
            has_us = True
    has_nonus = any(k in ll for k in NONUS)
    remote = "remote" in ll
    if has_us and has_nonus: return "US+intl"
    if has_us: return "US"
    if has_nonus: return "non-US"
    if remote: return "Remote?"
    return "?"

def parse_date(s):
    if not s: return None
    try:
        return datetime.date.fromisoformat(s[:10])
    except Exception:
        return None

# ---- dedup set ----
seen_urls, seen_ids = set(), set()
def add_seen(text):
    for u in re.findall(r"https?://[^\s|)<>]+", text):
        seen_urls.add(u.rstrip("/").lower())
    for jid in re.findall(r"/jobs/(\d+)", text):
        seen_ids.add(jid)
    for jid in re.findall(r"gh_jid=(\d+)", text):
        seen_ids.add(jid)
    for jid in re.findall(r"linkedin\.com/jobs/view/[\w-]*?(\d{6,})", text):
        seen_ids.add(jid)
    for uuid in re.findall(r"/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})", text):
        seen_ids.add(uuid)
for fn in ["data/scan-history.tsv", "data/pipeline.md", "data/applications.md"]:
    try:
        add_seen(open(fn, encoding="utf-8").read())
    except FileNotFoundError:
        pass

def is_dup(url, jid):
    if url and url.rstrip("/").lower() in seen_urls: return True
    if jid and str(jid) in seen_ids: return True
    return False

# ---- collect ----
cands, stats = [], {"fetched":0,"errors":[],"title_skip":0,"nonus_skip":0,"date_skip":0,"dup_skip":0,"backlog":0,"linkedin_raw":0}

def consider(company, title, url, loc, date, jid, portal):
    if not title_ok(title):
        stats["title_skip"] += 1; return
    st = us_status(loc)
    if st == "non-US":
        stats["nonus_skip"] += 1; return
    if is_dup(url, jid):
        stats["dup_skip"] += 1; return
    d = parse_date(date)
    if d and d < SINCE_D:
        stats["backlog"] += 1; stats["date_skip"] += 1; return
    cands.append({"company":company,"title":title.strip(),"url":url,"location":loc or "",
                  "us":st,"level":level_of(title),"posted":(d.isoformat() if d else ""),
                  "portal":portal})

for company, slug in GREENHOUSE.items():
    try:
        data = fetch(f"https://boards-api.greenhouse.io/v1/boards/{slug}/jobs")
        stats["fetched"] += 1
        for j in data.get("jobs", []):
            consider(company, j.get("title",""), j.get("absolute_url",""),
                     (j.get("location") or {}).get("name",""),
                     j.get("first_published") or j.get("updated_at"),
                     j.get("id"), "Greenhouse")
    except Exception as e:
        stats["errors"].append(f"GH {company}: {e}")
    time.sleep(0.2)

for company, slug in ASHBY.items():
    try:
        data = fetch(f"https://api.ashbyhq.com/posting-api/job-board/{slug}")
        stats["fetched"] += 1
        for j in data.get("jobs", []):
            if j.get("isListed") is False: continue
            consider(company, j.get("title",""), j.get("jobUrl",""),
                     j.get("location",""), j.get("publishedAt") or j.get("updatedAt"),
                     j.get("id"), "Ashby")
    except Exception as e:
        stats["errors"].append(f"Ashby {company}: {e}")
    time.sleep(0.2)

for company, slug in LEVER.items():
    try:
        data = fetch(f"https://api.lever.co/v0/postings/{slug}?mode=json")
        stats["fetched"] += 1
        for j in data:
            cat = j.get("categories") or {}
            ts = j.get("createdAt")
            ds = datetime.date.fromtimestamp(ts/1000).isoformat() if ts else None
            consider(company, j.get("text",""), j.get("hostedUrl",""),
                     cat.get("location",""), ds, j.get("id"), "Lever")
    except Exception as e:
        stats["errors"].append(f"Lever {company}: {e}")
    time.sleep(0.2)

# ---- LinkedIn (guest job search via Webscrapper/) ----
# Runs as part of every scan: scrapes LinkedIn, then feeds each card through the
# same consider() pipeline (title_filter, US-location, seniority, date, dedup) so
# LinkedIn jobs land in the same candidate pool the pipeline mode evaluates.
def linkedin_jid(url):
    m = re.search(r"/jobs/view/[\w-]*?(\d{6,})", url or "")
    return m.group(1) if m else None

def scan_linkedin():
    here = os.path.dirname(os.path.abspath(__file__))
    ws_dir = os.path.join(here, "Webscrapper")
    cfg_path = os.path.join(ws_dir, "config.json")
    if not os.path.exists(cfg_path):
        stats["errors"].append("LinkedIn: Webscrapper/config.json not found")
        return
    sys.path.insert(0, ws_dir)
    try:
        import webscrapper as ws
    except ImportError as e:
        stats["errors"].append(f"LinkedIn skipped: {e} "
                               "(run: python3 -m pip install --user beautifulsoup4 requests)")
        return
    try:
        cfg = ws.load_config(cfg_path)
        cards = ws.scrape_cards(cfg)
        stats["fetched"] += 1
        stats["linkedin_raw"] = len(cards)
        for j in cards:
            url = j.get("job_url", "")
            consider(j.get("company", ""), j.get("title", ""), url,
                     j.get("location", ""), j.get("date", ""),
                     linkedin_jid(url), "LinkedIn")
    except Exception as e:
        stats["errors"].append(f"LinkedIn: {e}")

if LINKEDIN:
    scan_linkedin()

# ---- output ----
order = {"newgrad":0,"unmarked":1,"senior":2}
cands.sort(key=lambda c: (order.get(c["level"],3), c["company"], c["posted"]), reverse=False)
json.dump(cands, open("/tmp/scan_candidates.json","w"), indent=2)

print(f"\n{'='*72}\nATS SCAN  —  since {SINCE}  —  {datetime.date.today()}")
print(f"{'='*72}")
print(f"Boards fetched OK : {stats['fetched']}/{len(GREENHOUSE)+len(ASHBY)+len(LEVER)+(1 if LINKEDIN else 0)}"
      + (f"  (incl. LinkedIn: {stats['linkedin_raw']} cards scraped)" if LINKEDIN else ""))
print(f"Title-filtered out: {stats['title_skip']}")
print(f"Non-US dropped    : {stats['nonus_skip']}")
print(f"Already seen (dup): {stats['dup_skip']}")
print(f"Older than window : {stats['backlog']}  (matched title+US but posted before {SINCE})")
print(f"NEW CANDIDATES    : {len(cands)}")
if stats["errors"]:
    print(f"\nBoard errors ({len(stats['errors'])}):")
    for e in stats["errors"]: print("  -", e)

def show(bucket, label):
    rows = [c for c in cands if c["level"] == bucket]
    if not rows: return
    print(f"\n{'-'*72}\n{label}  ({len(rows)})\n{'-'*72}")
    cur = None
    for c in rows:
        if c["company"] != cur:
            cur = c["company"]; print(f"\n{cur}")
        print(f"  [{c['us']:7}] {c['posted'] or '????-??-??'}  {c['title']}")
        print(f"            {c['url']}")
show("newgrad", "NEW-GRAD / ENTRY / INTERN  (top priority)")
show("unmarked", "UNMARKED LEVEL  (IC roles, no level in title — verify YoE in JD)")
show("senior", "SENIOR-GATED  (likely blocked for new grad — listed for awareness)")
print()
