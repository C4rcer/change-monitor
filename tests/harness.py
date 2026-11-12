"""Shared plumbing for Heron's real-Firefox tests (Selenium + geckodriver).

One headless, muted Firefox with the built add-on installed from the extracted
zip, a window for the web page under test and a second window on one of the
add-on's own pages (so reading storage never hides the page).

geckodriver runs with --allow-system-access so the tests can reach the
browser's own UI the way a user does: the toolbar button, the permission
prompt, and the state of the background page.
"""
import json
import os
import sys
import time
from pathlib import Path

from selenium import webdriver
from selenium.webdriver.common.action_chains import ActionChains
from selenium.webdriver.common.by import By
from selenium.webdriver.firefox.options import Options
from selenium.webdriver.firefox.service import Service

ROOT = Path(__file__).resolve().parents[1]
ADDON_ID = "heron-website-change-monitor@c4rcer"
WIDGET_ID = "heron-website-change-monitor_c4rcer-browser-action"
UUID = "6d1f0c1e-7a3b-4b5e-9c2d-4e0a51f0e7a1"
EXT = f"moz-extension://{UUID}"
FIREFOX = r"C:\Program Files\Mozilla Firefox\firefox.exe"
HOSTS = ["news.heron.test", "shop.heron.test", "app.heron.test", "misc.heron.test", "gone.heron.test",
         "harbourshop.example", "harbournews.example"]

results = []


def check(name, ok, detail=""):
    results.append((name, bool(ok)))
    line = ("PASS " if ok else "FAIL ") + name + (f"  [{detail}]" if detail != "" and not ok else "")
    print(line.encode("ascii", "replace").decode(), flush=True)  # Windows consoles choke on some characters


def wait(fn, timeout=8.0, step=0.1):
    end = time.time() + timeout
    last = None
    while time.time() < end:
        try:
            last = fn()
            if last:
                return last
        except Exception as e:  # noqa: BLE001
            last = None
            err = e  # noqa: F841
        time.sleep(step)
    return last


def latest_zip():
    zips = sorted((ROOT / "dist").glob("*.zip"), key=lambda p: p.stat().st_mtime)
    if not zips:
        sys.exit("build first: python tools/release.py build")
    return zips[-1]


class Fx:
    def __init__(self, unpacked, prefs=None, auto_grant=True, download_dir=None):
        os.environ.setdefault("SE_AVOID_STATS", "true")
        opts = Options()
        opts.binary_location = FIREFOX
        opts.add_argument("-headless")
        opts.set_preference("media.volume_scale", "0.0")
        opts.set_preference("extensions.webextensions.uuids", json.dumps({ADDON_ID: UUID}))
        opts.set_preference("network.dns.localDomains", ",".join(HOSTS))
        # Never a real Windows toast from a test run.
        opts.set_preference("alerts.useSystemBackend", False)
        opts.set_preference("security.notification_enable_delay", 0)
        if auto_grant:
            # Optional permissions are granted without the prompt (it still takes a real click to ask).
            opts.set_preference("extensions.webextOptionalPermissionPrompts", False)
        if download_dir:
            opts.set_preference("browser.download.folderList", 2)
            opts.set_preference("browser.download.dir", str(download_dir))
            opts.set_preference("browser.download.useDownloadDir", True)
            opts.set_preference("browser.download.alwaysOpenPanel", False)
            opts.set_preference("browser.helperApps.neverAsk.saveToDisk", "application/json")
        for k, v in (prefs or {}).items():
            opts.set_preference(k, v)
        self.d = webdriver.Firefox(options=opts, service=Service(service_args=["--allow-system-access"]))
        self.d.set_script_timeout(90)
        self.d.set_window_size(1280, 900)
        self.d.execute("INSTALL_ADDON", {"path": str(unpacked), "temporary": True})
        time.sleep(1.2)
        self.handles_after_install = len(self.d.window_handles)
        self.page = self.d.current_window_handle
        self.d.switch_to.new_window("window")
        self.ext = self.d.current_window_handle
        self.d.set_window_size(1100, 900)
        self.d.get(f"{EXT}/app/app.html")
        self.ready()
        self.to_page()

    def quit(self):
        self.d.quit()

    # ---- windows
    def to_page(self):
        if self.d.current_window_handle != self.page:
            self.d.switch_to.window(self.page)

    def to_ext(self):
        if self.d.current_window_handle != self.ext:
            self.d.switch_to.window(self.ext)

    def ready(self):
        return wait(lambda: self.d.execute_script("return document.body && document.body.dataset.ready === '1'"), 10)

    def page_get(self, url):
        self.to_page()
        self.d.get(url)

    def js(self, script, *args):
        self.to_page()
        return self.d.execute_script(script, *args)

    def xjs(self, script, *args):
        self.to_ext()
        return self.d.execute_script(script, *args)

    def api(self, code, *args):
        """Run async code with the WebExtension API, on the add-on's own page."""
        self.to_ext()
        return self.d.execute_async_script(
            "const done = arguments[arguments.length - 1];"
            f"(async () => {{ {code} }})().then(done, (e) => done('ERR ' + e));", *args)

    def send(self, type_, **data):
        return self.api("return await browser.runtime.sendMessage(arguments[0]);", {"type": type_, **data})

    def chrome(self, script, *args, ext=False):
        """Run privileged code in the browser window that holds the test page (or, with ext, the add-on's page)."""
        if ext:
            self.to_ext()
        else:
            self.to_page()
        with self.d.context("chrome"):
            return self.d.execute_script(script, *args)

    def frame_eval(self, where, body):
        """Run privileged code inside a content process: the test page ("page") or the real toolbar popup ("popup")."""
        self.to_page()
        with self.d.context("chrome"):
            return self.d.execute_async_script("""
              const [where, body, done] = arguments;
              const b = where === "popup" ? document.querySelector("browser.webextension-popup-browser") : gBrowser.selectedBrowser;
              if (!b) { done({ error: "no browser" }); return; }
              const mm = b.messageManager;
              const name = "heron-test:" + Math.random().toString(36).slice(2);
              const on = (m) => { mm.removeMessageListener(name, on); done(m.data); };
              mm.addMessageListener(name, on);
              mm.loadFrameScript("data:," + encodeURIComponent(
                "(() => { let out; try { out = (function () {" + body + "})(); } catch (e) { out = { error: String(e) }; }" +
                " sendAsyncMessage(" + JSON.stringify(name) + ", out === undefined ? null : out); })();"), false);
            """, where, body)

    # ---- add-on state
    def store(self, keys=None):
        return self.api("return await browser.storage.local.get(arguments[0]);", keys)

    def watches(self):
        return self.store("watches").get("watches") or []

    def watch(self, **want):
        for w in self.watches():
            if all(w.get(k) == v for k, v in want.items()):
                return w
        return None

    def by_id(self, wid):
        return self.watch(id=wid)

    def versions(self, wid):
        key = "snap:" + wid
        return (self.store(key).get(key) or {}).get("versions") or []

    def text(self, wid):
        v = self.versions(wid)
        return v[-1]["text"] if v else None

    def badge(self):
        return self.api("return await browser.action.getBadgeText({});")

    def title(self):
        return self.api("return await browser.action.getTitle({});")

    def origins(self):
        return sorted(self.api("return (await browser.permissions.getAll()).origins;"))

    def alarms(self):
        return self.api("return await browser.alarms.getAll();")

    def page_tab_id(self):
        return self.api("""
          const me = await browser.tabs.getCurrent();
          const t = (await browser.tabs.query({ active: true })).find((x) => x.windowId !== me.windowId);
          return t ? t.id : null;""")

    def bg_state(self):
        return self.chrome("return WebExtensionPolicy.getByID(arguments[0]).extension.backgroundState;", ADDON_ID)

    def set_watches(self, fn_js):
        """Edit the stored watch list directly (the test's way of moving the clock), then let the background catch up."""
        self.api(f"""
          const got = await browser.storage.local.get("watches");
          const list = got.watches || [];
          const now = Date.now();
          (function (list, now) {{ {fn_js} }})(list, now);
          await browser.storage.local.set({{ watches: list }});
          return true;""")

    # ---- the add-on's pages, in the second window
    def open_popup(self, url=None, title=""):
        tab = self.page_tab_id()
        from urllib.parse import urlencode
        q = {"tab": tab}
        if url is not None:
            q["url"] = url
            q["title"] = title
        self.to_ext()
        self.d.get(f"{EXT}/popup/popup.html?" + urlencode(q))
        self.ready()
        return tab

    def open_app(self, hash_=""):
        self.to_ext()
        self.d.get("about:blank")
        self.d.get(f"{EXT}/app/app.html" + hash_)
        self.ready()

    def open_changes(self, wid):
        self.to_ext()
        self.d.get(f"{EXT}/changes/changes.html?id={wid}")
        self.ready()

    def click(self, sel):
        self.to_ext()
        self.d.find_element(By.CSS_SELECTOR, sel).click()

    def xtext(self, sel):
        return self.xjs("const e = document.querySelector(arguments[0]); return e ? e.textContent.trim() : null;", sel)

    def xtexts(self, sel):
        return self.xjs("return [...document.querySelectorAll(arguments[0])].map((e) => e.textContent.trim());", sel)

    def row(self, wid, part=""):
        return f'.watch[data-id="{wid}"] {part}'.strip()

    # ---- the page under test
    def overlay(self):
        """State of Heron's in-page overlay: None, "picking", "busy", "ok", "problem" or "jsdrawn"."""
        return self.js("const h = document.querySelector('[data-heron-overlay]'); return h ? h.getAttribute('data-heron-overlay') : null;")

    def card(self):
        """What the in-page overlay shows. It sits in a closed shadow root, so it is read with browser privileges."""
        return self.frame_eval("page", """
          const host = content.document.querySelector("[data-heron-overlay]");
          const root = host && host.openOrClosedShadowRoot;
          if (!root) return null;
          const [box, tag, hint, card] = root.firstChild.children;
          const rect = (e) => { const r = e.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; };
          const shown = (e) => e.style.display !== "none";
          return {
            state: host.getAttribute("data-heron-overlay"),
            box: shown(box) ? rect(box) : null,
            tag: shown(tag) ? tag.textContent : null,
            hint: shown(hint) ? hint.textContent : null,
            text: shown(card) ? card.textContent : null,
            buttons: shown(card) ? [...card.querySelectorAll("button")].map((b) => {
              const r = b.getBoundingClientRect();
              return { label: b.textContent, x: r.left + r.width / 2, y: r.top + r.height / 2 };
            }) : [],
          };""")

    def card_click(self, label):
        c = self.card() or {}
        b = next((b for b in c.get("buttons", []) if b["label"] == label), None)
        if not b:
            return False
        self.click_at(b["x"], b["y"])
        return True

    def rect(self, sel, index=0):
        return self.js(
            "const r = document.querySelectorAll(arguments[0])[arguments[1]].getBoundingClientRect();"
            "return {x: r.left, y: r.top, w: r.width, h: r.height, cx: r.left + r.width / 2, cy: r.top + r.height / 2};",
            sel, index)

    def move(self, x, y):
        self.to_page()
        ac = ActionChains(self.d)
        ac.w3c_actions.pointer_action.move_to_location(int(x), int(y))
        ac.perform()

    def click_at(self, x, y):
        self.to_page()
        ac = ActionChains(self.d)
        ac.w3c_actions.pointer_action.move_to_location(int(x), int(y))
        ac.w3c_actions.pointer_action.click()
        ac.perform()

    def keys(self, *keys):
        self.to_page()
        ActionChains(self.d).send_keys(*keys).perform()

    # ---- the browser's own UI
    def click_toolbar_button(self):
        return self.chrome("""
          const item = document.getElementById(arguments[0]);
          if (!item) return "no toolbar item";
          const where = item.closest("#nav-bar") ? "nav-bar" : (item.closest("panel, toolbar") || {}).id;
          (item.querySelector(".unified-extensions-item-action-button") || item).click();
          return where;
        """, WIDGET_ID)

    def popup_panel(self):
        return self.chrome("""
          const b = document.querySelector("browser.webextension-popup-browser");
          return b && b.currentURI ? b.currentURI.spec : null;
        """)

    def popup_press(self, sel):
        """A real (trusted) mouse press on an element inside the toolbar popup."""
        return self.frame_eval("popup", f"""
          const el = content.document.querySelector({json.dumps(sel)});
          if (!el) return {{ error: "not found" }};
          const r = el.getBoundingClientRect();
          const x = r.left + r.width / 2, y = r.top + r.height / 2;
          const data = {{ button: 0, clickCount: 1 }};
          content.synthesizeMouseEvent("mousedown", x, y, data);
          content.synthesizeMouseEvent("mouseup", x, y, data);
          return {{ ok: true, disabled: !!el.disabled }};""")

    def popup_read(self, sel):
        return self.frame_eval("popup", f"""
          const el = content.document.querySelector({json.dumps(sel)});
          return el ? {{ text: el.textContent.trim(), hidden: !!el.hidden, disabled: !!el.disabled }} : null;""")

    def prompt(self, ext=False):
        """Firefox's permission prompt, if it is showing: its text and whether it can be answered."""
        return self.chrome("""
          const panel = PopupNotifications.panel;
          const n = panel && panel.state === "open" ? panel.firstElementChild : null;
          if (!n) return null;
          const texts = [...n.querySelectorAll("*")].filter((e) => !e.children.length && e.textContent.trim()).map((e) => e.textContent.trim());
          return { id: n.id, texts: [...new Set(texts)], disabled: !!n.button.disabled };
        """, ext=ext)

    def prompt_answer(self, allow, ext=False):
        return self.chrome("""
          const n = PopupNotifications.panel.firstElementChild;
          (arguments[0] ? n.button : n.secondaryButton).click();
          return true;
        """, allow, ext=ext)
