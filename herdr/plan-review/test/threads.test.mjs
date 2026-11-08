import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePage, wordText } from "../markdown.js";
import { tintMap, threadAt } from "../selection.js";
import { anchorOf, anchorWords, findQuote, threadsFromComments, openCounts, layoutMargin, ago } from "../threads.js";

const LINES = ["# Rate limits", "", "Use a **token bucket** per key.", "Buckets refill every second.", "", "- one key per user", "- token bucket again"];
const page = () => parsePage(LINES, 1);
const texts = (words, r) => words.slice(r[0], r[1] + 1).map(wordText).join(" ");

test("anchorOf: a word selection → line span, normalized quote and exact source range", () => {
  const { words } = page();
  const r = [4, 7]; // "token bucket per key."
  const a = anchorOf(words, r);
  assert.deepEqual([a.line, a.lineEnd, a.quote], [3, 3, "token bucket per key."]);
  assert.equal(LINES.join("\n").slice(a.range.start, a.range.end), "token bucket** per key.");
  const across = anchorOf(words, [6, 9]); // "per key." + "Buckets refill"
  assert.deepEqual([across.line, across.lineEnd, across.quote], [3, 4, "per key. Buckets refill"]);
});

test("anchorWords: range first, word-exact, even when the same words occur twice", () => {
  const { words } = page();
  const second = words.findLastIndex((w) => wordText(w) === "token");
  const a = anchorOf(words, [second, second + 1]);
  assert.deepEqual(anchorWords({ ...a }, words), { words: [second, second + 1], detached: false });
  // The round trip: what the mod sends maps back to the same words.
  for (const r of [[0, 1], [2, 5], [8, 12], [13, words.length - 1]]) assert.deepEqual(anchorWords(anchorOf(words, r), words).words, r);
});

test("anchorWords: without a range, the quote inside line..lineEnd; partial words at the edges", () => {
  const { words } = page();
  // The browser's selection cut "oken bucket per k" out of line 3.
  const r = anchorWords({ line: 3, lineEnd: 3, quote: "oken  bucket\nper k" }, words);
  assert.equal(texts(words, r.words), "token bucket per key.");
  // The same quote on line 7 wins when the anchor says line 7.
  const r7 = anchorWords({ line: 7, lineEnd: 7, quote: "token bucket" }, words);
  assert.equal(words[r7.words[0]].line, 7);
  // Out of the line span, the nearest match elsewhere on the page.
  assert.equal(words[anchorWords({ line: 6, lineEnd: 6, quote: "token bucket" }, words).words[0]].line, 7);
  assert.deepEqual(anchorWords({ line: 3, lineEnd: 3, quote: "not on this page" }, words), { words: null, detached: true });
});

test("anchorWords: lines only, whole-page and removed-line comments", () => {
  const { words } = page();
  assert.equal(texts(words, anchorWords({ line: 4, lineEnd: 4, quote: null }, words).words), "Buckets refill every second.");
  assert.deepEqual(anchorWords({ line: null, lineEnd: null, quote: null }, words), { words: null, detached: false });
  assert.deepEqual(anchorWords({ line: 3, lineEnd: 3, quote: "token", side: "old", baseVersion: 1 }, words), { words: null, detached: true });
  assert.deepEqual(anchorWords({ line: 90, lineEnd: 91, quote: null }, words), { words: null, detached: true });
  // A stale range that no longer covers words falls back to the quote.
  assert.equal(texts(words, anchorWords({ line: 4, lineEnd: 4, quote: "refill", range: { start: 9000, end: 9010 } }, words).words), "refill");
});

test("findQuote: a one-word quote may sit inside a word", () => {
  const { words } = page();
  assert.equal(wordText(words[findQuote(words, "ucke", 3, 3)[0]]), "bucket");
  assert.equal(findQuote(words, "nothing", 1, 1), null);
});

test("threadsFromComments: roots + replies → threads with authors, status and anchors; tint and hit test", () => {
  const { words } = page();
  const a = anchorOf(words, [4, 5]);
  const comments = [
    { id: "r2", doc: "root", line: null, lineEnd: null, quote: null, body: "Overall fine", author: "me", createdAt: "2026-01-01T10:05:00Z" },
    { id: "x1", doc: "root", parentId: "r1", body: "Because bursts", author: "agent", createdAt: "2026-01-01T10:02:00Z" },
    { id: "r1", doc: "root", ...a, body: "Why a bucket?", author: "me", delivery: "ask", createdAt: "2026-01-01T10:00:00Z" },
    { id: "x2", doc: "root", parentId: "r1", body: "OK", author: "me", delivery: "decision", createdAt: "2026-01-01T10:03:00Z" },
    { id: "r3", doc: "root", line: 4, lineEnd: 4, quote: "refill", body: "done", author: "me", resolved: true, createdAt: "2026-01-01T10:06:00Z" },
    { id: "r4", doc: "gone", line: 1, lineEnd: 1, quote: "x", body: "old page", author: "me", createdAt: "2026-01-01T10:07:00Z" },
    { id: "orphan", doc: "root", parentId: "missing", body: "?", author: "agent", createdAt: "2026-01-01T10:08:00Z" },
  ];
  const ts = threadsFromComments(comments, (slug) => (slug === "root" ? words : null));
  assert.deepEqual(ts.map((t) => t.id), ["r1", "r2", "r3", "r4"]);
  const [t1, t2, t3, t4] = ts;
  assert.deepEqual(t1.messages.map((m) => [m.author, m.body, m.delivery]), [["you", "Why a bucket?", "ask"], ["agent", "Because bursts", null], ["you", "OK", "decision"]]);
  assert.deepEqual([t1.kind, t1.words, t1.lines, t1.status], ["range", [4, 5], [3, 3], "open"]);
  assert.deepEqual([t2.kind, t2.words, t2.detached], ["page", null, false]);
  assert.equal(t3.status, "resolved");
  assert.deepEqual([t4.page, t4.detached], ["gone", true]);
  assert.deepEqual([...openCounts(ts)], [["root", 2], ["gone", 1]]);
  const tint = tintMap(ts, "root", "r1");
  assert.deepEqual(tint.get(4), { ids: ["r1"], active: true, resolved: false });
  assert.equal(tint.has(9), false); // r3 is resolved: no tint unless resolved threads are shown
  assert.equal(tintMap(ts, "root", null, true).has(9), true);
  assert.equal(threadAt(ts, "root", 5).id, "r1");
  assert.equal(threadAt(ts, "root", 9), null);
});

test("margin layout: no overlaps; the active card keeps its y and pushes others up", () => {
  const items = [{ id: "a", y: 0, h: 50 }, { id: "b", y: 20, h: 50 }, { id: "c", y: 200, h: 40 }];
  assert.deepEqual([...layoutMargin(items)], [["a", 0], ["b", 60], ["c", 200]]);
  assert.deepEqual(Object.fromEntries(layoutMargin(items, "b")), { a: 0, b: 60, c: 200 });
  const far = [{ id: "a", y: 100, h: 50 }, { id: "b", y: 120, h: 50 }];
  assert.deepEqual([...layoutMargin(far, "b")], [["b", 120], ["a", 60]]);
});

test("time labels", () => {
  assert.equal(ago(0, 10_000), "just now");
  assert.equal(ago(0, 5 * 60_000), "5 min ago");
  assert.equal(ago(0, 3 * 3600_000), "3 h ago");
});
