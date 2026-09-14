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
