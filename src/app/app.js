// The dashboard: every watch, adding by address, editing, settings, export and
// import. Like the popup it only reads storage; the background makes the changes.
import { wireSupportLinks } from "../shared/support.js";
import { DEFAULT_SETTINGS, KEYS, LIMITS } from "../shared/config.js";
import { isWatchable, originPattern, hostOf, fillIntervals, clampInterval, send } from "../shared/util.js";
import { createList } from "../shared/list.js";

const $ = (id) => document.getElementById(id);
const EXPORT_KIND = "heron-watch-list";

let watches = [];
let settings = { ...DEFAULT_SETTINGS };
let editing = null; // id of the watch in the edit dialog
let importing = null; // watches read from a file, waiting for "Import"

const list = createList($("list"), {
  openTab: (url) => browser.tabs.create({ url }),
  edit: (id) => openEdit(id),
});

function show(id, text, level) {
  const n = $(id);
  n.textContent = text || "";
  n.className = "note " + (level || "");
  n.hidden = !text;
}

function render() {
  list.render(watches);
  const n = watches.length;
  const changed = watches.filter((w) => w.unread > 0).length;
  $("count").textContent = n ? `(${n}${changed ? `, ${changed} changed` : ""})` : "";
  $("empty").hidden = n > 0;
  $("checkAll").hidden = !watches.some((w) => !w.paused);
  $("seenAll").hidden = !changed;
}

function renderSettings() {
  fillIntervals($("defEvery"), settings.interval);
  $("notify").checked = !!settings.notify;
}

async function load() {
  const got = await browser.storage.local.get([KEYS.watches, KEYS.settings]);
  watches = Array.isArray(got[KEYS.watches]) ? got[KEYS.watches] : [];
  settings = { ...DEFAULT_SETTINGS, ...(got[KEYS.settings] || {}) };
  render();
  renderSettings();
}

/** Ask Firefox for one or more sites. Must be called straight from a click. */
function askFor(urls) {
  const origins = [...new Set(urls.map(originPattern).filter(Boolean))];
  try {
    return browser.permissions.request({ origins }).catch(() => false);
  } catch {
    return Promise.resolve(false);
  }
}

// ---------------------------------------------------------------- add by URL

function normalUrl(raw) {
  const t = String(raw || "").trim();
  if (!t) return "";
  return /^[a-z][a-z0-9+.-]*:/i.test(t) ? t : "https://" + t;
}

function validSelector(sel) {
  if (!sel) return true;
  try {
    document.createDocumentFragment().querySelector(sel);
    return true;
  } catch {
    return false;
  }
}

$("addForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const url = normalUrl($("addUrl").value);
  const selector = $("addSelector").value.trim();
  if (!isWatchable(url)) return show("addMsg", "Enter the address of a web page, for example https://example.com/news.", "warn");
  if (!validSelector(selector)) return show("addMsg", "That CSS selector is not valid.", "warn");
  const asked = askFor([url]); // still inside the click
  $("addGo").disabled = true;
  show("addMsg", "Saving the page as it is now…", "");
  const granted = await asked;
  if (!granted) {
    $("addGo").disabled = false;
    return show("addMsg", `Nothing was added: Heron needs access to ${hostOf(url)} to check it in the background.`, "warn");
  }
  const res = await send("watch:add", { spec: { url, name: $("addName").value, selector, interval: clampInterval($("addEvery").value) } });
  $("addGo").disabled = false;
  if (res.ok) {
    $("addUrl").value = "";
    $("addName").value = "";
    $("addSelector").value = "";
    show("addMsg", res.warn || "Added. The page as it is now is the starting point.", res.warn ? "warn" : "ok");
  } else {
    show("addMsg", [res.title, res.text].filter(Boolean).join(". ") || "Could not add the watch.", "warn");
  }
  return undefined;
});

// ---------------------------------------------------------------------- edit

function openEdit(id) {
  const w = watches.find((x) => x.id === id);
  if (!w) return;
  editing = id;
  $("editName").value = w.name;
  $("editUrl").value = w.url;
  $("editSelector").value = w.selector || "";
  fillIntervals($("editEvery"), w.interval);
  show("editMsg", "");
  const d = $("editDialog");
  if (!d.open) d.showModal();
}

function closeEdit() {
  editing = null;
  if ($("editDialog").open) $("editDialog").close();
  if (location.hash.startsWith("#edit=")) history.replaceState(null, "", location.pathname);
}

$("editCancel").addEventListener("click", closeEdit);
$("editDialog").addEventListener("close", () => {
  editing = null;
});
$("editForm").addEventListener("submit", (e) => {
  e.preventDefault(); // Enter in a field: same as Save
  $("editSave").click();
});
$("editSave").addEventListener("click", async () => {
  const w = watches.find((x) => x.id === editing);
  if (!w) return closeEdit();
  const url = normalUrl($("editUrl").value);
  const selector = $("editSelector").value.trim();
  if (!isWatchable(url)) return show("editMsg", "Enter the address of a web page (http or https).", "warn");
  if (!validSelector(selector)) return show("editMsg", "That CSS selector is not valid.", "warn");
  if (originPattern(url) !== originPattern(w.url)) {
    const granted = await askFor([url]); // a new site: ask for it, inside this click
    if (!granted) return show("editMsg", `Not saved: Heron needs access to ${hostOf(url)} to check it.`, "warn");
  }
  $("editSave").disabled = true;
  const res = await send("watch:update", {
    id: w.id,
    patch: { name: $("editName").value, url, selector, interval: clampInterval($("editEvery").value) },
  });
  $("editSave").disabled = false;
  if (res.ok) return closeEdit();
  return show("editMsg", res.code === "exists" ? "Another watch already has this address and part." : "Could not save the change.", "warn");
});

function editFromHash() {
  const m = /^#edit=([0-9a-f]+)$/.exec(location.hash);
  if (m) openEdit(m[1]);
}

// ------------------------------------------------------------------ settings

$("defEvery").addEventListener("change", () => send("settings:set", { patch: { interval: clampInterval($("defEvery").value) } }));

$("notify").addEventListener("change", async () => {
  const box = $("notify");
  show("settingsMsg", "");
  if (!box.checked) {
    await send("settings:set", { patch: { notify: false } });
    return;
  }
  let granted = false;
  try {
    granted = await browser.permissions.request({ permissions: ["notifications"] }); // inside the click
  } catch {
    granted = false;
  }
  if (!granted) {
    box.checked = false;
    show("settingsMsg", "Notifications stay off: Firefox did not get permission to show them.", "warn");
    return;
  }
  await send("settings:set", { patch: { notify: true } });
});

// ---------------------------------------------------------- export and import

$("exportGo").addEventListener("click", () => {
  const data = {
    kind: EXPORT_KIND,
    version: 1,
    exported: new Date().toISOString(),
    watches: watches.map((w) => ({ name: w.name, url: w.url, selector: w.selector || "", interval: w.interval, paused: !!w.paused })),
  };
  const blob = new Blob([JSON.stringify(data, null, 2) + "\n"], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `heron-watches-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  show("backupMsg", `Exported ${data.watches.length} watch${data.watches.length === 1 ? "" : "es"}.`, "ok");
});

function readImport(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return { error: "This is not a Heron watch list (the file is not valid JSON)." };
  }
  const items = data && data.kind === EXPORT_KIND && Array.isArray(data.watches) ? data.watches : null;
  if (!items) return { error: "This is not a Heron watch list." };
  const good = [];
  for (const it of items) {
    if (!it || typeof it !== "object" || !isWatchable(it.url)) continue;
    const selector = typeof it.selector === "string" ? it.selector.trim() : "";
    if (!validSelector(selector)) continue;
    good.push({
      name: typeof it.name === "string" ? it.name : "",
      url: String(it.url).trim(),
      selector,
      interval: clampInterval(it.interval == null ? settings.interval : it.interval),
      paused: !!it.paused,
    });
  }
  return { watches: good.slice(0, LIMITS.watches), dropped: items.length - good.length };
}

function cancelImport() {
  importing = null;
  $("importPreview").hidden = true;
  $("importFile").value = "";
}

$("importFile").addEventListener("change", async () => {
  const file = $("importFile").files[0];
  show("backupMsg", "");
  if (!file) return;
  const read = file.size > 2 * 1024 * 1024 ? { error: "This file is too large to be a watch list." } : readImport(await file.text());
  if (read.error || !read.watches.length) {
    cancelImport();
    show("backupMsg", read.error || "There are no watches in this file that Heron can use.", "warn");
    return;
  }
  importing = read.watches;
  const sites = [...new Set(importing.map((w) => hostOf(w.url)))];
  const shown = sites.slice(0, 6).join(", ") + (sites.length > 6 ? ` and ${sites.length - 6} more` : "");
  $("importText").textContent =
    `${importing.length} watch${importing.length === 1 ? "" : "es"} on ${sites.length} site${sites.length === 1 ? "" : "s"}: ${shown}.`
    + (read.dropped ? ` ${read.dropped} entr${read.dropped === 1 ? "y" : "ies"} in the file can't be used and will be left out.` : "")
    + " Firefox will ask to let Heron read these sites.";
  $("importPreview").hidden = false;
});

$("importCancel").addEventListener("click", cancelImport);

$("importGo").addEventListener("click", async () => {
  if (!importing) return;
  const items = importing;
  const granted = await askFor(items.map((w) => w.url)); // inside the click
  if (!granted) {
    show("backupMsg", "Nothing was imported: Heron needs access to those sites to check them.", "warn");
    return;
  }
  cancelImport();
  const res = await send("import", { watches: items });
  if (!res.ok) return show("backupMsg", "The import did not work.", "warn");
  const parts = [`Imported ${res.added} watch${res.added === 1 ? "" : "es"}.`];
  if (res.skipped) parts.push(`${res.skipped} already existed.`);
  if (res.invalid) parts.push(`${res.invalid} could not be used.`);
  if (res.full) parts.push(`The list is full (${LIMITS.watches} watches).`);
  return show("backupMsg", parts.join(" "), res.added ? "ok" : "");
});

// -------------------------------------------------------------------- wiring

wireSupportLinks();

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
    render();
  }
  if (changes[KEYS.settings]) {
    settings = { ...DEFAULT_SETTINGS, ...(changes[KEYS.settings].newValue || {}) };
    renderSettings();
  }
});
window.addEventListener("hashchange", editFromHash);
setInterval(render, 30000);

load().then(() => {
  fillIntervals($("addEvery"), settings.interval);
  editFromHash();
  document.body.dataset.ready = "1";
  send("sync");
});
