// "What changed": the saved versions of one watch and the difference between
// each version and the one before it. Opening this page marks the watch as seen.
import { wireSupportLinks } from "../shared/support.js";
import { KEYS, ERRORS, WARNINGS } from "../shared/config.js";
import { ago, dateTime, prettyUrl, intervalLabel, send } from "../shared/util.js";
import { diffRows } from "../shared/diff.js";

const $ = (id) => document.getElementById(id);
const id = new URLSearchParams(location.search).get("id") || "";
const CONTEXT = 2; // unchanged lines kept around each change
const FOLD = 4; // fewer unchanged lines than this are simply shown

let watch = null;
let versions = []; // oldest first; the last one is the page as it is now
let selected = -1; // index of the newer version of the pair being compared
let fresh = 0; // how many of the newest changes the user has not seen yet
let opened = new Set(); // collapsed runs the user opened, for the selected change

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

function line(cls, gutter, content) {
  const r = el("div", "r " + cls);
  const t = el("span", "t");
  if (typeof content === "string") {
    t.textContent = content;
  } else {
    for (const part of content.parts) {
      if (part.changed) t.append(el(content.tag, "", part.text));
      else t.append(document.createTextNode(part.text));
    }
  }
  r.append(el("span", "g", gutter), t);
  return r;
}

function count(rows) {
  let added = 0;
  let removed = 0;
  for (const r of rows) {
    if (r.type === "add" || r.type === "chg") added++;
    if (r.type === "del" || r.type === "chg") removed++;
  }
  return { added, removed };
}

function countText(c) {
  const parts = [];
  if (c.added) parts.push(`${c.added} added`);
  if (c.removed) parts.push(`${c.removed} removed`);
  return parts.join(", ") || "no text changed";
}

function renderDiff() {
  const box = $("diff");
  box.replaceChildren();
  if (selected < 1) {
    // Only the first version exists: show it as it is.
    const text = versions.length ? versions[versions.length - 1].text : "";
    $("diffTitle").textContent = "No changes yet";
    $("counts").textContent = "";
    $("legend").hidden = true;
    $("showAll").closest("label").hidden = true;
    if (!text) {
      box.append(el("div", "none", versions.length ? "The watched part has no text right now." : "Heron has not been able to read this page yet."));
      return;
    }
    for (const t of text.split("\n")) box.append(line("eq", "", t));
    return;
  }
  $("legend").hidden = false;
  $("showAll").closest("label").hidden = false;
  const rows = diffRows(versions[selected - 1].text, versions[selected].text);
  $("diffTitle").textContent = "Changed " + dateTime(versions[selected].at);
  $("counts").textContent = countText(count(rows));
  const all = $("showAll").checked;
  // Mark which unchanged rows sit close enough to a change to be shown.
  const near = new Array(rows.length).fill(false);
  rows.forEach((r, i) => {
    if (r.type === "eq") return;
    for (let k = Math.max(0, i - CONTEXT); k <= Math.min(rows.length - 1, i + CONTEXT); k++) near[k] = true;
  });
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (r.type === "eq" && !all && !near[i]) {
      let end = i;
      while (end + 1 < rows.length && rows[end + 1].type === "eq" && !near[end + 1]) end++;
      const n = end - i + 1;
      if (opened.has(i) || n < FOLD) {
        for (let k = i; k <= end; k++) box.append(line("eq", "", rows[k].text));
      } else {
        const skip = el("button", "skip", `${n} unchanged line${n === 1 ? "" : "s"}`);
        skip.type = "button";
        skip.dataset.run = String(i);
        skip.title = "Show these lines";
        box.append(skip);
      }
      i = end;
      continue;
    }
    if (r.type === "eq") box.append(line("eq", "", r.text));
    else if (r.type === "add") box.append(line("add", "+", r.text));
    else if (r.type === "del") box.append(line("del", "−", r.text));
    else {
      box.append(line("chg old", "−", { parts: r.old, tag: "del" }));
      box.append(line("chg new", "+", { parts: r.new, tag: "ins" }));
    }
  }
}

function renderVersions() {
  const list = $("versions");
  list.replaceChildren();
  for (let i = versions.length - 1; i >= 1; i--) {
    const li = el("li");
    const b = el("button");
    b.type = "button";
    b.dataset.index = String(i);
    b.setAttribute("aria-current", String(i === selected));
    const when = el("span", "when", dateTime(versions[i].at));
    if (versions.length - i <= fresh) when.append(el("span", "new", "new"));
    const c = count(diffRows(versions[i - 1].text, versions[i].text));
    b.append(when, el("span", "what", countText(c)));
    li.append(b);
    list.append(li);
  }
  const first = versions[0];
  $("kept").textContent = first
    ? (versions.length > 1 ? "Oldest saved version: " : "First saved: ") + dateTime(first.at) + ". Heron keeps the last 10 versions."
    : "";
}

function renderHead() {
  document.title = "Heron: " + watch.name;
  $("name").textContent = watch.name;
  $("url").textContent = prettyUrl(watch.url);
  $("url").href = watch.url;
  $("open").href = watch.url;
  $("edit").href = "../app/app.html#edit=" + watch.id;
  $("meta").textContent = [
    watch.selector ? "One part of the page" : "Whole page",
    "checked every " + intervalLabel(watch.interval),
    watch.paused ? "paused" : "last checked " + ago(watch.lastCheck),
  ].join(" · ");
  $("meta").title = watch.selector || "";
  const p = $("problem");
  if (watch.error) {
    p.textContent = (ERRORS[watch.error.code] || { text: "The last check did not work." }).text;
    p.hidden = false;
  } else if (watch.warn || watch.truncated) {
    p.textContent = watch.warn ? WARNINGS[watch.warn.code] : WARNINGS.truncated;
    p.hidden = false;
  } else {
    p.hidden = true;
  }
}

async function load(first) {
  const key = KEYS.snap(id);
  const got = await browser.storage.local.get([KEYS.watches, key]);
  watch = (Array.isArray(got[KEYS.watches]) ? got[KEYS.watches] : []).find((w) => w.id === id) || null;
  $("gone").hidden = !!watch;
  $("view").hidden = !watch;
  if (!watch) return;
  const had = versions.length;
  versions = got[key] && Array.isArray(got[key].versions) ? got[key].versions : [];
  if (first) fresh = Math.min(watch.unread || 0, Math.max(0, versions.length - 1));
  else if (versions.length > had && had) fresh = Math.min(versions.length - 1, fresh + versions.length - had);
  if (first || versions.length !== had || selected >= versions.length) {
    selected = versions.length - 1; // the newest change
    opened = new Set();
  }
  renderHead();
  renderVersions();
  renderDiff();
  if (watch.unread) send("watch:seen", { id });
}

// -------------------------------------------------------------------- wiring

wireSupportLinks();

$("versions").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-index]");
  if (!b) return;
  selected = Number(b.dataset.index);
  opened = new Set();
  renderVersions();
  renderDiff();
});

$("diff").addEventListener("click", (e) => {
  const b = e.target.closest("button.skip");
  if (!b) return;
  opened.add(Number(b.dataset.run));
  renderDiff();
});

$("showAll").addEventListener("change", renderDiff);

$("check").addEventListener("click", async () => {
  const b = $("check");
  b.disabled = true;
  $("checkMsg").textContent = "Checking…";
  const res = await send("watch:check", { id });
  b.disabled = false;
  $("checkMsg").textContent = !res.ok ? "Could not check."
    : res.error ? "The check did not work."
    : res.changed ? "It changed just now."
    : "No change.";
});

browser.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && (changes[KEYS.watches] || changes[KEYS.snap(id)])) load(false);
});

load(true).then(() => {
  document.body.dataset.ready = "1";
});
