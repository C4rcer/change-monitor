// Runs in a web page, and only after the user asked for it there: the
// background loads it with scripting.executeScript when "Watch one part" or
// "Watch this page" was pressed in Heron's popup for this tab.
//
// Two jobs:
//   1. let the user point at the part of the page to watch and click it,
//   2. show the result of adding a watch ("Heron is watching this part").
//
// It reads the clicked element's text and works out CSS selectors for it;
// nothing else on the page is read, changed or sent anywhere. The overlay
// lives in a closed shadow root and is styled only through the CSSOM
// (element.style), so page styles can not reach it and a strict
// Content-Security-Policy can not block it.
(() => {
  "use strict";
  if (globalThis.__heronPicker) return; // already loaded in this page; its listener below is still alive
  globalThis.__heronPicker = true;

  const ATTR = "data-heron-overlay";
  const XHTML = "http://www.w3.org/1999/xhtml";
  const ACCENT = "#0b6bcb";
  const FONT = "13px/1.45 system-ui, -apple-system, 'Segoe UI', sans-serif";
  const PANEL =
    "background:rgba(22,22,26,.97);color:#fff;font:" + FONT + ";border-radius:10px;" +
    "box-shadow:0 0 0 1px rgba(255,255,255,.16),0 8px 26px rgba(0,0,0,.4);";
  // Inline !important beats anything a page stylesheet can say about a div or a popover.
  const HOST_CSS = [
    "all:initial", "position:fixed", "inset:0", "width:auto", "height:auto", "margin:0", "padding:0", "border:0",
    "background:transparent", "overflow:visible", "display:block", "z-index:2147483647", "pointer-events:none",
    "opacity:1", "visibility:visible", "transform:none", "filter:none", "max-width:none", "max-height:none",
  ].map((d) => d + " !important").join(";");
  const BLOCKED = ["mousedown", "mouseup", "pointerdown", "pointerup", "dblclick", "auxclick", "contextmenu"];

  let ui = null;
  let picking = false;
  let chain = []; // the element under the pointer and its ancestors, innermost first
  let level = 0; // how far up the chain the selection was widened
  let frame = 0;
  let closeTimer = 0;
  let every = "";

  // ------------------------------------------------------------------ overlay

  function make(tag, css, text) {
    const n = document.createElementNS(XHTML, tag);
    n.style.cssText = css;
    if (text != null) n.textContent = text;
    return n;
  }

  function build() {
    for (const old of document.querySelectorAll("[" + ATTR + "]")) old.remove(); // left by an older copy of this script
    const host = make("div", HOST_CSS);
    host.setAttribute(ATTR, "");
    const shadow = host.attachShadow({ mode: "closed" });
    const root = make("div", "position:fixed;inset:0;direction:ltr;pointer-events:none;text-align:left;");
    const box = make("div",
      "position:fixed;display:none;box-sizing:border-box;border:2px solid " + ACCENT + ";border-radius:4px;" +
      "background:rgba(11,107,203,.14);box-shadow:0 0 0 1px rgba(255,255,255,.7);pointer-events:none;");
    const tag = make("div",
      "position:fixed;display:none;max-width:min(420px,80vw);padding:3px 8px;border-radius:6px;background:" + ACCENT + ";" +
      "color:#fff;font:600 12px/16px system-ui,sans-serif;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;pointer-events:none;");
    const hint = make("div",
      PANEL + "position:fixed;left:50%;bottom:18px;transform:translateX(-50%);display:none;padding:8px 14px;" +
      "width:max-content;max-width:92vw;pointer-events:none;text-align:center;");
    const card = make("div",
      PANEL + "position:fixed;top:16px;right:16px;display:none;box-sizing:border-box;width:340px;max-width:calc(100vw - 32px);" +
      "padding:14px 16px;pointer-events:auto;");
    card.setAttribute("role", "status");
    root.append(box, tag, hint, card);
    shadow.append(root);
    document.documentElement.append(host);
    try {
      host.popover = "manual";
      host.showPopover(); // the top layer: above every z-index
    } catch {
      // Still a fixed overlay with the highest z-index.
    }
    ui = { host, box, tag, hint, card };
  }

  function teardown() {
    stopPicking();
    clearTimeout(closeTimer);
    if (ui) ui.host.remove();
    ui = null;
  }

  // ------------------------------------------------------------------ picking

  function current() {
    return chain[Math.min(level, chain.length - 1)] || null;
  }

  function draw() {
    frame = 0;
    if (!ui) return;
    const el = current();
    if (!el || !el.isConnected) {
      ui.box.style.display = "none";
      ui.tag.style.display = "none";
      return;
    }
    const r = el.getBoundingClientRect();
    const s = ui.box.style;
    s.display = "block";
    s.left = r.left - 2 + "px";
    s.top = r.top - 2 + "px";
    s.width = r.width + 4 + "px";
    s.height = r.height + 4 + "px";
    if (!picking) {
      ui.tag.style.display = "none";
      return;
    }
    const text = (el.innerText || "").replace(/\s+/g, " ").trim();
    ui.tag.textContent = text ? (text.length > 60 ? text.slice(0, 59) + "…" : text) : "(no text here)";
    const t = ui.tag.style;
    t.display = "block";
    t.left = Math.max(4, Math.min(r.left - 2, window.innerWidth - 200)) + "px";
    t.top = (r.top >= 30 ? r.top - 28 : Math.min(r.bottom + 6, window.innerHeight - 26)) + "px";
  }

  function redraw() {
    if (!frame) frame = requestAnimationFrame(draw);
  }

  function ours(e) {
    return !!ui && e.target === ui.host;
  }

  function onMove(e) {
    if (ours(e) || !e.isTrusted) return;
    const el = e.target && e.target.nodeType === 1 ? e.target : null;
    if (!el || el === chain[0]) return;
    chain = [];
    for (let n = el; n && n.nodeType === 1 && n !== document.body && n !== document.documentElement; n = n.parentElement) chain.push(n);
    level = 0;
    // Keep the hint out of the way of what is being pointed at.
    const low = e.clientY > window.innerHeight - 90;
    ui.hint.style.bottom = low ? "auto" : "18px";
    ui.hint.style.top = low ? "18px" : "auto";
    redraw();
  }

  function swallow(e) {
    if (ours(e)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
  }

  function onClick(e) {
    if (ours(e)) return;
    swallow(e);
    if (e.button !== 0 || !e.isTrusted) return; // a page script can not click for the user
    if (!current()) onMove(e);
    choose();
  }

  function onKey(e) {
    if (!e.isTrusted) return;
    if (e.key === "Escape") {
      swallow(e);
      cancel();
    } else if (e.key === "ArrowUp") {
      swallow(e);
      if (level < chain.length - 1) level++;
      redraw();
    } else if (e.key === "ArrowDown") {
      swallow(e);
      if (level > 0) level--;
      redraw();
    } else if (e.key === "Enter" && current()) {
      swallow(e);
      choose();
    }
  }

  function startPicking() {
    if (!ui) build();
    clearTimeout(closeTimer);
    ui.card.style.display = "none";
    ui.hint.textContent = "Click the part of the page to watch   ·   ↑ wider   ↓ narrower   ·   Esc to cancel";
    ui.hint.style.display = "block";
    ui.box.style.display = "none";
    ui.host.setAttribute(ATTR, "picking");
    chain = [];
    level = 0;
    if (picking) return;
    picking = true;
    window.addEventListener("mousemove", onMove, true);
    window.addEventListener("click", onClick, true);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("scroll", redraw, true);
    window.addEventListener("resize", redraw, true);
    for (const type of BLOCKED) window.addEventListener(type, swallow, true);
  }

  function stopPicking() {
    if (!picking) return;
    picking = false;
    window.removeEventListener("mousemove", onMove, true);
    window.removeEventListener("click", onClick, true);
    window.removeEventListener("keydown", onKey, true);
    window.removeEventListener("scroll", redraw, true);
    window.removeEventListener("resize", redraw, true);
    for (const type of BLOCKED) window.removeEventListener(type, swallow, true);
    if (ui) {
      ui.hint.style.display = "none";
      ui.tag.style.display = "none";
    }
  }

  function cancel() {
    browser.runtime.sendMessage({ type: "pick:cancel" }).catch(() => {});
    teardown();
  }

  // ---------------------------------------------------------------- selectors

  function stableId(id) {
    if (!id || id.length > 60 || /\d{4,}|^\d|[:.]|^(ember|react|radix|headlessui|__)/i.test(id)) return false;
    try {
      return document.querySelectorAll("#" + CSS.escape(id)).length === 1;
    } catch {
      return false;
    }
  }

  /** Class names that look written by a person, not made up by a build tool or toggled by a script. */
  function stableClasses(el) {
    const out = [];
    for (const c of el.classList) {
      if (c.length < 2 || c.length > 40) continue;
      if (/\d{3,}|^_|^(css|sc|jsx|svelte|emotion)-|^(is|has|js)-/.test(c)) continue;
      if (/(^|-)(active|open|hover|focus|selected|visible|hidden|loaded|loading|current|show|hide)$/.test(c)) continue;
      out.push(c);
      if (out.length === 2) break;
    }
    return out;
  }

  function nth(el) {
    let n = 1;
    let more = false;
    for (let s = el.previousElementSibling; s; s = s.previousElementSibling) if (s.localName === el.localName) n++;
    for (let s = el.nextElementSibling; s && !more; s = s.nextElementSibling) if (s.localName === el.localName) more = true;
    return n > 1 || more ? ":nth-of-type(" + n + ")" : "";
  }

  function step(el, useClasses) {
    const tag = CSS.escape(el.localName);
    if (!useClasses) return tag + nth(el);
    const classes = stableClasses(el);
    if (!classes.length) return tag + nth(el);
    const sel = tag + classes.map((c) => "." + CSS.escape(c)).join("");
    let same = 0;
    for (const s of el.parentElement ? el.parentElement.children : []) if (s.matches(sel)) same++;
    return same > 1 ? sel + nth(el) : sel;
  }

  function path(el, useClasses, useIds) {
    const steps = [];
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
      if (n === document.body) {
        steps.unshift("body");
        break;
      }
      if (n === document.documentElement) break;
      if (useIds && stableId(n.id)) {
        steps.unshift("#" + CSS.escape(n.id));
        break;
      }
      steps.unshift(step(n, useClasses));
    }
    return steps;
  }

  function unique(selector, el) {
    try {
      const found = document.querySelectorAll(selector);
      return found.length === 1 && found[0] === el;
    } catch {
      return false;
    }
  }

  /**
   * Several ways to find the same element again, most readable first. The
   * background tries each one on the HTML the server sends and keeps the one
   * whose text matches what was clicked.
   */
  function selectorsFor(el) {
    const out = [];
    const add = (s) => {
      if (s && !out.includes(s) && unique(s, el)) out.push(s);
    };
    if (stableId(el.id)) add("#" + CSS.escape(el.id));
    const named = path(el, true, true);
    for (let i = named.length - 1; i >= 0; i--) {
      const short = named.slice(i).join(" > ");
      if (unique(short, el)) {
        add(short);
        break;
      }
    }
    add(named.join(" > "));
    add(path(el, false, true).join(" > "));
    add(path(el, false, false).join(" > "));
    return out;
  }

  // --------------------------------------------------------------------- card

  function button(label, primary, onPress) {
    const b = make("button",
      "all:unset;box-sizing:border-box;padding:6px 12px;border-radius:7px;cursor:pointer;font:600 12.5px/16px system-ui,sans-serif;" +
      (primary ? "background:" + ACCENT + ";color:#fff;" : "background:rgba(255,255,255,.12);color:#fff;"), label);
    b.setAttribute("role", "button");
    b.tabIndex = 0;
    b.addEventListener("click", (e) => {
      if (e.isTrusted) onPress();
    });
    b.addEventListener("keydown", (e) => {
      if (e.isTrusted && (e.key === "Enter" || e.key === " ")) onPress();
    });
    return b;
  }

  /** Show a message card. `actions` is [[label, primary, handler]]; without actions it closes by itself. */
  function showCard(info, actions) {
    if (!ui) build();
    clearTimeout(closeTimer);
    const card = ui.card;
    card.replaceChildren();
    // The state (never the text) is mirrored on the host element.
    ui.host.setAttribute(ATTR, info.busy ? "busy" : info.code === "jsdrawn" ? "jsdrawn" : info.ok ? "ok" : "problem");
    const mark = info.busy ? "" : info.ok ? "✓ " : "";
    card.append(make("div", "font-weight:700;font-size:14px;margin:0 0 4px;", mark + (info.title || "")));
    if (info.text) card.append(make("div", "color:#d6d6de;", info.text));
    if (info.sees) card.append(make("div", "margin-top:8px;padding:6px 8px;border-radius:6px;background:rgba(255,255,255,.08);color:#fff;overflow-wrap:anywhere;", "It sees: “" + info.sees + "”"));
    if (info.warn) card.append(make("div", "margin-top:8px;padding:6px 8px;border-radius:6px;background:rgba(245,158,11,.18);color:#fde7b0;", info.warn));
    if (actions && actions.length) {
      const row = make("div", "display:flex;flex-wrap:wrap;gap:8px;margin-top:12px;");
      for (const [label, primary, onPress] of actions) row.append(button(label, primary, onPress));
      card.append(row);
    } else if (!info.busy) {
      const row = make("div", "display:flex;justify-content:flex-end;margin-top:10px;");
      row.append(button("OK", false, teardown));
      card.append(row);
      closeTimer = setTimeout(teardown, info.warn || !info.ok ? 14000 : 6000);
    }
    card.style.display = "block";
  }

  async function finish(request) {
    let res;
    try {
      res = await browser.runtime.sendMessage(request);
    } catch {
      res = null;
    }
    if (!res) res = { ok: false, title: "Heron did not answer", text: "Open Heron from the toolbar and try again." };
    if (!ui) return; // closed meanwhile
    if (res.code === "jsdrawn") {
      showCard(res, [
        ["Pick another part", true, startPicking],
        ["Watch the whole page", false, () => {
          ui.box.style.display = "none";
          showCard({ busy: true, title: "Saving the page as it is now…" });
          finish({ type: "pick:whole" });
        }],
        ["Cancel", false, cancel],
      ]);
      return;
    }
    showCard(res);
    if (!res.ok) ui.box.style.display = "none";
  }

  function choose() {
    const el = current();
    if (!el) return;
    stopPicking();
    chain = [el];
    level = 0;
    draw();
    showCard({ busy: true, title: "Checking that Heron can see this part…", text: every ? "It will be checked every " + every + "." : "" });
    finish({ type: "pick:chosen", candidates: selectorsFor(el), text: (el.innerText || "").slice(0, 100000) });
  }

  // ----------------------------------------------------------------- messages

  browser.runtime.onMessage.addListener((msg) => {
    if (!msg || typeof msg.type !== "string") return undefined;
    if (msg.type === "heron:pick") {
      every = msg.every || "";
      startPicking();
      return Promise.resolve({ ok: true });
    }
    if (msg.type === "heron:toast") {
      if (!picking) showCard(msg);
      return Promise.resolve({ ok: true });
    }
    return undefined;
  });
})();
