import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parsePlan, planFromDocs, parseMarker, neighbour, ancestors, treeRows } from "../plan.js";
import { parsePage, scanInline, wordsFromChars, highlightLine, codeWords, splitRow, wordText } from "../markdown.js";
import { range, extend, flowRange, rangeText, lineSpan } from "../selection.js";

const SAMPLE = readFileSync(new URL("./fixtures/plan.md", import.meta.url), "utf8");
const words = (md, resolve) => wordsFromChars(scanInline(md, resolve));
const texts = (md) => words(md).map((w) => w.segs.map((s) => s.text).join(""));

test("marker: slug, quoted title, parent; anything else is not a marker", () => {
  assert.deepEqual(parseMarker('<!--doc slug=a-b title="Hello there" parent=root-->'), { slug: "a-b", title: "Hello there", parent: "root" });
  assert.equal(parseMarker("<!-- a comment -->"), null);
  assert.equal(parseMarker("text <!--doc slug=x-->"), null);
});

test("plan: the sample has 10 pages in tree order with titles and source lines", () => {
  const plan = parsePlan(SAMPLE);
  assert.equal(plan.pages.length, 10);
  assert.equal(plan.root, "root");
  assert.equal(plan.title, "Plan review inside Herdr: can we build it?");
  assert.deepEqual(plan.children.get("can-herdr-do-it"), ["text-anchoring", "rendering", "agent-channel"]);
  const ta = plan.bySlug.get("text-anchoring");
  assert.equal(ta.depth, 2);
  assert.equal(SAMPLE.split("\n")[ta.startLine - 1], ta.lines[0]);
  assert.deepEqual(ancestors(plan, "text-anchoring").map((p) => p.slug), ["root", "can-herdr-do-it"]);
  assert.equal(neighbour(plan, "root", 1), "can-herdr-do-it");
  assert.equal(neighbour(plan, "root", -1), null);
});

test("plan: unknown parents and cycles hang under the root; tree rows carry guides", () => {
  const plan = parsePlan("# R\n<!--doc slug=a parent=b-->\n# A\n<!--doc slug=b parent=a-->\n# B\n<!--doc slug=c parent=nope-->\n# C");
  assert.equal(plan.bySlug.get("c").parent, "root");
  assert.ok([plan.bySlug.get("a").parent, plan.bySlug.get("b").parent].includes("root"));
  assert.equal(plan.pages.length, 4);
  const rows = treeRows(parsePlan("# R\n<!--doc slug=a-->\n# A\n<!--doc slug=a1 parent=a-->\n# A1\n<!--doc slug=b-->\n# B"));
  assert.deepEqual(rows.map((r) => [r.slug, r.depth, r.guides]), [["root", 0, []], ["a", 1, [true]], ["a1", 2, [true, false]], ["b", 1, [false]]]);
});

test("inline: bold, italic, code, links and punctuation glued to words", () => {
  const w = words("**Short answer: yes.** Use `hc send --if idle`, see [[next-step]] or [docs](https://x.dev) and *this*.", (s) => (s === "next-step" ? { title: "Next step" } : null));
  assert.deepEqual(w.map((x) => x.segs.map((s) => s.text).join("")), ["Short", "answer:", "yes.", "Use", "hc", "send", "--if", "idle,", "see", "Next", "step", "or", "docs", "and", "this."]);
  assert.ok(w[0].segs[0].bold && w[2].segs[0].bold && !w[3].segs[0].bold);
  assert.deepEqual(w[7].segs.map((s) => [s.text, !!s.code]), [["idle", true], [",", false]]);
  assert.deepEqual(w[9].segs[0].link, { slug: "next-step" });
  assert.deepEqual(w[12].segs[0].link, { url: "https://x.dev" });
  assert.ok(w[14].segs[0].italic && !w[14].segs[1].italic);
});

test("inline: snake_case and lone stars stay literal; escapes; [[slug|Label]]", () => {
  assert.deepEqual(texts("a snake_case_name and 2 * 3"), ["a", "snake_case_name", "and", "2", "*", "3"]);
  assert.deepEqual(texts("\\*not italic\\*"), ["*not", "italic*"]);
  const w = words("go to [[ideas|the ideas page]]");
  assert.deepEqual(w.slice(2).map((x) => [x.segs[0].text, x.segs[0].link.slug]), [["the", "ideas"], ["ideas", "ideas"], ["page", "ideas"]]);
});

test("blocks: headings, paragraphs, lists (nested, ordered), tables, code, quotes, images, rules", () => {
  const md = [
    "# Title", "", "Para one", "continues here.", "", "- a", "  - a1", "  - a2", "- b", "", "1. one", "2. two", "",
    "| A | B |", "|---|:-:|", "| x `y|z` | **w** |", "", "```js", "const x = 1; // hi", "```", "", "> quoted *text*", "", "![Flow](image:flow)", "", "---",
  ];
  const { blocks, words } = parsePage(md, 10);
  assert.deepEqual(blocks.map((b) => b.type), ["heading", "para", "list", "list", "table", "code", "quote", "image", "hr"]);
  assert.equal(blocks[1].flow.words.length, 4);
  assert.deepEqual(blocks[1].flow.words.map((w) => w.line), [12, 12, 13, 13]);
  assert.deepEqual(blocks[2].items.map((i) => i.depth), [0, 1, 1, 0]);
  assert.deepEqual(blocks[3].items.map((i) => i.number), [1, 2]);
  assert.deepEqual(blocks[4].align, ["left", "center"]);
  assert.equal(wordText(blocks[4].rows[0][0].words[1]), "y|z");
  assert.equal(blocks[5].lang, "js");
  assert.equal(blocks[5].lines[0].words.at(-1).segs[0].kind, "comment");
  assert.equal(blocks[6].blocks[0].type, "para");
  assert.equal(blocks[6].blocks[0].flow.words[0].block, 6);
  assert.equal(blocks[7].src, "image:flow");
  // Word indexes are dense and in reading order.
  words.forEach((w, i) => assert.equal(w.i, i));
});

test("blocks: the sample's pages parse without losing text", () => {
  const plan = parsePlan(SAMPLE);
  for (const p of plan.pages) {
    const { blocks, words } = parsePage(p.lines, p.startLine, (s) => plan.bySlug.get(s));
    assert.ok(blocks.length > 0, p.slug);
    for (const w of words) assert.ok(SAMPLE.split("\n")[w.line - 1] !== undefined);
  }
  const root = plan.pages[0];
  const { blocks } = parsePage(root.lines, root.startLine, (s) => plan.bySlug.get(s));
  const table = blocks.find((b) => b.type === "table");
  assert.equal(table.header.length, 3);
  assert.equal(table.rows.length, 9);
});

test("code: tokens and words keep exact spacing and indent", () => {
  assert.deepEqual(highlightLine('let s = "a b"; f(1)', "js").filter((t) => t.kind !== "plain").map((t) => [t.text, t.kind]),
    [["let", "keyword"], ["=", "punct"], ['"a b"', "string"], [";", "punct"], ["f", "fn"], ["(", "punct"], ["1", "number"], [")", "punct"]]);
  assert.equal(highlightLine("echo hi # note", "sh").at(-1).kind, "comment");
  const { indent, words } = codeWords("    a  =  b", "js");
  assert.equal(indent, "    ");
  assert.deepEqual(words.map((w) => [w.segs[0].text, w.space]), [["a", "  "], ["=", "  "], ["b", ""]]);
  const c = codeWords('f("a b") // two words', "js").words;
  assert.deepEqual(c.map((w) => w.segs.map((x) => x.text).join("")), ['f("a', 'b")', "//", "two", "words"]);
  assert.equal(c[3].segs[0].kind, "comment");
  assert.deepEqual(splitRow("| a | `b|c` | d\\|e |"), ["a", "`b|c`", "d\\|e"]);
});

test("selection: order, extend, flow, text across flows, line span", () => {
  const { words } = parsePage(["Alpha beta gamma.", "", "- one two", "- three", "", "```", "x  = 1", "```"], 1);
  assert.deepEqual(range({ anchor: 5, focus: 2 }), [2, 5]);
  assert.equal(range(null), null);
  assert.deepEqual(extend({ anchor: 1, focus: 1 }, 4), { anchor: 1, focus: 4 });
  assert.deepEqual(extend(null, 4), { anchor: 4, focus: 4 });
  assert.deepEqual(flowRange(words, 4), [3, 4]);
  assert.equal(rangeText(words, [1, 5]), "beta gamma.\none two\nthree");
  assert.equal(rangeText(words, [6, 8]), "x  = 1");
  assert.deepEqual(lineSpan(words, [1, 5]), [1, 4]);
});

test("planFromDocs: server documents become pages whose lines start at 1; the root comes first", () => {
  const plan = planFromDocs([
    { slug: "a", title: "Page A", parent: "top", markdown: "# A\n\ntext" },
    { slug: "top", title: "Top", parent: null, markdown: "# Top\r\nintro" },
    { slug: "b", title: null, parent: "nope", markdown: "# Bee" },
  ], "top");
  assert.equal(plan.root, "top");
  assert.deepEqual(plan.pages.map((p) => [p.slug, p.depth, p.startLine]), [["top", 0, 1], ["a", 1, 1], ["b", 1, 1]]);
  assert.deepEqual(plan.bySlug.get("top").lines, ["# Top", "intro"]);
  assert.equal(plan.bySlug.get("b").title, "Bee");
  // A single-document plan: no title from the server, the heading names it.
  const one = planFromDocs([{ slug: "root", title: null, parent: null, markdown: "# My plan\n\nbody" }], "root");
  assert.equal(one.title, "My plan");
  assert.equal(planFromDocs([], "root").pages.length, 1);
});

// Every word's [src, srcEnd) slice of the page source holds the word's own text (for plain text).
const sourceOf = (lines, w) => lines.join("\n").slice(w.src, w.srcEnd);

test("source offsets: paragraphs, headings, list items, quotes, table cells and code", () => {
  const lines = ["# The *title*", "", "Para **bold** word", "next line", "", "- item one", "  - [ ] nested", "", "> quoted text",
    "", "| a | b | a |", "|---|---|---|", "| x | y | x |", "", "```js", "  const v = 1;", "```"];
  const { words } = parsePage(lines, 1);
  const pick = (t) => words.filter((w) => wordText(w) === t);
  for (const w of words) assert.equal(sourceOf(lines, w).replace(/\*/g, ""), wordText(w), `word ${wordText(w)}`);
  // Same text in two table cells of one row: each word points at its own cell.
  const [x1, x2] = pick("x");
  assert.notEqual(x1.src, x2.src);
  const [a1, a2] = pick("a");
  assert.ok(a2.src > a1.src);
  assert.equal(pick("bold")[0].srcEnd - pick("bold")[0].src, 4);
  assert.equal(sourceOf(lines, pick("1;")[0]), "1;");
});

test("source offsets: page lines with a start line other than 1 still index the page text", () => {
  const { words } = parsePage(["alpha beta", "gamma"], 40);
  assert.deepEqual(words.map((w) => [w.line, w.src, w.srcEnd]), [[40, 0, 5], [40, 6, 10], [41, 11, 16]]);
});

