#!/bin/bash
# capshot.sh — fresh CAPTCHA screenshot, published at a short stable URL.
#   ./capshot.sh [slug]
# Re-run it any time the challenge rotates, then reload the URL on your phone.
cd "$(dirname "$0")" || exit 1
SLUG="${1:-}"
if [ -z "$SLUG" ]; then
  SLUG=$(ls -t answers/*.drive.json 2>/dev/null | head -20 | while read -r f; do
    python3 -c "
import json
d=json.load(open('$f'))
print(d['slug']) if not d.get('submitted') and d.get('ats') else None" 2>/dev/null
  done | head -1)
fi
[ -n "$SLUG" ] || { echo "no pending application"; exit 1; }
node captcha_relay.mjs "$SLUG" shot >/dev/null 2>&1
SRC="shots/${SLUG}-challenge.png"
[ -f "$SRC" ] || { echo "no challenge captured (it may have closed) — try again"; exit 2; }
cp "$SRC" shots/c.png
echo "slug: $SLUG"
echo "open: http://100.99.137.31:8899/c.png?$(date +%s)"
