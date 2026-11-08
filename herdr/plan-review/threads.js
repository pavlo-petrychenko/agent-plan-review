// Comment threads: the server's flat comment list → threads the view draws, anchoring each
// thread to the words of its page, the anchor a new comment sends, and the margin layout of
// thread cards. Pure: no Herdr imports, so node tests load it.
//
// A server comment (src/shared/types.ts `Comment`) is anchored by `line`/`lineEnd` (1-based
// lines of its page's markdown), `quote` (the selected text, whitespace-normalized) and,
// optionally, `range` ({ start, end }: character offsets into the page's markdown). Replies
// carry `parentId` and inherit the root's anchor.

import { rangeText, lineSpan } from "./selection.js";
import { wordText } from "./markdown.js";

export const MAX_QUOTE_LEN = 2000;

const norm = (s) => String(s ?? "").replace(/\s+/g, " ").trim();

/** The anchor a comment on words r = [from, to] sends: line span, quote and exact range. */
export function anchorOf(words, r) {
  const [line, lineEnd] = lineSpan(words, r);
  return {
    line,
    lineEnd,
    quote: norm(rangeText(words, r)).slice(0, MAX_QUOTE_LEN),
    range: { start: words[r[0]].src, end: words[r[1]].srcEnd },
  };
}

/**
 * Where a comment sits on a page's words: { words: [from, to] } or { words: null, detached }.
 *   1. `range`: the words whose source starts inside it (word-exact, what this mod sends);
 *   2. `quote`: its words inside line..lineEnd (the browser's selections may cut words, so the
 *      first and last quoted words may be parts of words), else nearest anywhere on the page;
 *   3. only lines: every word on those lines.
 * Whole-page comments (no line) have no words and are not detached.
 */
export function anchorWords(c, words) {
  if (c.line == null) return { words: null, detached: false };
  if (c.side === "old") return { words: null, detached: true };
  const line = c.line, lineEnd = c.lineEnd ?? c.line;
  if (c.range && Number.isFinite(c.range.start) && Number.isFinite(c.range.end) && c.range.end > c.range.start) {
    let a = -1, b = -1;
    for (const w of words) {
      if (w.src >= c.range.start && w.src < c.range.end) { if (a < 0) a = w.i; b = w.i; }
    }
    if (a >= 0) return { words: [a, b], detached: false };
  }
  const q = norm(c.quote);
  if (q) {
    const r = findQuote(words, q, line, lineEnd);
    if (r) return { words: r, detached: false };
    return { words: null, detached: true };
  }
  let a = -1, b = -1;
  for (const w of words) if (w.line >= line && w.line <= lineEnd) { if (a < 0) a = w.i; b = w.i; }
  return a >= 0 ? { words: [a, b], detached: false } : { words: null, detached: true };
}

/** The word range that reads as quote `q`, preferring a start inside line..lineEnd. */
export function findQuote(words, q, line = 1, lineEnd = line) {
  const parts = q.split(" ");
  const texts = words.map(wordText);
  const n = parts.length;
  const matchAt = (i) => {
    if (i + n > texts.length) return false;
    for (let k = 0; k < n; k++) {
      const t = texts[i + k], p = parts[k];
      if (n === 1) { if (!t.includes(p)) return false; }
      else if (k === 0) { if (!t.endsWith(p)) return false; }
      else if (k === n - 1) { if (!t.startsWith(p)) return false; }
      else if (t !== p) return false;
    }
    return true;
  };
  let best = null, bestCost = Infinity;
  for (let i = 0; i + n <= texts.length; i++) {
    if (!matchAt(i)) continue;
    const l = words[i].line;
    const cost = l >= line && l <= lineEnd ? 0 : 1 + Math.min(Math.abs(l - line), Math.abs(l - lineEnd));
    if (cost < bestCost) { best = i; bestCost = cost; if (cost === 0) break; }
  }
  return best === null ? null : [best, best + n - 1];
}

const at = (iso) => { const t = Date.parse(iso); return Number.isFinite(t) ? t : 0; };

/**
 * Server comments → threads: [{ id, page, kind: "range" | "page", status, quote, lines,
 * words, detached, createdAt, messages: [{ id, author: "you" | "agent", body, at, delivery }] }].
 * `wordsOf(slug)` gives a page's words (null when the page is not in this version).
 * Replies whose root is gone are dropped. Thread order: root creation time.
 */
export function threadsFromComments(comments, wordsOf) {
  const roots = [];
  const replies = new Map();
  for (const c of comments ?? []) {
    if (!c || typeof c.id !== "string") continue;
    if (c.parentId) {
      if (!replies.has(c.parentId)) replies.set(c.parentId, []);
      replies.get(c.parentId).push(c);
    } else roots.push(c);
  }
  const msg = (c) => ({ id: c.id, author: c.author === "agent" ? "agent" : "you", body: c.body ?? "", at: at(c.createdAt), delivery: c.delivery ?? null });
  return roots.map((c) => {
    const page = c.doc || "root";
    const words = wordsOf(page);
    const kind = c.line == null ? "page" : "range";
    const anchor = words ? anchorWords(c, words) : { words: null, detached: kind === "range" };
    const msgs = [c, ...(replies.get(c.id) ?? [])].sort((p, q) => at(p.createdAt) - at(q.createdAt)).map(msg);
    return {
      id: c.id,
      page,
      kind,
      status: c.resolved ? "resolved" : "open",
      quote: c.quote ?? null,
      lines: kind === "range" ? [c.line, c.lineEnd ?? c.line] : null,
      words: anchor.words,
      detached: anchor.detached,
      side: c.side ?? "new",
      createdAt: at(c.createdAt),
      messages: msgs,
    };
  }).sort((p, q) => p.createdAt - q.createdAt);
}

/** Open threads per page slug. */
export function openCounts(threads) {
  const m = new Map();
  for (const t of threads) if (t.status === "open") m.set(t.page, (m.get(t.page) ?? 0) + 1);
  return m;
}

/**
 * Margin layout: cards want to sit at their anchor's y. Overlaps push later cards down; the
 * active card keeps its own y and the cards above it move up out of its way (never above 0).
 * items: [{ id, y, h }] → Map(id → top).
 */
export function layoutMargin(items, activeId = null, gap = 10) {
  const xs = [...items].sort((p, q) => p.y - q.y || String(p.id).localeCompare(String(q.id)));
  const top = new Map();
  const ai = xs.findIndex((x) => x.id === activeId);
  if (ai < 0) {
    let next = 0;
    for (const x of xs) { const t = Math.max(x.y, next); top.set(x.id, t); next = t + x.h + gap; }
    return top;
  }
  top.set(xs[ai].id, Math.max(0, xs[ai].y));
  let next = top.get(xs[ai].id) + xs[ai].h + gap;
  for (let i = ai + 1; i < xs.length; i++) { const t = Math.max(xs[i].y, next); top.set(xs[i].id, t); next = t + xs[i].h + gap; }
  let limit = top.get(xs[ai].id) - gap;
  for (let i = ai - 1; i >= 0; i--) { const t = Math.min(xs[i].y, limit - xs[i].h); top.set(xs[i].id, t); limit = t - gap; }
  // Ran out of room above: fall back to pushing everything down from the top.
  if (ai > 0 && top.get(xs[0].id) < 0) {
    let n = 0;
    for (const x of xs) { const t = Math.max(x.y, n, x.id === activeId ? 0 : -Infinity); top.set(x.id, t); n = t + x.h + gap; }
  }
  return top;
}

/** "just now", "5 min ago", "3 h ago", "2 d ago". */
export function ago(at, now = Date.now()) {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 45) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}
