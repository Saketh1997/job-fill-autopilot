"""
Ashby fill via your Playwright MCP. Deterministic, no LLM.

  python ashby_fill_mcp.py https://jobs.ashbyhq.com/ramp/uuid ramp-swe

Ashby's posting page hides the form behind an Apply button, and its selects
are custom React comboboxes (the engine's fill_select opens-and-picks by
option text). Reads schema/{slug}.json + plans/{slug}.json. Never submits.
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
            await f.navigate(apply_url)

            # Reveal the application form.
            if await f.click_text("Apply for this Job") or await f.click_text("Apply"):
                await f.wait(800)

            # If the public API couldn't read the form, it left a page marker.
            if any(fld.source == "page" for fld in fields):
                await f.snapshot()
                print("!! form not in API; snapshot taken. custom fields need a "
                      "discovery pass before this can fill them deterministically.")

            for fld in sorted(fields, key=lambda x: x.kind != FILE):
                if fld.source == "page":
                    continue
                how = await f.fill_field(fld, plan.get(fld.key))
                print(f"  {fld.key:<28} {how}")

            missing = [fld.label for fld in fields
                       if fld.required and fld.source == "api"
                       and not plan.get(fld.key)]
            print("UNFILLED REQUIRED:", missing or "none")
            print("form filled. screenshot -> Discord. submit only after approval.")


if __name__ == "__main__":
    if len(sys.argv) < 3:
        raise SystemExit("usage: ashby_fill_mcp.py <url> <slug>")
    asyncio.run(main(sys.argv[1], sys.argv[2]))
