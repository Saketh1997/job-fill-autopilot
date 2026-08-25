#!/usr/bin/env python3
"""compare_images.py A.png B.png -> prints a 0-100 difference score.

The CAPTCHA staleness check cannot use an exact hash: hCaptcha animates its
progress dots and the page behind the transparent overlay repaints, so two
captures of the SAME puzzle never match byte for byte and every click was
refused as stale. This downscales both images and compares them coarsely, which
ignores animation but still moves sharply when the puzzle itself changes.
"""
import sys
from PIL import Image, ImageChops, ImageStat

a = Image.open(sys.argv[1]).convert("RGB").resize((32, 32), Image.LANCZOS)
b = Image.open(sys.argv[2]).convert("RGB").resize((32, 32), Image.LANCZOS)
diff = ImageChops.difference(a, b)
print(round(sum(ImageStat.Stat(diff).mean) / 3 / 255 * 100, 2))
