"""
LinkedIn apply triage over your Playwright MCP (Chrome :9222).

Rule: click Apply ONLY if it is the external redirect button, not Easy Apply.
  - Easy Apply  -> stays in LinkedIn's own flow. Skip here.
  - Apply       -> opens the company's ATS. Click, print the landed URL.

  python linkedin_apply.py [https://www.linkedin.com/jobs/view/1234567890]

On failure it prints the page URL and every button/link it actually saw, so
you can tell a login wall or wrong page from a classifier miss.
Never submits; it only opens the external application page.
"""
import sys, re, asyncio
from mcp import ClientSession
from mcp.client.stdio import stdio_client
from ats_common import SERVER, text_of, parse_snapshot

APPLY_ROLES = {"button", "link"}
TAB_TOOL = "browser_tabs"


def norm(s): return s.lower().strip()


def page_url(txt):
    m = re.search(r"Page URL:\s*(\S+)", txt or "")
    return m.group(1) if m else None


def find_apply(snap):
    """Return ('external'|'easy'|None, entry). Prefer an external Apply."""
    applies = [(role, name, ref) for role, name, ref in snap
               if role in APPLY_ROLES and "apply" in norm(name)]
    external = [e for e in applies if "easy apply" not in norm(e[1])]
    easy     = [e for e in applies if "easy apply" in norm(e[1])]
    if external:
        return "external", min(external, key=lambda e: len(e[1]))
    if easy:
        return "easy", easy[0]
    return None, None


def diagnose(raw):
    url = page_url(raw)
    print("NO_APPLY_BUTTON")
    print("  page:", url)
    low = (url or "").lower()
    if any(w in low for w in ("authwall", "login", "signup", "/uas/")):
        print("  -> this Chrome is NOT logged into LinkedIn. Log into the "
              ":9222 profile once, then rerun.")
    seen = [f'{role} "{name}"' for role, name, _ in parse_snapshot(raw)
            if role in APPLY_ROLES]
    print(f"  buttons/links seen ({len(seen)}):")
    for s in seen[:20]:
        print("   ", s)


async def resolve_landed_url(session, click_result):
    url = page_url(text_of(click_result))
    if url and "linkedin.com" not in url:
        return url
    try:
        listing = text_of(await session.call_tool(TAB_TOOL, {"action": "list"}))
        pairs = re.findall(r"(\d+)\s*:[^\n]*?(https?://\S+)", listing)
        ext = [(int(i), u.rstrip(")")) for i, u in pairs if "linkedin.com" not in u]
        if ext:
            idx, u = ext[-1]
            sel = await session.call_tool(TAB_TOOL, {"action": "select", "index": idx})
            return page_url(text_of(sel)) or u
    except Exception as e:
        print(f"  (tab handling unavailable: {e}; check the new tab manually)")
    return url


async def main(job_url=None):
    if job_url:
        job_url = job_url.strip()                     # kill stray newlines/spaces

    async with stdio_client(SERVER) as (r, w):
        async with ClientSession(r, w) as s:
            await s.initialize()

            if job_url:
                await s.call_tool("browser_navigate", {"url": job_url})

            kind = entry = None
            raw = ""
            for attempt in range(2):
                raw = text_of(await s.call_tool("browser_snapshot", {}))
                kind, entry = find_apply(parse_snapshot(raw))
                if kind:
                    break
                await s.call_tool("browser_wait_for", {"time": 1.5})

            if kind is None:
                diagnose(raw)
                return
            if kind == "easy":
                print(f"EASY_APPLY_SKIPPED ({entry[1]!r}) - handle in the LinkedIn flow")
                return

            role, name, ref = entry
            print(f"external apply: {name!r} [{ref}] - clicking")
            click_res = await s.call_tool("browser_click", {"target": str(ref)})

            landed = await resolve_landed_url(s, click_res)
            if landed and "linkedin.com" not in landed:
                print(f"EXTERNAL_URL={landed}")
            else:
                print("CLICKED but could not confirm external URL; check the new tab")


if __name__ == "__main__":
    asyncio.run(main(sys.argv[1] if len(sys.argv) > 1 else None))