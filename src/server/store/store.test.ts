/**
 * Store-level tests for the two cross-project behaviours:
 *   - cwd folding: a plan submitted from a subdirectory joins its repo project
 *     instead of minting a new one;
 *   - whole-plan diffs: every page of both versions in one payload;
 *   - moving versions between projects (repairing a stray project key).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PlanReviewStore } from './store.js';
import { PlanValidationError } from '../util/errors.js';

function makeStore(): PlanReviewStore {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'apr-store-'));
  return new PlanReviewStore({ home, port: 4999 });
}

function makeDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function makeRepo(): { repo: string; sub: string } {
  const repo = makeDir('apr-repo-');
  execFileSync('git', ['init', '-q'], { cwd: repo });
  const sub = path.join(repo, 'packages', 'thing');
  fs.mkdirSync(sub, { recursive: true });
  return { repo, sub };
}

const TREE_V1 = `# Plan

root one

<!--doc slug=impl title="Implementation" parent=root-->

step one

<!--doc slug=risks title="Risks" parent=root-->

risk one
`;

const TREE_V2 = `# Plan

root two

<!--doc slug=impl title="Implementation" parent=root-->

step two

<!--doc slug=notes title="Notes" parent=root-->

brand new page
`;

test('a plan submitted from a subdirectory joins the repo project', async () => {
  const store = makeStore();
  const { repo, sub } = makeRepo();

  const first = await store.recordPlan({ cwd: repo, origin: 'mcp', markdown: '# Plan\n\none' });
  const second = await store.recordPlan({ cwd: sub, origin: 'mcp', markdown: '# Plan\n\ntwo' });

  assert.equal(second.projectKey, first.projectKey);
  assert.equal(second.version, 2);

  const detail = await store.getProjectDetail(first.projectKey);
  assert.ok(!detail.meta.cwd.includes(`packages${path.sep}thing`), `cwd should be folded, got ${detail.meta.cwd}`);

  // The raw path survives on the review so gates can still match the session.
  const review = await store.getReview(second.reviewId);
  assert.equal(review?.agentCwd, sub);
  assert.equal(review?.cwd, detail.meta.cwd);
});

test('non-repo subdirectories fold into the nearest registered project', async () => {
  const store = makeStore();
  const parent = makeDir('apr-parent-');
  const child = path.join(parent, 'src', 'deep');
  fs.mkdirSync(child, { recursive: true });

  const first = await store.recordPlan({ cwd: parent, origin: 'api', markdown: '# Plan\n\none' });
  const second = await store.recordPlan({ cwd: child, origin: 'api', markdown: '# Plan\n\ntwo' });

  assert.equal(second.projectKey, first.projectKey);
  assert.equal(second.version, 2);
  assert.equal((await store.getProjectDetail(first.projectKey)).meta.cwd, parent);
});

test('whole-plan diff returns every page with statuses and content', async () => {
  const store = makeStore();
  const cwd = makeDir('apr-diff-');
  await store.recordPlan({ cwd, origin: 'mcp', markdown: TREE_V1 });
  const v2 = await store.recordPlan({ cwd, origin: 'mcp', markdown: TREE_V2 });

  const diff = await store.getDiffPayload(v2.projectKey, 1, 2);
  assert.equal(diff.from.n, 1);
  assert.equal(diff.to.n, 2);

  // New-side order first (root, impl, notes), then base-only docs (risks).
  assert.deepEqual(
    diff.docs.map((d) => [d.slug, d.status]),
    [
      ['root', 'modified'],
      ['impl', 'modified'],
      ['notes', 'added'],
      ['risks', 'removed'],
    ],
  );

  const impl = diff.docs.find((d) => d.slug === 'impl')!;
  assert.equal(impl.title, 'Implementation');
  assert.equal(impl.parent, 'root');
  assert.match(impl.from!, /step one/);
  assert.match(impl.to!, /step two/);

  // Removed pages keep their base title and carry no new content.
  const risks = diff.docs.find((d) => d.slug === 'risks')!;
  assert.equal(risks.title, 'Risks');
  assert.equal(risks.to, '');

  const notes = diff.docs.find((d) => d.slug === 'notes')!;
  assert.equal(notes.from, '');
  assert.match(notes.to!, /brand new page/);
  assert.equal(diff.to.manifest?.docs.length, 3);
});

test('unchanged pages are listed without any source text', async () => {
  const store = makeStore();
  const cwd = makeDir('apr-unchanged-');
  await store.recordPlan({ cwd, origin: 'mcp', markdown: TREE_V1 });
  const v2 = await store.recordPlan({
    cwd,
    origin: 'mcp',
    markdown: TREE_V1.replace('# Plan\n\nroot one', '# Plan\n\nroot two'),
  });

  const diff = await store.getDiffPayload(v2.projectKey, 1, 2);
  const risks = diff.docs.find((d) => d.slug === 'risks')!;
  assert.equal(risks.status, 'unchanged');
  assert.equal(risks.from, undefined);
  assert.equal(risks.to, undefined);
  assert.equal(risks.title, 'Risks');
});

test('a flat plan diffs as a single root page', async () => {
  const store = makeStore();
  const cwd = makeDir('apr-flat-');
  await store.recordPlan({ cwd, origin: 'mcp', markdown: '# Plan\n\nalpha\nbeta' });
  const v2 = await store.recordPlan({ cwd, origin: 'mcp', markdown: '# Plan\n\nalpha\ngamma' });

  const diff = await store.getDiffPayload(v2.projectKey, 1, 2);
  assert.equal(diff.docs.length, 1);
  assert.equal(diff.docs[0].status, 'modified');
  assert.equal(diff.docs[0].slug, 'root');
  assert.equal(diff.docs[0].title, 'Plan');
  assert.equal(diff.from.manifest, undefined);
});

test('moving versions between projects renumbers, carries comments and re-points reviews', async () => {
  const store = makeStore();
  const src = makeDir('apr-src-');
  const dst = makeDir('apr-dst-');

  const a1 = await store.recordPlan({ cwd: src, origin: 'mcp', markdown: TREE_V1 });
  await store.recordPlan({ cwd: src, origin: 'mcp', markdown: TREE_V2 });
  const b1 = await store.recordPlan({ cwd: dst, origin: 'mcp', markdown: '# Host\n\nbase' });
  await store.addComment(a1.projectKey, 1, { body: 'note on src v1', doc: 'impl', line: 3 });

  const res = await store.moveVersions(a1.projectKey, b1.projectKey);
  assert.deepEqual(res.moved, [
    { from: 1, to: 2 },
    { from: 2, to: 3 },
  ]);
  assert.equal(res.sourceRemoved, true);

  const detail = await store.getProjectDetail(b1.projectKey);
  assert.deepEqual(
    detail.versions.map((v) => [v.n, v.kind]),
    [
      [1, 'single'],
      [2, 'tree'],
      [3, 'tree'],
    ],
  );
  assert.equal(detail.meta.currentVersion, 3);
  assert.equal(detail.meta.latestHash, detail.versions[2].hash);

  // Tree docs survived the renumber.
  const impl = await store.getDocPayload(b1.projectKey, 2, 'impl');
  assert.match(impl.markdown, /step one/);

  // Comments travelled; the source has none left.
  const comments = await store.listComments(b1.projectKey, 2);
  assert.equal(comments.length, 1);
  assert.equal(comments[0].body, 'note on src v1');
  assert.deepEqual(await store.listComments(a1.projectKey, 1), []);

  // Pending reviews follow their version so the decision still lands.
  const review = await store.getReview(a1.reviewId);
  assert.equal(review?.projectKey, b1.projectKey);
  assert.equal(review?.version, 2);

  await assert.rejects(() => store.getProjectDetail(a1.projectKey), /Project not found/);
});

test('a partial move keeps the source project alive', async () => {
  const store = makeStore();
  const src = makeDir('apr-psrc-');
  const dst = makeDir('apr-pdst-');
  await store.recordPlan({ cwd: src, origin: 'api', markdown: '# A\n\none' });
  await store.recordPlan({ cwd: src, origin: 'api', markdown: '# A\n\ntwo' });
  const b1 = await store.recordPlan({ cwd: dst, origin: 'api', markdown: '# B\n\nbase' });

  const srcKey = b1.projectKey === src ? '' : (await store.listProjects()).find((p) => p.cwd === src)!.key;
  const res = await store.moveVersions(srcKey, b1.projectKey, [2]);

  assert.deepEqual(res.moved, [{ from: 2, to: 2 }]);
  assert.equal(res.sourceRemoved, false);
  const leftover = await store.getProjectDetail(srcKey);
  assert.deepEqual(leftover.versions.map((v) => v.n), [1]);
  assert.equal(leftover.meta.currentVersion, 1);
  assert.deepEqual((await store.getProjectDetail(b1.projectKey)).versions.map((v) => v.n), [1, 2]);
});

test('moving a project into itself is rejected', async () => {
  const store = makeStore();
  const cwd = makeDir('apr-self-');
  const plan = await store.recordPlan({ cwd, origin: 'api', markdown: '# A\n\none' });
  await assert.rejects(() => store.moveVersions(plan.projectKey, plan.projectKey), /same/);
});

test('review messages hand the agent human comments once, tracking a cursor', async () => {
  const store = makeStore();
  const cwd = makeDir('apr-msg-');
  const rec = await store.recordPlan({ cwd, origin: 'mcp', markdown: '# Plan\n\nbody' });
  const first = await store.addComment(rec.projectKey, rec.version, { body: 'first', doc: 'root', line: 1 });

  const initial = await store.getReviewMessages(rec.reviewId);
  assert.deepEqual(initial.comments.map((c) => c.body), ['first']);
  await store.markAgentCursor(rec.reviewId, initial.cursor);

  // The agent's own reply is conversation, not something to hand back.
  await store.addAgentReply(rec.projectKey, rec.version, first.id, 'answer');
  assert.equal((await store.getReviewMessages(rec.reviewId)).comments.length, 0);

  await store.addComment(rec.projectKey, rec.version, { body: 'second', doc: 'root', line: 2 });
  assert.deepEqual((await store.getReviewMessages(rec.reviewId)).comments.map((c) => c.body), ['second']);
});

test('open threads carry forward to the new version, re-anchored; resolved ones stay behind', async () => {
  const store = makeStore();
  const cwd = makeDir('apr-carry-');
  const v1 = await store.recordPlan({
    cwd,
    origin: 'mcp',
    markdown: '# Plan\n\nalpha\n\nbeta\n\ngamma',
  });
  const root = await store.addComment(v1.projectKey, 1, { body: 'why alpha?', doc: 'root', line: 3, quote: 'alpha' });
  const settled = await store.addComment(v1.projectKey, 1, { body: 'settled', doc: 'root', line: 5 });
  await store.resolveComment(v1.projectKey, 1, settled.id, true);
  await store.addAgentReply(v1.projectKey, 1, root.id, 'because reasons');

  // A line inserted above shifts alpha from line 3 to line 5.
  const v2 = await store.recordPlan({
    cwd,
    origin: 'mcp',
    markdown: '# Plan\n\nintro\n\nalpha\n\nbeta\n\ngamma',
  });
  assert.equal(v2.version, 2);

  const carried = await store.listComments(v2.projectKey, 2);
  const roots = carried.filter((c) => c.parentId == null);
  assert.equal(roots.length, 1, 'only the open thread carries');
  assert.equal(roots[0].body, 'why alpha?');
  assert.equal(roots[0].line, 5, 're-anchored by the diff');
  const replies = carried.filter((c) => c.parentId != null);
  assert.equal(replies.length, 1);
  assert.equal(replies[0].author, 'agent');
  assert.equal(replies[0].line, 5);
});

test('removed-line threads carry forward, re-anchor onto the new side, and stay answerable', async () => {
  const store = makeStore();
  const cwd = makeDir('apr-carry-old-');
  const v1 = await store.recordPlan({
    cwd,
    origin: 'mcp',
    markdown: '# Plan\n\nalpha\n\nbeta\n\ngamma',
  });
  // A question about a line the next version rewrites (an old-side anchor).
  const ask = await store.addComment(v1.projectKey, 1, {
    body: 'why change this line?',
    doc: 'root',
    line: 5,
    side: 'old',
    baseVersion: 1,
    quote: 'beta',
  });

  const v2 = await store.recordPlan({
    cwd,
    origin: 'mcp',
    markdown: '# Plan\n\nalpha\n\nbeta, but different\n\ngamma',
  });

  const carried = await store.listComments(v2.projectKey, 2);
  const roots = carried.filter((c) => c.parentId == null);
  assert.equal(roots.length, 1, 'the removed-line thread travels to the new version');
  assert.equal(roots[0].id, ask.id, 'and keeps its id, so replies resolve');
  assert.equal(roots[0].line, 5, 're-anchored onto the rewritten line itself');
  assert.equal(roots[0].side, undefined, 'no longer framed as a removed-line anchor');
  assert.equal(roots[0].baseVersion, undefined);
  assert.equal(roots[0].quote, 'beta', 'the quoted text still says what was being discussed');

  // The agent can answer it: the reply lands on the version the human is reading.
  const { comment, version } = await store.replyToThread(v2.projectKey, 2, ask.id, 'because reasons');
  assert.equal(version, 2);
  assert.equal(comment.parentId, ask.id);
  assert.equal(comment.line, 5);
  assert.equal((await store.listComments(v2.projectKey, 2)).length, 2);
});

test('replyToThread finds threads that stayed on an older version', async () => {
  const store = makeStore();
  const cwd = makeDir('apr-reply-old-');
  const v1 = await store.recordPlan({ cwd, origin: 'mcp', markdown: '# Plan\n\nalpha\n\nbeta' });
  const root = await store.addComment(v1.projectKey, 1, { body: 'about alpha', doc: 'root', line: 3 });
  await store.resolveComment(v1.projectKey, 1, root.id, true); // resolved => not carried
  const v2 = await store.recordPlan({ cwd, origin: 'mcp', markdown: '# Plan\n\nalpha\n\nbeta\n\ngamma' });
  assert.equal((await store.listComments(v2.projectKey, 2)).length, 0, 'resolved threads stay behind');

  // Answering it must not blow up with "Thread not found".
  const { version } = await store.replyToThread(v2.projectKey, 2, root.id, 'closing the loop');
  assert.equal(version, 1, 'routed to the version that actually owns the thread');
  assert.equal((await store.listComments(v1.projectKey, 1)).length, 2);
});

test('plan images are stored, image:NAME is rewritten, and a dangling ref fails the plan', async () => {
  const store = makeStore();
  const cwd = makeDir('apr-img-plan-');
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from('body'),
  ]);
  const result = await store.recordPlan({
    cwd,
    origin: 'mcp',
    markdown: '# Fixes\n\nbefore:\n\n![before the fix](image:before)\n\nafter:\n\n![after the fix](image:after)',
    images: [
      { name: 'before', dataBase64: png.toString('base64') },
      { name: 'after', dataBase64: png.toString('base64') },
    ],
  });
  const payload = await store.getVersionPayload(result.projectKey, result.version);
  assert.equal(payload.markdown!.includes('image:before'), false, 'refs are rewritten before storage');
  assert.match(payload.markdown!, /!\[before the fix\]\(\/api\/images\/[a-f0-9]{16}\.png\)/);
  // Same bytes => one file, so the two refs share a URL.
  const urls = [...payload.markdown!.matchAll(/\/api\/images\/[a-f0-9]{16}\.png/g)].map((m) => m[0]);
  assert.equal(new Set(urls).size, 1, 'content-addressed: one file for identical bytes');

  await assert.rejects(
    () =>
      store.recordPlan({
        cwd: makeDir('apr-img-plan2-'),
        origin: 'mcp',
        markdown: '# Broken\n\n![nope](image:not-attached)',
      }),
    (err: unknown) => {
      assert.ok(err instanceof PlanValidationError, 'rejected as a plan validation failure');
      assert.match(err.issues[0].message, /not attached/i);
      return true;
    },
  );
});
