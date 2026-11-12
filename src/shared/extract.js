// Turns what a server sent into the text Heron compares.
//
// A fetched page is parsed with DOMParser: nothing in it runs and nothing it
// links to is loaded. Only the readable text is kept, one line per block
// (paragraph, heading, list item, table row), so a change in markup, in a
// script or in a tracking token never counts as a change.

const SKIP = new Set([
  "script", "style", "noscript", "template", "iframe", "frame", "object", "embed", "canvas", "svg", "math",
  "head", "audio", "video", "map", "select", "datalist", "link", "meta", "title",
]);
const BLOCK = new Set([
  "address", "article", "aside", "blockquote", "body", "caption", "dd", "details", "dialog", "div", "dl", "dt",
  "fieldset", "figcaption", "figure", "footer", "form", "h1", "h2", "h3", "h4", "h5", "h6", "header", "hgroup",
  "hr", "html", "li", "main", "nav", "ol", "p", "pre", "section", "summary", "table", "tbody", "tfoot", "thead",
  "tr", "ul",
]);
const CELL = "\u001f"; // marks the end of a table cell inside a row
const SPACES = /[\s\u00a0\u1680\u2000-\u200d\u2028\u2029\u202f\u205f\u2060\u3000\ufeff]+/g;

export function squash(text) {
  return String(text || "").replace(SPACES, " ").trim();
}

function hiddenByMarkup(el) {
  if (el.hasAttribute("hidden")) return true;
  const style = el.getAttribute("style");
  return !!style && /(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*hidden)/i.test(style);
}

/** Readable text of an element: one line per block, no empty lines. */
export function textOf(root) {
  const out = [];
  let cur = "";
  const flush = () => {
    if (cur) {
      const line = cur.includes(CELL)
        ? cur.split(CELL).map(squash).filter(Boolean).join(" | ")
        : squash(cur);
      if (line) out.push(line);
      cur = "";
    }
  };
  const walk = (node, pre) => {
    for (let c = node.firstChild; c; c = c.nextSibling) {
      if (c.nodeType === 3) {
        if (pre && c.nodeValue.includes("\n")) {
          const parts = c.nodeValue.split("\n");
          parts.forEach((part, i) => {
            if (i) flush();
            cur += part;
          });
        } else {
          cur += c.nodeValue;
        }
        continue;
      }
      if (c.nodeType !== 1) continue;
      const tag = c.localName;
      if (SKIP.has(tag) || hiddenByMarkup(c)) continue;
      if (tag === "br") {
        flush();
        continue;
      }
      const block = BLOCK.has(tag);
      if (block) flush();
      walk(c, pre || tag === "pre");
      if (tag === "td" || tag === "th") cur += CELL;
      else if (block) flush();
    }
  };
  if (root) walk(root, root.localName === "pre");
  flush();
  return out.join("\n");
}

/** Text of a non-HTML answer (plain text, JSON, a feed): its lines, tidied. */
export function plainText(raw) {
  return String(raw || "").split(/\r\n?|\n/).map(squash).filter(Boolean).join("\n");
}

/** Cut at a line end so a long page is always cut at the same place. */
export function capText(text, max) {
  if (text.length <= max) return { text, truncated: false };
  const cut = text.lastIndexOf("\n", max);
  return { text: text.slice(0, cut > 0 ? cut : max), truncated: true };
}

/** "html", "text" (anything else readable) or "other" (images, PDFs, downloads). */
export function kindOf(contentType) {
  const type = String(contentType || "").split(";")[0].trim().toLowerCase();
  if (!type || type === "text/html" || type === "application/xhtml+xml") return "html";
  if (type.startsWith("text/") || /(?:^application\/|\+)(?:json|xml)$/.test(type) || type === "application/javascript") return "text";
  return "other";
}

/** Bytes to text with the page's own character set (header, BOM or <meta>), UTF-8 otherwise. */
export function decodeBody(bytes, contentType) {
  let charset = (/charset\s*=\s*["']?\s*([\w.:-]+)/i.exec(contentType || "") || [])[1];
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) charset = "utf-8";
  else if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) charset = "utf-16le";
  else if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) charset = "utf-16be";
  if (!charset) {
    const head = new TextDecoder("windows-1252").decode(bytes.subarray(0, 2048));
    charset = (/<meta[^>]+charset\s*=\s*["']?\s*([\w.:-]+)/i.exec(head) || [])[1];
  }
  try {
    return new TextDecoder(charset || "utf-8").decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

export function parseHtml(html) {
  return new DOMParser().parseFromString(html, "text/html");
}

/**
 * The watched text inside a parsed page.
 * Returns { ok: true, text } or { ok: false, code: "missing" | "selector" }.
 */
export function watchedText(doc, selector) {
  if (!selector) return { ok: true, text: textOf(doc.body || doc.documentElement) };
  let el;
  try {
    el = doc.querySelector(selector);
  } catch {
    return { ok: false, code: "selector" };
  }
  if (!el) return { ok: false, code: "missing" };
  return { ok: true, text: textOf(el) };
}

function words(text, min) {
  const all = String(text || "").toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
  return new Set(min > 1 ? all.filter((w) => w.length >= min) : all);
}

/** Share (0..1) of the distinct words (3+ letters) in `seen` that also appear in `fetched`. */
export function coverage(seen, fetched) {
  const a = words(seen, 3);
  if (!a.size) return 1;
  const b = words(fetched, 3);
  let hit = 0;
  for (const w of a) if (b.has(w)) hit++;
  return hit / a.size;
}

/** How alike two texts are (0..1), by shared distinct words and numbers. */
export function similarity(one, two) {
  const a = words(one, 1);
  const b = words(two, 1);
  if (!a.size && !b.size) return squash(one) === squash(two) ? 1 : 0;
  let hit = 0;
  for (const w of a) if (b.has(w)) hit++;
  return hit / (a.size + b.size - hit);
}
