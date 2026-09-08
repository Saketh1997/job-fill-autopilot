#!/usr/bin/env python3
"""
linkedin_queue.py -- shared read/write for data/linkedin-outreach-queue.json.

One record per posting, keyed by slug (jd_extract.slugify(company, title) --
same slug used everywhere else in this pipeline: answers/{slug}.json,
schema/{slug}.json, jd/{slug}.txt).

Status lifecycle (one-way, no loops back):
  pending_approval -> approved  -> sent
                    -> rejected
  pending_approval -> needs_review   (drafted but no confident contact found;
                                       never auto-sendable)
  approved -> failed   (linkedin_send.py attempted and stopped; a human decides
                        whether to re-approve, not the script)

This file is the ONLY writer of data/linkedin-outreach-queue.json. Every write
goes through _atomic_save (tmp + os.replace), so a crash mid-write can't
corrupt the array the way a partial `jq` in-place edit could.

CLI (used by n8n and by the shell wrappers):
  python3 linkedin_queue.py ingest <draft_result.json>   # upsert from a draft
  python3 linkedin_queue.py approve <slug>
  python3 linkedin_queue.py reject  <slug> [--reason TEXT]
  python3 linkedin_queue.py mark-sent   <slug> --confirmation TEXT
  python3 linkedin_queue.py mark-failed <slug> --error TEXT
  python3 linkedin_queue.py followup <slug> --message TEXT [--channel dm]
                                        [--confirmation TEXT]
  python3 linkedin_queue.py get    <slug>                 # prints record or {}
  python3 linkedin_queue.py list   [--status STATUS]       # prints array
"""
from __future__ import annotations
import json, os, sys, tempfile, datetime, argparse

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
QUEUE_PATH = os.path.join(ROOT, "data", "linkedin-outreach-queue.json")

STATUSES = {"pending_approval", "needs_review", "approved", "rejected", "sent", "failed"}


def _now():
    return datetime.datetime.now().astimezone().isoformat(timespec="seconds")


def load():
    if not os.path.exists(QUEUE_PATH):
        return []
    with open(QUEUE_PATH, "r") as f:
        text = f.read().strip()
    return json.loads(text) if text else []


def _atomic_save(records):
    os.makedirs(os.path.dirname(QUEUE_PATH), exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(QUEUE_PATH), prefix=".linkedin-queue-")
    try:
        with os.fdopen(fd, "w") as f:
            json.dump(records, f, indent=2)
            f.write("\n")
        os.replace(tmp, QUEUE_PATH)
    except Exception:
        if os.path.exists(tmp):
            os.remove(tmp)
        raise


def find(records, slug):
    for r in records:
        if r.get("slug") == slug:
            return r
    return None


def get(slug):
    return find(load(), slug) or {}


def ingest(draft_path):
    """Upsert a queue entry from a draft-result JSON written by linkedin-draft.sh.

    A re-draft of the same slug replaces the old entry outright UNLESS that
    entry is already approved/sent -- a fresh draft must never silently
    resurrect something a human already acted on.
    """
    with open(draft_path, "r") as f:
        draft = json.load(f)
    slug = draft.get("slug")
    if not slug:
        raise SystemExit(f"draft at {draft_path} has no slug")

    records = load()
    existing = find(records, slug)
    if existing and existing.get("status") in ("approved", "sent"):
        print(json.dumps({
            "slug": slug, "skipped": True,
            "reason": f"existing entry is already {existing['status']}; re-draft ignored",
        }))
        return existing

    message = (draft.get("message") or "").strip()
    contact_url = (draft.get("contact_profile_url") or "").strip() or None

    # Channel (added 2026-08-21). InMail spends a finite Premium credit, so it
    # is earned, not requested: the contact has to be an OSU alumnus AND sit
    # somewhere a referral actually carries -- an engineer, manager or recruiter
    # on a team that can put a name forward. Anyone else gets the connection
    # note. A draft that claims "inmail" without both halves of the mail is
    # demoted here rather than failing later in front of the browser.
    channel = (draft.get("channel") or "").strip().lower()
    subject = (draft.get("inmail_subject") or "").strip()
    body = (draft.get("inmail_body") or "").strip()
    is_alumni = bool(draft.get("is_alumni"))
    referral_power = (draft.get("referral_power") or "").strip().lower()
    if channel not in ("inmail", "connect"):
        channel = "inmail" if (is_alumni and referral_power == "high" and subject and body) else "connect"
    if channel == "inmail" and not (is_alumni and subject and body):
        channel = "connect"

    sendable = bool(contact_url) and (bool(subject and body) if channel == "inmail" else bool(message))
    status = "pending_approval" if sendable else "needs_review"

    record = {
        "slug": slug,
        "company": draft.get("company", ""),
        "role": draft.get("role", ""),
        "jd_url": draft.get("jd_url", ""),
        "contact_name": draft.get("contact_name", ""),
        "contact_title": draft.get("contact_title", ""),
        "contact_type": draft.get("contact_type", ""),
        "contact_profile_url": contact_url,
        "channel": channel,
        "is_alumni": is_alumni,
        "alumni_evidence": draft.get("alumni_evidence", ""),
        "referral_power": referral_power,
        "referral_rationale": draft.get("referral_rationale", ""),
        # Added 2026-09-02 so an approver can see, on the record itself, WHAT was
        # asked and the evidence the contact still works there. Referrals are an
        # employee-to-employee favour, so asking a recruiter or a hiring manager for
        # one reads badly; and a note written to someone who has already left is worse
        # than sending nothing. Both are judgement calls a human should be able to
        # check before approving, without opening the raw draft file.
        "ask_used": draft.get("ask_used", ""),
        "current_employment_evidence": draft.get("current_employment_evidence", ""),
        "inmail_subject": subject,
        "inmail_body": body,
        "inmail_body_chars": len(body),
        # The connect note is kept even on an InMail record: it is what a human
        # re-approves the draft as when the InMail leg reports no credits.
        "message": message,
        "char_count": len(message),
        "alt_targets": draft.get("alt_targets", []),
        "status": status,
        "channel_used": None,
        "created_at": existing["created_at"] if existing else _now(),
        "updated_at": _now(),
        "sent_at": None,
        "error": None,
    }
    records = [r for r in records if r.get("slug") != slug] + [record]
    _atomic_save(records)
    return record


def set_status(slug, status, **fields):
    if status not in STATUSES:
        raise SystemExit(f"bad status {status!r}, must be one of {sorted(STATUSES)}")
    records = load()
    rec = find(records, slug)
    if rec is None:
        raise SystemExit(f"no queue entry for slug {slug!r} -- run linkedin-draft.sh first")
    rec["status"] = status
    rec["updated_at"] = _now()
    rec.update(fields)
    _atomic_save(records)
    return rec


def add_followup(slug, message, channel="dm", confirmation=""):
    """Append a post-acceptance message to a record's `followups` list.

    A follow-up is not a status change: the record stays `sent`, because the
    outreach it belongs to was already sent. It is appended rather than
    overwritten so a second follow-up can never erase the first.

    This exists because follow-up DMs have no send path of their own --
    linkedin_send.py does connect notes and InMail only -- so they get driven
    ad hoc, and an ad-hoc sender that forgets to write back leaves the record
    reading `followups: null` for someone who was in fact already messaged.
    That has happened (Jatin Gupta, 2026-08-24). Treat a null/empty followups
    field as UNKNOWN, never as proof that nobody was contacted; the LinkedIn
    message thread is the only authoritative check.
    """
    records = load()
    rec = find(records, slug)
    if rec is None:
        raise SystemExit(f"no queue entry for slug {slug!r}")
    if rec.get("status") != "sent":
        raise SystemExit(f"{slug!r} is {rec.get('status')!r}, not 'sent' -- "
                         "a follow-up only makes sense after the outreach went out")
    entry = {
        "sent_at": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
        "channel": channel,
        "chars": len(message),
        "message": message,
    }
    if confirmation:
        entry["confirmation"] = confirmation
    rec.setdefault("followups", None)
    if not isinstance(rec.get("followups"), list):
        rec["followups"] = []
    rec["followups"].append(entry)
    rec["updated_at"] = _now()
    _atomic_save(records)
    return rec


def main():
    p = argparse.ArgumentParser()
    sub = p.add_subparsers(dest="cmd", required=True)

    sp = sub.add_parser("ingest"); sp.add_argument("draft_path")
    sp = sub.add_parser("approve"); sp.add_argument("slug")
    sp = sub.add_parser("reject"); sp.add_argument("slug"); sp.add_argument("--reason", default="")
    sp = sub.add_parser("mark-sent"); sp.add_argument("slug"); sp.add_argument("--confirmation", default="")
    sp = sub.add_parser("mark-failed"); sp.add_argument("slug"); sp.add_argument("--error", default="")
    sp = sub.add_parser("followup"); sp.add_argument("slug")
    sp.add_argument("--message", required=True); sp.add_argument("--channel", default="dm")
    sp.add_argument("--confirmation", default="")
    sp = sub.add_parser("get"); sp.add_argument("slug")
    sp = sub.add_parser("list"); sp.add_argument("--status", default=None)

    args = p.parse_args()

    if args.cmd == "ingest":
        print(json.dumps(ingest(args.draft_path), indent=2))
    elif args.cmd == "approve":
        print(json.dumps(set_status(args.slug, "approved"), indent=2))
    elif args.cmd == "reject":
        print(json.dumps(set_status(args.slug, "rejected", error=args.reason or None), indent=2))
    elif args.cmd == "mark-sent":
        print(json.dumps(set_status(args.slug, "sent", sent_at=_now(),
                                     error=None, confirmation=args.confirmation), indent=2))
    elif args.cmd == "mark-failed":
        print(json.dumps(set_status(args.slug, "failed", error=args.error), indent=2))
    elif args.cmd == "followup":
        print(json.dumps(add_followup(args.slug, args.message, args.channel,
                                      args.confirmation), indent=2))
    elif args.cmd == "get":
        print(json.dumps(get(args.slug), indent=2))
    elif args.cmd == "list":
        records = load()
        if args.status:
            records = [r for r in records if r.get("status") == args.status]
        print(json.dumps(records, indent=2))


if __name__ == "__main__":
    main()
