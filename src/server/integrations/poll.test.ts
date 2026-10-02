/**
 * waitForDecisionOrAsk — the loop that decides whether a blocked plan-mode
 * agent gets its turn back.
 *
 * The contract that matters: an Ask ends the wait (and is marked delivered so
 * it is never offered twice), a decision ends the wait, and silence times out
 * into the fail-open path rather than hanging forever.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { PlanReviewStore } from '../store/store.js';
import { waitForDecisionOrAsk, waitForDecision } from './poll.js';

function makeStore(): PlanReviewStore {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'apr-poll-'));
  return new PlanReviewStore({ home, port: 4999 });
}

/** A hook review with a pending question on it, plus its project/version. */
async function askReview(
  store: PlanReviewStore,
  body = 'why this approach?',
): Promise<{ projectKey: string; version: number; reviewId: string }> {
  const rec = await store.recordPlan({
    cwd: fs.mkdtempSync(path.join(os.tmpdir(), 'apr-poll-plan-')),
    origin: 'hook',
    sessionId: 'sess-1',
    toolUseId: 'tu-1',
    markdown: '# Plan\n\nbody\n',
  });
  await store.addComment(rec.projectKey, rec.version, {
    body,
    delivery: 'ask',
    reviewId: rec.reviewId,
    doc: 'root',
  });
  return { projectKey: rec.projectKey, version: rec.version, reviewId: rec.reviewId };
}

test('an Ask ends the wait and is marked delivered exactly once', async () => {
  const store = makeStore();
  const { reviewId } = await askReview(store);

  const first = await waitForDecisionOrAsk(store, reviewId, 30);
  assert.equal(first.kind, 'ask');
  if (first.kind !== 'ask') return;
  assert.match(first.comments[0].body, /why this approach\?/);
  assert.ok(first.cursor, 'a cursor is returned so the caller can persist it');

  // The cursor was persisted inside the wait, so the next round is quiet…
  const second = await waitForDecisionOrAsk(store, reviewId, 30);
  assert.equal(second.kind, 'timedOut', 'the same question is not offered twice');

  // …but a NEW question still wakes it.
  const again = await store.getReview(reviewId);
  assert.equal(again?.status, 'pending');
  await store.addComment(again!.projectKey, again!.version, {
    body: 'and the cap?',
    delivery: 'ask',
    reviewId,
    doc: 'root',
  });
  const third = await waitForDecisionOrAsk(store, reviewId, 30);
  assert.equal(third.kind, 'ask');
  if (third.kind === 'ask') assert.match(third.comments[0].body, /and the cap\?/);
});

test('a decision ends the wait before any Ask is noticed', async () => {
  const store = makeStore();
  const rec = await store.recordPlan({
    cwd: fs.mkdtempSync(path.join(os.tmpdir(), 'apr-poll-plan-')),
    origin: 'hook',
    sessionId: 'sess-1',
    markdown: '# Plan\n\nbody\n',
  });
  await store.decideReview(rec.reviewId, 'approve', 'ship it');

  const outcome = await waitForDecisionOrAsk(store, rec.reviewId, 30);
  assert.equal(outcome.kind, 'decided');
  if (outcome.kind !== 'decided') return;
  assert.equal(outcome.review.status, 'approved');
  assert.equal(outcome.review.resolvedAt != null, true, 'the decision stamped a resolution time');
});

test('silence times out rather than hanging, and a missing review is a timeout', async () => {
  const store = makeStore();
  const rec = await store.recordPlan({
    cwd: fs.mkdtempSync(path.join(os.tmpdir(), 'apr-poll-plan-')),
    origin: 'hook',
    sessionId: 'sess-1',
    markdown: '# Plan\n\nbody\n',
  });

  const quiet = await waitForDecisionOrAsk(store, rec.reviewId, 1);
  assert.equal(quiet.kind, 'timedOut');

  // A review that does not exist is the same fail-open outcome.
  const gone = await waitForDecisionOrAsk(store, 'no-such-review', 5);
  assert.equal(gone.kind, 'timedOut');
});

test('waitForDecision keeps its old shape and tolerates an Ask', async () => {
  const store = makeStore();
  const { reviewId } = await askReview(store);
  // The legacy helper must not hang on a question it cannot deliver — it hands
  // back the still-pending review, which its caller treats as fail-open.
  const review = await waitForDecision(store, reviewId, 1);
  assert.equal(review?.status, 'pending');
});
