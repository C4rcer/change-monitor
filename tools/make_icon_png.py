#!/usr/bin/env python3
"""Draw src/icons/icon-96.png, the picture used in desktop notifications.

  python tools/make_icon_png.py        (needs pillow)

Windows notifications do not show SVG, so the icon is drawn a second time here
with the same shapes and colors as src/icons/icon.svg. Run it again after
changing the SVG.
"""
from pathlib import Path

from PIL import Image, ImageDraw

S = 8  # supersampling
N = 96 * S
OUT = Path(__file__).resolve().parents[1] / "src" / "icons" / "icon-96.png"


def px(*v):
    return [round(x * S) for x in v]


def main():
    a, b = (0x38, 0xBD, 0xF8), (0x1D, 0x4E, 0xD8)
    grad = Image.new("RGB", (N, N))
    gp = grad.load()
    for y in range(N):
        for x in range(N):
            t = (x + y) / (2 * (N - 1))
            gp[x, y] = tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(3))
    mask = Image.new("L", (N, N), 0)
    ImageDraw.Draw(mask).rounded_rectangle(px(0, 0, 96, 96), 22 * S, fill=255)
    img = Image.new("RGBA", (N, N), (0, 0, 0, 0))
    img.paste(grad, (0, 0), mask)
    d = ImageDraw.Draw(img)
    d.rounded_rectangle(px(20, 18, 70, 80), 8 * S, fill="#ffffff")
    d.rounded_rectangle(px(29, 31, 61, 38), 3.5 * S, fill="#bfdbfe")
    d.rounded_rectangle(px(29, 46, 61, 53), 3.5 * S, fill="#f97316")
    d.rounded_rectangle(px(29, 61, 49, 68), 3.5 * S, fill="#bfdbfe")
    d.ellipse(px(71 - 14.5, 23 - 14.5, 71 + 14.5, 23 + 14.5), fill="#ffffff")
    d.ellipse(px(71 - 9.5, 23 - 9.5, 71 + 9.5, 23 + 9.5), fill="#f97316")
    img.resize((96, 96), Image.LANCZOS).save(OUT)
    print("wrote", OUT)


if __name__ == "__main__":
    main()
