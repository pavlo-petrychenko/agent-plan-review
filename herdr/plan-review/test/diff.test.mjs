import { test } from "node:test";
import assert from "node:assert/strict";
import { diffRows, diffStats, rowWords, collapseRows, buildDiffPage, removedRowOf, displayIndexOf } from "../diff.js";
import { parsePage, wordText } from "../markdown.js";
import { anchorOf, anchorWords, threadsFromComments } from "../threads.js";
import { tintMap } from "../selection.js";

const OLD = ["# Plan", "", "Use a token bucket per key.", "Refill every second.", "", "- one key per user", "- no burst"].join("\n");
const NEW = ["# Plan", "", "Use a **token bucket** per key.", "Refill every second.", "", "- one key per user", "- no burst", "- audit log"].join("\n");

const kinds = (rows) => rows.map((r) => `${r.kind[0]}${r.oldLine ?? ""}/${r.newLine ?? ""}`);

test("diffRows: equal, removed and added lines with the numbers of each side (as the web's unified rows)", () => {
  const rows = diffRows(OLD, NEW);
  assert.deepEqual(kinds(rows), ["e1/1", "e2/2", "d3/", "a/3", "e4/4", "e5/5", "e6/6", "e7/7", "a/8"]);
  assert.equal(rows[2].text, "Use a token bucket per key.");
  assert.equal(rows[3].text, "Use a **token bucket** per key.");
  assert.deepEqual(diffStats(rows), { added: 2, removed: 1 });
});

test("diffRows: identical texts are all equal; empty sides are all added or removed; CRLF is normalized", () => {
  assert.equal(diffStats(diffRows(NEW, NEW)).added, 0);
  assert.deepEqual(kinds(diffRows("", "a\nb")), ["a/1", "a/2"]);
  assert.deepEqual(kinds(diffRows("a\nb", "")), ["d1/", "d2/"]);
  assert.deepEqual(kinds(diffRows("a\r\nb", "a\nb")), ["e1/1", "e2/2"]);
  assert.deepEqual(diffRows("", ""), []);
});

test("diffRows: a moved or interleaved edit keeps the line numbers of both sides", () => {
  const rows = diffRows("a\nb\nc\nd\ne", "a\nc\nX\nd\ne\nf");
  assert.deepEqual(kinds(rows), ["e1/1", "d2/", "e3/2", "a/3", "e4/4", "e5/5", "a/6"]);
  // Every old line appears once as eq/del, every new line once as eq/add.
  assert.deepEqual(rows.filter((r) => r.oldLine).map((r) => r.oldLine), [1, 2, 3, 4, 5]);
  assert.deepEqual(rows.filter((r) => r.newLine).map((r) => r.newLine), [1, 2, 3, 4, 5, 6]);
});

test("diffRows: a huge rewrite does not build a huge table (one removed block, one added block)", () => {
  const a = Array.from({ length: 3000 }, (_, i) => `old ${i}`).join("\n");
  const b = Array.from({ length: 3000 }, (_, i) => `new ${i}`).join("\n");
  const rows = diffRows(a, b);
  assert.equal(rows.length, 6000);
  assert.deepEqual(diffStats(rows), { added: 3000, removed: 3000 });
});

test("rowWords: words only on the new side, with new-side lines and offsets into the new text", () => {
  const rows = diffRows(OLD, NEW);
  const words = rowWords(rows, NEW);
  assert.ok(rows.filter((r) => r.kind === "del").every((r) => r.count === 0));
  for (const w of words) {
    assert.equal(NEW.slice(w.src, w.srcEnd), wordText(w), "offset points at the word in the new text");
    assert.equal(NEW.split("\n")[w.line - 1].includes(wordText(w)), true);
    assert.equal(rows[w.row].newLine, w.line);
  }
  assert.deepEqual(words.map((w) => w.i), words.map((_w, i) => i));
  // "Use a **token bucket** per key." is the added row 3.
  const row = rows[3];
  assert.equal(words.slice(row.first, row.first + row.count).map(wordText).join(" "), "Use a **token bucket** per key.");
  assert.equal(row.indent, "");
  assert.equal(rows.find((r) => r.text === "- audit log").count, 3);
});

test("rowWords: indentation is kept out of the words but inside their offsets", () => {
  const text = "- a\n  - nested item";
  const rows = diffRows(text, text);
  const words = rowWords(rows, text);
  const nested = rows[1];
  assert.equal(nested.indent, "  ");
  assert.equal(text.slice(words[nested.first].src, words[nested.first].srcEnd), "-");
  assert.equal(words[nested.first].src, 6);
});

test("a comment on diff words round-trips: its anchor lands on the same text in the page's own words", () => {
  const { rows, words } = buildDiffPage(OLD, NEW);
  const added = rows.findIndex((r) => r.kind === "add" && r.newLine === 3);
  const r = [rows[added].first + 2, rows[added].first + 3]; // "**token bucket**"
  const anchor = anchorOf(words, r);
  assert.deepEqual([anchor.line, anchor.lineEnd], [3, 3]);
  assert.equal(NEW.slice(anchor.range.start, anchor.range.end), "**token bucket**");
  // The plain view of v2 places it on the words "token bucket".
  const page = parsePage(NEW.split("\n"), 1);
  const there = anchorWords({ ...anchor }, page.words);
  assert.equal(page.words.slice(there.words[0], there.words[1] + 1).map(wordText).join(" "), "token bucket");
  // And a comment made in the plain view is found on the diff's words.
  const plain = anchorOf(page.words, [there.words[0], there.words[0]]);
  const back = anchorWords(plain, words);
  assert.equal(wordText(words[back.words[0]]).replace(/\*/g, ""), "token");
});

test("threads in a diff: placed on the diff words, tinted, and the old-side ones pinned to their removed row", () => {
  const { rows, words } = buildDiffPage(OLD, NEW);
  const comments = [
    { id: "c1", doc: "root", line: 8, lineEnd: 8, quote: "audit log", range: { start: NEW.indexOf("audit"), end: NEW.indexOf("audit") + 9 }, body: "why?", author: "human", createdAt: "2026-01-01T10:00:00Z" },
    { id: "c2", doc: "root", line: 3, lineEnd: 3, side: "old", baseVersion: 1, quote: "token bucket", body: "was this wrong?", author: "human", createdAt: "2026-01-01T11:00:00Z" },
  ];
  const threads = threadsFromComments(comments, () => words);
  const [t1, t2] = threads;
  assert.equal(words.slice(t1.words[0], t1.words[1] + 1).map(wordText).join(" "), "audit log");
  assert.equal(t2.detached, true);
  assert.equal(t2.baseVersion, 1);
  const th = { side: t2.side, line: t2.lines[0], baseVersion: t2.baseVersion };
  assert.equal(removedRowOf(th, rows, 1), 2);
  assert.equal(removedRowOf(th, rows, 2), null, "another base: not shown on a removed row");
  assert.equal(removedRowOf({ ...th, side: "new" }, rows, 1), null);
  const tints = tintMap(threads, "root", null);
  assert.deepEqual([...tints.keys()], [t1.words[0], t1.words[0] + 1]);
});

test("collapseRows: long unchanged runs fold to one entry that keeps 3 lines of context; expanding shows them", () => {
  const body = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`);
  const next = [...body];
  next[0] = "line one";
  next[29] = "line thirty";
  const rows = diffRows(body.join("\n"), next.join("\n"));
  const disp = collapseRows(rows);
  const gaps = disp.filter((e) => e.gap);
  assert.equal(gaps.length, 1);
  const g = gaps[0];
  // rows: d1 a1 | eq 2..29 (28 rows) | d30 a30 → 3 kept on each side
  assert.equal(g.count, 22);
  assert.equal(g.to - g.from, 22);
  assert.equal(rows[g.from].kind, "eq");
  assert.equal(disp.filter((e) => !e.gap).length, rows.length - 22);
  // Expanded (keyed by the gap's first row), nothing is folded.
  assert.equal(collapseRows(rows, new Set([g.from])).some((e) => e.gap), false);
  assert.equal(collapseRows(rows, new Set([g.from])).length, rows.length);
  // The display index of a hidden row is its gap's.
  assert.equal(disp[displayIndexOf(disp, g.from + 5)].gap, true);
  assert.equal(displayIndexOf(disp, 0), 0);
});

test("collapseRows: a run too short to fold stays; an unchanged page folds to the whole page", () => {
  const rows = diffRows("a\nb\nc\nd\ne\nf\ng\nh\ni", "a\nb\nc\nd\nX\nf\ng\nh\ni");
  assert.equal(collapseRows(rows).some((e) => e.gap), false, "3 + 3 context covers all the equal lines but one run of 1");
  const same = diffRows(Array.from({ length: 12 }, (_, i) => `l${i}`).join("\n"), Array.from({ length: 12 }, (_, i) => `l${i}`).join("\n"));
  const disp = collapseRows(same);
  assert.equal(disp.length, 1);
  assert.deepEqual([disp[0].gap, disp[0].from, disp[0].to, disp[0].count], [true, 0, 12, 12]);
});

test("buildDiffPage: an added page is all added rows; a removed one all removed and without words", () => {
  const added = buildDiffPage("", "# New\n\nhello world");
  assert.deepEqual(added.stats, { added: 3, removed: 0 });
  assert.equal(added.words.length, 4);
  const removed = buildDiffPage("# Gone\n\nbye", "");
  assert.deepEqual(removed.stats, { added: 0, removed: 3 });
  assert.equal(removed.words.length, 0);
  assert.equal(removed.changed, true);
  assert.equal(buildDiffPage("x", "x").changed, false);
});
