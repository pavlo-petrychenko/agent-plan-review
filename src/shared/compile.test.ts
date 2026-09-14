import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compileRejection, compileApproval, compileIssues } from './compile.js';
import type { Comment, Manifest } from './types.js';

const noResolve = () => null;
const manifest: Manifest = {
  root: 'root',
  docs: [
    { slug: 'root', title: 'Plan', parent: null },
    { slug: 'risks', title: 'Risks', parent: 'root' },
  ],
};

const c = (over: Partial<Comment>): Comment => ({
  id: 'x',
  doc: 'root',
  line: null,
  lineEnd: null,
  quote: null,
  body: 'body',
  author: 'me',
  createdAt: new Date().toISOString(),
  ...over,
});

test('rejection with zero comments still instructs', () => {
  const out = compileRejection([], undefined, noResolve, 3);
  assert.match(out, /requested changes/);
  assert.match(out, /re-present/i);
});

test('rejection groups per document, lines sorted, prefers quotes', () => {
  const comments = [
    c({ doc: 'root', line: 12, lineEnd: null, quote: 'exact words', body: 'fix this' }),
    c({ doc: 'root', line: 4, body: 'earlier note' }),
    c({ doc: 'risks', body: 'general risk note' }),
  ];
  const out = compileRejection(comments, manifest, noResolve, 2);
  assert.match(out, /## Document: Plan/);
  assert.match(out, /\[line 4\] → earlier note/);
  assert.match(out, /\[line 12\] "exact words" → fix this/);
  assert.match(out, /## Document: Risks/);
  assert.match(out, /general risk note/);
  assert.match(out, /version 2/);
  const planIdx = out.indexOf('Document: Plan');
  const risksIdx = out.indexOf('Document: Risks');
  assert.ok(planIdx < risksIdx);
});

test('line comments sorted by line number', () => {
  const comments = [c({ line: 20, body: 'second' }), c({ line: 5, body: 'first' })];
  const out = compileRejection(comments, undefined, noResolve);
  assert.ok(out.indexOf('first') < out.indexOf('second'));
});

test('falls back to resolved source slice when no quote', () => {
  const comments = [c({ line: 3, lineEnd: 4, body: 'tighten' })];
  const out = compileRejection(comments, undefined, (_doc, l, le) => `slice ${l}-${le}`);
  assert.match(out, /\[lines 3-4\] "slice 3-4" → tighten/);
});

test('approval empty when no comments; notes otherwise', () => {
  assert.equal(compileApproval([], undefined, noResolve), '');
  const out = compileApproval([c({ body: 'keep it simple' })], undefined, noResolve);
  assert.match(out, /APPROVED the plan with 1 comment/);
  assert.match(out, /keep it simple/);
});

test('issues compiler lists every message and marker', () => {
  const out = compileIssues([
    { message: 'Bad slug.', marker: '<!--doc slug=Bad Slug-->' },
    { message: 'No root.' },
  ]);
  assert.match(out, /failed multi-document validation/);
  assert.match(out, /- Bad slug\./);
  assert.match(out, /<!--doc slug=Bad Slug-->/);
  assert.match(out, /- No root\./);
});

test('rejection names the requested re-submit channel', () => {
  const comments = [c({ line: 2, body: 'tweak' })];
  const mcp = compileRejection(comments, undefined, noResolve, 1, 'plan_review_submit');
  assert.match(mcp, /via plan_review_submit\./);
  const hook = compileRejection(comments, undefined, noResolve, 1);
  assert.match(hook, /via ExitPlanMode\./);
  const issuesMcp = compileIssues([{ message: 'x' }], 'plan_review_submit');
  assert.match(issuesMcp, /via plan_review_submit\./);
});

test('old-side (diff-anchored) comments are labelled as removed and quote the base version', () => {
  const comments = [
    c({ line: 41, lineEnd: 42, side: 'old', baseVersion: 9, body: 'why drop the rollout?' }),
    c({ line: 10, body: 'new-side note' }),
  ];
  const resolve = (_doc: string, line: number, lineEnd: number, baseVersion?: number): string =>
    baseVersion === 9 ? `base ${line}-${lineEnd}` : `current ${line}`;

  const out = compileRejection(comments, manifest, resolve, 10);
  assert.match(out, /\[removed in v9, lines 41-42\] "base 41-42" → why drop the rollout\?/);
  assert.match(out, /\[line 10\] "current 10" → new-side note/);
  // Removed-line comments come after current-line comments.
  assert.ok(out.indexOf('new-side note') < out.indexOf('why drop the rollout'));
});
