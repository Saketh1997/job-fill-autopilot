#!/usr/bin/env python3
"""show_image.py — print an image in the terminal as ANSI colour blocks.

  python3 show_image.py <path> [--width 64] [--grid 10x10] [--no-labels]

Written for one situation: the operator is on a phone over SSH and cannot open
a PNG, but still has to look at a CAPTCHA challenge and say which cells to
click. This transports the picture to their terminal. It does not interpret it —
every pixel printed is the pixel that was captured, and the person reading the
output does all of the seeing.

Two terminal rows are packed into one character row with the upper-half block
(U+2580): foreground paints the top pixel, background the bottom one, so a
64-column render is 64x128 pixels of real detail.

--grid draws the same lettered grid captcha_relay.mjs uses, as a ruler around
the edge, so an answer reads straight back as `click E5`.
"""
import sys
from PIL import Image

UPPER = "▀"


def render(path, width=64, grid=(10, 10), labels=True):
    im = Image.open(path).convert("RGB")
    # Two pixel rows per character row, and terminal cells are about twice as
    # tall as they are wide, so the vertical scale works out to 1:1.
    height = max(2, int(width * im.height / im.width))
    height -= height % 2
    im = im.resize((width, height), Image.LANCZOS)
    px = im.load()

    cols, rows = grid if grid else (0, 0)
    pad = "   " if labels and rows else ""

    out = []
    if labels and cols:
        # Column letters, placed at the centre of each grid column.
        header = [" "] * width
        for c in range(cols):
            centre = int((c + 0.5) * width / cols)
            ch = chr(ord("A") + c)
            if 0 <= centre < width:
                header[centre] = ch
        out.append(pad + "".join(header))

    for y in range(0, height, 2):
        line = [pad]
        if labels and rows:
            band = int(y / height * rows)
            centre_row = int((band + 0.5) * height / rows)
            mark = str(band + 1) if abs(y - centre_row) < 1 else ""
            line = [f"{mark:>2} "]
        for x in range(width):
            tr, tg, tb = px[x, y]
            br, bg, bb = px[x, y + 1] if y + 1 < height else (0, 0, 0)
            line.append(f"\x1b[38;2;{tr};{tg};{tb}m\x1b[48;2;{br};{bg};{bb}m{UPPER}")
        line.append("\x1b[0m")
        out.append("".join(line))
    return "\n".join(out)


def main():
    args = sys.argv[1:]
    if not args:
        raise SystemExit("usage: show_image.py <path> [--width N] [--grid CxR] [--no-labels]")
    path = args[0]
    width, grid, labels = 64, (10, 10), True
    i = 1
    while i < len(args):
        if args[i] == "--width":
            i += 1
            width = int(args[i])
        elif args[i] == "--grid":
            i += 1
            c, r = args[i].lower().split("x")
            grid = (int(c), int(r))
        elif args[i] == "--no-labels":
            labels = False
        elif args[i] == "--no-grid":
            grid = None
        i += 1
    print(render(path, width, grid, labels))


if __name__ == "__main__":
    main()
