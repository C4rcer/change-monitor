"""End-to-end test of Heron in a real Firefox (Selenium + geckodriver).

  python -m pip install selenium pillow      (once, ideally in a venv)
  python tools/release.py build
  python tests/e2e_firefox.py [main] [prompt] [suspend] [control]

Installs the built zip (extracted, by path) as a temporary add-on in throwaway
profiles and watches pages served by tests/server.py under made-up host names
(network.dns.localDomains). The server's pages change between checks. Every
browser runs headless and muted.

Sessions (all run when none is named):
  main     the whole add-on with the popup driven from a tab: add, detect and
           not detect, one part, the picker, pages drawn by JavaScript, the
           schedule, pause, problems, limits, notifications, edit, delete,
           export and import
  prompt   the real toolbar popup and Firefox's real permission prompt: denied,
           then allowed, for exactly one site
  suspend  the background page is stopped by Firefox after 2 s without work:
           the alarm wakes it and everything is read back from storage
  control  the same add-on with its content_security_policy line removed: the
           http:// check then fails, which proves the line is needed
"""
import json
import shutil
import sys
import tempfile
import time
import zipfile
from pathlib import Path

from selenium.webdriver.common.by import By
from selenium.webdriver.common.keys import Keys
from selenium.webdriver.support.ui import Select

sys.path.insert(0, str(Path(__file__).resolve().parent))
import server  # noqa: E402
from harness import ADDON_ID, EXT, Fx, check, latest_zip, results, wait  # noqa: E402

PORT = 8961
NEWS_HOST, SHOP_HOST, APP_HOST, MISC_HOST = "news.heron.test", "shop.heron.test", "app.heron.test", "misc.heron.test"
NEWS = f"http://{NEWS_HOST}:{PORT}/news"
SHOP = f"http://{SHOP_HOST}:{PORT}"
KETTLE = f"{SHOP}/shop/kettle"
DEALS = f"{SHOP}/shop/list"
APP = f"http://{APP_HOST}:{PORT}"
MISC = f"http://{MISC_HOST}:{PORT}"
GONE_HOST = "gone.heron.test"
GONE = f"http://{GONE_HOST}:8969/"  # nothing listens on that port
EURO = "€"
st = server.STATE


def pat(host):
    return f"*://{host}/*"


def near(a, b, tol=4):
    return a is not None and b is not None and all(abs(a[k] - b[k]) <= tol for k in ("x", "y", "w", "h"))


def grow(r, by=2):
    return {"x": r["x"] - by, "y": r["y"] - by, "w": r["w"] + 2 * by, "h": r["h"] + 2 * by}


def check_now(fx, wid, timeout=15):
    """Ask for a check through the same message the "Check now" button sends, and wait for it."""
    before = (fx.by_id(wid) or {}).get("lastCheck", 0)
    res = fx.send("watch:check", id=wid)
    wait(lambda: (fx.by_id(wid) or {}).get("lastCheck", 0) > before, timeout)
    return res


def add_by_url(fx, url, name="", selector="", timeout=20):
    """Add a watch through the form on the dashboard. Returns the watch."""
    fx.open_app()
    fx.xjs("document.getElementById('addUrl').value = arguments[0]; document.getElementById('addName').value = arguments[1];"
           "document.getElementById('addSelector').value = arguments[2];", url, name, selector)
    n = len(fx.watches())
    fx.click("#addGo")
    wait(lambda: len(fx.watches()) > n and not fx.xjs("return document.getElementById('addGo').disabled"), timeout, 0.2)
    return fx.watch(url=url, selector=selector)


def start_pick(fx, url, title):
    """Popup (in a tab) -> "Watch one part", then wait for the picker in the page."""
    fx.open_popup(url, title)
    fx.click("#addPart")
    return wait(lambda: fx.overlay() == "picking", 8)


def pick(fx, sel, index=0, want=("ok",)):
    r = fx.rect(sel, index)
    fx.move(r["cx"] - 3, r["cy"])
    fx.click_at(r["cx"], r["cy"])
    return wait(lambda: fx.overlay() in want and fx.overlay(), 15)


def close_card(fx):
    if fx.overlay():
        fx.card_click("OK")
        wait(lambda: fx.overlay() is None, 3)


# =================================================================== main

def session_main(unpacked):
    downloads = Path(tempfile.mkdtemp(prefix="heron-dl-"))
    fx = Fx(unpacked, download_dir=downloads)
    try:
        st.reset()
        # ---------------------------------------------------------- install
        check("install opens no tab", fx.handles_after_install == 1, fx.handles_after_install)
        man = fx.api("return browser.runtime.getManifest();")
        check("required permissions are alarms, storage, activeTab, scripting only",
              sorted(man.get("permissions", [])) == ["activeTab", "alarms", "scripting", "storage"] and not man.get("host_permissions"),
              (man.get("permissions"), man.get("host_permissions")))
        check("notifications and site access are optional",
              man.get("optional_permissions") == ["notifications"] and man.get("optional_host_permissions") == ["*://*/*"],
              (man.get("optional_permissions"), man.get("optional_host_permissions")))
        check("own CSP without upgrade-insecure-requests",
              "upgrade-insecure-requests" not in json.dumps(man.get("content_security_policy", {}))
              and "script-src 'self'" in man["content_security_policy"]["extension_pages"])
        shipped = json.loads((unpacked / "manifest.json").read_text(encoding="utf-8"))
        check("desktop only: no gecko_android in the manifest", "gecko_android" not in shipped["browser_specific_settings"])
        check("no site access at install", fx.origins() == [], fx.origins())
        check("badge empty at install", fx.badge() == "", fx.badge())
        check("no alarm while nothing is watched", fx.alarms() == [], fx.alarms())

        fx.open_popup("about:config", "Advanced Preferences")
        check("popup explains pages it can't watch",
              fx.xjs("return document.getElementById('hereForm').hidden") and "can't be watched" in (fx.xtext("#hereTitle") or ""))
        check("popup: empty list hint", not fx.xjs("return document.getElementById('empty').hidden"))
        check("popup has the Ko-fi pill", fx.xjs("return document.querySelector('header [data-support]').href") == "https://ko-fi.com/carcer7378")

        # ------------------------------------------------- whole page watch
        fx.page_get(NEWS)
        fx.open_popup(NEWS, "Harbour News")
        check("popup shows the page it was opened on",
              fx.xtext("#hereTitle") == "Harbour News" and fx.xtext("#hereUrl") == f"{NEWS_HOST}:{PORT}/news", fx.xtext("#hereUrl"))
        check("popup says which site Firefox will ask about", NEWS_HOST in (fx.xtext("#hereNote") or ""), fx.xtext("#hereNote"))
        fx.click("#addPage")
        w = wait(lambda: (lambda x: x if x and x.get("lastCheck") else None)(fx.watch(url=NEWS)), 15)
        check("whole-page watch created with a first version", bool(w) and w["selector"] == "" and len(fx.versions(w["id"])) == 1, w)
        news_id = w["id"]
        check("permission asked for that one site only", fx.origins() == [pat(NEWS_HOST)], fx.origins())
        checks = st.requests("/news", checks=True)
        check("plain http:// page on a non-loopback host was fetched (own CSP works)",
              len(checks) == 1 and checks[0]["host"] == NEWS_HOST, [(c["host"], c["path"]) for c in checks])
        base = fx.text(news_id)
        check("saved text is the readable text, one line per block",
              base.split("\n")[:3] == ["Harbour News", "All the news from the waterfront", "Harbour bridge reopens after repairs"], base[:120])
        check("scripts, styles, hidden blocks and noscript are left out",
              not any(x in base for x in ("tok", "color: red", "hidden block", "invisible block", "switch on JavaScript")), base)
        check("default interval is one hour", w["interval"] == 60 and abs(w["nextCheck"] - w["lastCheck"] - 3600000) < 2000, w["interval"])
        check("popup confirms", wait(lambda: "watching this page" in (fx.xtext("#hereMsg") or ""), 5), fx.xtext("#hereMsg"))
        check("popup: button shows the page is watched",
              fx.xtext("#addPage") == "Watching this page" and fx.xjs("return document.getElementById('addPage').disabled"))
        check("page shows a confirmation", wait(lambda: fx.overlay() == "ok", 5) and "watching this page" in (fx.card() or {}).get("text", ""),
              fx.card())
        close_card(fx)
        check("confirmation closes", fx.overlay() is None)
        al = fx.alarms()
        check("one alarm, set to the next due check", len(al) == 1 and abs(al[0]["scheduledTime"] - w["nextCheck"]) < 1500, (al, w["nextCheck"]))
        check("list row: no change", fx.xjs("return document.querySelector(arguments[0]).dataset.state", fx.row(news_id)) == "ok")

        # not changed (the page's scripts, styles and tokens differ on every request)
        fx.click(fx.row(news_id, '[data-act="check"]'))
        wait(lambda: fx.by_id(news_id)["lastCheck"] > w["lastCheck"], 10)
        w2 = fx.by_id(news_id)
        check("check now: nothing changed, nothing reported",
              w2["unread"] == 0 and len(fx.versions(news_id)) == 1 and fx.badge() == "" and len(st.requests("/news", checks=True)) == 2,
              (w2["unread"], len(st.requests("/news", checks=True))))

        # changed
        st.news.insert(0, "Storm warning for Saturday night")
        st.news.remove("Road works on Quay Street until Friday")
        fx.click(fx.row(news_id, '[data-act="check"]'))
        w3 = wait(lambda: (lambda x: x if x["unread"] else None)(fx.by_id(news_id)), 10)
        check("change detected", bool(w3) and w3["unread"] == 1 and w3["changes"] == 1 and len(fx.versions(news_id)) == 2, w3)
        check("change summary counts lines", w3["delta"]["added"] == 1 and w3["delta"]["removed"] == 1
              and "Storm warning" in w3["delta"]["sample"], w3["delta"])
        check("badge shows one changed watch", fx.badge() == "1" and "1 watched page changed" in fx.title(), (fx.badge(), fx.title()))
        check("popup row says Changed with a sample",
              wait(lambda: fx.xjs("return document.querySelector(arguments[0]).dataset.state", fx.row(news_id)) == "changed", 5)
              and "Storm warning" in fx.xtext(fx.row(news_id, ".w-sample")), fx.xtext(fx.row(news_id, ".w-status")))
        check("popup offers Mark all as seen", not fx.xjs("return document.getElementById('seenAll').hidden"))

        # the diff view
        fx.open_changes(news_id)
        check("diff view: added text", fx.xtexts("#diff .r.add .t") == ["Storm warning for Saturday night"], fx.xtexts("#diff .r.add .t"))
        check("diff view: removed text", fx.xtexts("#diff .r.del .t") == ["Road works on Quay Street until Friday"], fx.xtexts("#diff .r.del .t"))
        check("diff view: counts and one change marked new",
              fx.xtext("#counts") == "1 added, 1 removed" and len(fx.xtexts("#versions button")) == 1 and fx.xtexts("#versions .new") == ["new"],
              (fx.xtext("#counts"), fx.xtexts("#versions button")))
        skips = fx.xtexts("#diff .skip")
        eq0 = len(fx.xtexts("#diff .r.eq"))
        check("diff view: a long run of unchanged text is folded away, a short one is shown", skips == ["5 unchanged lines"] and eq0 == 10, (skips, eq0))
        fx.click("#diff .skip")
        check("diff view: a fold opens on click", len(fx.xtexts("#diff .r.eq")) > eq0)
        fx.click("#showAll")
        check("diff view: show unchanged text too", fx.xtexts("#diff .skip") == [] and len(fx.xtexts("#diff .r.eq")) == 15,
              len(fx.xtexts("#diff .r.eq")))
        check("diff view: name and link to the page", fx.xtext("#name") == "Harbour News" and fx.xjs("return document.getElementById('url').href") == NEWS)
        check("opening the diff marks the watch as seen", wait(lambda: fx.by_id(news_id)["unread"] == 0, 5) and fx.badge() == "", fx.badge())

        # an edited line: word-level
        st.news[st.news.index("Ferry timetable updated for winter")] = "Ferry timetable updated for spring"
        res = check_now(fx, news_id)
        check("check now answers with the outcome", res == {"ok": True, "changed": True, "error": None}, res)
        check("diff view updates by itself", wait(lambda: len(fx.xtexts("#versions button")) == 2, 5))
        check("diff view: edited line shows the changed words",
              fx.xtexts("#diff .r.chg.old del") == ["winter"] and fx.xtexts("#diff .r.chg.new ins") == ["spring"]
              and fx.xtexts("#diff .r.chg.new .t") == ["Ferry timetable updated for spring"],
              (fx.xtexts("#diff .r.chg.old del"), fx.xtexts("#diff .r.chg.new ins")))
        fx.click('#versions button[data-index="1"]')
        check("diff view: an older change can be opened", fx.xtexts("#diff .r.add .t") == ["Storm warning for Saturday night"])
        check("diff view: Check now button", (fx.click("#check"), wait(lambda: fx.xtext("#checkMsg") == "No change.", 8))[1], fx.xtext("#checkMsg"))
        wait(lambda: fx.by_id(news_id)["unread"] == 0, 5)

        # ---------------------------------------------------- one part
        fx.page_get(f"{SHOP}/setcookie")
        fx.page_get(KETTLE)
        visit = st.requests("/shop/kettle", checks=False)
        check("the browser itself sends the site's cookie", visit and "sid=secret" in (visit[-1]["cookie"] or ""), visit[-1]["cookie"] if visit else None)
        check("picker starts from the popup", start_pick(fx, KETTLE, "Blue Kettle - Harbour Shop"), fx.overlay())
        check("second site asked for on its own", fx.origins() == [pat(NEWS_HOST), pat(SHOP_HOST)], fx.origins())
        pr = fx.rect("#price")
        fx.move(pr["cx"] - 3, pr["cy"])
        fx.move(pr["cx"], pr["cy"])
        c = wait(lambda: (lambda x: x if x and x["box"] else None)(fx.card()), 5)
        check("picker outlines the element under the pointer", bool(c) and near(c["box"], grow(pr)) and c["tag"] == f"{EURO} 24.99", c)
        check("picker shows how to use it", bool(c) and "Click the part" in (c["hint"] or ""), c and c["hint"])
        fx.keys(Keys.ARROW_UP, Keys.ARROW_UP)
        time.sleep(0.3)
        check("arrow up widens the selection", near(fx.card()["box"], grow(fx.rect(".buy"))), (fx.card()["box"], fx.rect(".buy")))
        fx.keys(Keys.ARROW_DOWN, Keys.ARROW_DOWN)
        time.sleep(0.3)
        check("arrow down narrows it again", near(fx.card()["box"], grow(pr)), fx.card()["box"])
        fx.click_at(pr["cx"], pr["cy"])
        check("picking a part saves a watch", wait(lambda: fx.overlay() == "ok", 15), fx.card())
        kw = fx.watch(url=KETTLE)
        check("watch stores a selector for the part", bool(kw) and kw["selector"] == "#price", kw and kw["selector"])
        kettle_id = kw["id"]
        check("first version is just that part's text", fx.text(kettle_id) == f"{EURO} 24.99", fx.text(kettle_id))
        ctext = (fx.card() or {}).get("text") or ""
        check("page confirms and shows what Heron sees", "watching this part" in ctext and f"It sees: “{EURO} 24.99”" in ctext, ctext)
        check("the click did not reach the page (link not followed, page handler not run)",
              fx.js("return [location.pathname, window.clicks]") == ["/shop/kettle", 0], fx.js("return [location.pathname, window.clicks]"))
        close_card(fx)
        shop_checks = st.requests(host=SHOP_HOST, checks=True)
        check("checks are sent without cookies", len(shop_checks) >= 1 and all(c["cookie"] is None for c in shop_checks),
              [c["cookie"] for c in shop_checks])

        st.stock = "Only 2 left"  # outside the watched part; the clock also changes on every request
        check_now(fx, kettle_id)
        check("a change outside the watched part is ignored", fx.by_id(kettle_id)["unread"] == 0 and len(fx.versions(kettle_id)) == 1)
        st.price = f"{EURO} 19.99"
        check_now(fx, kettle_id)
        kw = fx.by_id(kettle_id)
        check("a change inside the watched part is detected", kw["unread"] == 1 and fx.text(kettle_id) == f"{EURO} 19.99", kw["unread"])
        check("summary shows old and new value", kw["delta"]["sample"] == "24.99 → 19.99", kw["delta"])
        fx.open_changes(kettle_id)
        check("diff view of a part: old and new words",
              fx.xtexts("#diff del") == ["24.99"] and fx.xtexts("#diff ins") == ["19.99"] and "One part" in fx.xtext("#meta"),
              (fx.xtexts("#diff del"), fx.xtexts("#diff ins")))
        wait(lambda: fx.by_id(kettle_id)["unread"] == 0, 5)

        # Esc cancels
        n_before = len(fx.watches())
        start_pick(fx, KETTLE, "Blue Kettle - Harbour Shop")
        fx.keys(Keys.ESCAPE)
        check("Esc cancels picking", wait(lambda: fx.overlay() is None, 3) and len(fx.watches()) == n_before
              and "pending" not in fx.store("pending"), fx.store("pending"))

        # picking the same part again
        start_pick(fx, KETTLE, "Blue Kettle - Harbour Shop")
        check("same part twice is refused", pick(fx, "#price", want=("ok", "problem")) == "problem"
              and "Already watching" in (fx.card() or {}).get("text", "") and len(fx.watches()) == n_before, fx.card())
        close_card(fx)

        # an element without an id
        fx.page_get(DEALS)
        start_pick(fx, DEALS, "Deals - Harbour Shop")
        check("part without an id can be picked", pick(fx, ".amount", 1) == "ok", fx.card())
        dw = fx.watch(url=DEALS)
        deals_id = dw["id"]
        check("selector built from classes and position", "#" not in dw["selector"] and "nth-of-type(2)" in dw["selector"]
              and fx.text(deals_id) == "12.50", (dw["selector"], fx.text(deals_id)))
        close_card(fx)
        st.deals = [("Teapot", "17.00"), ("Mug set", "12.50"), ("Tray", "8.00")]
        check_now(fx, deals_id)
        check("neighbouring parts changing is ignored", fx.by_id(deals_id)["unread"] == 0)
        st.deals = [("Teapot", "17.00"), ("Mug set", "11.00"), ("Tray", "8.00")]
        check_now(fx, deals_id)
        check("the picked part changing is detected", fx.by_id(deals_id)["unread"] == 1 and fx.text(deals_id) == "11.00")

        # a page with a strict Content-Security-Policy
        fx.page_get(KETTLE + "?csp=1")
        start_pick(fx, KETTLE + "?csp=1", "Blue Kettle - Harbour Shop")
        check("picker works under a strict page CSP", pick(fx, ".stock") == "ok", fx.card())
        sw = fx.watch(url=KETTLE + "?csp=1")
        check("part picked by class", bool(sw) and "stock" in sw["selector"] and fx.text(sw["id"]) == "Only 2 left", sw and sw["selector"])
        close_card(fx)

        # ------------------------------------ parts drawn by JavaScript
        n_before = len(fx.watches())
        fx.page_get(f"{APP}/spa")
        start_pick(fx, f"{APP}/spa", "Harbour Live")
        check("a part drawn by JavaScript is recognised", pick(fx, "#live", want=("ok", "jsdrawn", "problem")) == "jsdrawn", fx.card())
        c = fx.card()
        check("and explained, with three ways on",
              "can't see this part" in c["text"] and "JavaScript" in c["text"]
              and [b["label"] for b in c["buttons"]] == ["Pick another part", "Watch the whole page", "Cancel"], c)
        check("nothing was added for it", len(fx.watches()) == n_before)
        fx.card_click("Watch the whole page")
        check("fallback: watch the whole page", wait(lambda: fx.overlay() == "ok", 15), fx.card())
        spa = fx.watch(url=f"{APP}/spa")
        check("whole-page watch on a script-drawn page carries a warning",
              bool(spa) and spa["selector"] == "" and (spa.get("warn") or {}).get("code") in ("thin", "partial")
              and "JavaScript" in (fx.card() or {}).get("text", ""), spa and spa.get("warn"))
        close_card(fx)

        fx.page_get(f"{APP}/spa2")
        start_pick(fx, f"{APP}/spa2", "Harbour Counter")
        check("an element that is in the HTML but filled in by a script is recognised too",
              pick(fx, "#count", want=("ok", "jsdrawn", "problem")) == "jsdrawn", fx.card())
        fx.card_click("Pick another part")
        check("pick another part goes back to picking", wait(lambda: fx.overlay() == "picking", 5), fx.overlay())
        check("a server-sent part of the same page works", pick(fx, "h1") == "ok" and fx.text(fx.watch(url=f"{APP}/spa2")["id"]) == "Harbour Counter",
              fx.card())
        close_card(fx)

        fx.page_get(f"{APP}/spa")
        start_pick(fx, f"{APP}/spa", "Harbour Live")
        pick(fx, "#live", want=("jsdrawn",))
        n_now = len(fx.watches())
        fx.card_click("Cancel")
        check("cancel after the warning adds nothing", wait(lambda: fx.overlay() is None, 3) and len(fx.watches()) == n_now
              and "pending" not in fx.store("pending"))

        fx.page_get(f"{APP}/half")
        fx.open_popup(f"{APP}/half", "Harbour Dashboard")
        fx.click("#addPage")
        hw = wait(lambda: (lambda x: x if x and x.get("lastCheck") else None)(fx.watch(url=f"{APP}/half")), 15)
        check("whole page mostly drawn by JavaScript: warned with a share",
              bool(hw) and (hw.get("warn") or {}).get("code") == "partial" and hw["warn"]["pct"] < 50, hw and hw.get("warn"))
        check("popup shows that warning", wait(lambda: "JavaScript" in (fx.xtext("#hereMsg") or ""), 5)
              and "JavaScript" in (fx.xtext(fx.row(hw["id"], '.note[data-role="warn"]')) or ""), fx.xtext("#hereMsg"))
        wait(lambda: fx.overlay() == "ok", 5)
        close_card(fx)
        check("three sites, each asked for on its own", fx.origins() == sorted(pat(h) for h in (NEWS_HOST, SHOP_HOST, APP_HOST)), fx.origins())

        # ------------------------------------------- schedule and pause
        fx.open_popup(NEWS, "Harbour News")
        fx.click(fx.row(news_id, '[data-act="pause"]'))
        check("pause from the list", wait(lambda: fx.by_id(news_id)["paused"] is True, 5)
              and fx.xjs("return document.querySelector(arguments[0]).dataset.state", fx.row(news_id)) == "paused")
        st.news.append("Paused headline that nobody checks")
        before = {x["id"]: x["lastCheck"] for x in fx.watches()}
        shop_ids = [x["id"] for x in fx.watches() if SHOP_HOST in x["url"]]
        t0 = time.time()
        fx.set_watches("for (const w of list) w.nextCheck = now + 3000;")
        fx.send("sync")
        al = fx.alarms()
        check("alarm follows the earliest due watch", len(al) == 1 and 1500 < al[0]["scheduledTime"] - t0 * 1000 < 4500,
              al and al[0]["scheduledTime"] - t0 * 1000)
        done = wait(lambda: all(x["lastCheck"] > before[x["id"]] for x in fx.watches() if not x["paused"]), 30, 0.3)
        check("due watches are checked by the alarm, without anyone asking", done,
              [(x["name"], x["lastCheck"] > before[x["id"]]) for x in fx.watches()])
        check("a paused watch is skipped", fx.by_id(news_id)["lastCheck"] == before[news_id] and fx.by_id(news_id)["unread"] == 0)
        run = sorted(r["t"] for r in st.requests(host=SHOP_HOST, checks=True) if r["t"] > t0)
        gaps = [b - a for a, b in zip(run, run[1:])]
        check("checks on one site are spaced out", len(run) == len(shop_ids) == 3 and all(g >= 1.4 for g in gaps), gaps)
        time.sleep(0.5)
        al = fx.alarms()
        nxt = min(x["nextCheck"] for x in fx.watches() if not x["paused"])
        check("alarm set again for the next due watch", len(al) == 1 and abs(al[0]["scheduledTime"] - nxt) < 1500, (al, nxt))

        res = check_now(fx, news_id)
        check("check now also works on a paused watch", res["changed"] is True and fx.by_id(news_id)["unread"] == 1, res)
        before_resume = fx.by_id(news_id)["lastCheck"]
        st.news.append("Headline printed after resuming")
        fx.click(fx.row(news_id, '[data-act="pause"]'))
        check("resume checks soon after", wait(lambda: fx.by_id(news_id)["paused"] is False and fx.by_id(news_id)["lastCheck"] > before_resume, 10),
              fx.by_id(news_id)["paused"])
        fx.send("watch:update", id=kettle_id, patch={"interval": 1})
        check("interval can not go below 5 minutes", fx.by_id(kettle_id)["interval"] == 5, fx.by_id(kettle_id)["interval"])
        fx.send("watch:update", id=kettle_id, patch={"interval": 60})
        fx.click("#seenAll")
        check("mark all as seen", wait(lambda: all(x["unread"] == 0 for x in fx.watches()), 5) and fx.badge() == "", fx.badge())

        # ------------------------------------------------------ problems
        flaky = add_by_url(fx, f"{MISC}/flaky", "Status page")
        check("add by address from the dashboard", bool(flaky) and flaky["name"] == "Status page"
              and fx.text(flaky["id"]) == "Status\nAll systems normal", flaky and fx.text(flaky["id"]))
        flaky_id = flaky["id"]
        check("dashboard confirms the add", "Added" in (fx.xtext("#addMsg") or ""), fx.xtext("#addMsg"))
        check("fourth site asked for from the dashboard", pat(MISC_HOST) in fx.origins(), fx.origins())
        st.flaky_status = 500
        res = check_now(fx, flaky_id)
        f1 = fx.by_id(flaky_id)
        check("server error is recorded, not reported as a change",
              res["error"] == "server" and f1["error"]["code"] == "server" and f1["error"]["count"] == 1 and f1["unread"] == 0
              and len(fx.versions(flaky_id)) == 1 and fx.badge() == "", (res, f1["error"]))
        check("the row explains the problem", "server error" in (fx.xtext(fx.row(flaky_id, '.note[data-role="error"]')) or "").lower(),
              fx.xtext(fx.row(flaky_id, ".note")))
        check_now(fx, flaky_id)
        check_now(fx, flaky_id)
        check("three failed checks in a row flag the toolbar button",
              fx.by_id(flaky_id)["error"]["count"] == 3 and fx.badge() == "!" and "needs a look" in fx.title(), (fx.badge(), fx.title()))
        st.flaky_status = 404
        check_now(fx, flaky_id)
        check("a missing page is told apart", fx.by_id(flaky_id)["error"]["code"] == "notfound" and fx.by_id(flaky_id)["error"]["count"] == 1)
        st.flaky_status = 200
        check_now(fx, flaky_id)
        f2 = fx.by_id(flaky_id)
        check("recovery clears the problem without a false change", f2["error"] is None and f2["unread"] == 0 and fx.badge() == "", (f2["error"], fx.badge()))

        gone = add_by_url(fx, GONE, "Gone site")
        check("unreachable site: watch kept, problem shown, tried again sooner",
              bool(gone) and gone["error"]["code"] == "network" and 9 * 60000 <= gone["nextCheck"] - gone["lastCheck"] <= 11 * 60000
              and "first check did not work" in (fx.xtext("#addMsg") or ""), (gone and gone["error"], fx.xtext("#addMsg")))
        gone_id = gone["id"]
        for path, code in (("/account", "login"), ("/members", "blocked"), ("/image.png", "type"), ("/huge", "toobig"), ("/slow", "timeout")):
            x = add_by_url(fx, MISC + path, "Problem " + code, timeout=40)
            check(f"{path}: recognised as '{code}'", bool(x) and (x["error"] or {}).get("code") == code and fx.versions(x["id"]) == [], x and x["error"])
            fx.send("watch:delete", id=x["id"])

        st.deals = None  # the site was rebuilt: the watched part is gone
        check_now(fx, deals_id)
        d1 = fx.by_id(deals_id)
        check("watched part gone from the page: flagged, saved versions kept",
              d1["error"]["code"] == "missing" and len(fx.versions(deals_id)) == 2 and fx.text(deals_id) == "11.00", d1["error"])
        check("a part that is gone flags the toolbar button at once", fx.badge() == "!", fx.badge())
        st.deals = [("Teapot", "17.00"), ("Mug set", "11.00"), ("Tray", "8.00")]
        check_now(fx, deals_id)
        d2 = fx.by_id(deals_id)
        check("part back: problem cleared, no false change", d2["error"] is None and d2["unread"] == 0 and len(fx.versions(deals_id)) == 2, d2)
        fx.send("seen:all")

        fx.api("await browser.permissions.remove({ origins: [arguments[0]] }); return true;", pat(NEWS_HOST))
        n_req = len(st.requests("/news", checks=True))
        check_now(fx, news_id)
        check("site access taken away: no request is made and the watch says so",
              fx.by_id(news_id)["error"]["code"] == "permission" and len(st.requests("/news", checks=True)) == n_req, fx.by_id(news_id)["error"])
        fx.open_app()
        fx.click(fx.row(news_id, '[data-act="access"]'))
        check("Give access asks for the site again and checks",
              wait(lambda: fx.by_id(news_id)["error"] is None, 10) and pat(NEWS_HOST) in fx.origins(), fx.by_id(news_id)["error"])
        fx.send("seen:all")

        # -------------------------------------------------------- limits
        big = add_by_url(fx, f"{MISC}/big", "Long report")
        big_id = big["id"]
        check("a very long page is cut at 100,000 characters and says so",
              big["truncated"] is True and 90000 < big["size"] <= 100000 and len(fx.text(big_id)) == big["size"]
              and "100,000" in (fx.xtext(fx.row(big_id, '.note[data-role="warn"]')) or ""), (big["truncated"], big["size"]))
        for mark in ("second", "third", "fourth", "fifth", "sixth"):
            st.big_mark = mark
            check_now(fx, big_id)
        vs = fx.versions(big_id)
        check("saved history of one watch stays under 400,000 characters",
              fx.by_id(big_id)["changes"] == 5 and 2 <= len(vs) <= 4 and sum(len(v["text"]) for v in vs) <= 400000
              and "sixth" in vs[-1]["text"], (len(vs), sum(len(v["text"]) for v in vs)))
        fx.send("watch:delete", id=big_id)
        check("deleting a watch deletes its saved versions", "snap:" + big_id not in fx.store(None))

        notes = add_by_url(fx, f"{MISC}/notes.txt", "Notes")
        notes_id = notes["id"]
        check("plain text files can be watched", fx.text(notes_id) == "line one\nline two", fx.text(notes_id))
        for i in range(12):
            st.notes = f"line one\nline {i}"
            check_now(fx, notes_id)
        nw = fx.by_id(notes_id)
        check("only the last 10 versions are kept", nw["changes"] == 12 and nw["unread"] == 12 and len(fx.versions(notes_id)) == 10,
              (nw["changes"], len(fx.versions(notes_id))))
        check("stats count every caught change", fx.store("stats")["stats"]["changes"] >= 12, fx.store("stats"))
        lat = add_by_url(fx, f"{MISC}/latin1", "Menu")
        check("page in ISO-8859-1 is decoded with its own character set", fx.text(lat["id"]) == "Café crème à volonté", fx.text(lat["id"]))
        meta = add_by_url(fx, f"{MISC}/meta-latin1", "Menu 2")
        check("character set from a meta tag", fx.text(meta["id"]) == f"Crème brûlée {EURO} 6", fx.text(meta["id"]))
        tab = add_by_url(fx, f"{MISC}/table", "Prices")
        check("table rows become one line each",
              fx.text(tab["id"]).split("\n") == ["Item | Price | Stock", "Kettle | 24.99 | In stock", "Teapot | 18.00 | Sold out"], fx.text(tab["id"]))
        sel = add_by_url(fx, f"{MISC}/table", "Teapot row", "tbody tr:nth-of-type(2)")
        check("a part can be given as a CSS selector", bool(sel) and fx.text(sel["id"]) == "Teapot | 18.00 | Sold out", sel and fx.text(sel["id"]))
        n_before = len(fx.watches())
        fx.xjs("document.getElementById('addUrl').value = arguments[0]; document.getElementById('addSelector').value = 'div[';", f"{MISC}/table")
        fx.click("#addGo")
        check("an invalid selector is refused", wait(lambda: "not valid" in (fx.xtext("#addMsg") or ""), 3) and len(fx.watches()) == n_before)
        fx.xjs("document.getElementById('addUrl').value = 'ftp://example.com/file'; document.getElementById('addSelector').value = '';")
        fx.click("#addGo")
        check("only http and https addresses are accepted", wait(lambda: "address of a web page" in (fx.xtext("#addMsg") or ""), 3)
              and len(fx.watches()) == n_before, fx.xtext("#addMsg"))
        for x in (lat, meta, tab, sel):
            fx.send("watch:delete", id=x["id"])
        fx.send("seen:all")

        # ------------------------------------------------- notifications
        check("notifications are off and not permitted by default",
              fx.api("return await browser.permissions.contains({ permissions: ['notifications'] });") is False
              and not (fx.store("settings").get("settings") or {}).get("notify"))
        fx.open_app()
        fx.click("#notify")
        check("switching notifications on asks for the permission",
              wait(lambda: (fx.store("settings").get("settings") or {}).get("notify") is True, 5)
              and fx.api("return await browser.permissions.contains({ permissions: ['notifications'] });") is True)
        st.news.insert(0, "Regatta postponed to Sunday")
        fx.set_watches(f"for (const w of list) if (w.id === {json.dumps(news_id)}) w.nextCheck = now - 1000;")
        fx.send("sync")
        wait(lambda: fx.by_id(news_id)["unread"] == 1, 15)
        notes_all = wait(lambda: fx.api("return await browser.notifications.getAll();"), 5) or {}
        key = next((k for k in notes_all if k.startswith(f"change:{news_id}:")), None)
        check("a change found by the schedule shows a desktop notification",
              bool(key) and notes_all[key]["title"] == "Changed: Harbour News" and "Regatta postponed" in notes_all[key]["message"], notes_all)
        fx.api("for (const k of Object.keys(await browser.notifications.getAll())) await browser.notifications.clear(k); return true;")
        st.price = f"{EURO} 21.50"
        check_now(fx, kettle_id)
        time.sleep(0.5)
        check("a check the user asked for does not also notify",
              fx.by_id(kettle_id)["unread"] == 1 and fx.api("return Object.keys(await browser.notifications.getAll());") == [])
        st.news.insert(0, "Harbour office closed on Monday")
        st.price = f"{EURO} 22.00"
        st.deals = [("Teapot", "17.00"), ("Mug set", "10.00"), ("Tray", "8.00")]
        st.notes = "line one\nline last"
        four = [news_id, kettle_id, deals_id, notes_id]
        unread0 = {i: fx.by_id(i)["unread"] for i in four}
        fx.set_watches(f"for (const w of list) if ({json.dumps(four)}.includes(w.id)) w.nextCheck = now - 1000;")
        fx.send("sync")
        wait(lambda: all(fx.by_id(i)["unread"] > unread0[i] for i in four), 20, 0.3)
        many = wait(lambda: fx.api("return await browser.notifications.getAll();"), 5) or {}
        check("many changes at once give one notification, not a pile",
              len(many) == 1 and next(iter(many)).startswith("changes:") and next(iter(many.values()))["title"] == "4 watched pages changed", many)
        check("badge counts changed watches", fx.badge() == "4", fx.badge())
        fx.api("for (const k of Object.keys(await browser.notifications.getAll())) await browser.notifications.clear(k); return true;")
        fx.click("#notify")
        check("notifications can be switched off again", wait(lambda: (fx.store("settings").get("settings") or {}).get("notify") is False, 5))
        Select(fx.d.find_element(By.ID, "defEvery")).select_by_value("180")
        check("default interval setting is saved", wait(lambda: (fx.store("settings").get("settings") or {}).get("interval") == 180, 5))

        # ------------------------------------------------ popup extras
        fx.open_popup(NEWS, "Harbour News")
        check("new watches use the default interval", fx.xjs("return document.getElementById('hereEvery').value") == "180")
        check("popup is 400 px wide and nothing sticks out", fx.xjs("return [document.body.offsetWidth, document.body.scrollWidth]") == [400, 400],
              fx.xjs("return [document.body.offsetWidth, document.body.scrollWidth]"))
        check("one-time thank-you card after 10 caught changes",
              wait(lambda: fx.xjs("return !document.getElementById('supportCard').hidden"), 5) and "10 changes" in (fx.xtext("#supportCard p") or ""),
              fx.xtext("#supportCard p"))
        fx.click("#supportCard .link-btn")
        check("the card is remembered so it never repeats", 10 in (fx.store("supportNudge").get("supportNudge") or {}).get("seen", []))
        before = {x["id"]: x["lastCheck"] for x in fx.watches()}
        fx.click("#checkAll")
        check("Check all now checks every watch that is not paused",
              wait(lambda: all(x["lastCheck"] > before[x["id"]] for x in fx.watches() if not x["paused"]) and fx.xtext("#checkAll") == "Check all now", 40, 0.3),
              [(x["name"], x["lastCheck"] > before[x["id"]]) for x in fx.watches()])

        # ---------------------------------------------------------- edit
        handles = set(fx.d.window_handles)
        fx.click(fx.row(kettle_id, '[data-act="edit"]'))
        new = wait(lambda: set(fx.d.window_handles) - handles, 5)
        fx.d.switch_to.window(next(iter(new)))
        fx.ready()
        check("Edit in the popup opens the edit form on the dashboard",
              wait(lambda: fx.d.execute_script("return document.getElementById('editDialog').open"), 5)
              and fx.d.execute_script("return [editName.value, editUrl.value, editSelector.value, editEvery.value]")
              == ["Blue Kettle - Harbour Shop", KETTLE, "#price", "60"],
              fx.d.execute_script("return [editName.value, editUrl.value, editSelector.value, editEvery.value]"))
        fx.d.execute_script("editName.value = 'Kettle price';")
        Select(fx.d.find_element(By.ID, "editEvery")).select_by_value("15")
        nver = len(fx.versions(kettle_id)) if False else None
        fx.d.find_element(By.ID, "editSave").click()
        wait(lambda: not fx.d.execute_script("return document.getElementById('editDialog').open"), 5)
        fx.d.close()
        fx.d.switch_to.window(fx.ext)
        ke = fx.by_id(kettle_id)
        check("rename and new interval are saved, history kept", ke["name"] == "Kettle price" and ke["interval"] == 15 and len(fx.versions(kettle_id)) >= 3,
              (ke["name"], ke["interval"], len(fx.versions(kettle_id)), nver))
        fx.open_app(f"#edit={news_id}")
        wait(lambda: fx.xjs("return document.getElementById('editDialog').open"), 5)
        fx.xjs("editUrl.value = arguments[0];", NEWS + "?edition=2")
        fx.click("#editSave")
        ne = wait(lambda: (lambda x: x if x["url"].endswith("edition=2") and x["lastCheck"] else None)(fx.by_id(news_id)), 10)
        check("a new address starts the watch over", bool(ne) and ne["unread"] == 0 and len(fx.versions(news_id)) == 1 and ne["error"] is None, ne)
        NEWS2 = NEWS + "?edition=2"

        # -------------------------------------------------------- export
        expected = [{"name": x["name"], "url": x["url"], "selector": x["selector"], "interval": x["interval"], "paused": x["paused"]} for x in fx.watches()]
        fx.send("watch:pause", id=deals_id, paused=True)
        expected = [{"name": x["name"], "url": x["url"], "selector": x["selector"], "interval": x["interval"], "paused": x["paused"]} for x in fx.watches()]
        fx.open_app()
        fx.click("#exportGo")
        files = wait(lambda: [p for p in downloads.glob("heron-watches-*.json") if p.stat().st_size > 0], 10)
        data = json.loads(files[0].read_text(encoding="utf-8")) if files else {}
        check("export writes the watch list as a file", data.get("kind") == "heron-watch-list" and data.get("version") == 1
              and sorted(data["watches"], key=lambda x: (x["url"], x["selector"])) == sorted(expected, key=lambda x: (x["url"], x["selector"])),
              data.get("watches"))
        check("export holds no page text", "24.99" not in json.dumps(data) and "Harbour bridge" not in json.dumps(data))

        # -------------------------------------------------------- delete
        fx.click(fx.row(gone_id, '[data-act="delete"]'))
        check("delete asks first", wait(lambda: fx.xtext(fx.row(gone_id, '[data-act="delete"]')) == "Delete?", 3) and fx.by_id(gone_id) is not None)
        fx.click(fx.row(gone_id, '[data-act="delete"]'))
        check("second click deletes", wait(lambda: fx.by_id(gone_id) is None, 5))
        check("site access is given back when its last watch goes", pat(GONE_HOST) not in fx.origins(), fx.origins())
        check("access for sites still watched stays", pat(SHOP_HOST) in fx.origins())
        for x in fx.watches():
            fx.send("watch:delete", id=x["id"])
        leftovers = [k for k in fx.store(None) if k.startswith("snap:")]
        check("deleting everything leaves no site access, no saved text, no alarm, no badge",
              fx.watches() == [] and fx.origins() == [] and leftovers == [] and fx.alarms() == [] and fx.badge() == "",
              (fx.origins(), leftovers, fx.alarms(), fx.badge()))

        # -------------------------------------------------------- import
        sites = {x["url"].split("/")[2].split(":")[0] for x in expected}
        fx.open_app()
        fx.d.find_element(By.ID, "importFile").send_keys(str(files[0]))
        check("import shows what is in the file before doing anything",
              wait(lambda: not fx.xjs("return document.getElementById('importPreview').hidden"), 5)
              and f"{len(expected)} watches on {len(sites)} sites" in fx.xtext("#importText") and fx.watches() == [], fx.xtext("#importText"))
        fx.click("#importGo")
        check("import restores every watch", wait(lambda: len(fx.watches()) == len(expected), 10), len(fx.watches()))
        got = [{"name": x["name"], "url": x["url"], "selector": x["selector"], "interval": x["interval"], "paused": x["paused"]} for x in fx.watches()]
        check("names, addresses, parts, intervals and pauses survive the round trip",
              sorted(got, key=lambda x: (x["url"], x["selector"])) == sorted(expected, key=lambda x: (x["url"], x["selector"])), got)
        check("import asks for exactly the sites in the file", len(sites) == 5 and fx.origins() == sorted(pat(h) for h in sites), fx.origins())
        check("imported watches get their first version in the background",
              wait(lambda: all(x["lastCheck"] or x["paused"] for x in fx.watches()), 40, 0.3)
              and fx.text(fx.watch(url=KETTLE)["id"]) == f"{EURO} 22.00", [(x["name"], x["lastCheck"]) for x in fx.watches()])
        check("a paused imported watch stays unchecked", fx.watch(url=DEALS)["paused"] is True and fx.watch(url=DEALS)["lastCheck"] == 0)
        check("import message", "Imported" in (fx.xtext("#backupMsg") or ""), fx.xtext("#backupMsg"))
        fx.d.find_element(By.ID, "importFile").send_keys(str(files[0]))
        wait(lambda: not fx.xjs("return document.getElementById('importPreview').hidden"), 5)
        fx.click("#importGo")
        check("importing the same file again adds nothing",
              wait(lambda: "already existed" in (fx.xtext("#backupMsg") or ""), 10) and len(fx.watches()) == len(expected), fx.xtext("#backupMsg"))
        bad = downloads / "not-a-list.json"
        bad.write_text("{ this is not json", encoding="utf-8")
        fx.d.find_element(By.ID, "importFile").send_keys(str(bad))
        check("a file that is not a watch list is refused", wait(lambda: "not a Heron watch list" in (fx.xtext("#backupMsg") or ""), 5)
              and fx.xjs("return document.getElementById('importPreview').hidden"), fx.xtext("#backupMsg"))
        mixed = downloads / "mixed.json"
        mixed.write_text(json.dumps({"kind": "heron-watch-list", "version": 1, "watches": [
            {"name": "Fast", "url": f"{MISC}/table", "selector": "", "interval": 1},
            {"name": "Script", "url": "javascript:alert(1)"},
            {"name": "Bad part", "url": f"{MISC}/table", "selector": "td["},
            "nonsense",
        ]}), encoding="utf-8")
        fx.d.find_element(By.ID, "importFile").send_keys(str(mixed))
        wait(lambda: not fx.xjs("return document.getElementById('importPreview').hidden"), 5)
        check("unusable entries are counted and left out", "3 entries in the file can't be used" in fx.xtext("#importText"), fx.xtext("#importText"))
        fx.click("#importGo")
        fast = wait(lambda: fx.watch(name="Fast"), 10)
        check("an imported interval below the minimum is raised to 5 minutes", bool(fast) and fast["interval"] == 5
              and len(fx.watches()) == len(expected) + 1, fast and fast["interval"])

        fx.open_app()
        check("dashboard has the Support section with the Ko-fi link",
              fx.xjs("return [...document.querySelectorAll('[data-support]')].every((a) => a.href === 'https://ko-fi.com/carcer7378')")
              and "unlocked for everyone" in fx.xtext("main"))
        check_more_addons(fx.api)
        check("dashboard explains the limits", "JavaScript" in fx.xtext("main") and "without your cookies" in fx.xtext("main"))
        every = st.requests(checks=True)
        check("no check in the whole run carried a cookie", len(every) > 60 and all(r["cookie"] is None for r in every), len(every))
        check("every check was a GET", all(r["method"] == "GET" for r in every))
    finally:
        fx.quit()
        shutil.rmtree(downloads, ignore_errors=True)


# ================================================================= prompt

def session_prompt(unpacked):
    """The real toolbar popup and the real permission prompt, answered like a user would."""
    fx = Fx(unpacked, auto_grant=False)
    try:
        st.reset()
        fx.page_get(NEWS)
        where = fx.click_toolbar_button()
        check("toolbar button sits in the navigation bar", where == "nav-bar", where)
        check("the real popup opens", wait(lambda: (fx.popup_panel() or "").startswith(f"{EXT}/popup/popup.html"), 5), fx.popup_panel())
        got = wait(lambda: (lambda r: r if r and r.get("text") else None)(fx.popup_read("#hereTitle")), 5)
        check("popup reads the tab through activeTab alone", bool(got) and got["text"] == "Harbour News"
              and (fx.popup_read("#hereUrl") or {}).get("text") == f"{NEWS_HOST}:{PORT}/news", got)
        fx.popup_press("#addPage")
        p = wait(fx.prompt, 8)
        texts = " | ".join(p["texts"]) if p else ""
        check("Firefox asks, naming the add-on and only this site", bool(p) and NEWS_HOST in texts and "Heron" in texts
              and "all websites" not in texts.lower() and SHOP_HOST not in texts, texts)
        print("     prompt text:", texts.encode("ascii", "replace").decode())
        fx.prompt_answer(False)
        time.sleep(1.5)
        check("answering no adds nothing and grants nothing", fx.watches() == [] and fx.origins() == [] and "pending" not in fx.store("pending"),
              (fx.watches(), fx.origins(), fx.store("pending")))
        print("     popup after 'no':", fx.popup_panel(), (fx.popup_read("#hereMsg") or {}))

        fx.to_page()
        if not fx.popup_panel():
            fx.click_toolbar_button()
            wait(lambda: (fx.popup_panel() or "").startswith(f"{EXT}/popup/popup.html"), 5)
            wait(lambda: (fx.popup_read("#hereTitle") or {}).get("text"), 5)
        fx.popup_press("#addPage")
        p = wait(fx.prompt, 8)
        check("the prompt comes again on a new try", bool(p), p)
        fx.prompt_answer(True)
        w = wait(lambda: (lambda x: x if x and x.get("lastCheck") else None)(fx.watch(url=NEWS)), 15)
        check("answering yes adds the watch with its first version", bool(w) and len(fx.versions(w["id"])) == 1, w)
        check("exactly one site was granted", fx.origins() == [pat(NEWS_HOST)], fx.origins())
        panel = fx.popup_panel()
        print("     popup after 'yes':", panel)
        if panel:
            check("the popup, still open, confirms", wait(lambda: "watching this page" in ((fx.popup_read("#hereMsg") or {}).get("text") or ""), 5),
                  fx.popup_read("#hereMsg"))
        else:
            check("the popup closed for the prompt, so the page confirms", wait(lambda: fx.overlay() == "ok", 8)
                  and "watching this page" in (fx.card() or {}).get("text", ""), fx.card())

        # one part, from the real popup: the site is already allowed, so no second prompt
        fx.page_get(NEWS)
        fx.click_toolbar_button()
        wait(lambda: (fx.popup_read("#hereTitle") or {}).get("text"), 5)
        check("popup knows this page is watched", (fx.popup_read("#addPage") or {}).get("disabled") is True
              and "Firefox will ask" not in (fx.popup_read("#hereNote") or {}).get("text", "x"), fx.popup_read("#hereNote"))
        fx.popup_press("#addPart")
        check("picker starts without a second prompt and the popup gets out of the way",
              wait(lambda: fx.overlay() == "picking", 8) and fx.prompt() is None and wait(lambda: fx.popup_panel() is None, 5), (fx.overlay(), fx.popup_panel()))
        r = fx.rect("footer p", 1)
        fx.move(r["cx"] - 3, r["cy"])
        fx.click_at(r["cx"], r["cy"])
        check("part picked after a real popup click", wait(lambda: fx.overlay() == "ok", 15)
              and fx.text(fx.watch(url=NEWS, selector=fx.watches()[-1]["selector"])["id"]) == "Contact: desk@harbour.example", fx.card())

        # a second site: its own prompt
        fx.page_get(KETTLE)
        fx.click_toolbar_button()
        wait(lambda: (fx.popup_read("#hereTitle") or {}).get("text"), 5)
        fx.popup_press("#addPart")
        p = wait(fx.prompt, 8)
        texts = " | ".join(p["texts"]) if p else ""
        check("a second site gets its own prompt", bool(p) and SHOP_HOST in texts and NEWS_HOST not in texts, texts)
        fx.prompt_answer(True)
        check("after yes the picker starts in the page", wait(lambda: fx.overlay() == "picking", 8), fx.overlay())
        check("one part on the second site", pick(fx, "#price") == "ok" and fx.origins() == [pat(NEWS_HOST), pat(SHOP_HOST)], fx.origins())

        # the dashboard asks the same way: add by address
        fx.open_app()
        fx.xjs("document.getElementById('addUrl').value = arguments[0];", f"{MISC}/table")
        fx.click("#addGo")
        p = wait(lambda: fx.prompt(ext=True), 8)
        texts = " | ".join(p["texts"]) if p else ""
        check("adding by address shows the prompt for that site only", bool(p) and MISC_HOST in texts and NEWS_HOST not in texts
              and fx.watch(url=f"{MISC}/table") is None, texts)
        fx.prompt_answer(False, ext=True)
        check("no to that prompt: nothing added, and the dashboard says why",
              wait(lambda: "Nothing was added" in (fx.xtext("#addMsg") or ""), 5) and fx.watch(url=f"{MISC}/table") is None
              and pat(MISC_HOST) not in fx.origins(), fx.xtext("#addMsg"))
        fx.click("#addGo")
        wait(lambda: fx.prompt(ext=True), 8)
        fx.prompt_answer(True, ext=True)
        check("yes: the watch is added from the dashboard",
              wait(lambda: (fx.watch(url=f"{MISC}/table") or {}).get("lastCheck"), 15) and pat(MISC_HOST) in fx.origins(), fx.origins())

        # notifications: Firefox's own prompt, and "no" leaves them off
        fx.click("#notify")
        p = wait(lambda: fx.prompt(ext=True), 8)
        texts = " | ".join(p["texts"]) if p else ""
        check("switching notifications on shows Firefox's prompt", bool(p) and "notification" in texts.lower(), texts)
        fx.prompt_answer(False, ext=True)
        check("no: notifications stay off and the box is unticked again",
              wait(lambda: "stay off" in (fx.xtext("#settingsMsg") or ""), 5) and not fx.xjs("return document.getElementById('notify').checked")
              and not (fx.store("settings").get("settings") or {}).get("notify"), fx.xtext("#settingsMsg"))
        fx.click("#notify")
        wait(lambda: fx.prompt(ext=True), 8)
        fx.prompt_answer(True, ext=True)
        check("yes: notifications are on", wait(lambda: (fx.store("settings").get("settings") or {}).get("notify") is True, 5))
    finally:
        fx.quit()


# ================================================================ suspend

def session_suspend(unpacked):
    """Firefox stops the background page after 2 s of nothing to do. Nothing may depend on it staying alive."""
    fx = Fx(unpacked, prefs={"extensions.background.idle.timeout": 2000})
    try:
        st.reset()
        fx.page_get(NEWS)
        fx.open_popup(NEWS, "Harbour News")
        fx.click("#addPage")
        w = wait(lambda: (lambda x: x if x and x.get("lastCheck") else None)(fx.watch(url=NEWS)), 15)
        wid = w["id"]
        wait(lambda: fx.overlay() == "ok", 5)
        close_card(fx)
        check("background page is stopped by Firefox when idle", wait(lambda: fx.bg_state() == "stopped", 15, 0.2), fx.bg_state())
        check("watch, saved version and alarm are still there while it is stopped",
              fx.watch(id=wid) is not None and len(fx.versions(wid)) == 1 and len(fx.alarms()) == 1 and fx.bg_state() == "stopped", fx.bg_state())

        st.news.insert(0, "Night ferry cancelled")
        fx.set_watches("for (const w of list) w.nextCheck = now + 5000;")
        t0 = time.time()
        fx.send("sync")  # wakes it to set the alarm; then it goes idle again
        asleep = wait(lambda: fx.bg_state() == "stopped", 4.5, 0.1)
        slept_at = time.time() - t0
        check("it is stopped again before the alarm is due", bool(asleep) and slept_at < 4.8 and fx.by_id(wid)["unread"] == 0, (asleep, slept_at))
        got = wait(lambda: (lambda x: x if x["unread"] else None)(fx.by_id(wid)), 15, 0.2)
        check("the alarm wakes it and the change is found from what was stored",
              bool(got) and got["unread"] == 1 and len(fx.versions(wid)) == 2 and "Night ferry cancelled" in fx.text(wid), got)
        check("the check happened when the alarm was due, not before", 4.0 <= (got["lastCheck"] / 1000 - t0) <= 9.0, got["lastCheck"] / 1000 - t0)
        check("badge set by the woken page", fx.badge() == "1", fx.badge())
        check("it stops again afterwards and the badge stays", wait(lambda: fx.bg_state() == "stopped", 15, 0.2) and fx.badge() == "1", fx.bg_state())

        # the list is drawn from storage, and a button wakes the background
        fx.open_popup(NEWS, "Harbour News")
        check("popup shows the change with the background stopped or not",
              fx.xjs("return document.querySelector(arguments[0]).dataset.state", fx.row(wid)) == "changed")
        wait(lambda: fx.bg_state() == "stopped", 15, 0.2)
        fx.click("#seenAll")
        check("a click wakes it: mark as seen", wait(lambda: fx.by_id(wid)["unread"] == 0, 8) and fx.badge() == "", fx.badge())

        # a half-finished "watch one part" survives the stop
        fx.page_get(KETTLE)
        check("picker started", start_pick(fx, KETTLE, "Blue Kettle - Harbour Shop"))
        check("stopped while the user is still choosing", wait(lambda: fx.bg_state() == "stopped", 15, 0.2)
              and (fx.store("pending").get("pending") or {}).get("stage") == "picking", fx.store("pending"))
        check("the pick still lands after the stop", pick(fx, "#price") == "ok" and (fx.watch(url=KETTLE) or {}).get("selector") == "#price", fx.card())

        # a change found while stopped again, this time for the part
        wait(lambda: fx.bg_state() == "stopped", 15, 0.2)
        st.price = f"{EURO} 18.00"
        kid = fx.watch(url=KETTLE)["id"]
        fx.set_watches(f"for (const w of list) if (w.id === {json.dumps(kid)}) w.nextCheck = now + 3500;")
        fx.send("sync")
        wait(lambda: fx.bg_state() == "stopped", 3.2, 0.1)
        check("second wake-up: the part's change is found too", wait(lambda: fx.by_id(kid)["unread"] == 1, 15, 0.2) and fx.text(kid) == f"{EURO} 18.00",
              fx.by_id(kid))
    finally:
        fx.quit()


# ================================================================ control

def session_control(unpacked):
    """Heron without its content_security_policy line: Firefox's default MV3 policy upgrades http:// to https://."""
    broken = Path(tempfile.mkdtemp(prefix="heron-nocsp-"))
    shutil.copytree(unpacked, broken, dirs_exist_ok=True)
    man = json.loads((broken / "manifest.json").read_text(encoding="utf-8"))
    man.pop("content_security_policy")
    (broken / "manifest.json").write_text(json.dumps(man), encoding="utf-8")
    fx = Fx(broken)
    try:
        st.reset()
        fx.page_get(NEWS)
        fx.open_popup(NEWS, "Harbour News")
        fx.click("#addPage")
        w = wait(lambda: (lambda x: x if x and (x.get("lastCheck") or x.get("error")) else None)(fx.watch(url=NEWS)), 20)
        check("control: without the CSP line the same http:// check fails",
              bool(w) and (w["error"] or {}).get("code") == "network" and st.requests("/news", checks=True) == [],
              (w and w["error"], len(st.requests("/news", checks=True))))
    finally:
        fx.quit()
        shutil.rmtree(broken, ignore_errors=True)


SESSIONS = {"main": session_main, "prompt": session_prompt, "suspend": session_suspend, "control": session_control}


def check_more_addons(api):
    """Rate pill and "More free add-ons" card on the settings page that is open now.
    The expected list comes from the shared file, so a new round only flips `live` flags."""
    more = wait(lambda: api("""
      const items = [...document.querySelectorAll('#moreAddons .more-item a')];
      if (!items.length) return null;
      const rate = document.querySelector('[data-rate]');
      const all = document.querySelector('[data-more-all]');
      const m = await import('/shared/more-addons.js');
      const me = browser.runtime.id;
      const self = m.ADDONS.find((a) => a.id === me);
      const fake = [{id: 'a', live: true, android: false}, {id: 'b', live: true, android: true},
                    {id: 'self', live: true, android: true}, {id: 'c', live: false, android: true}];
      return {
        names: items.map((a) => a.querySelector('.more-name').textContent),
        expected: m.ADDONS.filter((a) => a.live && a.id !== me).map((a) => a.name),
        left_out: m.ADDONS.filter((a) => !a.live || a.id === me).map((a) => a.name),
        self_slug: self ? self.slug : null, self_live: self ? self.live : null,
        hrefs: items.map((a) => a.href),
        newTab: items.every((a) => a.target === '_blank' && a.rel === 'noopener'),
        rate: rate.hidden ? null : rate.href, rateNewTab: rate.target === '_blank',
        all: all.href,
        androidPick: m.moreAddons('self', 'android', fake).map((x) => x.id),
        desktopPick: m.moreAddons('self', 'win', fake).map((x) => x.id),
      };
    """))
    more = more if isinstance(more, dict) else {}
    check("this add-on is marked live in the shared add-on list", more.get("self_live") is True, more.get("self_slug"))
    check("settings page lists every other live add-on, in order",
          bool(more.get("names")) and more.get("names") == more.get("expected"), (more.get("names"), more.get("expected")))
    check("it leaves out itself and add-ons still in review",
          bool(more.get("names")) and not set(more["names"]) & set(more.get("left_out") or []), more.get("left_out"))
    check("each listed add-on links to its AMO page in a new tab",
          bool(more.get("hrefs")) and all(h.startswith("https://addons.mozilla.org/firefox/addon/") for h in more["hrefs"])
          and more.get("newTab") is True, more.get("hrefs"))
    check("rate link opens this add-on's own AMO page",
          bool(more.get("self_slug")) and more.get("rate") == "https://addons.mozilla.org/firefox/addon/%s/" % more.get("self_slug")
          and more.get("rateNewTab") is True, more.get("rate"))
    check("see-all link opens the author's AMO page",
          more.get("all") == "https://addons.mozilla.org/firefox/user/20013808/", more.get("all"))
    check("list skips itself and unreleased add-ons, and desktop-only ones on Android",
          more.get("desktopPick") == ["a", "b"] and more.get("androidPick") == ["b"],
          (more.get("desktopPick"), more.get("androidPick")))


def main():
    names = [a for a in sys.argv[1:] if a in SESSIONS] or list(SESSIONS)
    unpacked = Path(tempfile.mkdtemp(prefix="heron-e2e-"))
    with zipfile.ZipFile(latest_zip()) as z:
        z.extractall(unpacked)
    httpd = server.start(PORT)
    try:
        for name in names:
            print(f"\n=== {name}", flush=True)
            n = len(results)
            try:
                SESSIONS[name](unpacked)
            except Exception as e:  # noqa: BLE001
                import traceback
                traceback.print_exc()
                check(f"{name}: session ran to the end", False, repr(e)[:300])
            print(f"--- {name}: {sum(1 for _, ok in results[n:] if ok)}/{len(results) - n}", flush=True)
    finally:
        httpd.shutdown()
        shutil.rmtree(unpacked, ignore_errors=True)
    failed = [n for n, ok in results if not ok]
    print(f"\n{len(results) - len(failed)}/{len(results)} passed")
    for n in failed:
        print("  FAILED:", n.encode("ascii", "replace").decode())
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
