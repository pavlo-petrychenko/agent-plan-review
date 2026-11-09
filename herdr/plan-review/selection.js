// Selection over a page's words: ranges are inclusive word indexes [from, to]. Pure.
import { wordText } from "./markdown.js";

/** Anchor and focus (in either order) → [from, to]; null when there is no selection. */
export function range(sel) {
  if (!sel || sel.anchor == null || sel.focus == null) return null;
  return sel.anchor <= sel.focus ? [sel.anchor, sel.focus] : [sel.focus, sel.anchor];
}

export const inRange = (r, i) => !!r && i >= r[0] && i <= r[1];

/** Shift-click: keep the anchor, move the focus. With no selection, a one-word selection. */
export function extend(sel, i) {
  return sel && sel.anchor != null ? { anchor: sel.anchor, focus: i } : { anchor: i, focus: i };
}

/** All words of the flow (paragraph, list item, cell, code line) that holds word i. */
export function flowRange(words, i) {
  const f = words[i].flow;
  let a = i, b = i;
  while (a > 0 && words[a - 1].flow === f) a--;
  while (b < words.length - 1 && words[b + 1].flow === f) b++;
  return [a, b];
}

/**
 * The text of a range as a reader would copy it: words joined by their own spacing,
 * flows (paragraphs, cells, code lines) on separate lines; code keeps its exact spacing.
 */
export function rangeText(words, r) {
  if (!r) return "";
  let s = "";
  for (let i = r[0]; i <= r[1]; i++) {
    const w = words[i];
    s += wordText(w);
    if (i === r[1]) break;
    const next = words[i + 1];
    if (next.flow !== w.flow) s += "\n";
    else s += w.code ? w.space : w.space ? " " : "";
  }
  return s;
}

/** First and last source line a range touches. */
export function lineSpan(words, r) {
  let lo = Infinity, hi = -Infinity;
  for (let i = r[0]; i <= r[1]; i++) { lo = Math.min(lo, words[i].line); hi = Math.max(hi, words[i].line); }
  return [lo, hi];
}

/**
 * How each word is tinted by comments: Map(word index → { ids, active }).
 * Only threads with a word range, on this page, open (or all when `withResolved`).
 */
export function tintMap(threads, page, activeId, withResolved = false) {
  const map = new Map();
  for (const t of threads) {
    if (t.page !== page || !t.words || t.detached) continue;
    if (t.status !== "open" && !withResolved && t.id !== activeId) continue;
    for (let i = t.words[0]; i <= t.words[1]; i++) {
      const e = map.get(i) ?? { ids: [], active: false, resolved: true };
      e.ids.push(t.id);
      if (t.id === activeId) e.active = true;
      if (t.status === "open") e.resolved = false;
      map.set(i, e);
    }
  }
  return map;
}

/** The thread a click on word i means: the shortest open range covering it. */
export function threadAt(threads, page, i) {
  let best = null;
  for (const t of threads) {
    if (t.page !== page || !t.words || t.detached || t.status !== "open") continue;
    if (i < t.words[0] || i > t.words[1]) continue;
    if (!best || t.words[1] - t.words[0] < best.words[1] - best.words[0]) best = t;
  }
  return best;
}

/** The link a word belongs to ("slug:x" / "url:y"), or null. */
export function linkKeyOf(word) {
  const l = word?.segs?.find((s) => s.link)?.link;
  return l ? (l.slug ? `slug:${l.slug}` : l.url ? `url:${l.url}` : null) : null;
}

/** The words of the link around word i, as [from, to], or null when word i is not in a link. One
 *  link's words are neighbours with the same target (a link's label may span several words). */
export function linkRange(words, i) {
  const key = linkKeyOf(words[i]);
  if (!key) return null;
  let a = i, b = i;
  while (a > 0 && words[a - 1].flow === words[i].flow && linkKeyOf(words[a - 1]) === key) a--;
  while (b < words.length - 1 && words[b + 1].flow === words[i].flow && linkKeyOf(words[b + 1]) === key) b++;
  return [a, b];
}
