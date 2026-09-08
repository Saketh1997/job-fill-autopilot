"""
Shared across all six files.

  Field        normalized field, ATS-agnostic. Fetch files emit these.
  dump/load    schema.json IO
  MCPFiller    async client that drives your Playwright MCP to fill a form

Wired to YOUR server: Microsoft @playwright/mcp over CDP to the shared Chrome.
Endpoint comes from CDP_ENDPOINT, default http://localhost:9226 (the port
job-browser.service binds; 9222 is NOT it — see Job_applicator/CLAUDE.md).
That server is SNAPSHOT-BASED: snapshot once -> refs -> act with {element,ref}.
No browser_find. The fill is deterministic: no Claude Code, no LLM tokens, and
because no model reads the snapshot, the snapshot is free here.

PRECONDITION: Chrome must already be running with remote debugging, e.g.
  google-chrome --remote-debugging-port=9222 --user-data-dir=/home/hunter/.chrome-mcp
"""

from __future__ import annotations
from dataclasses import dataclass, asdict, field as dcfield
import os, re, json

# ---------- normalized field vocabulary ----------
TEXT, TEXTAREA, SELECT, MULTISELECT, FILE, TYPEAHEAD = (
    "TEXT", "TEXTAREA", "SELECT", "MULTISELECT", "FILE", "TYPEAHEAD")


@dataclass
class Field:
    key: str
    kind: str
    label: str
    required: bool = False
    options: list = dcfield(default_factory=list)
    source: str = "api"


def dump_fields(fields, path):
    json.dump([asdict(f) for f in fields], open(path, "w"), indent=2)


def load_fields(path):
    return [Field(**d) for d in json.load(open(path))]


# ---------- per-slug output paths ----------
_BASE = os.path.dirname(os.path.abspath(__file__))


# ---------- HTTP ----------
# Ashby's posting API 403s the default "Python-urllib/3.x" User-Agent, so every
# fetcher goes through this. An honest identifying UA, not a spoofed browser.
USER_AGENT = "career-ops-jobapp/1.0 (+https://sakethmetta.org)"


def fetch_json(url, timeout=15):
    import urllib.request
    req = urllib.request.Request(
        url, headers={"User-Agent": USER_AGENT, "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.load(r)


def _clean_slug(slug):
    """A slug is a bare name. Anything path-like is rejected, so a posting id
    can never read or write outside the per-slug directories."""
    slug = (slug or "").strip()
    if not slug or slug != os.path.basename(slug) or slug in (".", ".."):
        raise SystemExit(f"bad slug: {slug!r}")
    return slug


def slug_paths(slug):
    """Write side: (schema/{slug}.json, jd/{slug}.html), parent dirs created.

    The jd/ path is legacy: JD text is owned by stage 1 (../jd_extract.py, which
    writes jd/{slug}.txt). The *_jd.py fetchers write the schema only.
    """
    slug = _clean_slug(slug)
    schema_dir, jd_dir = os.path.join(_BASE, "schema"), os.path.join(_BASE, "jd")
    os.makedirs(schema_dir, exist_ok=True)
    os.makedirs(jd_dir, exist_ok=True)
    return os.path.join(schema_dir, slug + ".json"), os.path.join(jd_dir, slug + ".html")


def slug_inputs(slug):
    """Read side for the fill step: (schema_path, plan_path).

    Schema is whatever the matching *_jd.py fetcher wrote. The plan is
    plans/{slug}.json, falling back to a bare plan.json so a pre-slug
    single-application workflow keeps working. Both must exist.
    """
    slug = _clean_slug(slug)
    schema_path = os.path.join(_BASE, "schema", slug + ".json")
    plan_path = os.path.join(_BASE, "plans", slug + ".json")
    if not os.path.exists(plan_path) and os.path.exists(os.path.join(_BASE, "plan.json")):
        plan_path = os.path.join(_BASE, "plan.json")
    if not os.path.exists(schema_path):
        raise SystemExit(f"no schema at {schema_path} "
                         f"-- run the matching *_jd.py fetcher with slug {slug!r} first")
    if not os.path.exists(plan_path):
        raise SystemExit(f"no plan at {plan_path}")
    return schema_path, plan_path


# ================================================================
# ADAPTER  --  matched to @playwright/mcp (your mcp.json)
# ================================================================
# Optional import: only the fill step drives the browser. The JD fetchers and
# the planning step import Field/dump_fields/slug_paths from this module and
# must keep working on a machine with no mcp package installed.
try:
    from mcp import ClientSession, StdioServerParameters      # noqa: E402
    from mcp.client.stdio import stdio_client                 # noqa: E402
    HAVE_MCP = True
except ImportError:                                           # pragma: no cover
    ClientSession = stdio_client = StdioServerParameters = None
    HAVE_MCP = False

_NODE20_BIN = "/home/hunter/.nvm/versions/node/v20.20.2/bin"
SERVER = StdioServerParameters(
    # Run node20 directly and hand it the mcp script. No shebang, no PATH
    # lookup, so the system Node 18 can never be picked up.
    command=_NODE20_BIN + "/node",
    args=[_NODE20_BIN + "/playwright-mcp",
          "--cdp-endpoint", os.environ.get("CDP_ENDPOINT",
                                           "http://localhost:9226"),
          # playwright-mcp's action timeout defaults to 5000ms. LinkedIn's
          # invite dialog is an Ember component that re-renders between the
          # snapshot and the click, so the locator resolves but stays
          # unactionable past 5s and the tool call is rejected. That burns an
          # outreach draft outright (linkedin_send.py gets ONE attempt and
          # writes status=failed on any ambiguity), so the budget is raised.
          # Costs nothing on a healthy click -- it only bounds the failure.
          "--timeout-action", os.environ.get("MCP_ACTION_TIMEOUT", "20000")],
    env={**os.environ, "PATH": _NODE20_BIN + ":" + os.environ.get("PATH", "")},
) if HAVE_MCP else None


def require_mcp():
    """Fail loudly at the start of a fill run rather than deep inside it."""
    if not HAVE_MCP:
        raise SystemExit("the fill step needs the mcp package: pip install mcp")

# Real @playwright/mcp tool names.
TOOL = {
    "navigate": "browser_navigate",        # {url}
    "snapshot": "browser_snapshot",        # {}  -> a11y tree w/ [ref=eNN]
    "click":    "browser_click",           # {element, target}
    "type":     "browser_type",            # {element, target, text}
    "select":   "browser_select_option",   # {element, target, values[]}
    "upload":   "browser_file_upload",     # {paths[]}  (needs open file chooser)
    "wait":     "browser_wait_for",        # {time}  seconds
}

# roles emitted in the snapshot for each normalized kind
ROLES = {
    TEXT: {"textbox"}, TEXTAREA: {"textbox"},
    SELECT: {"combobox", "listbox"}, MULTISELECT: {"combobox", "listbox"},
    TYPEAHEAD: {"textbox", "combobox"},
}

# snapshot line:  - textbox "First Name*" [ref=e34]
_LINE = regex = re.compile(r'([a-zA-Z][\w-]*)\s+"((?:[^"\\]|\\.)*)"\s*\[ref=([a-zA-Z0-9]+)\]')


def text_of(result) -> str:
    return "\n".join(getattr(b, "text", "") or "" for b in getattr(result, "content", []))


def parse_snapshot(txt: str):
    """-> list of (role, accessible_name, ref)."""
    return [(m.group(1), m.group(2), m.group(3)) for m in _LINE.finditer(txt)]


def _norm(s: str) -> str:
    return s.lower().rstrip("*").strip()


def best_match(snap, label, roles=None):
    """Pick the snapshot entry whose name best matches label (+ optional roles)."""
    t = _norm(label)
    best, best_score = None, 99
    for role, name, ref in snap:
        if roles and role not in roles:
            continue
        n = _norm(name)
        if n == t:
            score = 0
        elif n.startswith(t) or t.startswith(n):
            score = 1
        elif t in n or n in t:
            score = 2
        else:
            continue
        # tie-break toward the shortest name (avoids "First" matching "Preferred First")
        score = (score, len(n))
        if score < (best_score if isinstance(best_score, tuple) else (best_score, 0)):
            best, best_score = (role, name, ref), score
    return best
# ================================================================
# END ADAPTER
# ================================================================


class MCPToolError(RuntimeError):
    """A playwright-mcp tool call came back with isError set."""


class MCPFiller:
    """Deterministic snapshot-based fill. One instance per application."""

    def __init__(self, session: ClientSession):
        self.s = session
        self._snap = None            # cached parsed snapshot

    async def _call(self, key, args):
        # call_tool does NOT raise on a tool-side failure — it comes back as a
        # result with isError set. Swallowing that made every fill print as a
        # success while the form stayed empty, which is the worst possible
        # failure mode here: a "filled" report on a blank application.
        res = await self.s.call_tool(TOOL[key], args)
        body = text_of(res)
        # isError is NOT set for an argument-schema rejection: it arrives as an
        # ordinary result whose body starts "### Error". Checking only isError
        # let those through, so a renamed argument (ref -> target, 2026-08-22)
        # turned every click and fill into a silent no-op that still reported
        # success -- exactly the blank-application failure this guard exists
        # to prevent. Both forms must be treated as failures.
        if getattr(res, "isError", False) or body.lstrip().startswith("### Error"):
            raise MCPToolError(f"{TOOL[key]} failed: {' '.join(body.split())[:400]}")
        return res

    # ---- navigation / snapshot cache ----
    async def navigate(self, url):
        await self._call("navigate", {"url": url})
        self._snap = None            # DOM changed, invalidate

    async def snapshot(self):
        self._snap = parse_snapshot(text_of(await self._call("snapshot", {})))
        return self._snap

    async def _refresh(self):
        if self._snap is None:
            await self.snapshot()

    async def wait(self, ms=600):
        try:
            await self._call("wait", {"time": ms / 1000})
        except Exception:
            pass

    async def locate(self, label, roles=None):
        await self._refresh()
        return best_match(self._snap, label, roles)

    async def click_text(self, label) -> bool:
        m = await self.locate(label, roles={"button", "link"})
        if not m:
            m = await self.locate(label)          # any role
        if m:
            await self._call("click", {"element": m[1], "target": m[2]})
            self._snap = None                     # click may change the DOM
        return bool(m)

    # ---- type-dispatched recipes ----
    async def fill_text(self, label, value):
        m = await self.locate(label, ROLES[TEXT])
        if m:
            await self._call("type", {"element": m[1], "target": m[2], "text": value})
        return m

    async def fill_select(self, label, value):
        m = await self.locate(label, ROLES[SELECT]) or await self.locate(label)
        if not m:
            return None
        try:                                       # native <select>
            await self._call("select", {"element": m[1], "target": m[2], "values": [value]})
            return m
        except Exception:
            pass
        await self._call("click", {"element": m[1], "target": m[2]})   # open combobox
        await self.snapshot()                                       # options appear
        opt = await self.locate(value, roles={"option"})
        if opt:
            await self._call("click", {"element": opt[1], "target": opt[2]})
            self._snap = None
        return m

    async def fill_typeahead(self, label, value):
        m = await self.locate(label, ROLES[TYPEAHEAD])
        if not m:
            return None
        await self._call("type", {"element": m[1], "target": m[2], "text": value})
        await self.wait(700)                       # geocode debounce
        await self.snapshot()
        opt = await self.locate(value.split(",")[0], roles={"option"})
        if opt:
            await self._call("click", {"element": opt[1], "target": opt[2]})
            self._snap = None
        return m

    async def fill_file(self, label, path):
        # @playwright/mcp uploads to an OPEN file chooser. Click the field's
        # attach control to open it, then upload. Resume parsing autofills
        # other fields a beat later, so callers run this FIRST.
        m = (await self.locate("Attach", roles={"button"})
             or await self.locate(label))
        if m:
            await self._call("click", {"element": m[1], "target": m[2]})
            await self.wait(400)
        await self._call("upload", {"paths": [path]})
        await self.wait(2500)
        self._snap = None

    async def fill_field(self, f: Field, value):
        """-> a status string. One field's failure never aborts the others, but
        it is reported as ERROR / not-found rather than as a fill."""
        if value is None:
            return "skip"
        try:
            if f.kind == FILE:
                await self.fill_file(f.label, value)
                return "file"
            if f.kind == TYPEAHEAD:
                return "typeahead" if await self.fill_typeahead(f.label, value) \
                    else "NOT FOUND"
            if f.kind in (SELECT, MULTISELECT):
                return "select" if await self.fill_select(f.label, value) \
                    else "NOT FOUND"
            return "text" if await self.fill_text(f.label, value) else "NOT FOUND"
        except MCPToolError as e:
            return f"ERROR {e}"