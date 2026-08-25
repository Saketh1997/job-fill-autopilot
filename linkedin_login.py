#!/usr/bin/env python3
"""linkedin_login.py — capture a LinkedIn session cookie after a manual login.

LinkedIn only reveals an employer's apply URL to a logged-in session (the guest
job page hides it behind a sign-in modal), so `linkedin_apply.py` needs a
cookie. This script reads the cookies out of the Chrome that is already running
with --remote-debugging-port=9222, over CDP — `li_at` is httpOnly, so
`document.cookie` cannot see it — verifies them against a read-only API call,
and writes LINKEDIN_COOKIE to .env.

Nothing here logs in on the user's behalf or submits anything: the human does
the authentication in their own browser, this only picks up the result. The
probe is a read of the user's own session (`/voyager/api/me`); it applies to
nothing, saves nothing, and messages nobody.

Usage:
  .venv-jobspy/bin/python linkedin_login.py            # wait up to 10 min
  .venv-jobspy/bin/python linkedin_login.py --check    # test the stored cookie
  .venv-jobspy/bin/python linkedin_login.py --timeout 300
"""
import json
import os
import sys
import time
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import cdp_helper as cdp  # noqa: E402
import linkedin_apply as la  # noqa: E402

ENV_FILE = os.path.join(HERE, ".env")
LOGIN_URL = "https://www.linkedin.com/jobs/"
# Read-only: the identity behind the cookie. A logged-out session gets 401 here,
# which is exactly the distinction this script has to make.
PROBE_URL = "https://www.linkedin.com/voyager/api/me"


def probe(cookie):
    """(ok, who) — is this cookie an authenticated LinkedIn session?"""
    csrf = la.csrf_token(cookie)
    if not csrf:
        return False, None
    try:
        req = urllib.request.Request(PROBE_URL, headers={
            "Cookie": cookie, "csrf-token": csrf,
            "Accept": "application/vnd.linkedin.normalized+json+2.1",
            "x-restli-protocol-version": "2.0.0", "User-Agent": la.UA})
        with urllib.request.urlopen(req, timeout=25) as r:
            data = json.loads(r.read().decode("utf-8", "replace"))
    except Exception:
        return False, None
    me = data.get("data") or {}
    if not me.get("plainId"):
        return False, None
    mini = next((i for i in data.get("included") or []
                 if i.get("firstName")), {})
    name = " ".join(filter(None, [mini.get("firstName"), mini.get("lastName")]))
    return True, name or f"member {me['plainId']}"


def write_env(cookie):
    lines, replaced = [], False
    if os.path.exists(ENV_FILE):
        for line in open(ENV_FILE, encoding="utf-8"):
            if line.startswith("LINKEDIN_COOKIE="):
                lines.append(f"LINKEDIN_COOKIE={cookie}\n")
                replaced = True
            else:
                lines.append(line)
    if not replaced:
        if lines and not lines[-1].endswith("\n"):
            lines.append("\n")
        lines.append(f"LINKEDIN_COOKIE={cookie}\n")
    with open(ENV_FILE, "w", encoding="utf-8") as f:
        f.writelines(lines)
    os.chmod(ENV_FILE, 0o600)


def session_header(cookies):
    """The cookies Voyager authenticates on, as a request header.

    Only `COOKIE_KEYS` are kept — the jar holds ~28 tracking cookies that add
    nothing but length, and a shorter header keeps the .env line manageable.
    Cookie order follows the jar; LinkedIn does not care."""
    return "; ".join(f"{c['name']}={c['value']}" for c in cookies
                     if c["name"] in la.COOKIE_KEYS)


def main():
    args = sys.argv[1:]
    if "--check" in args:
        cookie = la.load_cookie()
        if not cookie:
            sys.exit("no LINKEDIN_COOKIE in .env — run this without --check first")
        ok, who = probe(cookie)
        print(f"stored cookie: {'VALID' if ok else 'REJECTED'}"
              + (f" ({who})" if ok else " — log in again to refresh it"))
        sys.exit(0 if ok else 1)

    timeout = 600
    if "--timeout" in args:
        timeout = int(args[args.index("--timeout") + 1])

    if not any("linkedin.com" in t.get("url", "") for t in cdp.pages()):
        cdp.open_url(LOGIN_URL)
    print(f"[linkedin-login] waiting up to {timeout}s for a logged-in session "
          f"in your Chrome window ({LOGIN_URL})", flush=True)

    deadline = time.time() + timeout
    seen = 0
    while time.time() < deadline:
        try:
            cookies = cdp.cookies_for("linkedin")
        except Exception as e:
            print(f"[linkedin-login] CDP read failed: {e}", flush=True)
            time.sleep(5)
            continue
        if len(cookies) != seen:
            seen = len(cookies)
            print(f"[linkedin-login] {seen} linkedin cookie(s) present", flush=True)
        header = session_header(cookies)
        if header:
            ok, who = probe(header)
            if ok:
                write_env(header)
                print(f"[linkedin-login] authenticated as {who} — wrote "
                      f"LINKEDIN_COOKIE to .env (chmod 600, gitignored)")
                return
        time.sleep(5)

    sys.exit("[linkedin-login] timed out — no authenticated session detected. "
             "Log in at https://www.linkedin.com and re-run.")


if __name__ == "__main__":
    main()
