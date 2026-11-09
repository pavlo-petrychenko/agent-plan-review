import { test } from "node:test";
import assert from "node:assert/strict";
import { linkRange, linkKeyOf } from "../selection.js";

const w = (i, link, flow = 0) => ({ i, flow, segs: [{ text: "x", ...(link ? { link } : {}) }] });

test("linkRange covers every word of one link, and only words with the same target in the same flow", () => {
  const words = [w(0), w(1, { url: "https://a" }), w(2, { url: "https://a" }), w(3, { slug: "b" }), w(4, { url: "https://a" }, 1), w(5)];
  assert.deepEqual(linkRange(words, 1), [1, 2]);
  assert.deepEqual(linkRange(words, 2), [1, 2]);
  assert.deepEqual(linkRange(words, 3), [3, 3]);
  assert.deepEqual(linkRange(words, 4), [4, 4], "another flow (a table cell) is another link");
  assert.equal(linkRange(words, 0), null);
  assert.equal(linkKeyOf(words[3]), "slug:b");
});
