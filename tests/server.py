"""Local test server for Heron's E2E test and screenshots (stdlib only).

Answers on any Host name, so Firefox can reach it as news.heron.test,
shop.heron.test, ... through the network.dns.localDomains pref. The test runs
it in a thread and changes STATE between checks; every request is logged with
its time, host, path, Cookie and Accept header.

Routes:
  /news            a list of headlines (STATE.news) between a fixed header and footer;
                   scripts, styles, a hidden block and a random token change on every request
  /shop/kettle     product page: #price (STATE.price), .stock (STATE.stock) and a clock that
                   changes on every request. ?csp=1 adds a strict Content-Security-Policy
  /shop/list       deals without ids (STATE.deals); STATE.deals = None removes the list
  /spa             the server sends an empty shell; a script draws the content
  /spa2            #count exists in the HTML but is filled in by a script
  /half            a little server text, most of the page drawn by a script
  /table           a table with three rows
  /flaky           200 with STATE.flaky_text, or STATE.flaky_status when that is not 200
  /account         302 to /login      /members  403      /image.png  image/png
  /big             STATE.big_lines lines of text (far more than Heron keeps)
  /huge            6 MB of HTML
  /latin1          ISO-8859-1 bytes, charset in the header
  /meta-latin1     windows-1252 bytes, charset only in a <meta> tag
  /notes.txt       text/plain (STATE.notes)
  /setcookie       sets a cookie
  /slow            answers after 25 s (longer than Heron waits)
  /demo/...        the pages used for the listing screenshots (tests/demo/*.html)
  anything else    404
"""
import http.server
import threading
import time
from pathlib import Path
from urllib.parse import parse_qs, urlparse

DEMO = Path(__file__).resolve().parent / "demo"
CSP = "default-src 'none'; style-src 'nonce-herontest'; script-src 'nonce-herontest'"

NEWS = [
    "Harbour bridge reopens after repairs",
    "Ferry timetable updated for winter",
    "Council approves new cycle lanes",
    "Library extends weekend opening hours",
    "Fish market moves to the east quay",
    "Lighthouse tours start again in May",
    "Road works on Quay Street until Friday",
    "Sailing club wins regional regatta",
    "New bakery opens on Market Square",
    "Museum shows photographs of the old port",
    "Tide tables for the coming month published",
    "Volunteers clean the north beach",
]


class State:
    def __init__(self):
        self.lock = threading.Lock()
        self.reset()

    def reset(self):
        self.log = []  # dicts: t, method, host, path, query, cookie, accept
        self.counter = 0
        self.news = list(NEWS)
        self.price = "€ 24.99"
        self.stock = "In stock"
        self.deals = [("Teapot", "18.00"), ("Mug set", "12.50"), ("Tray", "9.00")]
        self.flaky_status = 200
        self.flaky_text = "All systems normal"
        self.big_lines = 4000
        self.big_mark = "first"
        self.notes = "line one\nline two"

    def requests(self, path=None, host=None, checks=None):
        """Logged requests, optionally only for a path / host / only Heron's own checks."""
        with self.lock:
            out = list(self.log)
        if path is not None:
            out = [r for r in out if r["path"] == path]
        if host is not None:
            out = [r for r in out if r["host"] == host]
        if checks is not None:
            out = [r for r in out if r["check"] == checks]
        return out


STATE = State()
# Heron's checks send this Accept header; page loads by the browser do not.
CHECK_ACCEPT = "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5"


def page(title, body, head=""):
    return f"<!doctype html><html lang=en><head><meta charset=utf-8><title>{title}</title>{head}</head><body>{body}</body></html>"


def news_page(s, n):
    items = "".join(f"<li>{t}</li>" for t in s.news)
    return page(
        "Harbour News",
        f"""<header><h1>Harbour News</h1><p>All the news from the waterfront</p></header>
<script>var token = "tok{n}"; document.title = "Harbour News";</script>
<style>.x{n} {{ color: red }}</style>
<div hidden>hidden block {n}</div>
<div style="display:none">invisible block {n}</div>
<noscript>Please switch on JavaScript {n}</noscript>
<main data-token="tok{n}"><ul id="items">{items}</ul></main>
<footer><p>Printed at the harbour office</p><p>Contact: desk@harbour.example</p></footer>""",
        f'<meta name="csrf" content="csrf{n}">',
    )


def kettle_page(s, n, nonce=""):
    na = f' nonce="{nonce}"' if nonce else ""
    return page(
        "Blue Kettle - Harbour Shop",
        f"""<div id="top"><nav><a href="/shop/list">Deals</a> <a href="/news">News</a></nav></div>
<main>
  <h1>Blue Kettle</h1>
  <div class="product">
    <p class="desc">A sturdy enamel kettle for the stove, 1.5 litres.</p>
    <div class="buy"><a id="buylink" href="/elsewhere"><span id="price" class="price">{s.price}</span></a> <span class="stock">{s.stock}</span></div>
  </div>
  <aside id="clock">Server time: tick {n}</aside>
</main>
<script{na}>window.clicks = 0; document.addEventListener("click", () => {{ window.clicks++; }});</script>""",
        f"<style{na}>body {{ font: 16px sans-serif; margin: 40px; }} .buy {{ margin: 20px 0; padding: 12px; width: 320px; }} #price {{ font-size: 28px; }}</style>",
    )


def list_page(s):
    if s.deals is None:
        body = "<h1>Deals</h1><p>No deals this week.</p>"
    else:
        rows = "".join(
            f'<li class="deal"><span class="name">{name}</span> <span class="amount">{amount}</span></li>' for name, amount in s.deals
        )
        body = f'<h1>Deals</h1><div class="wrap"><ul class="deals">{rows}</ul></div><p>Prices in euro.</p>'
    return page("Deals - Harbour Shop", body, "<style>body { font: 16px sans-serif; margin: 40px; } li { margin: 12px 0; }</style>")


SPA = page(
    "Harbour Live",
    """<div id="app"></div>
<script>document.getElementById("app").innerHTML =
  "<h1>Harbour Live</h1><p id='live'>Ships in port right now: 42</p><p>Drawn in your browser by a script.</p>";</script>""",
    "<style>body { font: 16px sans-serif; margin: 40px; }</style>",
)

SPA2 = page(
    "Harbour Counter",
    """<h1>Harbour Counter</h1><p>Berths taken: <span id="count"></span></p>
<script>document.getElementById("count").textContent = "17 of 30";</script>""",
    "<style>body { font: 16px sans-serif; margin: 40px; }</style>",
)

HALF = page(
    "Harbour Dashboard",
    """<h1>Harbour Dashboard</h1><p>Weather and berths at a glance.</p><div id="rest"></div>
<script>
  const words = ["anchor", "berth", "cargo", "dredger", "estuary", "fairway", "gangway", "harbour", "inlet", "jetty",
    "keel", "lantern", "mooring", "navigator", "outboard", "pilot", "quayside", "rudder", "schooner", "tugboat",
    "upwind", "vessel", "wharf", "yardarm", "zephyr", "ballast", "capstan", "dockyard", "ebbtide", "foghorn"];
  document.getElementById("rest").innerHTML = words.map((w) => "<p>The " + w + " report is ready for the morning shift.</p>").join("");
</script>""",
)

TABLE = page(
    "Price list",
    """<table><thead><tr><th>Item</th><th>Price</th><th>Stock</th></tr></thead>
<tbody><tr><td>Kettle</td><td>24.99</td><td>In stock</td></tr><tr><td>Teapot</td><td>18.00</td><td>Sold out</td></tr></tbody></table>""",
)


class Handler(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.0"

    def log_message(self, *a):
        pass

    def do_HEAD(self):
        self.route("HEAD")

    def do_GET(self):
        self.route("GET")

    def send(self, code, body="", headers=None, ctype="text/html; charset=utf-8"):
        raw = body if isinstance(body, bytes) else body.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(raw)))
        self.send_header("Cache-Control", "no-store")
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        self.end_headers()
        if self.command != "HEAD":
            try:
                self.wfile.write(raw)
            except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
                pass

    def route(self, method):
        u = urlparse(self.path)
        q = {k: v[0] for k, v in parse_qs(u.query).items()}
        host = (self.headers.get("Host") or "").split(":")[0].lower()
        accept = self.headers.get("Accept") or ""
        s = STATE
        with s.lock:
            s.counter += 1
            n = s.counter
            s.log.append({
                "t": time.time(), "method": method, "host": host, "path": u.path, "query": u.query,
                "cookie": self.headers.get("Cookie"), "accept": accept, "check": accept == CHECK_ACCEPT,
            })
        p = u.path
        if p == "/news":
            self.send(200, news_page(s, n))
        elif p == "/shop/kettle":
            if q.get("csp"):
                self.send(200, kettle_page(s, n, "herontest"), {"Content-Security-Policy": CSP})
            else:
                self.send(200, kettle_page(s, n))
        elif p == "/shop/list":
            self.send(200, list_page(s))
        elif p == "/spa":
            self.send(200, SPA)
        elif p == "/spa2":
            self.send(200, SPA2)
        elif p == "/half":
            self.send(200, HALF)
        elif p == "/table":
            self.send(200, TABLE)
        elif p == "/flaky":
            if s.flaky_status != 200:
                self.send(s.flaky_status, page("Error", f"<h1>Error {s.flaky_status}</h1>"))
            else:
                self.send(200, page("Status", f"<h1>Status</h1><p>{s.flaky_text}</p>"))
        elif p == "/account":
            self.send(302, "", {"Location": "/login?next=/account"})
        elif p == "/login":
            self.send(200, page("Sign in", "<h1>Sign in</h1><form><input name=user><input name=pass type=password></form>"))
        elif p == "/members":
            self.send(403, page("Forbidden", "<h1>Members only</h1>"))
        elif p == "/image.png":
            self.send(200, b"\x89PNG\r\n\x1a\n" + b"\0" * 64, ctype="image/png")
        elif p == "/big":
            lines = "".join(f"<p>Line {i:05d} of the long report, {s.big_mark} edition</p>" for i in range(s.big_lines))
            self.send(200, page("Long report", lines))
        elif p == "/huge":
            self.send(200, page("Huge", "<p>" + "x" * (6 * 1024 * 1024) + "</p>"))
        elif p == "/latin1":
            self.send(200, "<!doctype html><title>Menu</title><p>Café crème à volonté</p>".encode("iso-8859-1"),
                      ctype="text/html; charset=ISO-8859-1")
        elif p == "/meta-latin1":
            self.send(200, '<!doctype html><meta charset="windows-1252"><title>Menu</title><p>Crème brûlée € 6</p>'.encode("windows-1252"),
                      ctype="text/html")
        elif p == "/notes.txt":
            self.send(200, s.notes, ctype="text/plain; charset=utf-8")
        elif p == "/slow":
            time.sleep(25)
            self.send(200, page("Slow", "<p>late</p>"))
        elif p == "/setcookie":
            self.send(200, page("Cookie", "<p>cookie set</p>"), {"Set-Cookie": "sid=secret; Path=/; Max-Age=3600"})
        elif p.startswith("/demo/"):
            f = (DEMO / p[len("/demo/"):]).resolve()
            if f.is_file() and DEMO in f.parents:
                text = f.read_text(encoding="utf-8")
                for key, value in getattr(s, "demo", {}).items():
                    text = text.replace("{{" + key + "}}", value)
                self.send(200, text)
            else:
                self.send(404, page("Not found", "<h1>Not found</h1>"))
        else:
            self.send(404, page("Not found", "<h1>Not found</h1>"))


def start(port):
    httpd = http.server.ThreadingHTTPServer(("127.0.0.1", port), Handler)
    httpd.daemon_threads = True
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd
