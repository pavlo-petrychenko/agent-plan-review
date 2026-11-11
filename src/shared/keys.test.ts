import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeProjectKey } from './keys.js';

test('stable and collision-free across same-named paths', () => {
  const a = sanitizeProjectKey('/home/dev/app');
  const b = sanitizeProjectKey('/home/other/app');
  assert.equal(a, sanitizeProjectKey('/home/dev/app'));
  assert.notEqual(a, b);
});

test('readable base plus hash suffix', () => {
  assert.match(sanitizeProjectKey('/Users/x/my-project'), /^my-project-[0-9a-f]{8}$/);
});

test('weird characters sanitized', () => {
  assert.match(sanitizeProjectKey('C:\\Users\\Dev\\Proj Name!!'), /^proj-name-[0-9a-f]{8}$/);
});

test('plan project keys round-trip and never collide with worktree keys', async () => {
  const { newPlanId, normalizePlanId, parsePlanProjectKey, planProjectKey } = await import('./keys.js');
  const wt = sanitizeProjectKey('/code/website');
  const id = newPlanId();
  assert.match(id, /^p-[0-9a-f]{6}$/);
  const key = planProjectKey(wt, id);
  assert.deepEqual(parsePlanProjectKey(key), { worktreeKey: wt, planId: id });
  assert.equal(parsePlanProjectKey(wt), null);
  // A worktree folder named like a plan suffix still ends in its path hash.
  assert.equal(parsePlanProjectKey(sanitizeProjectKey('/code/x.p-abcdef')), null);
  assert.equal(normalizePlanId('P-3F9A1C'), 'p-3f9a1c');
  assert.equal(normalizePlanId('3f9a1c'), 'p-3f9a1c');
  assert.equal(normalizePlanId(key), null);
});
