"""
Greenhouse fill via your Playwright MCP. Deterministic, no LLM.

  python greenhouse_fill_mcp.py https://job-boards.greenhouse.io/togetherai/jobs/5199554007 togetherai-swe

Reads schema/{slug}.json (from greenhouse_jd.py) and plans/{slug}.json
(field_key -> value, from your deterministic mapping step). Drives the MCP to
fill the inline form.
Never submits: it stops at a filled form for your Discord approval gate.
"""
import sys, json, asyncio
from ats_common import (SERVER, MCPFiller, load_fields, slug_inputs, require_mcp,
                        ClientSession, stdio_client, FILE)


async def main(apply_url, slug):
    require_mcp()
    schema_path, plan_path = slug_inputs(slug)
    fields = load_fields(schema_path)
    plan = json.load(open(plan_path))

    async with stdio_client(SERVER) as (r, w):
        async with ClientSession(r, w) as s:
            await s.initialize()
            f = MCPFiller(s)
            await f.navigate(apply_url)          # form is inline on the job page

            # Resume FIRST: Greenhouse parses it and autofills name/email a beat
            # later, which would clobber values written before the parse lands.
            for fld in sorted(fields, key=lambda x: x.kind != FILE):
                how = await f.fill_field(fld, plan.get(fld.key))
                print(f"  {fld.key:<18} {how}")

            missing = [fld.label for fld in fields
                       if fld.required and not plan.get(fld.key)]
            print("UNFILLED REQUIRED:", missing or "none")
            print("form filled. screenshot -> Discord. submit only after approval.")


if __name__ == "__main__":
    if len(sys.argv) < 3:
        raise SystemExit("usage: greenhouse_fill_mcp.py <url> <slug>")
    asyncio.run(main(sys.argv[1], sys.argv[2]))
