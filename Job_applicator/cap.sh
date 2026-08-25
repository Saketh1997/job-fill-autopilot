#!/bin/bash
# cap.sh — take a fresh CAPTCHA screenshot and print it in THIS terminal.
#
#   ./cap.sh [slug] [width]
#
# With no slug it picks the most recently filled application that is not yet
# submitted. Run it, read the picture, then tell the agent which cells to click.
cd "$(dirname "$0")" || exit 1
SLUG="${1:-}"
WIDTH="${2:-60}"
if [ -z "$SLUG" ]; then
  SLUG=$(ls -t answers/*.drive.json 2>/dev/null | while read -r f; do
    python3 -c "
import json,sys
d=json.load(open('$f'))
print(d['slug']) if not d.get('submitted') else None" 2>/dev/null
  done | head -1)
fi
[ -n "$SLUG" ] || { echo "no pending application found"; exit 1; }
echo "slug: $SLUG"
node captcha_relay.mjs "$SLUG" shot >/dev/null 2>&1
SHOT="shots/${SLUG}-challenge.png"
[ -f "$SHOT" ] || { echo "no challenge captured — it may have closed"; exit 2; }
python3 show_image.py "$SHOT" --width "$WIDTH"
echo
echo "reply with cells, e.g.:  E5 F6 G7   (repeat a cell to click it twice)"
