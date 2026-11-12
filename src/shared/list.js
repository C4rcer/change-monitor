// The list of watches, drawn the same way in the popup and on the dashboard.
// Pages only read storage; every change goes to the background as a message.
import { ERRORS, WARNINGS } from "./config.js";
import { ago, prettyUrl, intervalLabel, originPattern, send } from "./util.js";

const SVG = "http://www.w3.org/2000/svg";
const ICONS = {
  changes: "M6 4h9l4 4v12H6z M9.5 11h5 M12 8.5v5 M9.5 16.5h5",
  check: "M20 11a8 8 0 1 0-2.3 5.7 M20 4v7h-7",
  pause: "M9 5v14 M15 5v14",
  play: "M8 5l11 7-11 7z",
  open: "M14 5h5v5 M19 5l-8 8 M11 7H6v11h11v-5",
  edit: "M4 20h4L19 9l-4-4L4 16z M13.5 6.5l4 4",
  trash: "M5 7h14 M10 7V4h4v3 M7 7l1 13h8l1-13",
};

export function icon(name) {
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS(SVG, "path");
  path.setAttribute("d", ICONS[name]);
  svg.append(path);
  return svg;
}

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

export function changesUrl(id) {
  return browser.runtime.getURL("changes/changes.html?id=" + encodeURIComponent(id));
}

/** Changed first (newest change on top), then problems, then the rest by name. */
export function sortWatches(list) {
  const rank = (w) => (w.unread > 0 ? 0 : w.error && !w.paused ? 1 : w.paused ? 3 : 2);
  return [...list].sort((a, b) =>
    rank(a) - rank(b)
    || (rank(a) === 0 ? (b.lastChange || 0) - (a.lastChange || 0) : 0)
    || a.name.localeCompare(b.name));
}

function deltaText(d) {
  if (!d) return "";
  const parts = [];
  if (d.added) parts.push("+" + d.added);
  if (d.removed) parts.push("−" + d.removed);
  return parts.length ? parts.join(" ") + (d.added + d.removed === 1 ? " line" : " lines") : "";
}

export function statusOf(w, now = Date.now()) {
  if (w.unread > 0) {
    return { kind: "changed", chip: "Changed", text: [ago(w.lastChange, now), deltaText(w.delta)].filter(Boolean).join(" · "), sample: (w.delta && w.delta.sample) || "" };
  }
  if (w.paused) return { kind: "paused", chip: "Paused", text: w.lastCheck ? "last checked " + ago(w.lastCheck, now) : "" };
  if (w.error) return { kind: "problem", chip: (ERRORS[w.error.code] || {}).short || "Problem", text: "since " + ago(w.error.since, now) };
  if (!w.lastCheck) return { kind: "new", chip: "Starting", text: "the first check is on its way" };
  return {
    kind: "ok",
    chip: "No change",
    text: "checked " + ago(w.lastCheck, now) + (w.lastChange ? " · last change " + ago(w.lastChange, now) : ""),
  };
}

function actionButton(act, title, iconName) {
  const b = el("button", "icon-btn");
  b.type = "button";
  b.dataset.act = act;
  b.title = title;
  b.setAttribute("aria-label", title);
  b.append(icon(iconName));
  return b;
}

function watchRow(w, now, state) {
  const st = statusOf(w, now);
  const li = el("li", "watch is-" + st.kind);
  li.dataset.id = w.id;
  li.dataset.state = st.kind;
  if (w.error) li.dataset.error = w.error.code;
  if (w.warn) li.dataset.warn = w.warn.code;

  const main = el("div", "w-main");
  const name = el("a", "w-name", w.name);
  name.href = changesUrl(w.id);
  name.dataset.act = "view";
  name.title = "See what changed";
  const meta = el("div", "w-meta", [prettyUrl(w.url), w.selector ? "one part" : "whole page", "every " + intervalLabel(w.interval)].join(" · "));
  meta.title = w.url + (w.selector ? "\n" + w.selector : "");
  const status = el("div", "w-status");
  status.append(el("span", "chip " + st.kind, st.chip), document.createTextNode(st.text));
  if (st.sample) status.append(document.createElement("br"), el("span", "w-sample", st.sample));
  main.append(name, meta, status);

  if (w.error && !(w.paused && !w.unread)) {
    const info = ERRORS[w.error.code] || { text: "The last check did not work." };
    const detail = w.error.detail && !["permission", "missing", "login"].includes(w.error.code) ? " (" + w.error.detail + ")" : "";
    const note = el("div", "note " + (w.error.code === "permission" ? "bad" : "warn"), info.text + detail);
    note.dataset.role = "error";
    if (w.error.code === "permission") {
      const give = el("button", "link", "Give access");
      give.type = "button";
      give.dataset.act = "access";
      note.append(give);
    }
    main.append(note);
  } else if (w.warn || w.truncated) {
    const found = w.warn && w.warn.code === "partial" && w.warn.pct != null ? ` It found about ${w.warn.pct}% of the words you see.` : "";
    const note = el("div", "note", w.warn ? WARNINGS[w.warn.code] + found : WARNINGS.truncated);
    note.dataset.role = "warn";
    main.append(note);
  }

  const check = actionButton("check", "Check now", "check");
  if (state.busy.has(w.id)) {
    check.disabled = true;
    check.classList.add("busy");
  }
  const del = actionButton("delete", "Delete", "trash");
  if (state.armed && state.armed.id === w.id) {
    del.classList.add("armed");
    del.textContent = "Delete?";
  }
  const actions = el("div", "w-actions");
  actions.append(
    actionButton("view", "See what changed", "changes"),
    check,
    w.paused ? actionButton("pause", "Resume", "play") : actionButton("pause", "Pause", "pause"),
    actionButton("open", "Open the page", "open"),
    actionButton("edit", "Edit", "edit"),
    del,
  );
  li.append(main, actions);
  return li;
}

/**
 * A list of watches inside `container` (a <ul>).
 *   openTab(url)   open an address in a new tab
 *   edit(id)       open the edit form
 * Returns { render(watches) }.
 */
export function createList(container, { openTab, edit }) {
  const state = { watches: [], busy: new Set(), armed: null };
  const render = (watches) => {
    if (watches) state.watches = watches;
    const now = Date.now();
    container.replaceChildren(...sortWatches(state.watches).map((w) => watchRow(w, now, state)));
  };
  const disarm = () => {
    if (!state.armed) return;
    clearTimeout(state.armed.timer);
    state.armed = null;
  };
  const check = async (id) => {
    state.busy.add(id);
    render();
    await send("watch:check", { id });
    state.busy.delete(id);
    render();
  };
  container.addEventListener("click", async (e) => {
    const target = e.target.closest("[data-act]");
    if (!target || !container.contains(target)) return;
    const row = target.closest(".watch");
    const w = row && state.watches.find((x) => x.id === row.dataset.id);
    if (!w) return;
    const act = target.dataset.act;
    if (act === "view") e.preventDefault();
    if (act === "delete") {
      if (state.armed && state.armed.id === w.id) {
        disarm();
        await send("watch:delete", { id: w.id });
        return;
      }
      // Two clicks, so a slip of the mouse does not delete a watch and its saved versions.
      disarm();
      state.armed = {
        id: w.id,
        timer: setTimeout(() => {
          state.armed = null;
          render();
        }, 3500),
      };
      render();
      return;
    }
    if (state.armed) {
      disarm();
      render();
    }
    if (act === "view") {
      openTab(changesUrl(w.id));
    } else if (act === "open") {
      openTab(w.url);
    } else if (act === "edit") {
      edit(w.id);
    } else if (act === "pause") {
      await send("watch:pause", { id: w.id, paused: !w.paused });
    } else if (act === "check") {
      if (!state.busy.has(w.id)) await check(w.id);
    } else if (act === "access") {
      // Asked inside the click, so Firefox shows its permission prompt for this one site.
      const granted = await browser.permissions.request({ origins: [originPattern(w.url)] }).catch(() => false);
      if (granted) await check(w.id);
    }
  });
  return { render };
}
