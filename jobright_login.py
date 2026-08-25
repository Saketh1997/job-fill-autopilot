#!/usr/bin/env python3
"""jobright_login.py — capture a JobRight session cookie after a manual login.

JobRight only reveals an employer's apply URL to a logged-in session, so
`jobright_scan_parser.py` needs a cookie. This script opens JobRight in the
Chrome that is already running with --remote-debugging-port=9222, waits for the
user to log in by hand, reads the resulting cookies over CDP (which returns
httpOnly cookies — `document.cookie` cannot see the session one), verifies them
against a read-only API call, and writes JOBRIGHT_COOKIE to .env.

Nothing here logs in on the user's behalf or submits anything: the human does
the authentication, this only picks up the result.

Usage:
  .venv-jobspy/bin/python jobright_login.py            # wait up to 10 min
  .venv-jobspy/bin/python jobright_login.py --check    # test the stored cookie
  .venv-jobspy/bin/python jobright_login.py --timeout 300
"""
import json
import os
import re
import sys
import time
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import cdp_helper as cdp  # noqa: E402

ENV_FILE = os.path.join(HERE, ".env")
LOGIN_URL = "https://jobright.ai/jobs"
# Any real job id works as a probe. The test is whether the server-rendered
# page carries "applyLink" — that field appears only for a logged-in session,
# which is exactly the capability the parser needs. Read-only, and it does not
# touch the user's JobRight tracker.
PROBE_ID = "6a73795132ebbc14ffb4f2bc"
PROBE_URL = f"https://jobright.ai/jobs/info/{PROBE_ID}"
UA = ("Mozilla/5.0 (X11; Ubuntu; Linux x86_64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36")


def probe(cookie):
    """(ok, apply_url) — does this cookie unlock employer apply links?"""
    try:
        req = urllib.request.Request(PROBE_URL, headers={
            "User-Agent": UA, "Cookie": cookie,
            "Accept": "text/html", "Referer": "https://jobright.ai/jobs"})
        with urllib.request.urlopen(req, timeout=25) as r:
            page = r.read().decode("utf-8", "replace")
    except Exception:
        return False, None
    m = re.search(r'\\?"(?:applyLink|originalUrl)\\?"\s*:\s*\\?"(https?://[^"\\]{10,400})', page)
    return (True, m.group(1)) if m else (False, None)


def write_env(cookie):
    lines, replaced = [], False
    if os.path.exists(ENV_FILE):
        for line in open(ENV_FILE, encoding="utf-8"):
            if line.startswith("JOBRIGHT_COOKIE="):
                lines.append(f"JOBRIGHT_COOKIE={cookie}\n")
                replaced = True
            else:
                lines.append(line)
    if not replaced:
        if lines and not lines[-1].endswith("\n"):
            lines.append("\n")
        lines.append(f"JOBRIGHT_COOKIE={cookie}\n")
    with open(ENV_FILE, "w", encoding="utf-8") as f:
        f.writelines(lines)
    os.chmod(ENV_FILE, 0o600)


def stored_cookie():
    try:
        for line in open(ENV_FILE, encoding="utf-8"):
            if line.startswith("JOBRIGHT_COOKIE="):
                return line.split("=", 1)[1].strip()
    except OSError:
        pass
    return ""


def main():
    args = sys.argv[1:]
    if "--check" in args:
        cookie = stored_cookie()
        if not cookie:
            sys.exit("no JOBRIGHT_COOKIE in .env — run this without --check first")
        ok, url = probe(cookie)
        print(f"stored cookie: {'VALID' if ok else 'REJECTED'}"
              + (f" (via {url})" if ok else " — log in again to refresh it"))
        sys.exit(0 if ok else 1)

    timeout = 600
    if "--timeout" in args:
        timeout = int(args[args.index("--timeout") + 1])

    if not any("jobright.ai" in t.get("url", "") for t in cdp.pages()):
        cdp.open_url(LOGIN_URL)
    print(f"[jobright-login] waiting up to {timeout}s for a logged-in session "
          f"in your Chrome window ({LOGIN_URL})", flush=True)

    deadline = time.time() + timeout
    seen = 0
    while time.time() < deadline:
        try:
            cookies = cdp.cookies_for("jobright")
        except Exception as e:
            print(f"[jobright-login] CDP read failed: {e}", flush=True)
            time.sleep(5)
            continue
        if len(cookies) != seen:
            seen = len(cookies)
            print(f"[jobright-login] {seen} jobright cookie(s) present "
                  f"({', '.join(sorted(c['name'] for c in cookies))[:120]})", flush=True)
        if cookies:
            header = "; ".join(f"{c['name']}={c['value']}" for c in cookies)
            ok, url = probe(header)
            if ok:
                write_env(header)
                names = sorted(c["name"] for c in cookies)
                print(f"[jobright-login] authenticated — wrote JOBRIGHT_COOKIE to .env "
                      f"(chmod 600, gitignored); cookies: {', '.join(names)}")
                print(f"[jobright-login] verified against {url}")
                return
        time.sleep(5)

    sys.exit("[jobright-login] timed out — no authenticated session detected. "
             "Log in at https://jobright.ai and re-run.")


if __name__ == "__main__":
    main()
