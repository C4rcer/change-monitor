// Small helpers shared by the background and the pages.
import { LIMITS, INTERVALS } from "./config.js";

export function parseUrl(raw) {
  try {
    return new URL(String(raw).trim());
  } catch {
    return null;
  }
}

/** Only http(s) addresses without user:password@ can be watched. */
export function isWatchable(raw) {
  const u = parseUrl(raw);
  return !!u && (u.protocol === "http:" || u.protocol === "https:") && !!u.hostname && !u.username && !u.password;
}

export function hostOf(raw) {
  const u = parseUrl(raw);
  return u ? u.hostname.toLowerCase() : "";
}

/** The one-site permission a watch needs. Match patterns have no port. */
export function originPattern(raw) {
  const host = hostOf(raw);
  return host ? `*://${host}/*` : "";
}

/** Address shown in lists: no scheme, no trailing slash. */
export function prettyUrl(raw) {
  const u = parseUrl(raw);
  if (!u) return String(raw || "");
  const path = (u.pathname === "/" ? "" : u.pathname) + u.search;
  return u.host + path;
}

export function clampInterval(minutes) {
  const n = Math.round(Number(minutes));
  if (!Number.isFinite(n)) return 60;
  return Math.min(LIMITS.maxInterval, Math.max(LIMITS.minInterval, n));
}

export function intervalLabel(minutes) {
  const m = clampInterval(minutes);
  const unit = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
  if (m % 10080 === 0) return unit(m / 10080, "week");
  if (m % 1440 === 0) return unit(m / 1440, "day");
  if (m % 60 === 0) return unit(m / 60, "hour");
  return unit(m, "minute");
}

/** Fill a <select> with the interval choices, keeping an unusual stored value selectable. */
export function fillIntervals(select, current) {
  const cur = clampInterval(current);
  const values = INTERVALS.includes(cur) ? INTERVALS : [...INTERVALS, cur].sort((a, b) => a - b);
  select.replaceChildren();
  for (const v of values) {
    const o = document.createElement("option");
    o.value = String(v);
    o.textContent = intervalLabel(v);
    select.append(o);
  }
  select.value = String(cur);
}

export function ago(ts, now = Date.now()) {
  if (!ts) return "never";
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  return d === 1 ? "yesterday" : `${d} days ago`;
}

export function until(ts, now = Date.now()) {
  const s = Math.round((ts - now) / 1000);
  if (s <= 45) return "in a moment";
  const m = Math.round(s / 60);
  if (m < 60) return `in ${m} min`;
  const h = Math.round(m / 60);
  if (h < 24) return `in ${h} h`;
  const d = Math.round(h / 24);
  return d === 1 ? "tomorrow" : `in ${d} days`;
}

export function dateTime(ts) {
  if (!ts) return "";
  return new Date(ts).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

export function clip(text, max) {
  const t = String(text || "").replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, Math.max(0, max - 1)).trimEnd() + "…" : t;
}

export function uid() {
  const a = new Uint8Array(8);
  crypto.getRandomValues(a);
  return Array.from(a, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Send a message to the background; resolves to { ok: false } when it can not be reached. */
export async function send(type, data = {}) {
  try {
    const res = await browser.runtime.sendMessage({ type, ...data });
    return res === undefined ? { ok: false, code: "no-answer" } : res;
  } catch (e) {
    return { ok: false, code: "gone", detail: String((e && e.message) || e) };
  }
}
