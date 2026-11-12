// Event page. Firefox stops it after about 30 seconds without work and starts
// it again for an alarm, a message or a permission change, so nothing that
// matters lives in a variable here: watches, saved versions, settings and a
// half-finished "add" are all in storage.local. The few module variables below
// only keep two things that happen at the same moment from tripping over each
// other.
//
// Jobs:
//   1. check watched pages on their schedule (one alarm, set to the next due watch),
//   2. compare what the server sent with the last saved version,
//   3. show changes on the toolbar button and, if switched on, as a notification,
//   4. be the only writer of the watch list, so two pages can not overwrite each other.
//
// Every check is a plain GET without cookies, straight from this browser to the
// watched site. Nothing is sent anywhere else.

import { LIMITS, DEFAULT_SETTINGS, KEYS, ERRORS, WARNINGS } from "./shared/config.js";
import { parseUrl, isWatchable, hostOf, originPattern, prettyUrl, clampInterval, intervalLabel, clip, uid } from "./shared/util.js";
import { squash, plainText, capText, kindOf, decodeBody, parseHtml, watchedText, coverage, similarity } from "./shared/extract.js";
import { summarize } from "./shared/diff.js";

const TICK = "heron-tick";
const EXT_ORIGIN = browser.runtime.getURL("");
const store = browser.storage.local;
const LOGIN = /(^|[./_-])(login|log-in|logon|signin|sign-in|sign_in|signon|auth|authorize|authenticate|oauth2?|sso|saml)([./_?-]|$)/i;
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

// ------------------------------------------------------------------- storage

let chain = Promise.resolve();
/** Run one read-change-write at a time. */
function locked(fn) {
  const run = chain.then(fn);
  chain = run.then(() => {}, () => {});
  return run;
}

async function getWatches() {
  const got = await store.get(KEYS.watches);
  return Array.isArray(got[KEYS.watches]) ? got[KEYS.watches] : [];
}

async function getSettings() {
  const got = await store.get(KEYS.settings);
  const s = { ...DEFAULT_SETTINGS, ...(got[KEYS.settings] || {}) };
  s.interval = clampInterval(s.interval);
  s.notify = !!s.notify;
  return s;
}

async function getSnap(id) {
  const key = KEYS.snap(id);
  const got = await store.get(key);
  const snap = got[key];
  return snap && Array.isArray(snap.versions) ? snap : { versions: [] };
}

/** Change the watch list under the lock, then refresh the badge and the alarm. */
function mutate(fn) {
  return locked(async () => {
    const list = await getWatches();
    const out = await fn(list);
    await store.set({ [KEYS.watches]: list });
    await afterChange(list);
    return out;
  });
}

function stripHash(raw) {
  const u = parseUrl(raw);
  if (!u) return String(raw || "");
  u.hash = "";
  return u.href;
}

// ----------------------------------------------------------- badge and alarm

function needsAttention(w) {
  return !w.paused && !!w.error && ((ERRORS[w.error.code] || {}).sticky || w.error.count >= 3);
}

async function updateBadge(list) {
  const unread = list.filter((w) => w.unread > 0).length;
  const trouble = list.filter(needsAttention).length;
  try {
    if (unread) {
      await browser.action.setBadgeBackgroundColor({ color: "#0b6bcb" });
      await browser.action.setBadgeTextColor({ color: "#ffffff" });
      await browser.action.setBadgeText({ text: String(unread) });
      await browser.action.setTitle({ title: `Heron: ${unread} watched page${unread === 1 ? "" : "s"} changed` });
    } else if (trouble) {
      await browser.action.setBadgeBackgroundColor({ color: "#b45309" });
      await browser.action.setBadgeTextColor({ color: "#ffffff" });
      await browser.action.setBadgeText({ text: "!" });
      await browser.action.setTitle({ title: `Heron: ${trouble} watch${trouble === 1 ? " needs" : "es need"} a look` });
    } else {
      await browser.action.setBadgeText({ text: "" });
      await browser.action.setTitle({ title: null });
    }
  } catch {
    // The badge is a nicety; a check must never fail because of it.
  }
}

let running = null; // the check run in progress, if any

async function schedule(list) {
  if (running) return; // the run sets the alarm itself when it is done
  const active = (list || (await getWatches())).filter((w) => !w.paused);
  if (!active.length) {
    await browser.alarms.clear(TICK);
    return;
  }
  const next = Math.min(...active.map((w) => w.nextCheck || 0));
  await browser.alarms.create(TICK, { when: Math.max(Date.now() + 1000, next) });
}

async function afterChange(list) {
  await updateBadge(list);
  await schedule(list);
}

// -------------------------------------------------------------- fetch a page

function statusCode(status) {
  if (status === 404 || status === 410) return "notfound";
  if ([401, 403, 407, 429, 451].includes(status)) return "blocked";
  if (status >= 500) return "server";
  return "http";
}

function looksLikeLogin(orig, final) {
  const o = parseUrl(orig);
  const f = parseUrl(final);
  if (!o || !f) return false;
  const where = (u) => u.hostname + u.pathname;
  return LOGIN.test(where(f)) && !LOGIN.test(where(o));
}

/** The body as bytes, or null when it is larger than `max`. */
async function readCapped(res, max) {
  if (Number(res.headers.get("content-length")) > max) {
    if (res.body) res.body.cancel().catch(() => {});
    return null;
  }
  if (!res.body) {
    const all = new Uint8Array(await res.arrayBuffer());
    return all.length > max ? null : all;
  }
  const reader = res.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > max) {
      reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

/**
 * Get a page the way every check does: one GET, no cookies, no referrer, no cache.
 * Returns { ok: true, kind: "html", doc } or { ok: true, kind: "text", raw },
 * or { ok: false, code, detail }.
 */
async function loadPage(url) {
  let allowed = false;
  try {
    allowed = await browser.permissions.contains({ origins: [originPattern(url)] });
  } catch {
    allowed = false;
  }
  if (!allowed) return { ok: false, code: "permission" };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), LIMITS.fetchTimeoutMs);
  try {
    const res = await fetch(url, {
      method: "GET",
      redirect: "follow",
      credentials: "omit",
      cache: "no-store",
      referrerPolicy: "no-referrer",
      signal: ctrl.signal,
      headers: { Accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5" },
    });
    if (res.status >= 400 || res.status === 0) {
      if (res.body) res.body.cancel().catch(() => {});
      return { ok: false, code: statusCode(res.status), detail: "HTTP " + res.status };
    }
    if (res.redirected && looksLikeLogin(url, res.url)) {
      if (res.body) res.body.cancel().catch(() => {});
      return { ok: false, code: "login", detail: prettyUrl(res.url) };
    }
    const type = res.headers.get("content-type") || "";
    const kind = kindOf(type);
    if (kind === "other") {
      if (res.body) res.body.cancel().catch(() => {});
      return { ok: false, code: "type", detail: type.split(";")[0] };
    }
    const bytes = await readCapped(res, LIMITS.bodyBytes);
    if (!bytes) return { ok: false, code: "toobig" };
    const raw = decodeBody(bytes, type);
    return kind === "html" ? { ok: true, kind, doc: parseHtml(raw) } : { ok: true, kind, raw };
  } catch (e) {
    if (ctrl.signal.aborted) return { ok: false, code: "timeout" };
    return { ok: false, code: "network", detail: String((e && e.message) || e) };
  } finally {
    clearTimeout(timer);
  }
}

/** The watched text of a loaded page: { ok: true, text, truncated } or { ok: false, code }. */
function readWatched(page, selector) {
  if (!page.ok) return page;
  let got;
  if (page.kind === "html") {
    got = watchedText(page.doc, selector);
    if (!got.ok) return got;
  } else {
    if (selector) return { ok: false, code: "missing" };
    got = { text: plainText(page.raw) };
  }
  const capped = capText(got.text, LIMITS.snapshotChars);
  return { ok: true, text: capped.text, truncated: capped.truncated };
}

// ------------------------------------------------------------------- checking

function trimHistory(snap) {
  const v = snap.versions;
  while (v.length > LIMITS.versions) v.shift();
  const total = () => v.reduce((n, x) => n + x.text.length, 0);
  while (v.length > 2 && total() > LIMITS.historyChars) v.shift();
}

/** What to tell the user about a fresh baseline, or null. `seen` is the text the user had on screen. */
function warningFor(text, seen, selector, scripts) {
  if (selector) {
    if (seen != null && squash(seen) !== squash(text) && similarity(seen, text) < 0.5) return { code: "differs" };
    return null;
  }
  if (seen != null && squash(seen).length > 200) {
    const share = coverage(seen, text);
    if (share < 0.5) return { code: "partial", pct: Math.round(share * 100) };
  }
  if (text.length < 150 && scripts > 0) return { code: "thin" }; // next to nothing to read, and scripts to draw the rest
  return null;
}

/**
 * Check one watch now. `page` is an already loaded copy (used right after the
 * user picked a part), `seen` the text the user had on screen when adding.
 * Resolves to { id, name, url, changed, baseline, error, sample } or null when
 * the watch is gone or was edited meanwhile.
 */
async function checkWatch(id, { page = null, seen = null } = {}) {
  const before = (await getWatches()).find((w) => w.id === id);
  if (!before) return null;
  const loaded = page || (await loadPage(before.url));
  const res = readWatched(loaded, before.selector);
  const scripts = loaded.ok && loaded.kind === "html" ? loaded.doc.scripts.length : 0;
  return locked(async () => {
    const list = await getWatches();
    const w = list.find((x) => x.id === id);
    if (!w || w.url !== before.url || w.selector !== before.selector) return null;
    const now = Date.now();
    const every = clampInterval(w.interval) * 60000;
    const out = { id, name: w.name, url: w.url, changed: false, baseline: false, error: null, sample: "" };
    if (!res.ok) {
      const offline = navigator.onLine === false && (res.code === "network" || res.code === "timeout");
      if (offline) {
        w.nextCheck = now + Math.min(every, LIMITS.retryMinutes * 60000);
      } else {
        const prev = w.error;
        const same = prev && prev.code === res.code;
        w.error = { code: res.code, detail: clip(res.detail || "", 200), since: same ? prev.since : now, count: same ? prev.count + 1 : 1 };
        w.lastCheck = now;
        const soon = (res.code === "network" || res.code === "timeout") && w.error.count <= 3;
        w.nextCheck = now + (soon ? Math.min(every, LIMITS.retryMinutes * 60000) : every);
        out.error = res.code;
      }
    } else {
      const key = KEYS.snap(id);
      const snap = await getSnap(id);
      const latest = snap.versions[snap.versions.length - 1];
      w.error = null;
      w.lastCheck = now;
      w.nextCheck = now + every;
      w.size = res.text.length;
      w.truncated = !!res.truncated;
      if (!latest) {
        snap.versions.push({ at: now, text: res.text });
        w.warn = warningFor(res.text, seen, w.selector, scripts);
        out.baseline = true;
        out.sample = clip(res.text, 140);
        await store.set({ [key]: snap });
      } else if (latest.text !== res.text) {
        const sum = summarize(latest.text, res.text);
        snap.versions.push({ at: now, text: res.text });
        trimHistory(snap);
        w.lastChange = now;
        w.unread = (w.unread || 0) + 1;
        w.changes = (w.changes || 0) + 1;
        w.delta = { added: sum.added, removed: sum.removed, sample: sum.sample };
        out.changed = true;
        out.sample = sum.sample;
        await store.set({ [key]: snap });
        const got = await store.get(KEYS.stats);
        const stats = got[KEYS.stats] || {};
        await store.set({ [KEYS.stats]: { ...stats, changes: (stats.changes || 0) + 1 } });
      }
    }
    await store.set({ [KEYS.watches]: list });
    await afterChange(list);
    return out;
  });
}

/** Check several watches: sites side by side, but one request at a time per site with a pause in between. */
async function checkMany(ids) {
  const list = await getWatches();
  const lanes = new Map();
  for (const id of ids) {
    const w = list.find((x) => x.id === id);
    if (!w) continue;
    const host = hostOf(w.url);
    if (!lanes.has(host)) lanes.set(host, []);
    lanes.get(host).push(id);
  }
  const queue = [...lanes.values()];
  const results = [];
  const worker = async () => {
    for (let lane = queue.shift(); lane; lane = queue.shift()) {
      for (let i = 0; i < lane.length; i++) {
        if (i) await sleep(LIMITS.hostGapMs);
        try {
          const r = await checkWatch(lane[i]);
          if (r) results.push(r);
        } catch {
          // One broken watch must not stop the others.
        }
      }
    }
  };
  await Promise.all(Array.from({ length: LIMITS.parallelHosts }, worker));
  return results;
}

/** Check every watch that is due, then set the alarm for the next one. */
function runDue() {
  if (running) return running;
  running = (async () => {
    // If Firefox stops this page halfway, this alarm brings it back to finish.
    await browser.alarms.create(TICK, { when: Date.now() + 2 * 60000 });
    if (navigator.onLine === false) return [];
    const now = Date.now();
    const due = (await getWatches()).filter((w) => !w.paused && (w.nextCheck || 0) <= now + 2000);
    const results = due.length ? await checkMany(due.map((w) => w.id)) : [];
    await notify(results);
    return results;
  })().catch(() => []).finally(async () => {
    running = null;
    if (navigator.onLine === false) await browser.alarms.create(TICK, { when: Date.now() + 5 * 60000 });
    else await schedule().catch(() => {});
  });
  return running;
}

// -------------------------------------------------------------- notifications

async function notify(results) {
  const changed = results.filter((r) => r && r.changed);
  if (!changed.length || !browser.notifications) return;
  if (!(await getSettings()).notify) return;
  const iconUrl = browser.runtime.getURL("icons/icon-96.png");
  try {
    if (changed.length <= 3) {
      for (const r of changed) {
        await browser.notifications.create(`change:${r.id}:${Date.now()}`, {
          type: "basic",
          iconUrl,
          title: "Changed: " + r.name,
          message: r.sample || prettyUrl(r.url),
        });
      }
    } else {
      await browser.notifications.create(`changes:${Date.now()}`, {
        type: "basic",
        iconUrl,
        title: `${changed.length} watched pages changed`,
        message: clip(changed.map((r) => r.name).join(", "), 200),
      });
    }
  } catch {
    // Notifications switched off in the system: the badge still shows the change.
  }
}

function onNotificationClicked(nid) {
  const m = /^change:([0-9a-f]+):/.exec(nid);
  const url = m ? "changes/changes.html?id=" + m[1] : "app/app.html";
  browser.tabs.create({ url: browser.runtime.getURL(url) });
  browser.notifications.clear(nid);
}

let notifyWired = false;
function wireNotifications() {
  if (notifyWired || !browser.notifications) return;
  browser.notifications.onClicked.addListener(onNotificationClicked);
  notifyWired = true;
}

// --------------------------------------------------------------- add a watch

/** Words for the page toast, the picker and the popup after an add. */
function describe(res, what) {
  if (!res.ok) {
    if (res.code === "exists") return { ok: false, code: "exists", id: res.id, title: "Already watching this", text: "Heron already has a watch for exactly this." };
    if (res.code === "full") return { ok: false, code: "full", title: "Watch list is full", text: `Heron keeps up to ${LIMITS.watches} watches. Delete one to add another.` };
    if (res.code === "bad-url") return { ok: false, code: "bad-url", title: "Can't watch this address", text: "Heron can watch http and https pages." };
    return { ok: false, code: res.code || "error", title: "Could not add the watch", text: (ERRORS[res.code] || {}).text || "Something went wrong." };
  }
  const w = res.watch;
  const out = { ok: true, id: w.id, title: `Heron is watching ${what}`, text: `It checks every ${intervalLabel(w.interval)}, on this device.`, warn: "", sees: "" };
  if (w.error) {
    out.level = "warn";
    out.warn = `The first check did not work: ${(ERRORS[w.error.code] || {}).text || w.error.code} Heron will keep trying.`;
  } else {
    if (w.selector && res.sample) out.sees = clip(res.sample, 110);
    if (w.warn) {
      out.level = "warn";
      out.warn = WARNINGS[w.warn.code] || "";
    } else if (w.truncated) {
      out.level = "warn";
      out.warn = WARNINGS.truncated;
    }
  }
  return out;
}

/**
 * Create a watch and save its first version.
 * `spec` is { url, name, selector, interval, paused }.
 */
async function addWatch(spec, { page = null, seen = null, check = true } = {}) {
  const url = String(spec.url || "").trim();
  if (!isWatchable(url) || url.length > LIMITS.urlChars) return { ok: false, code: "bad-url" };
  const selector = String(spec.selector || "").trim().slice(0, LIMITS.selectorChars);
  const settings = await getSettings();
  const now = Date.now();
  const watch = {
    id: uid(),
    name: clip(spec.name, LIMITS.nameChars) || prettyUrl(url),
    url,
    selector,
    interval: clampInterval(spec.interval == null ? settings.interval : spec.interval),
    paused: !!spec.paused,
    createdAt: now,
    lastCheck: 0,
    lastChange: 0,
    nextCheck: now,
    unread: 0,
    changes: 0,
    size: 0,
    truncated: false,
    error: null,
    warn: null,
    delta: null,
  };
  const added = await mutate((list) => {
    if (list.length >= LIMITS.watches) return { ok: false, code: "full" };
    const dup = list.find((w) => w.url === url && w.selector === selector);
    if (dup) return { ok: false, code: "exists", id: dup.id };
    list.push(watch);
    return { ok: true };
  });
  if (!added.ok) return added;
  let first = null;
  if (check) first = await checkWatch(watch.id, { page, seen });
  const fresh = (await getWatches()).find((w) => w.id === watch.id) || watch;
  return { ok: true, id: watch.id, watch: fresh, sample: first ? first.sample : "" };
}

function popupOpen() {
  try {
    return browser.extension.getViews({ type: "popup" }).length > 0;
  } catch {
    return false;
  }
}

/** Load the in-page script into a tab and hand it a message. */
async function tellPage(tabId, message) {
  try {
    await browser.scripting.executeScript({ target: { tabId }, files: ["content/picker.js"] });
    const res = await browser.tabs.sendMessage(tabId, message, { frameId: 0 });
    return res || { ok: true };
  } catch (e) {
    // about: pages, addons.mozilla.org, the PDF viewer: Firefox lets no add-on in there.
    return { ok: false, code: "blocked", detail: String((e && e.message) || e) };
  }
}

/** What the user has on screen in a tab, to compare with what the server sends. */
async function textOnScreen(tabId, url) {
  try {
    const tab = await browser.tabs.get(tabId);
    if (!tab.url || stripHash(tab.url) !== stripHash(url)) return null;
    const [r] = await browser.scripting.executeScript({
      target: { tabId },
      func: () => (document.body ? document.body.innerText.slice(0, 200000) : ""),
    });
    return r && typeof r.result === "string" ? r.result : null;
  } catch {
    return null;
  }
}

async function getPending() {
  const got = await store.get(KEYS.pending);
  const p = got[KEYS.pending];
  if (!p) return null;
  if (Date.now() - p.at > LIMITS.pendingMs) {
    await store.remove(KEYS.pending);
    return null;
  }
  return p;
}

/**
 * The popup asked to watch the page in a tab. The site permission may still be
 * waiting for the user's answer (Firefox closes the popup while it asks), so
 * the request is parked in storage and finished from permissions.onAdded.
 */
async function beginAdd(msg) {
  const url = stripHash(msg.url);
  if (!isWatchable(url)) return describe({ ok: false, code: "bad-url" });
  if (!Number.isInteger(msg.tabId)) return { ok: false, code: "no-tab" };
  await locked(() => store.set({
    [KEYS.pending]: {
      mode: msg.mode === "part" ? "part" : "page",
      stage: "permission",
      tabId: msg.tabId,
      url,
      title: clip(msg.title, LIMITS.nameChars),
      interval: clampInterval(msg.interval),
      origin: originPattern(url),
      at: Date.now(),
    },
  }));
  return completePending();
}

async function completePending() {
  const p = await locked(async () => {
    const pending = await getPending();
    if (!pending || pending.stage !== "permission") return null;
    if (!(await browser.permissions.contains({ origins: [pending.origin] }))) return null;
    if (pending.mode === "page") await store.remove(KEYS.pending);
    else await store.set({ [KEYS.pending]: { ...pending, stage: "picking" } });
    return pending;
  });
  if (!p) return { ok: true, waiting: true };
  if (p.mode === "part") {
    const res = await tellPage(p.tabId, { type: "heron:pick", every: intervalLabel(p.interval) });
    if (!res.ok) {
      await store.remove(KEYS.pending);
      return lastAdd(p, { ok: false, code: "blocked", title: "Can't pick on this page", text: "Firefox doesn't let add-ons work on this page." });
    }
    return { ok: true, picking: true };
  }
  const seen = await textOnScreen(p.tabId, p.url);
  const res = describe(await addWatch({ url: p.url, name: p.title, selector: "", interval: p.interval }, { seen }), "this page");
  await lastAdd(p, res);
  if (!popupOpen()) await tellPage(p.tabId, { type: "heron:toast", ...res });
  return res;
}

/** Leave the outcome where the popup can find it: it may have been closed and reopened meanwhile. */
async function lastAdd(p, res) {
  await store.set({ [KEYS.lastAdd]: { ...res, at: Date.now(), tabId: p.tabId, url: p.url } });
  return res;
}

async function permissionAnswer(msg) {
  if (msg.granted) return completePending();
  await locked(async () => {
    const pending = await getPending();
    if (pending && pending.stage === "permission") await store.remove(KEYS.pending);
  });
  return { ok: true };
}

/** The pending "watch one part" that a message from a page belongs to, or null. */
async function pickingFor(sender) {
  const p = await getPending();
  if (!p || p.stage !== "picking" || !sender.tab || sender.tab.id !== p.tabId || sender.frameId !== 0) return null;
  const url = stripHash(sender.url || "");
  if (!isWatchable(url) || originPattern(url) !== p.origin) return null;
  return { ...p, url };
}

/**
 * The user clicked a part of the page. Load the page the way a check does and
 * see whether that part is in it: parts drawn later by JavaScript are not.
 */
async function pickChosen(msg, sender) {
  const p = await pickingFor(sender);
  if (!p) return { ok: false, code: "stale", title: "Picking timed out", text: "Open Heron from the toolbar and start again." };
  const page = await loadPage(p.url);
  if (!page.ok) return describe(page);
  const seen = squash(msg.text);
  const candidates = (Array.isArray(msg.candidates) ? msg.candidates : [])
    .filter((s) => typeof s === "string" && s && s.length <= LIMITS.selectorChars)
    .slice(0, 6);
  let best = null;
  if (page.kind === "html") {
    for (const selector of candidates) {
      const got = watchedText(page.doc, selector);
      if (!got.ok) continue;
      const score = squash(got.text) === seen ? 2 : similarity(got.text, seen);
      if (!best || score > best.score) best = { selector, text: got.text, score };
      if (score === 2) break;
    }
  }
  if (!best || (!squash(best.text) && seen)) {
    return {
      ok: false,
      code: "jsdrawn",
      title: "Heron can't see this part",
      text: "It is not in the HTML the server sends: the page draws it later with JavaScript. Heron checks in the background without opening the page, so it would never see it change.",
    };
  }
  const res = await addWatch({ url: p.url, name: p.title, selector: best.selector, interval: p.interval }, { page, seen: msg.text });
  if (res.ok || res.code === "exists") await store.remove(KEYS.pending);
  return describe(res, "this part");
}

async function pickWhole(sender) {
  const p = await pickingFor(sender);
  if (!p) return { ok: false, code: "stale", title: "Picking timed out", text: "Open Heron from the toolbar and start again." };
  await store.remove(KEYS.pending);
  const seen = await textOnScreen(p.tabId, p.url);
  return describe(await addWatch({ url: p.url, name: p.title, selector: "", interval: p.interval }, { seen }), "this page");
}

// ------------------------------------------------------------- list actions

async function updateWatch(id, patch) {
  let reset = false;
  let oldOrigin = "";
  const res = await mutate(async (list) => {
    const w = list.find((x) => x.id === id);
    if (!w) return { ok: false, code: "gone" };
    const next = { ...w };
    if (patch.name != null) next.name = clip(patch.name, LIMITS.nameChars) || prettyUrl(w.url);
    if (patch.interval != null) next.interval = clampInterval(patch.interval);
    if (patch.url != null) {
      const url = String(patch.url).trim();
      if (!isWatchable(url) || url.length > LIMITS.urlChars) return { ok: false, code: "bad-url" };
      next.url = url;
    }
    if (patch.selector != null) next.selector = String(patch.selector).trim().slice(0, LIMITS.selectorChars);
    if (list.some((x) => x.id !== id && x.url === next.url && x.selector === next.selector)) return { ok: false, code: "exists" };
    reset = next.url !== w.url || next.selector !== w.selector;
    if (reset) {
      // Another address or another part: the old versions no longer compare.
      oldOrigin = originPattern(w.url);
      Object.assign(next, { lastCheck: 0, lastChange: 0, unread: 0, error: null, warn: null, delta: null, size: 0, truncated: false, nextCheck: Date.now() });
      await store.remove(KEYS.snap(id));
    } else if (next.interval !== w.interval) {
      next.nextCheck = Math.min(w.nextCheck || 0, (w.lastCheck || Date.now()) + next.interval * 60000);
    }
    Object.assign(w, next);
    return { ok: true };
  });
  if (res.ok && reset) {
    await checkWatch(id);
    await dropUnusedOrigin(oldOrigin);
  }
  return res;
}

/** Give a site permission back when no watch needs it any more. */
async function dropUnusedOrigin(origin) {
  if (!origin) return;
  const list = await getWatches();
  if (list.some((w) => originPattern(w.url) === origin)) return;
  try {
    await browser.permissions.remove({ origins: [origin] });
  } catch {
    // Already gone.
  }
}

async function deleteWatch(id) {
  let origin = "";
  await mutate((list) => {
    const i = list.findIndex((w) => w.id === id);
    if (i < 0) return;
    origin = originPattern(list[i].url);
    list.splice(i, 1);
  });
  await store.remove(KEYS.snap(id));
  await dropUnusedOrigin(origin);
  return { ok: true };
}

function setPaused(id, paused) {
  return mutate((list) => {
    const w = list.find((x) => x.id === id);
    if (!w) return { ok: false, code: "gone" };
    w.paused = !!paused;
    if (!w.paused) w.nextCheck = Math.min(w.nextCheck || 0, Date.now());
    return { ok: true };
  });
}

function markSeen(id) {
  return mutate((list) => {
    for (const w of list) if (id == null || w.id === id) w.unread = 0;
    return { ok: true };
  });
}

async function importWatches(items) {
  const counts = { ok: true, added: 0, skipped: 0, invalid: 0 };
  for (const item of Array.isArray(items) ? items.slice(0, LIMITS.watches * 2) : []) {
    if (!item || typeof item !== "object") {
      counts.invalid++;
      continue;
    }
    const res = await addWatch(item, { check: false });
    if (res.ok) counts.added++;
    else if (res.code === "exists") counts.skipped++;
    else if (res.code === "full") {
      counts.full = true;
      break;
    } else counts.invalid++;
  }
  if (counts.added) runDue(); // first versions are fetched in the background, site by site
  return counts;
}

async function setSettings(patch) {
  const s = await getSettings();
  if (patch.interval != null) s.interval = clampInterval(patch.interval);
  if (patch.notify != null) {
    let allowed = false;
    try {
      allowed = await browser.permissions.contains({ permissions: ["notifications"] });
    } catch {
      allowed = false;
    }
    s.notify = !!patch.notify && allowed;
    if (s.notify) wireNotifications();
  }
  await store.set({ [KEYS.settings]: s });
  return { ok: true, settings: s };
}

/** Put the badge and the alarm right, and catch up on anything that is due. */
async function sync() {
  const list = await getWatches();
  await afterChange(list);
  if (list.some((w) => !w.paused && (w.nextCheck || 0) <= Date.now())) runDue();
  return { ok: true };
}

// -------------------------------------------------------------------- events

browser.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === TICK) return runDue();
  return undefined;
});

browser.runtime.onMessage.addListener((msg, sender) => {
  if (!msg || typeof msg.type !== "string" || sender.id !== browser.runtime.id) return undefined;
  const fromOwnPage = typeof sender.url === "string" && sender.url.startsWith(EXT_ORIGIN);
  if (!fromOwnPage) {
    // A web page's tab: only the picker talks from there, and only about a pick the user started.
    switch (msg.type) {
      case "pick:chosen":
        return pickChosen(msg, sender);
      case "pick:whole":
        return pickWhole(sender);
      case "pick:cancel":
        return pickingFor(sender).then((p) => (p ? store.remove(KEYS.pending) : null)).then(() => ({ ok: true }));
      default:
        return undefined;
    }
  }
  switch (msg.type) {
    case "add:begin":
      return beginAdd(msg);
    case "add:permission":
      return permissionAnswer(msg);
    case "watch:add":
      return addWatch(msg.spec || {}).then((res) => describe(res, "this page"));
    case "watch:update":
      return updateWatch(msg.id, msg.patch || {});
    case "watch:delete":
      return deleteWatch(msg.id);
    case "watch:pause":
      return setPaused(msg.id, msg.paused);
    case "watch:check":
      return checkWatch(msg.id).then((r) => (r ? { ok: true, changed: r.changed, error: r.error } : { ok: false, code: "gone" }));
    case "check:all":
      return getWatches()
        .then((list) => checkMany(list.filter((w) => !w.paused).map((w) => w.id)))
        .then((rs) => ({ ok: true, checked: rs.length, changed: rs.filter((r) => r.changed).length }));
    case "watch:seen":
      return markSeen(msg.id);
    case "seen:all":
      return markSeen(null);
    case "import":
      return importWatches(msg.watches);
    case "settings:set":
      return setSettings(msg.patch || {});
    case "sync":
      return sync();
    default:
      return undefined;
  }
});

browser.permissions.onAdded.addListener((added) => {
  if (added.permissions && added.permissions.includes("notifications")) wireNotifications();
  if (added.origins && added.origins.length) return completePending();
  return undefined;
});

browser.permissions.onRemoved.addListener(async (removed) => {
  if (removed.permissions && removed.permissions.includes("notifications")) {
    const s = await getSettings();
    if (s.notify) await store.set({ [KEYS.settings]: { ...s, notify: false } });
  }
});

browser.runtime.onInstalled.addListener(() => sync());
browser.runtime.onStartup.addListener(() => sync());

wireNotifications();
