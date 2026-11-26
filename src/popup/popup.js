import { wireSupportLinks, maybeShowMilestone } from "../shared/support.js";
import { DEFAULT_SETTINGS, KEYS } from "../shared/config.js";
import { isWatchable, originPattern, prettyUrl, hostOf, parseUrl, fillIntervals, clampInterval, send } from "../shared/util.js";
import { createList } from "../shared/list.js";

const $ = (id) => document.getElementById(id);

// ?tab=<id>&url=...&title=... drives the popup from a normal tab (the E2E and the
// listing screenshots). Opened from the toolbar, Firefox tells us the tab itself.
const params = new URLSearchParams(location.search);
const forcedTab = params.has("tab") ? Number(params.get("tab")) : null;

let here = null; // { tabId, url, title } of the page the popup was opened on
let watches = [];
let busy = false;
let shownAdd = 0;

function openTab(url) {
  browser.tabs.create({ url });
  if (forcedTab == null) window.close();
}

const list = createList($("list"), {
  openTab,
  edit: (id) => openTab(browser.runtime.getURL("app/app.html#edit=" + id)),
});

function noHash(raw) {
  const u = parseUrl(raw);
  if (!u) return raw;
  u.hash = "";
  return u.href;
}

async function findHere() {
  if (forcedTab != null) return { tabId: forcedTab, url: params.get("url") || "", title: params.get("title") || "" };
  try {
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    return tab ? { tabId: tab.id, url: tab.url || "", title: tab.title || "" } : null;
  } catch {
    return null;
  }
}

function showMsg(text, level) {
  const m = $("hereMsg");
  m.textContent = text || "";
  m.className = "note " + (level || "");
  m.hidden = !text;
}

function renderHere() {
  const ok = !!here && isWatchable(here.url);
  $("hereForm").hidden = !ok;
  if (!ok) {
    $("hereTitle").textContent = "This page can't be watched";
    $("hereUrl").textContent = "Heron watches regular web pages (http and https). Open one and click the toolbar button again, or add an address under “All watches”.";
    $("hereUrl").style.whiteSpace = "normal";
    return;
  }
  $("hereTitle").textContent = here.title || prettyUrl(here.url);
  $("hereUrl").textContent = prettyUrl(here.url);
  const url = noHash(here.url);
  const whole = watches.some((w) => noHash(w.url) === url && !w.selector);
  $("addPage").disabled = busy || whole;
  $("addPage").textContent = whole ? "Watching this page" : "Watch this page";
  $("addPart").disabled = busy;
  $("hereEvery").disabled = busy;
  const known = watches.some((w) => originPattern(w.url) === originPattern(here.url));
  $("hereNote").textContent = known
    ? "Checked from this device, without your cookies."
    : `Firefox will ask once to let Heron read ${hostOf(here.url)}. Checks run on this device, without your cookies.`;
}

function renderList() {
  list.render(watches);
  const n = watches.length;
  $("count").textContent = n ? `(${n})` : "";
  $("empty").hidden = n > 0;
  $("checkAll").hidden = !watches.some((w) => !w.paused);
  $("seenAll").hidden = !watches.some((w) => w.unread > 0);
}

/** The outcome of the last "Watch this page" for this tab, written by the background. */
function showLastAdd(last) {
  if (!last || !here || last.tabId !== here.tabId || last.url !== noHash(here.url)) return;
  if (last.at <= shownAdd || Date.now() - last.at > 15000) return;
  shownAdd = last.at;
  busy = false;
  showMsg([last.title, last.warn || last.text].filter(Boolean).join(". "), last.ok && !last.warn ? "ok" : "warn");
  renderHere();
}

async function load() {
  const got = await browser.storage.local.get([KEYS.watches, KEYS.settings, KEYS.lastAdd]);
  watches = Array.isArray(got[KEYS.watches]) ? got[KEYS.watches] : [];
  renderList();
  renderHere();
  showLastAdd(got[KEYS.lastAdd]);
  return got;
}

/**
 * Start a watch for the page the popup was opened on.
 * The permission is asked for right here, inside the click, and only for this
 * one site. Firefox may close the popup while its prompt is open, so the
 * background finishes the job (and tells the user in the page) either way.
 */
function begin(mode) {
  if (busy || !here) return;
  busy = true;
  showMsg(mode === "part" ? "Waiting for Firefox's permission prompt…" : "Saving the page as it is now…", "");
  renderHere();
  let asked;
  try {
    asked = browser.permissions.request({ origins: [originPattern(here.url)] });
  } catch (e) {
    asked = Promise.reject(e);
  }
  const started = send("add:begin", {
    mode,
    tabId: here.tabId,
    url: here.url,
    title: here.title,
    interval: clampInterval($("hereEvery").value),
  });
  asked.then(async (granted) => {
    const first = await started;
    if (!granted) {
      await send("add:permission", { granted: false });
      busy = false;
      showMsg(`Nothing was added: Heron needs access to ${hostOf(here.url)} to check it in the background.`, "warn");
      renderHere();
      return;
    }
    const res = first && first.waiting ? await send("add:permission", { granted: true }) : first;
    if (mode === "part") {
      if (res && res.ok === false && !res.waiting) {
        busy = false;
        showMsg([res.title, res.text].filter(Boolean).join(". "), "warn");
        renderHere();
      } else if (forcedTab == null) {
        window.close(); // out of the way: the page is the picker now
      } else {
        busy = false;
        showMsg("Now click the part to watch in the page.", "");
        renderHere();
      }
    }
    // "page": the result arrives through storage (see showLastAdd).
  }, () => {
    busy = false;
    showMsg("Firefox did not show its permission prompt. Close this panel and try again.", "warn");
    renderHere();
  });
}

// -------------------------------------------------------------------- wiring

wireSupportLinks();

$("btnOptions").addEventListener("click", () => {
  browser.runtime.openOptionsPage();
  if (forcedTab == null) window.close();
});
$("openApp").addEventListener("click", () => {
  browser.runtime.openOptionsPage();
  if (forcedTab == null) window.close();
});
$("addPage").addEventListener("click", () => begin("page"));
$("addPart").addEventListener("click", () => begin("part"));
$("seenAll").addEventListener("click", () => send("seen:all"));
$("checkAll").addEventListener("click", async () => {
  const b = $("checkAll");
  b.disabled = true;
  b.textContent = "Checking…";
  await send("check:all");
  b.disabled = false;
  b.textContent = "Check all now";
});

browser.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes[KEYS.watches]) {
    watches = Array.isArray(changes[KEYS.watches].newValue) ? changes[KEYS.watches].newValue : [];
    renderList();
    renderHere();
  }
  if (changes[KEYS.lastAdd]) showLastAdd(changes[KEYS.lastAdd].newValue);
});

setInterval(renderList, 30000); // keeps "5 min ago" honest while the popup stays open

(async () => {
  here = await findHere();
  shownAdd = Date.now() - 4000; // a result older than a few seconds belongs to an earlier visit
  const got = await load();
  fillIntervals($("hereEvery"), ({ ...DEFAULT_SETTINGS, ...(got[KEYS.settings] || {}) }).interval);
  document.body.dataset.ready = "1";
  send("sync"); // puts the badge and the alarm right if Firefox dropped them
  const stats = (await browser.storage.local.get(KEYS.stats))[KEYS.stats] || {};
  maybeShowMilestone($("supportCard"), stats.changes || 0, [10, 100], (m) =>
    `Heron has caught ${m} changes for you.`);
})();
