import { test } from 'node:test';
import assert from 'node:assert/strict';
import { apiCache, refresh } from './cache.js';

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

test('refresh keeps current data visible while re-fetching', async () => {
  const key = 'comments:refresh-project:1';
  let comments = ['first'];
  const fetcher = async () => ({ comments: [...comments] });
  await apiCache.refetch(key, fetcher);

  comments = ['first', 'second'];
  refresh(key);

  assert.deepEqual(apiCache.getSnapshot(key)?.data, { comments: ['first'] });
  assert.equal(apiCache.getSnapshot(key)?.loading, false);

  await settle();
  assert.deepEqual(apiCache.getSnapshot(key)?.data, { comments: ['first', 'second'] });
  assert.equal(apiCache.getSnapshot(key)?.loading, false);
});

test('unchanged review polls produce no cache notifications', async () => {
  const reviewKey = 'review:refresh-poll';
  const commentsKey = 'comments:refresh-project:2';
  await apiCache.refetch(reviewKey, async () => ({ id: 'refresh-poll', status: 'pending' }));
  await apiCache.refetch(commentsKey, async () => ({ comments: ['visible'] }));

  const seen: unknown[] = [];
  const unsubscribe = apiCache.subscribeAll(() => seen.push(apiCache.getSnapshot(commentsKey)?.data));
  try {
    for (let index = 0; index < 4; index += 1) {
      await apiCache.refetch(reviewKey, async () => ({ id: 'refresh-poll', status: 'pending' }));
      refresh(commentsKey);
      await settle();
    }
  } finally {
    unsubscribe();
  }

  assert.deepEqual(seen, []);
});

test('prefix invalidation does not collide with longer key segments', async () => {
  const v1 = 'comments:prefix-project:1';
  const v10 = 'comments:prefix-project:10';
  const v11 = 'comments:prefix-project:11';
  await apiCache.refetch(v1, async () => ({ comments: [1] }));
  await apiCache.refetch(v10, async () => ({ comments: [10] }));
  await apiCache.refetch(v11, async () => ({ comments: [11] }));

  apiCache.invalidate(v1);

  assert.equal(apiCache.getSnapshot(v1), undefined);
  assert.deepEqual(apiCache.getSnapshot(v10)?.data, { comments: [10] });
  assert.deepEqual(apiCache.getSnapshot(v11)?.data, { comments: [11] });

  await settle();
  assert.deepEqual(apiCache.getSnapshot(v1)?.data, { comments: [1] });
  assert.deepEqual(apiCache.getSnapshot(v10)?.data, { comments: [10] });
  assert.deepEqual(apiCache.getSnapshot(v11)?.data, { comments: [11] });
});
