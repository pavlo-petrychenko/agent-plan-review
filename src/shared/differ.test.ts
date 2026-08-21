import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diffTexts } from './differ.js';

test('identical texts → no changes', () => {
  const d = diffTexts('a\nb\nc', 'a\nb\nc');
  assert.deepEqual(d.stats, { added: 0, removed: 0 });
  assert.ok(d.rows.every((r) => r.kind === 'eq'));
});

test('stats count added and removed', () => {
  const d = diffTexts('keep\nold1\nold2', 'keep\nnew1\nnew2\nextra');
  assert.deepEqual(d.stats, { added: 3, removed: 2 });
});

test('side-by-side pairs mod runs row-wise and pads blanks', () => {
  const d = diffTexts('a\nx1\ny1\nz', 'a\nx2\ny2\nq2\nz');
  const modRows = d.rows.filter((r) => r.kind === 'mod');
  assert.equal(modRows.length, 2);
  assert.equal(modRows[0].left?.text, 'x1');
  assert.equal(modRows[0].right?.text, 'x2');
  // one leftover insert padded on the left
  const addRow = d.rows.find((r) => r.kind === 'add' && r.right?.text === 'q2');
  assert.ok(addRow);
  assert.equal(addRow.left, undefined);
});

test('unified rows carry line numbers and markers', () => {
  const d = diffTexts('a\nb', 'a\nc');
  const del = d.unified.find((r) => r.kind === 'del');
  const add = d.unified.find((r) => r.kind === 'add');
  assert.equal(del?.text, 'b');
  assert.equal(del?.oldLine, 2);
  assert.equal(add?.text, 'c');
  assert.equal(add?.newLine, 2);
});

test('empty vs content diffs fully added', () => {
  const d = diffTexts('', 'one\ntwo');
  assert.deepEqual(d.stats, { added: 2, removed: 0 });
});
