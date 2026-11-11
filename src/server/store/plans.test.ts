/**
 * Plans: several agents in one worktree each keep their own plan project, so
 * versions, content-hash dedup and carried threads never cross agents. Every
 * test runs against a temp store home; nothing touches ~/.agent-plan-review.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PlanReviewStore } from './store.js';
import { PlanSelectionError, PlanValidationError } from '../util/errors.js';
import { parsePlanProjectKey, sanitizeProjectKey } from '../../shared/keys.js';
import { NEW_PLAN_TARGET } from '../../shared/types.js';
import type { RecordInput } from './record.js';

function makeStore(): PlanReviewStore {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'apr-plans-'));
  return new PlanReviewStore({ home, port: 4999 });
}

const makeDir = (prefix: string): string => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));

const submit = (store: PlanReviewStore, cwd: string, markdown: string, extra: Partial<RecordInput> = {}) =>
  store.recordPlan({ cwd, origin: 'mcp', markdown, ...extra });

test('two agents in one worktree get two plans, each at v1; the worktree key stays untouched', async () => {
  const store = makeStore();
  const cwd = makeDir('apr-plans-two-');
  const a = await submit(store, cwd, '# Plan A\n\nalpha', { agentId: 'claude:a' });
  const b = await submit(store, cwd, '# Plan B\n\nbeta', { agentId: 'claude:b' });

  assert.notEqual(a.projectKey, b.projectKey);
  assert.equal(a.version, 1);
  assert.equal(b.version, 1);
  const worktreeKey = sanitizeProjectKey(cwd);
  assert.equal(parsePlanProjectKey(a.projectKey)?.worktreeKey, worktreeKey);
  assert.equal(parsePlanProjectKey(b.projectKey)?.worktreeKey, worktreeKey);
  assert.equal(await store.projects.get(worktreeKey), null);

  const metaA = await store.projects.get(a.projectKey);
  assert.equal(metaA?.cwd, cwd);
  assert.equal(metaA?.name, path.basename(cwd));
  assert.equal(metaA?.plan?.title, 'Plan A');
  assert.deepEqual(metaA?.agents, ['claude:a']);
  assert.equal((await store.getReview(a.reviewId))?.agentId, 'claude:a');
  assert.equal((await store.projects.listByWorktree(cwd)).length, 2);
});

test('a revision lands on the agent\'s own plan and carries only its own open threads', async () => {
  const store = makeStore();
  const cwd = makeDir('apr-plans-carry-');
  const a1 = await submit(store, cwd, '# A\n\nalpha', { agentId: 'claude:a' });
  const b1 = await submit(store, cwd, '# B\n\nbeta', { agentId: 'claude:b' });
  await store.addComment(a1.projectKey, 1, { body: 'question for A', doc: 'root', line: 3 });
  await store.addComment(b1.projectKey, 1, { body: 'question for B', doc: 'root', line: 3 });

  const a2 = await submit(store, cwd, '# A\n\nalpha revised', { agentId: 'claude:a' });
  assert.equal(a2.projectKey, a1.projectKey);
  assert.equal(a2.version, 2);
  const bodies = (await store.listComments(a2.projectKey, 2)).map((c) => c.body);
  assert.deepEqual(bodies, ['question for A']);
  // B's plan did not move.
  assert.equal((await store.projects.get(b1.projectKey))?.currentVersion, 1);
});

test('the same agent submitting twice makes v2 of one plan; the title follows the newest root', async () => {
  const store = makeStore();
  const cwd = makeDir('apr-plans-title-');
  const v1 = await submit(store, cwd, '# First title\n\none', { agentId: 'claude:a' });
  const v2 = await submit(store, cwd, '# Second title\n\ntwo', { agentId: 'claude:a' });
  assert.equal(v2.projectKey, v1.projectKey);
  assert.equal(v2.version, 2);
  const meta = await store.projects.get(v1.projectKey);
  assert.equal(meta?.plan?.title, 'Second title');
  assert.deepEqual(meta?.agents, ['claude:a']);

  // A tree plan's title is its root page title.
  await submit(store, cwd, '# Tree root\n\nr\n\n<!--doc slug=impl title="Impl" parent=root-->\n\ni', {
    agentId: 'claude:a',
  });
  assert.equal((await store.projects.get(v1.projectKey))?.plan?.title, 'Tree root');
});

test('planId writes to that plan and adds the agent to it; plan id and full key both work', async () => {
  const store = makeStore();
  const cwd = makeDir('apr-plans-id-');
  const a = await submit(store, cwd, '# A\n\none', { agentId: 'claude:a' });
  const meta = await store.projects.get(a.projectKey);
  const id = meta!.plan!.id;
  assert.match(id, /^p-[0-9a-f]{6}$/);

  const byId = await submit(store, cwd, '# A\n\ntwo', { agentId: 'claude:b', planId: id });
  assert.equal(byId.projectKey, a.projectKey);
  assert.equal(byId.version, 2);
  assert.deepEqual((await store.projects.get(a.projectKey))?.agents, ['claude:a', 'claude:b']);

  // Full key, and the agent that joined moves to the end on its next write.
  const byKey = await submit(store, cwd, '# A\n\nthree', { agentId: 'claude:a', planId: a.projectKey });
  assert.equal(byKey.version, 3);
  assert.deepEqual((await store.projects.get(a.projectKey))?.agents, ['claude:b', 'claude:a']);

  // The bare hex works too.
  const bare = await submit(store, cwd, '# A\n\nfour', { planId: id.slice(2) });
  assert.equal(bare.projectKey, a.projectKey);
});

test('a planId from another worktree fails and lists this worktree\'s plans', async () => {
  const store = makeStore();
  const here = makeDir('apr-plans-here-');
  const there = makeDir('apr-plans-there-');
  const mine = await submit(store, here, '# Mine\n\nm', { agentId: 'claude:a' });
  const theirs = await submit(store, there, '# Theirs\n\nt', { agentId: 'claude:x' });
  const mineId = (await store.projects.get(mine.projectKey))!.plan!.id;

  await assert.rejects(
    submit(store, here, '# Mine\n\nm2', { agentId: 'claude:a', planId: theirs.projectKey }),
    (err: unknown) => {
      assert.ok(err instanceof PlanSelectionError);
      assert.ok(err instanceof PlanValidationError, 'integrations report it like a validation error');
      assert.match(err.message, /belongs to another worktree/);
      assert.match(err.message, new RegExp(`${mineId} "Mine", v1`));
      assert.doesNotMatch(err.message, /Theirs/);
      return true;
    },
  );
  // Nothing was recorded anywhere.
  assert.equal((await store.projects.get(theirs.projectKey))?.currentVersion, 1);
  assert.equal((await store.projects.get(mine.projectKey))?.currentVersion, 1);
});

test('an unknown planId fails with a clear error', async () => {
  const store = makeStore();
  const cwd = makeDir('apr-plans-unknown-');
  await assert.rejects(submit(store, cwd, '# X\n\nx', { planId: 'p-000000' }), (err: unknown) => {
    assert.ok(err instanceof PlanSelectionError);
    assert.match(err.message, /Unknown plan "p-000000"/);
    assert.match(err.message, /no plans yet/);
    return true;
  });
  await assert.rejects(submit(store, cwd, '# X\n\nx', { planId: 'nonsense' }), /not a plan id/);
});

test('newPlan starts a fresh plan even when the agent already has one', async () => {
  const store = makeStore();
  const cwd = makeDir('apr-plans-new-');
  const first = await submit(store, cwd, '# One\n\n1', { agentId: 'claude:a' });
  const second = await submit(store, cwd, '# Two\n\n2', { agentId: 'claude:a', newPlan: true });
  assert.notEqual(second.projectKey, first.projectKey);
  assert.equal(second.version, 1);
  // The agent's next plain submit continues its newest plan.
  const next = await submit(store, cwd, '# Two\n\n2b', { agentId: 'claude:a' });
  assert.equal(next.projectKey, second.projectKey);
  assert.equal(next.version, 2);
});

test('without an agent id the worktree key is used, exactly as before plans', async () => {
  const store = makeStore();
  const cwd = makeDir('apr-plans-legacy-');
  const v1 = await submit(store, cwd, '# L\n\none');
  const v2 = await submit(store, cwd, '# L\n\ntwo');
  assert.equal(v1.projectKey, sanitizeProjectKey(cwd));
  assert.equal(v2.projectKey, v1.projectKey);
  assert.equal(v2.version, 2);
  const meta = await store.projects.get(v1.projectKey);
  assert.equal(meta?.plan, undefined);
  assert.equal(meta?.agents, undefined);

  // An agent with an id is not auto-continued into the legacy project.
  const agent = await submit(store, cwd, '# L\n\nthree', { agentId: 'claude:a' });
  assert.notEqual(agent.projectKey, v1.projectKey);
});

test('a hook session with a pending legacy review stays in the legacy project', async () => {
  const store = makeStore();
  const cwd = makeDir('apr-plans-upgrade-');
  // Recorded before plans existed: no agent id.
  const old = await store.recordPlan({ cwd, origin: 'hook', sessionId: 's1', markdown: '# L\n\none' });
  const legacyKey = sanitizeProjectKey(cwd);
  assert.equal(old.projectKey, legacyKey);

  const again = await store.recordPlan({
    cwd,
    origin: 'hook',
    sessionId: 's1',
    agentId: 'claude:s1',
    markdown: '# L\n\ntwo',
  });
  assert.equal(again.projectKey, legacyKey);
  assert.equal(again.version, 2);
  assert.equal(again.reusedReview, true, 'the same review follows the session');
  assert.deepEqual((await store.projects.get(legacyKey))?.agents, ['claude:s1']);

  // Another session in the same worktree gets its own plan.
  const other = await store.recordPlan({
    cwd,
    origin: 'hook',
    sessionId: 's2',
    agentId: 'claude:s2',
    markdown: '# Other\n\nx',
  });
  assert.notEqual(other.projectKey, legacyKey);
});

test('end to end: two agents, a human comment on each, A revises → A sees only its own thread', async () => {
  const store = makeStore();
  const cwd = makeDir('apr-plans-e2e-');
  const a1 = await submit(store, cwd, '# Plan A\n\nstep one\n\nstep two', { agentId: 'claude:a' });
  const b1 = await submit(store, cwd, '# Plan B\n\nother work', { agentId: 'term:t1:pi' });
  assert.notEqual(a1.projectKey, b1.projectKey);

  const onA = await store.addComment(a1.projectKey, a1.version, {
    body: 'why step one?',
    doc: 'root',
    line: 3,
    quote: 'step one',
    reviewId: a1.reviewId,
  });
  const onB = await store.addComment(b1.projectKey, b1.version, {
    body: 'what other work?',
    doc: 'root',
    line: 3,
    reviewId: b1.reviewId,
  });
  await store.decideReview(a1.reviewId, 'reject');
  await store.decideReview(b1.reviewId, 'reject');

  // B re-presenting identical content dedups onto its own v1, not A's.
  const b1again = await submit(store, cwd, '# Plan B\n\nother work', { agentId: 'term:t1:pi' });
  assert.equal(b1again.projectKey, b1.projectKey);
  assert.equal(b1again.deduped, true);

  const a2 = await submit(store, cwd, '# Plan A\n\nintro\n\nstep one\n\nstep two', { agentId: 'claude:a' });
  assert.equal(a2.projectKey, a1.projectKey);
  assert.equal(a2.version, 2);
  const threads = (await store.listComments(a2.projectKey, 2)).filter((c) => c.parentId == null);
  assert.deepEqual(
    threads.map((c) => [c.id, c.body]),
    [[onA.id, 'why step one?']],
  );
  assert.ok(!threads.some((c) => c.id === onB.id));
  const listed = (await store.listProjects()).filter((p) => p.cwd === cwd);
  assert.equal(listed.length, 2);
});

test('a subfolder submit folds onto the worktree root, which many plans share', async () => {
  const store = makeStore();
  const cwd = makeDir('apr-plans-fold-');
  const sub = path.join(cwd, 'pkg', 'inner');
  fs.mkdirSync(sub, { recursive: true });
  const a = await submit(store, cwd, '# A\n\na', { agentId: 'claude:a' });
  await submit(store, cwd, '# B\n\nb', { agentId: 'claude:b' });
  // Not a git repo: folding falls back to the registered cwds (one, de-duplicated).
  const a2 = await submit(store, sub, '# A\n\na2', { agentId: 'claude:a' });
  assert.equal(a2.projectKey, a.projectKey);
  assert.equal(a2.version, 2);
  assert.equal((await store.getReview(a2.reviewId))?.cwd, cwd);
});

test('a hook that fires twice for one ExitPlanMode call lands on ONE new plan', async () => {
  const store = makeStore();
  const cwd = makeDir('apr-plans-double-');
  const fire = () =>
    store.recordPlan({
      cwd,
      origin: 'hook',
      markdown: '# Plan\n\nbody',
      agentId: 'claude:s1',
      sessionId: 's1',
      toolUseId: 'toolu_same',
    });
  const [x, y] = await Promise.all([fire(), fire()]);
  assert.equal(x.projectKey, y.projectKey);
  assert.equal((await store.projects.listByWorktree(cwd)).length, 1);
  assert.equal([x.isLoser, y.isLoser].filter(Boolean).length, 1);
});

test('moving versions to "new-plan" splits a mixed worktree project into a plan of the same worktree', async () => {
  const store = makeStore();
  const cwd = makeDir('apr-plans-split-');
  const legacyKey = sanitizeProjectKey(cwd);
  // The old worktree plan: A's plan at v1 and v3, agent B's plan joined it at v2 (by key).
  await submit(store, cwd, '# Plan A\n\nalpha');
  const b = await submit(store, cwd, '# Plan B\n\nbeta', { planId: legacyKey, agentId: 'claude:b', agent: { terminal: 'tB' } });
  await submit(store, cwd, '# Plan A\n\nalpha two');
  assert.equal(b.projectKey, legacyKey);
  await store.addComment(legacyKey, 2, { body: 'about B', doc: 'root', line: 3 });

  const res = await store.moveVersions(legacyKey, NEW_PLAN_TARGET, [2]);
  const created = parsePlanProjectKey(res.to);
  assert.ok(created, 'a plan key');
  assert.equal(created.worktreeKey, legacyKey);
  assert.deepEqual(res.moved, [{ from: 2, to: 1 }]);
  assert.equal(res.sourceRemoved, false);

  const meta = await store.projects.get(res.to);
  assert.equal(meta?.cwd, cwd);
  assert.equal(meta?.plan?.id, created.planId);
  assert.equal(meta?.plan?.title, 'Plan B');
  assert.deepEqual(meta?.agents, ['claude:b']);
  assert.equal(meta?.currentVersion, 1);
  assert.equal((await store.getReview(b.reviewId))?.projectKey, res.to);
  assert.equal((await store.listComments(res.to, 1)).length, 1);
  assert.deepEqual(
    (await store.getProjectDetail(legacyKey)).versions.map((v) => v.n),
    [1, 3],
    'the source keeps its other versions',
  );

  // The worktree now has the legacy project and the new plan.
  assert.equal((await store.listProjects(cwd)).length, 2);
  assert.deepEqual((await store.projects.get(legacyKey))?.agents, [], 'the source no longer claims B');
  // B's next submission continues the new plan.
  const b2 = await submit(store, cwd, '# Plan B\n\nbeta revised', { agentId: 'claude:b' });
  assert.equal(b2.projectKey, res.to);
  assert.equal(b2.version, 2);
});

test('moving to "new-plan" without versions moves everything; an empty selection creates nothing', async () => {
  const store = makeStore();
  const cwd = makeDir('apr-plans-split2-');
  await submit(store, cwd, '# Old\n\none');
  await assert.rejects(() => store.moveVersions(sanitizeProjectKey(cwd), NEW_PLAN_TARGET, [9]), /No versions/);
  assert.equal((await store.projects.listByWorktree(cwd)).length, 1);

  const res = await store.moveVersions(sanitizeProjectKey(cwd), NEW_PLAN_TARGET);
  assert.equal(res.sourceRemoved, true);
  const [only] = await store.projects.listByWorktree(cwd);
  assert.equal(only.key, res.to);
  assert.equal(only.plan?.title, 'Old');
});

test('listProjects: ?cwd narrows to one worktree; lastTerminal is the newest review with a terminal', async () => {
  const store = makeStore();
  const cwd = makeDir('apr-plans-list-');
  const other = makeDir('apr-plans-list-other-');
  const a = await submit(store, cwd, '# A\n\na', { agentId: 'claude:a', agent: { terminal: 't1' } });
  await new Promise((r) => setTimeout(r, 5));
  await submit(store, cwd, '# A\n\na2', { agentId: 'claude:a', agent: { terminal: 't2' } });
  await new Promise((r) => setTimeout(r, 5));
  const b = await submit(store, cwd, '# B\n\nb', { agentId: 'claude:b' });
  await submit(store, other, '# Elsewhere\n\nx', { agentId: 'claude:c' });

  const all = await store.listProjects();
  assert.equal(all.length, 3);
  const inWorktree = await store.listProjects(cwd);
  assert.deepEqual(inWorktree.map((p) => p.key).sort(), [a.projectKey, b.projectKey].sort());
  const sa = inWorktree.find((p) => p.key === a.projectKey)!;
  assert.equal(sa.lastTerminal, 't2');
  assert.equal(sa.pending, 2);
  assert.equal(sa.versionCount, 2);
  assert.equal(inWorktree.find((p) => p.key === b.projectKey)!.lastTerminal, undefined);
});
