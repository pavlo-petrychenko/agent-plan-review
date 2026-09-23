/**
 * The review poll must stay responsive while someone is watching and back off
 * once nobody is, so the schedule is a pure function with pinned boundaries.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reviewPollDelay } from './reviewPollDelay.js';

test('fast while the human is actively looking at a pending review', () => {
  assert.equal(reviewPollDelay(0), 2_500);
  assert.equal(reviewPollDelay(29_999), 2_500);
});

test('backs off as the review sits there', () => {
  assert.equal(reviewPollDelay(30_000), 5_000);
  assert.equal(reviewPollDelay(119_999), 5_000);
  assert.equal(reviewPollDelay(2 * 60_000), 15_000);
  assert.equal(reviewPollDelay(9 * 60_000), 15_000);
  assert.equal(reviewPollDelay(10 * 60_000), 30_000);
  assert.equal(reviewPollDelay(24 * 60 * 60_000), 30_000, 'and caps out');
});

test('the schedule is monotonic and always slower than the first window', () => {
  const samples = [0, 30_000, 120_000, 600_000, 3_600_000].map(reviewPollDelay);
  for (let i = 1; i < samples.length; i++) assert.ok(samples[i] >= samples[i - 1]);
  assert.ok(samples[samples.length - 1] > samples[0]);
  // A one-hour-old pending review costs this much less than a fixed 2.5s poll.
  const hourly = 3_600_000 / reviewPollDelay(3_600_000);
  assert.ok(hourly <= 120, `at most 120 polls/hour, got ${Math.round(hourly)}`);
});
