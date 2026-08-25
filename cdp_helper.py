#!/usr/bin/env python3
"""cdp_helper.py — minimal Chrome DevTools Protocol client.

Talks to the Chrome already running with `--remote-debugging-port=9226` (the
same browser .mcp.json points its playwright server at), so a page the user is
logged into can be reused instead of asking them to re-authenticate somewhere.

Used by `jobright_login.py` to read the JobRight session cookie after a manual
login. Cookies come from `Network.getAllCookies`, which returns httpOnly
cookies too — `document.cookie` cannot see the session cookie that matters here.

Requires websocket-client, installed in .venv-jobspy:
  .venv-jobspy/bin/pip install websocket-client

Usage (all read-only):
  .venv-jobspy/bin/python cdp_helper.py targets
  .venv-jobspy/bin/python cdp_helper.py cookies jobright.ai
  .venv-jobspy/bin/python cdp_helper.py open https://jobright.ai/jobs
"""
import json
import os
import socket
import sys
import time
import urllib.parse

def _endpoint():
    """CDP_ENDPOINT wins, so this agrees with the scrape/fill scripts.

    The shared browser moved to 9226 (see Job_applicator/CLAUDE.md); 9222 stays
    the fallback only for a Chrome started the old way."""
    raw = os.environ.get("CDP_ENDPOINT", "").strip()
    if not raw:
        return "127.0.0.1", 9226
    netloc = urllib.parse.urlparse(raw if "//" in raw else f"http://{raw}").netloc
    host, _, port = netloc.partition(":")
    return host or "127.0.0.1", int(port or 9226)


HOST, PORT = _endpoint()


def http_get(path, verb="GET", retries=3):
    """CDP's HTTP endpoints over a raw socket — curl is blocked in this sandbox.

    `/json/new` requires PUT (Chrome rejects GET as an "unsafe HTTP verb"), so
    the verb is a parameter.

    Chrome intermittently closes the very first connection without writing a
    response (typically the first call after an idle period), which surfaced as
    a JSONDecodeError on an empty body in the caller. An empty read is retried
    rather than returned."""
    for attempt in range(retries):
        body = _http_get_once(path, verb)
        if body:
            return body
        if attempt < retries - 1:
            time.sleep(0.3)
    return body


def _http_get_once(path, verb):
    s = socket.create_connection((HOST, PORT), timeout=5)
    s.sendall(f"{verb} {path} HTTP/1.1\r\nHost: localhost:{PORT}\r\n"
              f"Connection: close\r\n\r\n".encode())
    buf = b""
    while True:
        try:
            chunk = s.recv(65536)
        except socket.timeout:
            break
        if not chunk:
            break
        buf += chunk
    s.close()
    head, _, body = buf.partition(b"\r\n\r\n")
    # /json/list switches to Transfer-Encoding: chunked once enough tabs are
    # open; without de-chunking, the body starts with a hex length line and
    # json.loads fails on what looks like valid output.
    if b"transfer-encoding: chunked" in head.lower():
        out, rest = b"", body
        while rest:
            size_line, _, rest = rest.partition(b"\r\n")
            try:
                size = int(size_line.split(b";")[0].strip(), 16)
            except ValueError:
                break
            if size == 0:
                break
            out += rest[:size]
            rest = rest[size + 2:]      # skip the chunk's trailing CRLF
        body = out
    return body.decode("utf-8", "replace")


def targets():
    return json.loads(http_get("/json/list"))


def pages():
    return [t for t in targets() if t.get("type") == "page"]


def _ws(target):
    # suppress_origin: Chrome rejects a DevTools WebSocket that carries an
    # Origin header ("Rejected an incoming WebSocket connection from the
    # http://localhost:9222 origin") unless it was started with
    # --remote-allow-origins. Sending no Origin at all is accepted, and avoids
    # asking the user to relaunch their browser with an extra flag.
    import websocket
    return websocket.create_connection(target["webSocketDebuggerUrl"],
                                       timeout=30, max_size=64 * 1024 * 1024,
                                       suppress_origin=True)


def call(target, method, params=None, _id=1):
    ws = _ws(target)
    try:
        ws.send(json.dumps({"id": _id, "method": method, "params": params or {}}))
        while True:
            msg = json.loads(ws.recv())
            if msg.get("id") == _id:
                if "error" in msg:
                    raise RuntimeError(msg["error"])
                return msg.get("result", {})
    finally:
        ws.close()


def cookies_for(domain_substr, target=None):
    """All cookies whose domain contains `domain_substr`, httpOnly included."""
    target = target or (pages() or [None])[0]
    if not target:
        raise RuntimeError("no page target in the running Chrome")
    result = call(target, "Network.getAllCookies")
    return [c for c in result.get("cookies", [])
            if domain_substr in c.get("domain", "")]


def cookie_header(domain_substr):
    """The cookies as a single `name=value; ...` Cookie header string."""
    return "; ".join(f"{c['name']}={c['value']}" for c in cookies_for(domain_substr))


def open_url(url):
    """Open `url` in a new tab of the user's browser and return the target."""
    encoded = url.replace("&", "%26")
    http_get(f"/json/new?{encoded}", verb="PUT")
    for t in pages():
        if url.split("?")[0] in t.get("url", ""):
            return t
    return None


def evaluate(target, expression, await_promise=True):
    """Run JS in the page and return its value (page origin, page cookies)."""
    result = call(target, "Runtime.evaluate", {
        "expression": expression,
        "awaitPromise": await_promise,
        "returnByValue": True,
    })
    if result.get("exceptionDetails"):
        raise RuntimeError(result["exceptionDetails"].get("text", "JS error"))
    return result.get("result", {}).get("value")


def main():
    cmd = sys.argv[1] if len(sys.argv) > 1 else "targets"
    if cmd == "targets":
        for t in pages():
            print(f"  {t.get('title','')[:50]:50} {t.get('url','')[:70]}")
    elif cmd == "cookies":
        domain = sys.argv[2] if len(sys.argv) > 2 else "jobright"
        found = cookies_for(domain)
        print(f"{len(found)} cookie(s) for *{domain}*:")
        for c in found:
            print(f"  {c['name']:28} httpOnly={c.get('httpOnly')} "
                  f"len={len(c['value'])} domain={c['domain']}")
    elif cmd == "open":
        t = open_url(sys.argv[2])
        print("opened:", (t or {}).get("url", "(tab not found)"))
    else:
        sys.exit(__doc__)


if __name__ == "__main__":
    main()
