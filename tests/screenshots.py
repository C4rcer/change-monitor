"""Capture the AMO listing screenshots (1280x800) of Heron in a real Firefox.

  python tools/release.py build
  python tests/screenshots.py          (needs selenium + pillow)

Writes store-assets/screenshots/{1-changes,2-popup,3-pick}.png. The pages being
watched are tests/demo/*.html (a made-up shop and a made-up local paper) served
by tests/server.py; nothing here ships in the add-on. The watches are made the
real way (popup, picker, real checks against pages that then change); only the
times are moved back afterwards so the list does not read "just now" everywhere.
"""
import json
import shutil
import sys
import tempfile
import time
import zipfile
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter
from selenium.webdriver.common.by import By

sys.path.insert(0, str(Path(__file__).resolve().parent))
import server  # noqa: E402
from harness import ROOT, Fx, latest_zip, wait  # noqa: E402

PORT = 8962
SHOP = f"http://harbourshop.example:{PORT}/demo/shop.html"
NEWS = f"http://harbournews.example:{PORT}/demo/news.html"
JOBS = NEWS + "?page=jobs"
OUT = ROOT / "store-assets" / "screenshots"
W, H = 1280, 800
# 1.5 device pixels per CSS pixel (Firefox only does scales where 60 / scale is a whole number).
DPR = 1.5
EURO = "€"
MIN = 60000

HEADLINES = [
    "Harbour bridge reopens after three weeks of repairs",
    "Ferry timetable: last crossing leaves at 21:40",
    "Council approves two new cycle lanes on the quay",
    "Library extends its weekend opening hours",
    "Fish market moves to the east quay in March",
    "Lighthouse tours start again in May",
    "Road works on Quay Street until Friday",
    "Sailing club wins the regional regatta",
    "New bakery opens on Market Square",
    "Museum shows photographs of the old port",
]
JOB_ITEMS = ["Harbour master's assistant, full time", "Lock keeper, seasonal", "Tour guide for the lighthouse, weekends"]


def items(lines):
    return "\n".join(f"    <li>{t}</li>" for t in lines)


def news_demo(lines):
    return {"title": "The Harbour Gazette", "heading": "Today on the waterfront", "intro": "News from the port, the quays and the town.", "items": items(lines)}


def fit(img):
    """Crop/pad a capture to exactly 1280x800."""
    canvas = Image.new("RGB", (W, H), (246, 243, 238))
    canvas.paste(img.convert("RGB").crop((0, 0, min(W, img.width), min(H, img.height))), (0, 0))
    return canvas


def card(img, radius=14, scale=1.0):
    """Rounded corners and a soft drop shadow around a capture."""
    img = img.convert("RGBA")
    if scale != 1.0:
        img = img.resize((round(img.width * scale), round(img.height * scale)), Image.LANCZOS)
    mask = Image.new("L", img.size, 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, img.width - 1, img.height - 1), radius, fill=255)
    pad = 40
    out = Image.new("RGBA", (img.width + pad * 2, img.height + pad * 2), (0, 0, 0, 0))
    sm = Image.new("L", out.size, 0)
    ImageDraw.Draw(sm).rounded_rectangle((pad, pad + 8, pad + img.width, pad + img.height + 8), radius, fill=130)
    out.putalpha(sm.filter(ImageFilter.GaussianBlur(18)))
    out.paste(img, (pad, pad), mask)
    return out, pad


def set_viewport(fx, cw, ch):
    """Grow the current window until the page area is exactly cw x ch CSS pixels."""
    outer = [cw + 16, ch + 100]
    inner = None
    for _ in range(8):
        fx.d.set_window_size(*outer)
        time.sleep(0.3)
        inner = fx.d.execute_script("return [innerWidth, innerHeight]")
        if inner == [cw, ch]:
            break
        outer = [outer[0] + cw - inner[0], outer[1] + ch - inner[1]]
    return inner


def main():
    unpacked = Path(tempfile.mkdtemp(prefix="heron-shots-"))
    with zipfile.ZipFile(latest_zip()) as z:
        z.extractall(unpacked)
    httpd = server.start(PORT)
    st = server.STATE
    st.reset()
    shop = {"price": f"{EURO} 24.99", "was": "", "stock": "In stock"}
    st.demo = {**shop, **news_demo(HEADLINES)}
    OUT.mkdir(parents=True, exist_ok=True)
    fx = Fx(unpacked, prefs={
        "layout.css.devPixelsPerPx": str(DPR),
        "ui.systemUsesDarkTheme": 0,
        "layout.css.prefers-color-scheme.content-override": 1,  # light
    })
    try:
        cw, ch = round(W / DPR), round(H / DPR)
        fx.to_page()
        print("page viewport:", set_viewport(fx, cw, ch))

        # ---- real watches on the demo pages
        fx.page_get(NEWS)
        fx.open_popup(NEWS, "The Harbour Gazette")
        fx.click("#addPage")
        news = wait(lambda: (lambda x: x if x and x.get("lastCheck") else None)(fx.watch(url=NEWS)), 15)
        wait(lambda: fx.overlay() == "ok", 5)
        fx.card_click("OK")
        st.demo.update({"title": "Jobs at the harbour", "heading": "Jobs at the harbour", "intro": "Open positions this month.", "items": items(JOB_ITEMS)})
        jobs = fx.send("watch:add", spec={"url": JOBS, "name": "Jobs at the harbour", "interval": 1440})
        st.demo.update(news_demo(HEADLINES))

        fx.page_get(SHOP)
        fx.open_popup(SHOP, "Enamel Kettle, 1.5 l - Harbour & Co.")
        fx.click("#addPart")
        wait(lambda: fx.overlay() == "picking", 8)
        r = fx.rect("#price")
        fx.move(r["cx"] - 4, r["cy"])
        fx.click_at(r["cx"], r["cy"])
        wait(lambda: fx.overlay() == "ok", 15)
        fx.card_click("OK")
        kettle = fx.watch(url=SHOP)
        fx.send("watch:update", id=kettle["id"], patch={"name": "Enamel kettle: price", "interval": 30})

        # ---- the pages change, Heron notices
        changed = list(HEADLINES)
        changed[1] = "Ferry timetable: last crossing leaves at 22:15"
        changed.remove("Road works on Quay Street until Friday")
        changed.insert(0, "Storm warning for Saturday night: harbour closed to small boats")
        changed.insert(4, "Tide tables for March are out")
        st.demo.update(news_demo(changed))
        fx.send("watch:check", id=news["id"])
        st.demo.update({"price": f"{EURO} 19.99", "was": f"was {EURO} 24.99"})
        fx.send("watch:check", id=kettle["id"])
        st.demo.update(news_demo(changed))

        # Times only: spread them out so the list reads like a few days of use.
        fx.api(f"""
          const now = Date.now(), MIN = {MIN};
          const got = await browser.storage.local.get(null);
          for (const w of got.watches) {{
            if (w.id === {json.dumps(kettle["id"])}) Object.assign(w, {{ lastChange: now - 12 * MIN, lastCheck: now - 12 * MIN, createdAt: now - 4 * 1440 * MIN }});
            else if (w.id === {json.dumps(news["id"])}) Object.assign(w, {{ lastChange: now - 47 * MIN, lastCheck: now - 3 * MIN, createdAt: now - 6 * 1440 * MIN }});
            else Object.assign(w, {{ lastCheck: now - 5 * 60 * MIN, createdAt: now - 9 * 1440 * MIN }});
            const snap = got["snap:" + w.id];
            if (snap && snap.versions.length > 1) {{
              snap.versions[0].at = w.createdAt;
              snap.versions[snap.versions.length - 1].at = w.lastChange;
              await browser.storage.local.set({{ ["snap:" + w.id]: snap }});
            }}
          }}
          await browser.storage.local.set({{ watches: got.watches }});
          return true;""")
        print("watches:", [(w["name"], w["unread"]) for w in fx.watches()], jobs.get("ok"))

        # ---- 3: picking a part of the page
        fx.page_get(SHOP)
        time.sleep(0.5)
        base_path = OUT / "_base.png"
        fx.d.save_screenshot(str(base_path))
        base = Image.open(base_path)
        fx.open_popup(SHOP, "Enamel Kettle, 1.5 l - Harbour & Co.")
        fx.click("#addPart")
        wait(lambda: fx.overlay() == "picking", 8)
        r = fx.rect(".buy")
        fx.move(r["x"] + 30, r["cy"] - 20)
        fx.move(r["x"] + 40, r["y"] + 25)
        time.sleep(0.6)
        fx.to_page()
        fx.d.save_screenshot(str(OUT / "3-pick.png"))
        fit(Image.open(OUT / "3-pick.png")).save(OUT / "3-pick.png")
        from selenium.webdriver.common.keys import Keys
        fx.keys(Keys.ESCAPE)

        # ---- 2: the popup, rendered in a tab and composited where Firefox opens it
        fx.open_popup(SHOP, "Enamel Kettle, 1.5 l - Harbour & Co.")
        fx.d.set_window_size(900, 1400)
        time.sleep(0.6)
        print("popup CSS size:", fx.d.execute_script("return [document.body.offsetWidth, document.body.offsetHeight]"))
        pop_path = OUT / "_popup.png"
        fx.d.find_element(By.TAG_NAME, "body").screenshot(str(pop_path))
        popup = Image.open(pop_path)
        backdrop = fit(base).convert("RGBA")
        backdrop = Image.alpha_composite(backdrop, Image.new("RGBA", backdrop.size, (23, 50, 77, 70)))
        k = min(1.0, (H - 28) / popup.height)
        shadowed, pad = card(popup, radius=14, scale=k)
        shot = backdrop.copy()
        shot.alpha_composite(shadowed, (W - shadowed.width + pad - 30, 14 - pad))
        shot.convert("RGB").save(OUT / "2-popup.png")

        # ---- 1: what changed
        fx.to_ext()
        print("changes viewport:", set_viewport(fx, cw, ch))
        fx.open_changes(news["id"])
        time.sleep(0.8)
        fx.d.save_screenshot(str(OUT / "1-changes.png"))
        fit(Image.open(OUT / "1-changes.png")).save(OUT / "1-changes.png")
    finally:
        fx.quit()
        httpd.shutdown()
        shutil.rmtree(unpacked, ignore_errors=True)
        for tmp in OUT.glob("_*.png"):
            tmp.unlink()
    for p in sorted(OUT.glob("*.png")):
        print(p.relative_to(ROOT), Image.open(p).size)


if __name__ == "__main__":
    main()
