"""
linkedin_send.py -- send an approved LinkedIn outreach message. No model call:
deterministic browser mechanics only, over the same Playwright MCP / CDP
session linkedin_apply.py uses (CDP endpoint 9226 -- see Job_applicator/CLAUDE.md
"Browser" section, settled 2026-08-08. Do NOT default to 9222).

Two channels, chosen by the queue record's "channel" field (see CLAUDE.md
"InMail vs. connection note rules"):

  connect -- Connect -> "Add a note" -> <=300-char note -> Send. The default.
  inmail  -- Message -> Subject + Body as two distinct fields -> Send. Spends a
             finite Premium InMail credit, so it is reserved for a contact who
             is both an alumnus and in a position where a referral carries
             weight, and it NEVER silently falls back to a connection request:
             a credit send that cannot find its Subject field is a failure to
             report, not a cheaper message to send instead. Falling back would
             also burn the one connection request that channel gets, on text
             written for a different medium.

Hard gate: refuses unless data/linkedin-outreach-queue.json has this slug at
status "approved". This is enforced here, independent of whatever approval
layer (Discord + n8n) calls it -- a stray or malformed call can never send.
One attempt only: on any ambiguity or failure the entry moves to "failed" and
this script does NOT retry (same rule as job-application submission: one
retry max, never blind-loop on a form -- see memory feedback_no_double_retry).

  python3 linkedin_send.py <slug>

Exit: 0 sent · 1 blocked/error (see printed JSON "error" for why).
"""
import re, sys, asyncio
from mcp import ClientSession
from mcp.client.stdio import stdio_client
from ats_common import SERVER, text_of, parse_snapshot
import linkedin_queue as q

CLICKABLE = {"button", "link"}
TEXTISH = ("textbox", "textarea", "combobox")
DIALOG_ROLES = {"dialog", "alertdialog"}

# LinkedIn's global nav search ("Search", "I'm looking for...") is a combobox,
# and it sits AHEAD of any modal in the accessibility tree. An unfiltered
# find_textbox therefore returns the nav search rather than the invite dialog's
# textarea: the note gets typed into the nav, the search typeahead steals focus
# and dismisses the invite modal, and the next snapshot has no Send button --
# which surfaces as the misleading "typed the note but found no Send control".
NAV_TEXTBOXES = ("search", "looking for")
NOTE_BOXES = ("note", "invitation", "message")

# "Send profile in a message" lives in the profile's own More menu and contains
# the substring "send"; "Send without a note" would send the invite but DROP the
# personalised note, which is the entire point of the draft.
SEND_AVOID = ("profile", "without a note")

# The parsed snapshot is FLAT -- parse_snapshot throws the indentation away --
# so scoping has to be positional. LinkedIn puts a "More" in the global nav as
# well as in the profile top card, and a "Connect" button on every
# "People also viewed" card far down the page. Anchoring on the first control
# that names the profile owner drops the nav; a bounded window drops the
# sidebar. The windows are generous because non-control nodes share the list.
PROFILE_WINDOW = 40
MENU_WINDOW = 60

NOTE_MAX = 300      # LinkedIn's connection-note limit
SUBJECT_MAX = 200   # InMail subject
BODY_MAX = 1900     # InMail body


def norm(s):
    return (s or "").lower().strip()


def find_by_name(snap, *needles, roles=CLICKABLE, avoid=()):
    """First (role, name, ref) whose name contains any needle and no avoid word.

    `avoid` matters more here than anywhere else in this repo: LinkedIn's global
    nav carries a "Messaging" link on every page, and a naive "message" match
    picks it up and navigates away from the profile instead of opening compose.
    """
    for role, name, ref in snap:
        if role not in roles:
            continue
        n = norm(name)
        if any(a in n for a in avoid):
            continue
        if any(needle in n for needle in needles):
            return role, name, ref
    return None


def find_textbox(snap, *needles, avoid=()):
    """First text control, optionally restricted to one whose name matches.

    `avoid` exists for the same reason it does on find_by_name: LinkedIn's
    global nav carries a search combobox on every page, and it precedes any
    modal in the tree, so an unfiltered match lands there. See NAV_TEXTBOXES.
    """
    for role, name, ref in snap:
        if role not in TEXTISH:
            continue
        n = norm(name)
        if any(a in n for a in avoid):
            continue
        if not needles or any(x in n for x in needles):
            return role, name, ref
    return None


def has_dialog(snap):
    """True when a modal is open. Dialogs carry a [ref=], so parse_snapshot
    reports them like any other node."""
    return any(role in DIALOG_ROLES for role, _, _ in snap)


def dialog_scope(snap):
    """Entries from the first dialog onward, or None when no modal is open."""
    for i, (role, _name, _ref) in enumerate(snap):
        if role in DIALOG_ROLES:
            return snap[i:]
    return None


def custom_invite_url(profile_url):
    """LinkedIn's invite control is an <a href="/preload/custom-invite/...">,
    not a modal trigger. Clicking it under automation opens nothing, but
    navigating to it directly raises the "Add a note to your invitation?"
    dialog reliably. Derive it from the vanity name in the profile URL."""
    m = re.search(r"/in/([^/?#]+)", profile_url or "")
    if not m:
        return None
    return ("https://www.linkedin.com/preload/custom-invite/?vanityName=" + m.group(1))


def profile_scope(snap, contact_name, window=PROFILE_WINDOW):
    """The profile owner's own action area, or None when it cannot be located.

    Returning None rather than the whole snapshot is deliberate: an unscoped
    fallback is exactly the bug this exists to prevent.
    """
    who = norm(contact_name)
    if not who:
        return None
    for i, (_role, name, _ref) in enumerate(snap):
        if who in norm(name):
            return snap[i:i + window]
    return None


def textboxes(snap):
    return [(role, name, ref) for role, name, ref in snap if role in TEXTISH]


def controls_seen(snap, limit=20):
    return [f'{role} "{name}"' for role, name, _ in snap if role in CLICKABLE][:limit]


def fail(slug, error, **extra):
    q.set_status(slug, "failed", error=error)
    return {"sent": False, "slug": slug, "error": error, **extra}


class ToolError(RuntimeError):
    """A browser tool call was REJECTED. Previously these were discarded, so a
    rejected click was indistinguishable from a successful one -- which is how
    this script reported invitations as sent while never clicking anything."""


def _check(res, what):
    txt = text_of(res)
    if getattr(res, "isError", False) or txt.lstrip().startswith("### Error"):
        raise ToolError(f"{what}: {' '.join(txt.split())[:200]}")
    return txt


async def snapshot_raw(s):
    """Raw snapshot TEXT. Needed because parse_snapshot's line regex requires a
    quoted accessible name, and LinkedIn's modal renders as `dialog [active]
    [ref=..]` with no name -- so dialogs are invisible to the parsed form."""
    return text_of(await s.call_tool("browser_snapshot", {}))


async def snapshot(s):
    return parse_snapshot(await snapshot_raw(s))


def dialog_block(txt):
    """The raw sub-block of the first dialog, by indentation, or None."""
    lines = txt.splitlines()
    for i, ln in enumerate(lines):
        m = re.match(r"^(\s*)-\s+(?:dialog|alertdialog)\b", ln)
        if not m:
            continue
        indent = len(m.group(1))
        out = [ln]
        for nxt in lines[i + 1:]:
            if nxt.strip() and (len(nxt) - len(nxt.lstrip())) <= indent:
                break
            out.append(nxt)
        return "\n".join(out)
    return None


_RAW_NODE = re.compile(
    r'^\s*-\s+([a-zA-Z][\w-]*)(?:\s+"((?:[^"\\]|\\.)*)")?[^\n]*?\[ref=([A-Za-z0-9]+)\]')


def raw_nodes(block, roles):
    """(role, name, ref) for nodes in a raw block, INCLUDING unnamed ones.

    parse_snapshot only sees nodes with a quoted accessible name. LinkedIn's
    invite textarea has none, so the note composer looks empty to the parsed
    form even when it is open and focused.
    """
    out = []
    for ln in (block or "").splitlines():
        m = _RAW_NODE.match(ln)
        if m and m.group(1) in roles:
            out.append((m.group(1), m.group(2) or "", m.group(3)))
    return out


def raw_textbox(block, avoid=()):
    """First text control in the block, named or not, skipping `avoid` names."""
    for role, name, ref in raw_nodes(block, TEXTISH):
        if any(a in norm(name) for a in avoid):
            continue
        return role, name, ref
    return None


def dialog_entries(txt):
    """Parsed controls inside the open modal, or None when none is open."""
    blk = dialog_block(txt)
    return parse_snapshot(blk) if blk else None


async def click(s, hit, settle=1.0):
    # NOTE: this playwright-mcp names the argument `target`, not `ref`.
    _check(await s.call_tool("browser_click",
                             {"element": hit[1], "target": str(hit[2])}),
           f"click {hit[1]!r}")
    await s.call_tool("browser_wait_for", {"time": settle})


async def wait_for_dialog(s, tries=6, delay=1.2):
    """Return the first snapshot that shows a modal, or the last one tried.

    LinkedIn mounts the invite dialog asynchronously and it can take several
    seconds under Xvfb, so a single post-click settle is not enough: the
    snapshot comes back dialog-less and the note has nowhere safe to go.
    """
    raw = await snapshot_raw(s)
    for _ in range(tries):
        if dialog_block(raw) is not None:
            return raw
        await s.call_tool("browser_wait_for", {"time": delay})
        raw = await snapshot_raw(s)
    return raw


async def type_into(s, box, text, settle=0.5):
    _check(await s.call_tool("browser_type",
                             {"element": box[1], "target": str(box[2]), "text": text}),
           f"type into {box[1]!r}")
    await s.call_tool("browser_wait_for", {"time": settle})


async def send_inmail(s, slug, rec, snap):
    """Message -> Subject + Body -> Send. No fallback to Connect, by design."""
    subject = (rec.get("inmail_subject") or "").strip()
    body = (rec.get("inmail_body") or "").strip()

    hit = find_by_name(snap, "message", avoid=("messaging", "message requests"))
    if not hit:
        # A profile with no Message button means no InMail is on offer here
        # (out of credits, or the member does not accept them). Report it --
        # the drafted InMail can be re-approved as a connect note by a human.
        return fail(slug, "no Message control on the profile -- InMail unavailable "
                          "(out of credits, or this member does not accept InMail); "
                          "not falling back to Connect",
                    seen=controls_seen(snap))
    await click(s, hit, settle=1.5)
    snap = await snapshot(s)

    subject_box = find_textbox(snap, "subject")
    if not subject_box:
        return fail(slug, "compose opened but no Subject field -- this is a regular "
                          "message box, not an InMail; refusing to spend the draft here",
                    seen=[f'{r} "{n}"' for r, n, _ in textboxes(snap)][:10])

    body_box = None
    for role, name, ref in textboxes(snap):
        if (role, name, ref) == subject_box:
            continue
        if any(k in norm(name) for k in ("write a message", "message body", "type your message", "message")):
            body_box = (role, name, ref)
            break
    if body_box is None:
        rest = [b for b in textboxes(snap) if b != subject_box]
        body_box = rest[0] if rest else None
    if body_box is None:
        return fail(slug, "InMail compose has a Subject field but no body field")

    await type_into(s, subject_box, subject)
    await type_into(s, body_box, body)
    snap = await snapshot(s)

    send_btn = find_by_name(snap, "send")
    if not send_btn:
        return fail(slug, "InMail subject and body typed but no Send control found")
    await click(s, send_btn, settle=1.5)

    confirmation = (f"InMail sent: clicked {send_btn[1]!r} "
                    f"(subject {len(subject)} chars, body {len(body)} chars)")
    q.set_status(slug, "sent", confirmation=confirmation, channel_used="inmail")
    return {"sent": True, "slug": slug, "channel": "inmail",
            "confirmation": confirmation}


async def send_connect(s, slug, rec, snap):
    """Invite dialog -> Add a note -> <=300 chars -> Send -> CONFIRM 'Pending'.

    The invite is reached by navigating to /preload/custom-invite/ rather than
    by clicking the profile's Connect control: that control is an <a>, and
    clicking it under automation opens no dialog at all. Falls back to an open
    message thread when no invite dialog appears, which is the already-connected
    case. Every profile lookup is scoped -- unscoped substring matching is what
    made this report success while sending nothing.
    """
    message = (rec.get("message") or "").strip()
    who = rec.get("contact_name") or ""
    profile_url = rec.get("contact_profile_url") or ""
    mode = "connect"

    invite_url = custom_invite_url(profile_url)
    dlg = None
    if invite_url:
        await s.call_tool("browser_navigate", {"url": invite_url})
        raw = await wait_for_dialog(s)
        dlg = dialog_entries(raw)

    if dlg is not None:
        note = find_by_name(dlg, "add a note")
        if note:
            await click(s, note, settle=1.0)
            raw = await wait_for_dialog(s, tries=3)
            dlg = dialog_entries(raw) or dlg
        box = (find_textbox(dlg, *NOTE_BOXES, avoid=NAV_TEXTBOXES)
               or find_textbox(dlg, avoid=NAV_TEXTBOXES)
               or raw_textbox(dialog_block(raw), avoid=NAV_TEXTBOXES))
        if not box:
            return fail(slug, "invite dialog opened but no note textbox appeared",
                        seen=controls_seen(dlg))
        await type_into(s, box, message)
        raw = await snapshot_raw(s)
        dlg = dialog_entries(raw) or dlg
        send_btn = find_by_name(dlg, "send invitation", "send now", "send",
                                avoid=SEND_AVOID)
        if not send_btn:
            return fail(slug, "typed the note but found no Send control in the "
                              "invite dialog", seen=controls_seen(dlg))
    else:
        # No invite dialog: most likely already connected, so use the thread.
        await s.call_tool("browser_navigate", {"url": profile_url})
        await s.call_tool("browser_wait_for", {"time": 1.5})
        snap = await snapshot(s)
        scope = profile_scope(snap, who)
        if scope is None:
            return fail(slug, f"no invite dialog, and could not locate the profile "
                              f"action area for {who!r} -- refusing to click unscoped",
                        seen=controls_seen(snap))
        hit = find_by_name(scope, "message", avoid=("messaging", "message requests"))
        if not hit:
            return fail(slug, "no invite dialog and no Message control -- cannot send",
                        seen=controls_seen(scope))
        mode = "message"
        await click(s, hit, settle=1.5)
        raw = await snapshot_raw(s)
        snap = parse_snapshot(raw)
        mdlg = dialog_entries(raw)
        box = (find_textbox(mdlg or snap, *NOTE_BOXES, avoid=NAV_TEXTBOXES)
               or find_textbox(mdlg or snap, avoid=NAV_TEXTBOXES))
        if not box:
            return fail(slug, "no compose textbox after clicking Message",
                        seen=controls_seen(snap))
        await type_into(s, box, message)
        raw = await snapshot_raw(s)
        snap = parse_snapshot(raw)
        send_btn = find_by_name(dialog_entries(raw) or snap, "send", avoid=SEND_AVOID)
        if not send_btn:
            return fail(slug, "typed the message but found no Send control",
                        seen=controls_seen(snap))

    await click(s, send_btn, settle=2.0)

    # A click is not evidence. The old code wrote status "sent" purely because
    # it clicked something, which reported success for an invite that never
    # left. Re-read the profile and require the invitation to be visible.
    if mode == "connect":
        await s.call_tool("browser_navigate", {"url": profile_url})
        await s.call_tool("browser_wait_for", {"time": 2.5})
        snap = await snapshot(s)
        after = profile_scope(snap, who, window=MENU_WINDOW)
        if after is None:
            return fail(slug, f"clicked {send_btn[1]!r} but the profile could not be "
                              "re-read to confirm -- treat as UNSENT",
                        seen=controls_seen(snap))
        if not find_by_name(after, "pending"):
            return fail(slug, f"clicked {send_btn[1]!r} but the profile never showed "
                              "'Pending' -- invite NOT confirmed sent",
                        seen=controls_seen(after))
        confirmation = (f"clicked {send_btn[1]!r} via custom-invite dialog; "
                        "profile now shows 'Pending'")
    else:
        # No equivalent post-state exists for an open thread, so this one stays
        # click-confirmed only. Recorded honestly rather than implied.
        confirmation = f"clicked {send_btn[1]!r} via message flow (not independently verified)"

    q.set_status(slug, "sent", confirmation=confirmation, channel_used=mode)
    return {"sent": True, "slug": slug, "channel": mode, "confirmation": confirmation}


def validate(slug, rec):
    """Returns an error string, or None when the record is sendable."""
    if not rec:
        return "no queue entry -- run linkedin-draft.sh first"
    if rec.get("status") != "approved":
        return f"status is {rec.get('status')!r}, not 'approved' -- refusing to send"
    if not rec.get("contact_profile_url"):
        return "no contact_profile_url"

    channel = norm(rec.get("channel")) or "connect"
    if channel == "inmail":
        subject = (rec.get("inmail_subject") or "").strip()
        body = (rec.get("inmail_body") or "").strip()
        if not subject or len(subject) > SUBJECT_MAX:
            return f"inmail_subject invalid (len={len(subject)}, max {SUBJECT_MAX})"
        if not body or len(body) > BODY_MAX:
            return f"inmail_body invalid (len={len(body)}, max {BODY_MAX})"
    else:
        message = (rec.get("message") or "").strip()
        if not message or len(message) > NOTE_MAX:
            return f"message missing or over {NOTE_MAX} chars (len={len(message)})"
    return None


async def send(slug):
    rec = q.get(slug)
    err = validate(slug, rec)
    if err:
        # A record that was never sendable must not be marked failed on the
        # strength of a bad *call* -- only a record that reached the browser
        # and stopped there gets that. Status guards are reported, not written.
        if rec and rec.get("status") == "approved" and "status is" not in err:
            return fail(slug, err)
        return {"sent": False, "slug": slug, "error": err}

    channel = norm(rec.get("channel")) or "connect"
    url = rec["contact_profile_url"]

    async with stdio_client(SERVER) as (r, w):
        async with ClientSession(r, w) as s:
            await s.initialize()
            await s.call_tool("browser_navigate", {"url": url})
            await s.call_tool("browser_wait_for", {"time": 1.5})
            snap = await snapshot(s)

            try:
                if channel == "inmail":
                    return await send_inmail(s, slug, rec, snap)
                return await send_connect(s, slug, rec, snap)
            except ToolError as e:
                return fail(slug, f"browser tool rejected: {e}")


def main():
    if len(sys.argv) != 2:
        print('{"sent": false, "error": "usage: linkedin_send.py <slug>"}')
        sys.exit(2)
    slug = sys.argv[1]
    result = asyncio.run(send(slug))
    import json
    print(json.dumps(result))
    sys.exit(0 if result.get("sent") else 1)


if __name__ == "__main__":
    main()
