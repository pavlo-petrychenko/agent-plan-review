// Version diffs for the plan view: the same line diff as the web UI (src/shared/differ.ts),
// projected to unified rows, then to selectable words on the NEW side. Pure: no Herdr imports,
// so node tests load it.

const lines = (text) => {
  const t = String(text ?? "").replace(/\r\n?/g, "\n");
  return t.length === 0 ? [] : t.split("\n");
};

// The LCS table above this many cells is not built: the middle of such a diff reads as one
// removed block and one added block (a rewrite, not an edit).
const MAX_CELLS = 4_000_000;

/**
 * Line diff of two texts → unified rows, in the order the web's `toViewRows(diff, 'unified')`
 * gives: { kind: "eq" | "add" | "del", oldLine?, newLine?, text }. Line numbers are 1-based
 * lines of each text; `eq` has both, `del` only the old, `add` only the new.
 */
export function diffRows(oldText, newText) {
  const a = lines(oldText), b = lines(newText);
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const rows = [];
  for (let k = 0; k < head; k++) rows.push({ kind: "eq", oldLine: k + 1, newLine: k + 1, text: a[k] });
  const n = a.length - head - tail, m = b.length - head - tail;
  const mid = middle(a, b, head, n, m);
  rows.push(...mid);
  for (let k = 0; k < tail; k++) {
    const i = a.length - tail + k, j = b.length - tail + k;
    rows.push({ kind: "eq", oldLine: i + 1, newLine: j + 1, text: a[i] });
  }
  return rows;
}

function middle(a, b, off, n, m) {
  const out = [];
  const del = (i) => out.push({ kind: "del", oldLine: off + i + 1, text: a[off + i] });
  const add = (j) => out.push({ kind: "add", newLine: off + j + 1, text: b[off + j] });
  if (n === 0 || m === 0 || (n + 1) * (m + 1) > MAX_CELLS) {
    for (let i = 0; i < n; i++) del(i);
    for (let j = 0; j < m; j++) add(j);
    return out;
  }
  const w = m + 1;
  const dp = new Int32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * w + j] = a[off + i] === b[off + j] ? dp[(i + 1) * w + j + 1] + 1 : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
    }
  }
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[off + i] === b[off + j]) {
      out.push({ kind: "eq", oldLine: off + i + 1, newLine: off + j + 1, text: a[off + i] });
      i++; j++;
    } else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) del(i++);
    else add(j++);
  }
  while (i < n) del(i++);
  while (j < m) add(j++);
  return out;
}

/** { added, removed } line counts of rows. */
export function diffStats(rows) {
  let added = 0, removed = 0;
  for (const r of rows) { if (r.kind === "add") added++; else if (r.kind === "del") removed++; }
  return { added, removed };
}

/**
 * The words of the rows that exist on the new side (`eq` and `add`): the same shape as the
 * words of a drawn page (markdown.js), so selection, anchors and thread tints work on them
 * unchanged. A word is a run of non-blank characters of the line; `flow` and `row` are the
 * row's index in `rows`, `line` its new line number, `src`/`srcEnd` the character offsets
 * into the NEW text (what a comment's `range` means). Also sets `row.first`/`row.count`
 * (the row's words) and `row.indent`.
 * `newText` is the new side as the server stores it.
 */
export function rowWords(rows, newText) {
  const src = lines(newText);
  const starts = new Array(src.length);
  let at = 0;
  for (let k = 0; k < src.length; k++) { starts[k] = at; at += src[k].length + 1; }
  const words = [];
  rows.forEach((row, r) => {
    row.first = words.length;
    row.count = 0;
    row.indent = "";
    if (row.kind === "del") return;
    const text = row.text;
    row.indent = /^\s*/.exec(text)[0];
    const base = starts[row.newLine - 1] ?? 0;
    for (const m of text.matchAll(/\S+/g)) {
      const end = m.index + m[0].length;
      words.push({ i: words.length, segs: [{ text: m[0] }], space: end < text.length, line: row.newLine, flow: r, row: r, block: r, src: base + m.index, srcEnd: base + end });
      row.count++;
    }
  });
  return words;
}

/**
 * Rows → what is drawn: runs of unchanged rows longer than `2 * context + 1` collapse into one
 * `{ gap, from, to, count }` entry (`from`..`to` half-open row indexes) that keeps `context`
 * rows next to each change. `expanded` is a Set of gap keys (the gap's `from`) shown in full.
 * Entries: { row: index } | { gap: true, from, to, count }.
 */
export function collapseRows(rows, expanded = new Set(), context = 3) {
  const out = [];
  let r = 0;
  while (r < rows.length) {
    if (rows[r].kind !== "eq") { out.push({ row: r++ }); continue; }
    let e = r;
    while (e < rows.length && rows[e].kind === "eq") e++;
    const atStart = r === 0, atEnd = e === rows.length;
    const keepHead = atStart ? 0 : context, keepTail = atEnd ? 0 : context;
    const hidden = e - r - keepHead - keepTail;
    if (hidden <= 1 || expanded.has(r + keepHead)) { for (let k = r; k < e; k++) out.push({ row: k }); }
    else {
      for (let k = r; k < r + keepHead; k++) out.push({ row: k });
      out.push({ gap: true, from: r + keepHead, to: e - keepTail, count: hidden });
      for (let k = e - keepTail; k < e; k++) out.push({ row: k });
    }
    r = e;
  }
  return out;
}

/** A page's diff: { rows, words, stats, changed } — `oldText` null/"" for an added page, `newText` "" for a removed one. */
export function buildDiffPage(oldText, newText) {
  const rows = diffRows(oldText, newText);
  const words = rowWords(rows, newText);
  const stats = diffStats(rows);
  return { rows, words, stats, changed: stats.added + stats.removed > 0 };
}

/**
 * Where a thread anchored on a removed line (`side: "old"`) sits in a diff against `base`:
 * the index of the `del` row of that old line, else null (the thread belongs to another base).
 */
export function removedRowOf(comment, rows, base) {
  if (comment.side !== "old" || comment.line == null || comment.baseVersion !== base) return null;
  const at = rows.findIndex((r) => r.kind === "del" && r.oldLine === comment.line);
  return at < 0 ? null : at;
}

/** The display index (in `collapseRows` output) that shows row `r` (a gap stands for its rows). */
export function displayIndexOf(display, r) {
  for (let k = 0; k < display.length; k++) {
    const e = display[k];
    if (e.gap ? r >= e.from && r < e.to : e.row === r) return k;
  }
  return -1;
}
