import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePage } from "../markdown.js";
import { makeUnits, changedUnits, unitsByBlock } from "../units.js";

const page = (lines) => parsePage(lines, 1);

test("units: small blocks are whole; big lists, tables and code are chunked; every word has a unit", () => {
  const md = ["# T", "", "para one two", "", ...Array.from({ length: 5 }, (_, i) => `- item ${i}`), "", "| a | b |", "|---|---|",
    ...Array.from({ length: 6 }, (_, i) => `| r${i} | x |`), "", "```", ...Array.from({ length: 7 }, (_, i) => `line ${i}`), "```"];
  const { blocks, words } = page(md);
  const { units, wordUnit } = makeUnits(blocks, words.length, 3);
  assert.deepEqual(units.map((u) => [u.block, u.kind, u.from, u.to]), [
    [0, "whole", 0, 0], [1, "whole", 0, 0],
    [2, "part", 0, 3], [2, "part", 3, 5],
    [3, "part", 0, 3], [3, "part", 3, 6], [3, "part", 6, 7],
    [4, "part", 0, 3], [4, "part", 3, 6], [4, "part", 6, 7],
  ]);
  assert.ok([...wordUnit].every((u) => u >= 0));
  assert.equal(wordUnit[words.findIndex((w) => w.segs[0].text === "r2")], 5);
  assert.deepEqual([...unitsByBlock(units).get(3)].map((u) => u.id), [4, 5, 6]);
});

test("units: quotes count as one unit with their inner words", () => {
  const { blocks, words } = page(["> a b", "> c"]);
  const { units, wordUnit } = makeUnits(blocks, words.length);
  assert.equal(units.length, 1);
  assert.deepEqual([...wordUnit], [0, 0, 0]);
});

test("changedUnits: only the units whose tint changed, plus the word before a change", () => {
  const wu = Int32Array.from([0, 0, 0, 1, 1, 1, 2, 2, 2]);
  assert.deepEqual([...changedUnits([0, 1], [0, 2], wu)], [0]);
  assert.deepEqual([...changedUnits([0, 2], [0, 3], wu)].sort(), [0, 1]);
  assert.deepEqual([...changedUnits(null, [7, 7], wu)].sort(), [2]);
  assert.deepEqual([...changedUnits([4, 4], null, wu)].sort(), [1]);
  assert.deepEqual([...changedUnits([1, 5], [1, 5], wu)], []);
  assert.deepEqual([...changedUnits([0, 8], [0, 3], wu)].sort(), [1, 2]);
});


test("table columns: at least as wide as their longest word; a table wider than the text scrolls", async () => {
  const { tableColumns, tableWidth } = await import("../markdown.js");
  const cell = (...words) => ({ words: words.map((t) => ({ segs: [{ text: t }] })) });
  const code = (t) => ({ words: [{ segs: [{ text: t, code: true }] }] });
  const b = { header: [cell("Feature"), cell("Operation"), cell("Why")], rows: [[cell("Call", "type"), cell("ClassifyConversation"), code("conventions.md:61")]] };
  const cols = tableColumns(b);
  assert.ok(cols[1].min >= 20 * 8.2 + 24, "ClassifyConversation fits its cell");
  assert.ok(cols[2].min >= 17 * 8.6 + 10 + 24, "a code chip fits its cell");
  assert.equal(tableWidth(cols), cols.reduce((n, c) => n + c.min, 0) + 2);
});
