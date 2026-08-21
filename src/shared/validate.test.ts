import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateDocs } from './validate.js';

const body = (slug: string, md: string) => new Map([[slug, md]]);

test('valid tree yields no issues', () => {
  const docs = [
    { slug: 'root', title: 'Plan', parent: null },
    { slug: 'child', title: 'Child', parent: 'root' },
  ];
  const bodies = body('root', 'see [[child]]');
  bodies.set('child', 'back to (doc:root)');
  assert.deepEqual(validateDocs(docs as never, bodies), []);
});

test('collects all issue kinds at once', () => {
  const docs = [
    { slug: 'Bad Slug', title: '', parent: 'ghost' },
    { slug: 'root', title: 'R', parent: null },
    { slug: 'root2', title: 'R2', parent: null },
  ];
  const issues = validateDocs(docs as never, body('bad-slug-x', ''));
  const messages = issues.map((i) => i.message);
  assert.ok(messages.some((m) => m.includes('Invalid document slug "Bad Slug"')));
  assert.ok(messages.some((m) => m.includes('missing a title')));
  assert.ok(messages.some((m) => m.includes('references parent "ghost"')));
  assert.ok(messages.some((m) => m.includes('Multiple root documents')));
});

test('duplicate slugs reported', () => {
  const docs = [
    { slug: 'a', title: 'A', parent: null },
    { slug: 'a', title: 'A again', parent: 'a' },
  ];
  const issues = validateDocs(docs as never, body('a', ''));
  assert.ok(issues.some((i) => i.message.includes('Duplicate document slug "a"')));
});

test('parent cycle detected', () => {
  const docs = [
    { slug: 'a', title: 'A', parent: 'b' },
    { slug: 'b', title: 'B', parent: 'c' },
    { slug: 'c', title: 'C', parent: 'a' },
  ];
  const issues = validateDocs(docs as never, body('a', ''));
  assert.ok(issues.some((i) => i.message.includes('cycle')));
});

test('zero roots detected', () => {
  const docs = [{ slug: 'a', title: 'A', parent: 'b' }];
  const issues = validateDocs(docs as never, body('a', ''));
  assert.ok(issues.some((i) => i.message.includes('No root document')));
});

test('dangling wiki + doc links reported with doc attribution', () => {
  const docs = [{ slug: 'root', title: 'R', parent: null }];
  const issues = validateDocs(docs as never, body('root', 'see [[nowhere]] and [[Ghost|g]] and [t](doc:missing)'));
  const linkIssues = issues.filter((i) => i.message.includes('links to unknown document'));
  assert.equal(linkIssues.length, 3);
});

test('wiki links inside code fences are not validated', () => {
  const docs = [{ slug: 'root', title: 'R', parent: null }];
  const md = '```\n[[nowhere]]\n```';
  const issues = validateDocs(docs as never, body('root', md));
  assert.equal(issues.length, 0);
});
