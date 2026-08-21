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
