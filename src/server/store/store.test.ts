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
  assert.ok(
    !detail.meta.cwd.includes(`packages${path.sep}thing`),
    `cwd should be folded, got ${detail.meta.cwd}`,
  );

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
  assert.deepEqual(
    leftover.versions.map((v) => v.n),
    [1],
  );
  assert.equal(leftover.meta.currentVersion, 1);
  assert.deepEqual(
    (await store.getProjectDetail(b1.projectKey)).versions.map((v) => v.n),
    [1, 2],
  );
});

test('moving a project into itself is rejected', async () => {
  const store = makeStore();
  const cwd = makeDir('apr-self-');
  const plan = await store.recordPlan({ cwd, origin: 'api', markdown: '# A\n\none' });
  await assert.rejects(() => store.moveVersions(plan.projectKey, plan.projectKey), /same/);
});

test('review messages deliver only targeted Ask comments once, tracking a monotonic cursor', async () => {
  const store = makeStore();
  const cwd = makeDir('apr-msg-');
  const rec = await store.recordPlan({ cwd, origin: 'mcp', markdown: '# Plan\n\nbody' });
  await store.comments.create(rec.projectKey, rec.version, { body: 'legacy' }, 'root');
  await store.addComment(rec.projectKey, rec.version, { body: 'batched', doc: 'root', delivery: 'decision' });
  assert.deepEqual((await store.getReviewMessages(rec.reviewId)).comments, []);

  const first = await store.addComment(rec.projectKey, rec.version, {
    body: 'first',
    doc: 'root',
    line: 1,
    delivery: 'ask',
    reviewId: rec.reviewId,
  });
  const initial = await store.getReviewMessages(rec.reviewId);
  assert.deepEqual(
    initial.comments.map((c) => c.body),
    ['first'],
  );
  await store.markAgentCursor(rec.reviewId, initial.cursor);
  await store.markAgentCursor(rec.reviewId, '2020-01-01T00:00:00.000Z');
  assert.equal((await store.getReview(rec.reviewId))?.agentCursor, initial.cursor);

  await store.addAgentReply(rec.projectKey, rec.version, first.id, 'answer');
  assert.equal((await store.getReviewMessages(rec.reviewId)).comments.length, 0);

  const second = await store.addComment(rec.projectKey, rec.version, {
    body: 'second',
    doc: 'root',
    line: 2,
    delivery: 'ask',
    reviewId: rec.reviewId,
  });
  await store.addComment(rec.projectKey, rec.version, {
    body: 'later batch',
    doc: 'root',
    delivery: 'decision',
  });
  const next = await store.getReviewMessages(rec.reviewId);
  assert.deepEqual(
    next.comments.map((c) => c.body),
    ['second'],
  );
  assert.equal(
    next.cursor,
    (await store.listComments(rec.projectKey, rec.version)).find((c) => c.body === 'second')?.createdAt,
  );
  await store.markAgentCursor(rec.reviewId, next.cursor);
  await store.resolveComment(rec.projectKey, rec.version, second.id, true);
  const afterResolve = await store.getReviewMessages(rec.reviewId);
  assert.deepEqual(afterResolve.comments, []);
  assert.equal(afterResolve.cursor, next.cursor);

  const resolved = await store.addComment(rec.projectKey, rec.version, {
    body: 'resolved before delivery',
    doc: 'root',
    delivery: 'ask',
    reviewId: rec.reviewId,
  });
  await store.resolveComment(rec.projectKey, rec.version, resolved.id, true);
  assert.deepEqual((await store.getReviewMessages(rec.reviewId)).comments, []);
});

test('Ask comments require the exact pending MCP review and only that thread can receive agent replies', async () => {
  const store = makeStore();
  const mcp = await store.recordPlan({
    cwd: makeDir('apr-ask-mcp-'),
    origin: 'mcp',
    markdown: '# MCP\n\nbody',
  });
  const api = await store.recordPlan({
    cwd: makeDir('apr-ask-api-'),
    origin: 'api',
    markdown: '# API\n\nbody',
  });

  await assert.rejects(
    () => store.addComment(mcp.projectKey, mcp.version, { body: 'missing target', delivery: 'ask' }),
    /reviewId is required/,
  );
  await assert.rejects(
    () =>
      store.addComment('wrong-project', mcp.version, {
        body: 'wrong project',
        delivery: 'ask',
        reviewId: mcp.reviewId,
      }),
    /does not match/,
  );
  await assert.rejects(
    () =>
      store.addComment(mcp.projectKey, mcp.version + 1, {
        body: 'wrong version',
        delivery: 'ask',
        reviewId: mcp.reviewId,
      }),
    /does not match/,
  );
  await assert.rejects(
    () =>
      store.addComment(api.projectKey, api.version, {
        body: 'wrong origin',
        delivery: 'ask',
        reviewId: api.reviewId,
      }),
    /only available for MCP/,
  );

  const decision = await store.addComment(mcp.projectKey, mcp.version, {
    body: 'wait for decision',
    delivery: 'decision',
  });
  await assert.rejects(() => store.reviewReplyTarget(mcp.reviewId, decision.id), /not an Ask/);
  const reply = await store.addComment(mcp.projectKey, mcp.version, {
    body: 'first-level reply',
    parentId: decision.id,
    delivery: 'decision',
  });
  await assert.rejects(
    () =>
      store.addComment(mcp.projectKey, mcp.version, {
        body: 'nested reply',
        parentId: reply.id,
        delivery: 'decision',
      }),
    /Thread not found/,
  );
  await store.resolveComment(mcp.projectKey, mcp.version, decision.id, true);
  await assert.rejects(
    () =>
      store.addComment(mcp.projectKey, mcp.version, {
        body: 'reply after resolve',
        parentId: decision.id,
        delivery: 'decision',
      }),
    /Reopen the thread/,
  );

  const ask = await store.addComment(mcp.projectKey, mcp.version, {
    body: 'ask now',
    delivery: 'ask',
    reviewId: mcp.reviewId,
  });
  const target = await store.reviewReplyTarget(mcp.reviewId, ask.id);
  assert.equal(target.review.id, mcp.reviewId);
  assert.equal(target.version, mcp.version);

  await store.decideReview(mcp.reviewId, 'approve');
  await assert.rejects(
    () =>
      store.addComment(mcp.projectKey, mcp.version, {
        body: 'too late',
        delivery: 'ask',
        reviewId: mcp.reviewId,
      }),
    /already approved/,
  );
  await assert.rejects(
    () =>
      store.addComment(mcp.projectKey, mcp.version, {
        body: 'late decision note',
        delivery: 'decision',
        reviewId: mcp.reviewId,
      }),
    /already approved/,
  );
  await assert.rejects(() => store.reviewReplyTarget(mcp.reviewId, ask.id), /already approved/);
});

test('an Ask is delivered only to its targeted review when a version has multiple reviews', async () => {
  const store = makeStore();
  const cwd = makeDir('apr-ask-target-');
  const first = await store.recordPlan({ cwd, origin: 'mcp', markdown: '# Same plan\n\nbody' });
  const second = await store.recordPlan({ cwd, origin: 'mcp', markdown: '# Same plan\n\nbody' });
  assert.equal(first.version, second.version);

  await store.addComment(first.projectKey, first.version, {
    body: 'for the second review only',
    delivery: 'ask',
    reviewId: second.reviewId,
  });
  assert.deepEqual((await store.getReviewMessages(first.reviewId)).comments, []);
  assert.deepEqual(
    (await store.getReviewMessages(second.reviewId)).comments.map((comment) => comment.body),
    ['for the second review only'],
  );
});

test('a reject summary joins the decision without waking the conversation', async () => {
  const store = makeStore();
  const cwd = makeDir('apr-summary-');
  const rec = await store.recordPlan({ cwd, origin: 'mcp', markdown: '# Plan\n\nbody' });
  const decision = await store.decideReview(rec.reviewId, 'reject', 'Focus on rollout safety');
  assert.match(decision.review.reason ?? '', /Focus on rollout safety/);
  const summary = (await store.listComments(rec.projectKey, rec.version)).find(
    (c) => c.body === 'Focus on rollout safety',
  );
  assert.equal(summary?.delivery, 'decision');
  assert.equal(summary?.decisionReviewId, rec.reviewId);
  assert.deepEqual((await store.getReviewMessages(rec.reviewId)).comments, []);

  const sameVersion = await store.recordPlan({ cwd, origin: 'mcp', markdown: '# Plan\n\nbody' });
  assert.equal(sameVersion.version, rec.version);
  const approval = await store.decideReview(sameVersion.reviewId, 'approve');
  assert.doesNotMatch(approval.review.notes ?? '', /Focus on rollout safety/);

  const nextVersion = await store.recordPlan({ cwd, origin: 'mcp', markdown: '# Revised\n\nbody' });
  assert.equal(
    (await store.listComments(nextVersion.projectKey, nextVersion.version)).some(
      (comment) => comment.body === 'Focus on rollout safety',
    ),
    false,
  );
});

test('concurrent comment writes preserve every message', async () => {
  const store = makeStore();
  const rec = await store.recordPlan({
    cwd: makeDir('apr-writes-'),
    origin: 'mcp',
    markdown: '# Plan\n\nbody',
  });
  await Promise.all(
    Array.from({ length: 20 }, (_, index) =>
      store.addComment(rec.projectKey, rec.version, { body: `comment-${index}`, delivery: 'decision' }),
    ),
  );
  const bodies = (await store.listComments(rec.projectKey, rec.version)).map((comment) => comment.body);
  assert.equal(bodies.length, 20);
  assert.equal(new Set(bodies).size, 20);
});

test('Ask creation and a simultaneous decision are serialized without losing accepted feedback', async () => {
  const store = makeStore();
  const rec = await store.recordPlan({
    cwd: makeDir('apr-race-'),
    origin: 'mcp',
    markdown: '# Plan\n\nbody',
  });
  const ask = store.addComment(rec.projectKey, rec.version, {
    body: 'race-safe ask',
    delivery: 'ask',
    reviewId: rec.reviewId,
  });
  const decision = store.decideReview(rec.reviewId, 'approve');
  const [askResult, decisionResult] = await Promise.allSettled([ask, decision]);
  assert.equal(decisionResult.status, 'fulfilled');
  const review = await store.getReview(rec.reviewId);
  assert.equal(review?.status, 'approved');
  if (askResult.status === 'fulfilled') {
    assert.match(review?.notes ?? '', /race-safe ask/);
  } else {
    assert.match(String(askResult.reason), /already approved/);
  }
});

test('open threads carry forward to the new version, re-anchored; resolved ones stay behind', async () => {
  const store = makeStore();
  const cwd = makeDir('apr-carry-');
  const v1 = await store.recordPlan({
    cwd,
    origin: 'mcp',
    markdown: '# Plan\n\nalpha\n\nbeta\n\ngamma',
  });
  const root = await store.addComment(v1.projectKey, 1, {
    body: 'why alpha?',
    doc: 'root',
    line: 3,
    quote: 'alpha',
  });
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

test('removed-line threads carry forward, re-anchor, and preserve the original Ask target', async () => {
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
    delivery: 'ask',
    reviewId: v1.reviewId,
  });

  const v2 = await store.recordPlan({
    cwd,
    origin: 'mcp',
    markdown: '# Plan\n\nalpha\n\nbeta, but different\n\ngamma',
  });

  const carried = await store.listComments(v2.projectKey, 2);
  const roots = carried.filter((c) => c.parentId == null);
  assert.equal(roots.length, 1, 'the removed-line thread travels to the new version');
  assert.equal(roots[0].id, ask.id, 'and keeps its thread identity');
  assert.equal(roots[0].line, 5, 're-anchored onto the rewritten line itself');
  assert.equal(roots[0].side, undefined, 'no longer framed as a removed-line anchor');
  assert.equal(roots[0].baseVersion, undefined);
  assert.equal(roots[0].quote, 'beta', 'the quoted text still says what was being discussed');
  assert.equal(roots[0].delivery, 'ask');
  assert.equal(roots[0].wakeReviewId, v1.reviewId, 'the original review can still answer the carried thread');
  const reply = await store.replyToReview(v1.reviewId, ask.id, 'because reasons');
  assert.equal(reply.version, 2);
  assert.equal(reply.comment.parentId, ask.id);
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
    markdown:
      '# Fixes\n\nbefore:\n\n![before the fix](image:before)\n\nafter:\n\n![after the fix](image:after)',
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

// ---------------------------------------------------------------------------
// plan-mode conversation: one review per session, Asks answered across rounds
// ---------------------------------------------------------------------------

test('a hook session reuses its pending review across presentations', async () => {
  const store = makeStore();
  const cwd = makeDir('apr-session-');

  const first = await store.recordPlan({
    cwd,
    origin: 'hook',
    sessionId: 'sess-1',
    toolUseId: 'tu-1',
    markdown: '# Plan\n\nStep one.',
  });
  assert.equal(first.reusedReview, false, 'nothing to reuse on the first call');

  // The agent answers a question by presenting the plan again, unchanged.
  const again = await store.recordPlan({
    cwd,
    origin: 'hook',
    sessionId: 'sess-1',
    toolUseId: 'tu-2',
    markdown: '# Plan\n\nStep one.',
  });
  assert.equal(again.reusedReview, true);
  assert.equal(again.reviewId, first.reviewId, 'same review, so its threads stay live');
  assert.equal(again.version, first.version, 'byte-identical plan reuses the version');
  assert.equal(
    (await store.listReviews({ status: 'pending', projectKey: first.projectKey })).length,
    1,
    'no orphan pending review is left behind',
  );

  // A revised plan makes a new version but STILL the same review, retargeted.
  const revised = await store.recordPlan({
    cwd,
    origin: 'hook',
    sessionId: 'sess-1',
    toolUseId: 'tu-3',
    markdown: '# Plan\n\nStep one, now with backoff.',
  });
  assert.equal(revised.reviewId, first.reviewId);
  assert.equal(revised.version, 2);
  assert.equal((await store.getReview(first.reviewId))?.version, 2, 'review follows the plan');

  // A different session is a different review; MCP submissions never reuse.
  const other = await store.recordPlan({
    cwd,
    origin: 'hook',
    sessionId: 'sess-2',
    markdown: '# Plan\n\nStep one, now with backoff.',
  });
  assert.notEqual(other.reviewId, first.reviewId);
  const mcp = await store.recordPlan({
    cwd,
    origin: 'mcp',
    sessionId: 'sess-1',
    markdown: '# Plan\n\nStep one, now with backoff.',
  });
  assert.notEqual(mcp.reviewId, first.reviewId, 'a second MCP submission is a new review');
});

test('an Ask on a plan-mode review survives a revised plan and is answered once', async () => {
  const store = makeStore();
  const cwd = makeDir('apr-ask-');
  const first = await store.recordPlan({
    cwd,
    origin: 'hook',
    sessionId: 'sess-1',
    toolUseId: 'tu-1',
    markdown: '# Plan\n\nStep one.\n',
  });

  const asked = await store.addComment(first.projectKey, 1, {
    body: 'why exponential backoff here?',
    delivery: 'ask',
    reviewId: first.reviewId,
    doc: 'root',
  });
  assert.equal(asked.wakeReviewId, first.reviewId, 'the Ask targets this review');

  const delivered = await store.getReviewMessages(first.reviewId);
  assert.equal(delivered.comments.length, 1);

  // The agent revises in the light of the question; the thread must follow.
  const revised = await store.recordPlan({
    cwd,
    origin: 'hook',
    sessionId: 'sess-1',
    toolUseId: 'tu-2',
    markdown: '# Plan\n\nStep one, with exponential backoff.\n',
  });
  assert.equal(revised.reviewId, first.reviewId);

  const stillOpen = await store.getReviewMessages(first.reviewId);
  assert.equal(
    stillOpen.comments.length,
    1,
    'the Ask carried onto v2 and is still deliverable on the same review',
  );

  const { comment: reply } = await store.replyToReview(
    first.reviewId,
    asked.id,
    'because retries were hammering the API',
  );
  assert.equal(reply.author, 'agent');
  assert.equal(reply.parentId, asked.id);
  assert.equal(reply.doc, 'root', 'the reply anchors where the thread now lives');

  // Delivering it marks the cursor, so the next round does not re-ask it.
  await store.markAgentCursor(first.reviewId, stillOpen.cursor);
  assert.equal((await store.getReviewMessages(first.reviewId)).comments.length, 0);

  // A second question after the cursor IS delivered.
  const second = await store.addComment(first.projectKey, 2, {
    body: 'and the cap?',
    delivery: 'ask',
    reviewId: first.reviewId,
    doc: 'root',
  });
  const next = await store.getReviewMessages(first.reviewId);
  assert.equal(next.comments.length, 1);
  assert.equal(next.comments[0].id, second.id);
});

test('an Ask needs a consumer: api reviews still may not take one', async () => {
  const store = makeStore();
  const rec = await store.recordPlan({
    cwd: makeDir('apr-api-'),
    origin: 'api',
    markdown: '# Plan\n\nbody\n',
  });
  await assert.rejects(
    () =>
      store.addComment(rec.projectKey, rec.version, {
        body: 'question',
        delivery: 'ask',
        reviewId: rec.reviewId,
        doc: 'root',
      }),
    /Ask is only available for MCP and plan-mode hook reviews/,
  );
  // …but the decision batch still works there. A human decision comment is
  // deliberately NOT stamped with a review id — it belongs to whichever decision
  // happens, not to this one — so it never blocks an Ask from being offered.
  const batch = await store.addComment(rec.projectKey, rec.version, {
    body: 'note',
    delivery: 'decision',
    reviewId: rec.reviewId,
    doc: 'root',
  });
  assert.equal(batch.decisionReviewId, undefined);
  assert.equal(batch.delivery, 'decision');
});

test('a carried thread keeps its word range only while the line anchor and text hold', async () => {
  const store = makeStore();
  const cwd = makeDir('apr-carry-range-');
  const v1Text = '# Plan\n\nalpha one\n\nbeta two\n';
  const v1 = await store.recordPlan({ cwd, origin: 'mcp', markdown: v1Text });
  const offset = (text: string, word: string) => ({
    start: text.indexOf(word),
    end: text.indexOf(word) + word.length,
  });
  const beta = await store.addComment(v1.projectKey, 1, {
    body: 'beta?',
    line: 5,
    lineEnd: 5,
    quote: 'two',
    range: offset(v1Text, 'two'),
  });
  assert.deepEqual(beta.range, offset(v1Text, 'two'), 'range persists on create');

  // Only the tail changes: line 5 and the text at the offsets are untouched.
  await store.recordPlan({ cwd, origin: 'mcp', markdown: '# Plan\n\nalpha one\n\nbeta two\n\ngamma\n' });
  const [kept] = (await store.listComments(v1.projectKey, 2)).filter((c) => c.parentId == null);
  assert.equal(kept.line, 5);
  assert.deepEqual(kept.range, offset(v1Text, 'two'), 'unmoved anchor keeps its range');

  // A line inserted above moves the anchor: the range is dropped, the quote stays.
  await store.recordPlan({
    cwd,
    origin: 'mcp',
    markdown: '# Plan\n\nintro\n\nalpha one\n\nbeta two\n\ngamma\n',
  });
  const [moved] = (await store.listComments(v1.projectKey, 3)).filter((c) => c.parentId == null);
  assert.equal(moved.line, 7);
  assert.equal(moved.range, undefined, 'moved anchor drops its range');
  assert.equal(moved.quote, 'two');
});

test('a reused hook review records and updates its agent terminal', async () => {
  const store = makeStore();
  const cwd = makeDir('apr-session-agent-');
  const first = await store.recordPlan({
    cwd,
    origin: 'hook',
    sessionId: 'sess-a',
    markdown: '# Plan\n\nStep.',
    agent: { terminal: 't1', harness: 'claude-code' },
  });
  assert.deepEqual((await store.getReview(first.reviewId))?.agent, { terminal: 't1', harness: 'claude-code' });

  // Same plan, same session, now from another terminal: same review, new link.
  const again = await store.recordPlan({
    cwd,
    origin: 'hook',
    sessionId: 'sess-a',
    markdown: '# Plan\n\nStep.',
    agent: { terminal: 't2', harness: 'claude-code' },
  });
  assert.equal(again.reviewId, first.reviewId);
  assert.deepEqual((await store.getReview(first.reviewId))?.agent, { terminal: 't2', harness: 'claude-code' });

  // A revision without a known terminal keeps the existing link.
  await store.recordPlan({ cwd, origin: 'hook', sessionId: 'sess-a', markdown: '# Plan\n\nStep two.' });
  const review = await store.getReview(first.reviewId);
  assert.equal(review?.version, 2);
  assert.deepEqual(review?.agent, { terminal: 't2', harness: 'claude-code' });
});
