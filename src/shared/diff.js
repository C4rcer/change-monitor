// Text comparison: which lines were added and removed between two saved
// versions, and which words changed inside a line that was edited.
//
// Myers' O(ND) algorithm: fast when little changed (the usual case), with a
// cap on the number of edits so a completely rewritten page can not eat memory.

const MAX_EDITS = 1500;

/** Edit script from a to b as an array of 0 (keep), -1 (remove from a), 1 (add from b), or null over the cap. */
function myers(a, b, maxD) {
  const n = a.length;
  const m = b.length;
  if (!n && !m) return [];
  const limit = Math.min(n + m, maxD);
  const offset = limit + 1;
  const v = new Int32Array(2 * limit + 3);
  const trace = [];
  let found = -1;
  outer: for (let d = 0; d <= limit; d++) {
    trace.push(v.slice(offset - d - 1, offset + d + 2)); // v before round d, for k in [-d-1, d+1]
    for (let k = -d; k <= d; k += 2) {
      let x;
      if (k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])) x = v[offset + k + 1];
      else x = v[offset + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) {
        found = d;
        break outer;
      }
    }
  }
  if (found < 0) return null;
  const ops = [];
  let x = n;
  let y = m;
  for (let d = found; d > 0; d--) {
    const snap = trace[d];
    const at = (k) => snap[k + d + 1];
    const k = x - y;
    const prevK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1;
    const prevX = at(prevK);
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      ops.push(0);
      x--;
      y--;
    }
    if (x === prevX) {
      ops.push(1);
      y--;
    } else {
      ops.push(-1);
      x--;
    }
  }
  while (x > 0 && y > 0) {
    ops.push(0);
    x--;
    y--;
  }
  return ops.reverse();
}

/**
 * Compare two arrays. Returns runs: [{ op: "eq" | "del" | "add", items: [...] }].
 * "del" items come from `a`, "add" items from `b`.
 */
export function diffSeq(a, b) {
  let start = 0;
  const max = Math.min(a.length, b.length);
  while (start < max && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  const runs = [];
  const push = (op, items) => {
    if (!items.length) return;
    const last = runs[runs.length - 1];
    if (last && last.op === op) last.items.push(...items);
    else runs.push({ op, items: [...items] });
  };
  push("eq", a.slice(0, start));
  const ops = myers(midA, midB, MAX_EDITS);
  if (!ops) {
    // Too different to line up: everything in between was replaced.
    push("del", midA);
    push("add", midB);
  } else {
    let i = 0;
    let j = 0;
    for (const op of ops) {
      if (op === 0) {
        push("eq", [midA[i]]);
        i++;
        j++;
      } else if (op < 0) {
        push("del", [midA[i++]]);
      } else {
        push("add", [midB[j++]]);
      }
    }
  }
  push("eq", a.slice(endA));
  return runs;
}

export function lines(text) {
  return text ? String(text).split("\n") : [];
}

/** Words, numbers with their separators (24.99, 21:40), runs of spaces, and single punctuation marks. */
function tokens(line) {
  return line.match(/\s+|\d+(?:[.,:\/-]\d+)*|[\p{L}\p{N}_]+|[^\s\p{L}\p{N}_]/gu) || [];
}

/**
 * Word-level comparison of one edited line.
 * Returns { same: 0..1, old: [{ text, changed }], new: [{ text, changed }] }.
 */
export function diffWords(oldLine, newLine) {
  const runs = diffSeq(tokens(oldLine), tokens(newLine));
  const oldParts = [];
  const newParts = [];
  let kept = 0;
  const add = (list, text, changed) => {
    const last = list[list.length - 1];
    if (last && last.changed === changed) last.text += text;
    else list.push({ text, changed });
  };
  for (const run of runs) {
    const text = run.items.join("");
    if (run.op === "eq") {
      kept += text.replace(/\s+/g, "").length;
      add(oldParts, text, false);
      add(newParts, text, false);
    } else if (run.op === "del") {
      add(oldParts, text, true);
    } else {
      add(newParts, text, true);
    }
  }
  const size = Math.max(oldLine.replace(/\s+/g, "").length, newLine.replace(/\s+/g, "").length) || 1;
  return { same: kept / size, old: glue(oldParts), new: glue(newParts) };
}

/** "In stock" marked as one changed piece, not as two words with a plain space between them. */
function glue(parts) {
  const out = [];
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    const last = out[out.length - 1];
    if (!p.changed && /^\s+$/.test(p.text) && last && last.changed && parts[i + 1] && parts[i + 1].changed) {
      last.text += p.text + parts[i + 1].text;
      i++;
    } else {
      out.push({ text: p.text, changed: p.changed });
    }
  }
  return out;
}

/**
 * Rows for the "what changed" view.
 *   { type: "eq", text }
 *   { type: "del", text }             a line that is gone
 *   { type: "add", text }             a new line
 *   { type: "chg", old, new }         an edited line, as word parts from diffWords
 */
export function diffRows(oldText, newText) {
  const rows = [];
  const runs = diffSeq(lines(oldText), lines(newText));
  for (let i = 0; i < runs.length; i++) {
    const run = runs[i];
    if (run.op === "eq") {
      for (const text of run.items) rows.push({ type: "eq", text });
      continue;
    }
    let removed = [];
    let added = [];
    if (run.op === "del") {
      removed = run.items;
      if (runs[i + 1] && runs[i + 1].op === "add") added = runs[++i].items;
    } else {
      added = run.items;
    }
    // A removed line followed by a similar new one is shown as one edited line.
    // So is a single short line replaced by another ("In stock" -> "Sold out", one price by another).
    const pairs = Math.min(removed.length, added.length);
    const swap = removed.length === 1 && added.length === 1 && removed[0].length <= 60 && added[0].length <= 60;
    const leftoverDel = [];
    const leftoverAdd = [];
    for (let p = 0; p < pairs; p++) {
      const w = diffWords(removed[p], added[p]);
      if (w.same >= 0.35 || swap) {
        rows.push({ type: "chg", old: w.old, new: w.new });
      } else {
        leftoverDel.push(removed[p]);
        leftoverAdd.push(added[p]);
      }
    }
    for (const text of [...leftoverDel, ...removed.slice(pairs)]) rows.push({ type: "del", text });
    for (const text of [...leftoverAdd, ...added.slice(pairs)]) rows.push({ type: "add", text });
  }
  return rows;
}

/** Counts and a one-line sample of a change, for the list and the notification. */
export function summarize(oldText, newText) {
  const rows = diffRows(oldText, newText);
  let added = 0;
  let removed = 0;
  let sample = "";
  const changedText = (parts) => parts.filter((p) => p.changed).map((p) => p.text).join(" ").replace(/\s+/g, " ").trim();
  for (const r of rows) {
    if (r.type === "add") {
      added++;
      if (!sample) sample = r.text;
    } else if (r.type === "del") {
      removed++;
    } else if (r.type === "chg") {
      added++;
      removed++;
      if (!sample) {
        const was = changedText(r.old);
        const now = changedText(r.new);
        sample = was && now ? `${was} → ${now}` : r.new.map((p) => p.text).join("");
      }
    }
  }
  if (!sample) {
    const gone = rows.find((r) => r.type === "del");
    if (gone) sample = "Removed: " + gone.text;
  }
  return { added, removed, sample: sample.length > 160 ? sample.slice(0, 159) + "…" : sample };
}
