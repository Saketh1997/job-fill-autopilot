"""
Lever fill via your Playwright MCP. Deterministic, no LLM.

  python lever_fill_mcp.py https://jobs.lever.co/company/uuid company-swe

Reads schema/{slug}.json + plans/{slug}.json.
Lever's form lives at /apply. Standard fields fill deterministically. Custom
questions that Lever's JSON didn't expose are marked source="page"; this does
a snapshot so they surface, but filling them reliably is the one spot where a
discovery pass (or the vision fallback) may be needed. Never submits.
"""
import sys, json, asyncio
from ats_common import (SERVER, MCPFiller, load_fields, slug_inputs, require_mcp,
                        ClientSession, stdio_client, FILE)


def apply_url(url):
    return url.rstrip("/") + "/apply" if not url.rstrip("/").endswith("apply") else url


async def main(url, slug):
    require_mcp()
    schema_path, plan_path = slug_inputs(slug)
    fields = load_fields(schema_path)
    plan = json.load(open(plan_path))

    async with stdio_client(SERVER) as (r, w):
        async with ClientSession(r, w) as s:
            await s.initialize()
            f = MCPFiller(s)
            await f.navigate(apply_url(url))

            for fld in sorted(fields, key=lambda x: x.kind != FILE):
                if fld.source == "page":
                    continue
                how = await f.fill_field(fld, plan.get(fld.key))
                print(f"  {fld.key:<22} {how}")

            # Surface any custom questions the API hid, so nothing submits blank.
            if any(fld.source == "page" for fld in fields):
                await f.snapshot()
                print("!! custom questions not in Lever API. snapshot taken; "
                      "review before approval. these may need a discovery pass.")

            missing = [fld.label for fld in fields
                       if fld.required and fld.source == "api"
                       and not plan.get(fld.key)]
            print("UNFILLED REQUIRED:", missing or "none")
            print("form filled. screenshot -> Discord. submit only after approval.")


if __name__ == "__main__":
    if len(sys.argv) < 3:
        raise SystemExit("usage: lever_fill_mcp.py <url> <slug>")
    asyncio.run(main(sys.argv[1], sys.argv[2]))
