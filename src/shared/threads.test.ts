import { test } from 'node:test';
import assert from 'node:assert/strict';
import { actionableMessage, commentDelivery, groupThreads, isOpenThread, latestCreatedAt } from './threads.js';
import type { Comment } from './types.js';

const c = (over: Partial<Comment>): Comment => ({
  id: 'x',
  doc: 'root',
  line: null,
  lineEnd: null,
  quote: null,
  body: 'body',
  author: 'me',
  createdAt: '2026-01-01T00:00:00.000Z',
  ...over,
});

test('groupThreads nests replies under their root, oldest first', () => {
  const threads = groupThreads([
    c({ id: 'r1', createdAt: '2026-01-01T00:00:02.000Z' }),
    c({ id: 'r2', createdAt: '2026-01-01T00:00:01.000Z' }),
    c({ id: 'a1', parentId: 'r1', author: 'agent', createdAt: '2026-01-01T00:00:03.000Z' }),
    c({ id: 'a2', parentId: 'r1', createdAt: '2026-01-01T00:00:04.000Z' }),
  ]);
  assert.deepEqual(threads.map((t) => t.root.id), ['r2', 'r1']);
  assert.deepEqual(threads[1].replies.map((r) => r.id), ['a1', 'a2']);
});

test('orphan replies (missing root) are ignored', () => {
  const threads = groupThreads([c({ id: 'a1', parentId: 'gone' })]);
  assert.equal(threads.length, 0);
});

test('actionableMessage is the newest human message in the thread', () => {
  const thread = groupThreads([
    c({ id: 'r1', body: 'original', createdAt: '2026-01-01T00:00:01.000Z' }),
    c({ id: 'a1', parentId: 'r1', author: 'agent', body: 'agent', createdAt: '2026-01-01T00:00:02.000Z' }),
    c({ id: 'm2', parentId: 'r1', body: 'refined', createdAt: '2026-01-01T00:00:03.000Z' }),
  ])[0];
  assert.equal(actionableMessage(thread).body, 'refined');
});

test('isOpenThread reflects the resolved flag on the root', () => {
  assert.equal(isOpenThread({ root: c({ id: 'r1' }), replies: [] }), true);
  assert.equal(isOpenThread({ root: c({ id: 'r1', resolved: true }), replies: [] }), false);
});

test('legacy human comments default to decision delivery', () => {
  assert.equal(commentDelivery(c({})), 'decision');
  assert.equal(commentDelivery(c({ delivery: 'ask' })), 'ask');
  assert.equal(commentDelivery(c({ delivery: 'decision' })), 'decision');
});

test('latestCreatedAt picks the newest, or null when empty', () => {
  assert.equal(latestCreatedAt([]), null);
  assert.equal(
    latestCreatedAt([c({ createdAt: '2026-01-01T00:00:01.000Z' }), c({ createdAt: '2026-02-01T00:00:00.000Z' })]),
    '2026-02-01T00:00:00.000Z',
  );
});
