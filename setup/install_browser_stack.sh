#!/usr/bin/env bash
# install_browser_stack.sh -- build the headless browser the pipeline drives.
#
#   bash setup/install_browser_stack.sh            install and start
#   bash setup/install_browser_stack.sh --check    report only, change nothing
#
# Three systemd USER units: a virtual display, a Chrome with CDP open on it, and
# a VNC server so a human can watch or clear a CAPTCHA. Every non-obvious choice
# below cost a failed run before it was settled; see PIPELINE.md section 2.1.
#
# The one thing to protect: the Chrome profile directory. Every portal login the
# pipeline has -- LinkedIn, the job boards, each ATS account -- lives in it, and
# losing it means logging in to all of them again.

set -euo pipefail

CHECK_ONLY=0
[ "${1:-}" = "--check" ] && CHECK_ONLY=1

DISPLAY_NUM="${CAREER_OPS_DISPLAY:-:99}"
CDP_PORT="${CAREER_OPS_CDP_PORT:-9226}"
VNC_PORT="${CAREER_OPS_VNC_PORT:-5900}"
PROFILE_DIR="${CAREER_OPS_CHROME_PROFILE:-$HOME/job-browser-chrome}"
UNIT_DIR="$HOME/.config/systemd/user"

say()  { printf '  %s\n' "$*"; }
warn() { printf '  WARN  %s\n' "$*" >&2; }
die()  { printf '  FAIL  %s\n' "$*" >&2; exit 1; }

# ---------------------------------------------------------------- dependencies
echo "career-ops browser stack"
echo

# Chrome stable specifically. NOT snap chromium: it serves /json/version but
# never completes a CDP handshake from outside its confinement, so every
# connectOverCDP hangs for 30s and times out. NOT playwright's bundled chromium:
# that is Chrome for Testing, and some career portals render fewer controls for
# it -- an Apply anchor that simply does not resolve.
CHROME=""
for c in /opt/google/chrome/chrome /usr/bin/google-chrome-stable /usr/bin/google-chrome; do
  [ -x "$c" ] && { CHROME="$c"; break; }
done
[ -n "$CHROME" ] || die "Google Chrome stable not found. Install it (not snap chromium, not Chrome for Testing) and re-run."
say "chrome     $CHROME"

MISSING=()
command -v Xvfb   >/dev/null || MISSING+=(xvfb)
command -v x11vnc >/dev/null || MISSING+=(x11vnc)
if [ ${#MISSING[@]} -gt 0 ]; then
  warn "missing: ${MISSING[*]}"
  say  "install with: sudo apt-get install -y ${MISSING[*]}"
  [ "$CHECK_ONLY" = 1 ] || die "install the packages above, then re-run"
fi

command -v systemctl >/dev/null || die "no systemctl; these are systemd user units"
say "display    $DISPLAY_NUM"
say "cdp port   $CDP_PORT"
say "profile    $PROFILE_DIR"
echo

if [ "$CHECK_ONLY" = 1 ]; then
  for u in xvfb job-browser x11vnc; do
    state=$(systemctl --user is-active "$u.service" 2>/dev/null || true)
    printf '  %-14s %s\n' "$u" "${state:-not installed}"
  done
  if curl -sf --max-time 3 "http://localhost:$CDP_PORT/json/version" >/dev/null 2>&1; then
    say "CDP responding on $CDP_PORT"
  else
    warn "no CDP on $CDP_PORT"
  fi
  exit 0
fi

mkdir -p "$UNIT_DIR" "$PROFILE_DIR"

cat > "$UNIT_DIR/xvfb.service" <<EOF
[Unit]
Description=career-ops virtual display

[Service]
ExecStart=/usr/bin/Xvfb $DISPLAY_NUM -screen 0 1920x1080x24 -nolisten tcp
Restart=always

[Install]
WantedBy=default.target
EOF

# --no-sandbox is deliberately absent: Chrome stable does not need it. It IS
# needed for playwright's chromium, because Ubuntu 23.10+ AppArmor restricts
# unprivileged user namespaces -- which is one more reason to use Chrome stable.
cat > "$UNIT_DIR/job-browser.service" <<EOF
[Unit]
Description=career-ops persistent Chrome (CDP)
After=xvfb.service
Requires=xvfb.service

[Service]
Environment=DISPLAY=$DISPLAY_NUM
ExecStart=$CHROME \\
  --remote-debugging-port=$CDP_PORT --remote-debugging-address=127.0.0.1 \\
  --user-data-dir=$PROFILE_DIR \\
  --no-first-run --no-default-browser-check \\
  --disable-features=Translate --window-size=1920,1080 about:blank
Restart=always

[Install]
WantedBy=default.target
EOF

# -localhost -nopw on purpose: no password, bound to 127.0.0.1 only. Reach it
# with `ssh -L $VNC_PORT:localhost:$VNC_PORT <host>`, never by opening the port.
cat > "$UNIT_DIR/x11vnc.service" <<EOF
[Unit]
Description=career-ops VNC onto the virtual display
After=xvfb.service
Requires=xvfb.service

[Service]
Environment=DISPLAY=$DISPLAY_NUM
ExecStart=/usr/bin/x11vnc -display $DISPLAY_NUM -rfbport $VNC_PORT -localhost -forever -shared -nopw -quiet
Restart=always

[Install]
WantedBy=default.target
EOF

systemctl --user daemon-reload
systemctl --user enable --now xvfb.service job-browser.service x11vnc.service

# The port takes about ten seconds to bind. Poll it; a single sleep either wastes
# time or reports a false failure.
printf '  waiting for CDP'
for _ in $(seq 1 30); do
  if curl -sf --max-time 2 "http://localhost:$CDP_PORT/json/version" >/dev/null 2>&1; then
    echo
    say "up: $(curl -s "http://localhost:$CDP_PORT/json/version" | head -c 200)"
    echo
    say "Add this to your shell profile:"
    say "  export CDP_ENDPOINT=http://localhost:$CDP_PORT"
    echo
    say "Next: log in to LinkedIn and your job boards ONCE in that browser."
    say "  ssh -L $VNC_PORT:localhost:$VNC_PORT <this host>, then point a VNC client at localhost:$VNC_PORT"
    say "Then back up $PROFILE_DIR. It holds every session the pipeline has."
    exit 0
  fi
  printf '.'
  sleep 1
done
echo
die "CDP never came up on $CDP_PORT. Check: systemctl --user status job-browser.service"
