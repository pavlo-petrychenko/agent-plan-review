import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeHunks, diffSegments, diffTexts, toViewRows } from './differ.js';

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

test('hunks collapse long unchanged runs to context', () => {
  const before = Array.from({ length: 20 }, (_, i) => `old-${i}`);
  const after = [...before];
  after[10] = 'new-10';
  const d = diffTexts(before.join('\n'), after.join('\n'));

  assert.equal(d.rows.length, 20);
  assert.equal(d.hunks.length, 1);
  const [hunk] = d.hunks;
  assert.deepEqual(hunk, { start: 7, end: 14 }); // 3 context rows each side

  const segments = diffSegments(d.rows, d.hunks);
  assert.deepEqual(segments, [
    { kind: 'gap', start: 0, count: 7 },
    { kind: 'rows', start: 7, end: 14 },
    { kind: 'gap', start: 14, count: 6 },
  ]);
});

test('nearby changes merge into one hunk, distant ones split', () => {
  const before = Array.from({ length: 40 }, (_, i) => `l-${i}`);
  const after = [...before];
  after[5] = 'a';
  after[8] = 'b'; // 2 rows apart → merge
  after[30] = 'c'; // far away → second hunk
  const d = diffTexts(before.join('\n'), after.join('\n'));

  assert.equal(d.hunks.length, 2);
  assert.equal(d.hunks[0].start, 2);
  assert.equal(d.hunks[0].end, 12); // 8 + 1 + 3 context
  assert.equal(d.hunks[1].start, 27);
  assert.equal(d.hunks[1].end, 34);
});

test('no changes → no hunks, no gaps', () => {
  const d = diffTexts('a\nb', 'a\nb');
  assert.deepEqual(d.hunks, []);
  assert.deepEqual(diffSegments(d.rows, d.hunks), [{ kind: 'gap', start: 0, count: 2 }]);
});

test('leading and trailing unchanged runs stay in gaps', () => {
  const before = Array.from({ length: 30 }, (_, i) => `l-${i}`);
  const after = [...before];
  after[29] = 'changed';
  const d = diffTexts(before.join('\n'), after.join('\n'));
  const segments = diffSegments(d.rows, d.hunks);
  assert.deepEqual(segments[0], { kind: 'gap', start: 0, count: 26 });
  assert.equal(segments[segments.length - 1].kind, 'rows');
});

test('computeHunks clamps context at the document edges', () => {
  const rows = diffTexts('a\nb', 'a\nc\nd').rows;
  const hunks = computeHunks(rows, 3);
  assert.deepEqual(hunks, [{ start: 0, end: rows.length }]);
});

test('view rows mirror their own mode row list and keep sides honest', () => {
  const d = diffTexts('a\nx1\ny1\nz', 'a\nx2\ny2\nq2\nz');
  const split = toViewRows(d, 'split');
  const unified = toViewRows(d, 'unified');

  assert.deepEqual(split.map((r) => r.kind), d.rows.map((r) => r.kind));
  assert.deepEqual(unified.map((r) => r.kind), d.unified.map((r) => r.kind));

  // Unified lists removals and additions separately; split pairs them.
  assert.equal(split.filter((r) => r.kind === 'mod').length, 2);
  assert.ok(unified.filter((r) => r.kind === 'del').every((r) => r.newLine === undefined && r.oldLine != null));
  assert.ok(unified.filter((r) => r.kind === 'add').every((r) => r.oldLine === undefined && r.newLine != null));
  assert.ok(unified.filter((r) => r.kind === 'eq').every((r) => r.oldLine != null && r.newLine != null));
});

test('hunk segments always stay inside their own row list', () => {
  const d = diffTexts(Array.from({ length: 30 }, (_, i) => `l-${i}`).join('\n'), Array.from({ length: 30 }, (_, i) => `l-${i}`).join('\n') + '\ntail');
  for (const mode of ['split', 'unified'] as const) {
    const rows = toViewRows(d, mode);
    const segments = diffSegments(rows, computeHunks(rows));
    let covered = 0;
    for (const seg of segments) {
      assert.ok(seg.start <= rows.length, `${mode}: start in range`);
      covered += seg.kind === 'gap' ? seg.count : seg.end - seg.start;
    }
    assert.equal(covered, rows.length, `${mode}: segments cover every row exactly once`);
  }
});
