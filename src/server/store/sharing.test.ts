/**
 * Sharing plans between agents of one worktree: list, read (get) and join.
 * Every test runs against a temp store home; nothing touches ~/.agent-plan-review.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PlanReviewStore } from './store.js';
import { PlanSelectionError } from '../util/errors.js';
import { sanitizeProjectKey } from '../../shared/keys.js';
import type { RecordInput } from './record.js';

function makeStore(): PlanReviewStore {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'apr-share-'));
  return new PlanReviewStore({ home, port: 4999 });
}

const makeDir = (prefix: string): string => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));

const submit = (store: PlanReviewStore, cwd: string, markdown: string, extra: Partial<RecordInput> = {}) =>
  store.recordPlan({ cwd, origin: 'mcp', markdown, ...extra });

const planIdOf = async (store: PlanReviewStore, key: string): Promise<string> =>
  (await store.projects.get(key))!.plan!.id;

test('join then a submit without planId lands in the joined plan, although the agent has a newer own plan', async () => {
  const store = makeStore();
  const cwd = makeDir('apr-share-join-');
  const x = await submit(store, cwd, '# X\n\nfrom A', { agentId: 'claude:a' });
  const own = await submit(store, cwd, '# Mine\n\nfrom B', { agentId: 'claude:b' });
  const xMetaBefore = await store.projects.get(x.projectKey);

  await store.joinPlan(cwd, await planIdOf(store, x.projectKey), 'claude:b');

  // Join changes participation only: no version, no updatedAt bump.
  const xMeta = await store.projects.get(x.projectKey);
  assert.deepEqual(xMeta?.agents, ['claude:a', 'claude:b']);
  assert.equal(xMeta?.currentVersion, 1);
  assert.equal(xMeta?.updatedAt, xMetaBefore?.updatedAt);
  assert.equal((await store.projects.get(own.projectKey))?.currentVersion, 1);

  const next = await submit(store, cwd, '# X\n\nrevised by B', { agentId: 'claude:b' });
  assert.equal(next.projectKey, x.projectKey);
  assert.equal(next.version, 2);

  // An explicit write to another plan (planId) makes that one the newest again.
  await submit(store, cwd, '# Mine\n\nB again, by id', {
    agentId: 'claude:b',
    planId: await planIdOf(store, own.projectKey),
  });
  const again = await submit(store, cwd, '# X\n\nthird', { agentId: 'claude:b' });
  assert.equal(again.projectKey, own.projectKey);
});

test('join then a hook-origin submit with the same agent id lands in the joined plan', async () => {
  const store = makeStore();
  const cwd = makeDir('apr-share-hook-');
  const x = await submit(store, cwd, '# X\n\nfrom A', { agentId: 'claude:a' });
  const own = await submit(store, cwd, '# Mine\n\nfrom B', { agentId: 'claude:b' });
  assert.notEqual(x.projectKey, own.projectKey);

  await store.joinPlan(cwd, await planIdOf(store, x.projectKey), 'claude:b');
  const viaHook = await store.recordPlan({
    cwd,
    origin: 'hook',
    sessionId: 'b',
    agentId: 'claude:b',
    toolUseId: 'tool-1',
    markdown: '# X\n\nExitPlanMode from B',
  });
  assert.equal(viaHook.projectKey, x.projectKey);
  assert.equal(viaHook.version, 2);
  assert.equal((await store.projects.get(own.projectKey))?.currentVersion, 1);
});

test('join outranks a pending legacy hook review of the same session', async () => {
  const store = makeStore();
  const cwd = makeDir('apr-share-legacy-');
  const legacy = await store.recordPlan({ cwd, origin: 'hook', sessionId: 's1', markdown: '# L\n\none' });
  assert.equal(legacy.projectKey, sanitizeProjectKey(cwd));
  const other = await submit(store, cwd, '# Other\n\nx', { agentId: 'claude:o' });

  await store.joinPlan(cwd, await planIdOf(store, other.projectKey), 'claude:s1');
  const next = await store.recordPlan({
    cwd,
    origin: 'hook',
    sessionId: 's1',
    agentId: 'claude:s1',
    markdown: '# Other\n\ny',
  });
  assert.equal(next.projectKey, other.projectKey);
});

test('another agent updating a plan I own does not pull me back after I joined elsewhere', async () => {
  const store = makeStore();
  const cwd = makeDir('apr-share-pull-');
  const mine = await submit(store, cwd, '# Mine\n\none', { agentId: 'claude:b' });
  const x = await submit(store, cwd, '# X\n\none', { agentId: 'claude:a' });
  await store.joinPlan(cwd, await planIdOf(store, mine.projectKey), 'claude:c');
  await store.joinPlan(cwd, await planIdOf(store, x.projectKey), 'claude:b');

  // C (also on `mine`) writes it later: B's updatedAt for `mine` is now newer than the join.
  await submit(store, cwd, '# Mine\n\ntwo', { agentId: 'claude:c' });
  const next = await submit(store, cwd, '# X\n\ntwo', { agentId: 'claude:b' });
  assert.equal(next.projectKey, x.projectKey);
});

test('join accepts the full key of a legacy worktree plan and rejects foreign or unknown plans', async () => {
  const store = makeStore();
  const cwd = makeDir('apr-share-keys-');
  const other = makeDir('apr-share-keys-other-');
  const legacy = await store.recordPlan({ cwd, origin: 'mcp', markdown: '# Legacy\n\nold' });
  const foreign = await submit(store, other, '# Foreign\n\nx', { agentId: 'claude:z' });

  const meta = await store.joinPlan(cwd, legacy.projectKey, 'claude:a');
  assert.equal(meta.key, legacy.projectKey);
  const next = await submit(store, cwd, '# Legacy\n\nnew', { agentId: 'claude:a' });
  assert.equal(next.projectKey, legacy.projectKey);

  await assert.rejects(store.joinPlan(cwd, foreign.projectKey, 'claude:a'), PlanSelectionError);
  await assert.rejects(store.joinPlan(cwd, 'p-abcdef', 'claude:a'), /Unknown plan/);
  assert.equal((await store.projects.get(foreign.projectKey))?.agents?.includes('claude:a'), false);
});

test('listPlans: newest first, mine, status of the newest review on the current version, legacy flagged', async () => {
  const store = makeStore();
  const cwd = makeDir('apr-share-list-');
  const legacy = await store.recordPlan({ cwd, origin: 'mcp', markdown: '# Old shared\n\nold' });
  const a = await submit(store, cwd, '# Plan A\n\nalpha', {
    agentId: 'claude:a',
    agent: { terminal: 'term-a', harness: 'claude-code' },
  });
  const b = await submit(store, cwd, '# Plan B\n\nbeta', { agentId: 'claude:b' });
  await store.decideReview(a.reviewId, 'approve');
  await store.decideReview(b.reviewId, 'reject');
  const b2 = await submit(store, cwd, '# Plan B2\n\nbeta two', { agentId: 'claude:b' });
  const c = await submit(store, cwd, '# Plan C\n\ngamma', { agentId: 'claude:c' });
  assert.ok(b2.version === 2 && c.version === 1);

  const asA = await store.listPlans(cwd, 'claude:a');
  assert.deepEqual(
    asA.map((p) => p.title),
    ['Plan C', 'Plan B2', 'Plan A', 'Old shared'],
  );
  const byTitle = Object.fromEntries(asA.map((p) => [p.title, p]));
  assert.equal(byTitle['Plan A'].mine, true);
  assert.equal(byTitle['Plan C'].mine, false);
  assert.equal(byTitle['Plan A'].status, 'approved');
  assert.equal(byTitle['Plan A'].lastAgentTerminal, 'term-a');
  assert.equal(byTitle['Plan B2'].status, 'pending', 'B2 is a new version with its own pending review');
  assert.equal(byTitle['Plan B2'].currentVersion, 2);
  assert.equal(byTitle['Plan C'].lastAgentTerminal, undefined);
  assert.match(byTitle['Plan A'].planId, /^p-[0-9a-f]{6}$/);
  assert.equal(byTitle['Old shared'].worktreePlan, true);
  assert.equal(byTitle['Old shared'].planId, legacy.projectKey);
  assert.equal(byTitle['Old shared'].mine, false);

  // `mine` follows the asker, and a plan nobody reviewed yet reports none.
  assert.equal((await store.listPlans(cwd, 'claude:c')).find((p) => p.title === 'Plan C')?.mine, true);
  const reviewFile = path.join(store.config.home, 'reviews', `${c.reviewId}.json`);
  fs.rmSync(reviewFile);
  assert.equal((await store.listPlans(cwd, 'claude:c')).find((p) => p.title === 'Plan C')?.status, 'none');

  // Another worktree's plans are not listed.
  assert.deepEqual(await store.listPlans(makeDir('apr-share-list-empty-'), 'claude:a'), []);
});

test('getPlan: markdown, only open threads with replies, version choice, and no change to agents', async () => {
  const store = makeStore();
  const cwd = makeDir('apr-share-get-');
  const a1 = await submit(store, cwd, '# Plan A\n\nline one\nline two', { agentId: 'claude:a' });
  const open = await store.addComment(a1.projectKey, 1, { body: 'open question', doc: 'root', line: 3 });
  const closed = await store.addComment(a1.projectKey, 1, { body: 'closed question', doc: 'root', line: 4 });
  await store.addAgentReply(a1.projectKey, 1, open.id, 'an answer');
  await store.resolveComment(a1.projectKey, 1, closed.id, true);
  const metaBefore = JSON.stringify(await store.projects.get(a1.projectKey));
  const planId = await planIdOf(store, a1.projectKey);

  const got = await store.getPlan(cwd, planId);
  assert.equal(got.planId, planId);
  assert.equal(got.title, 'Plan A');
  assert.equal(got.version, 1);
  assert.equal(got.markdown, '# Plan A\n\nline one\nline two');
  assert.equal(got.openThreads.length, 1);
  assert.equal(got.openThreads[0].threadId, open.id);
  assert.equal(got.openThreads[0].body, 'open question');
  assert.equal(got.openThreads[0].line, 3);
  assert.equal(got.openThreads[0].doc, 'root');
  assert.equal(got.openThreads[0].author, 'me');
  assert.deepEqual(got.openThreads[0].replies, [{ author: 'agent', body: 'an answer' }]);
  assert.equal(JSON.stringify(await store.projects.get(a1.projectKey)), metaBefore, 'get changes nothing');

  // A later version: default is the current one, an older one can be asked for; the thread carried forward.
  await submit(store, cwd, '# Plan A\n\nline one\nline two\nline three', { agentId: 'claude:a' });
  assert.match((await store.getPlan(cwd, planId)).markdown, /line three/);
  assert.doesNotMatch((await store.getPlan(cwd, planId, 1)).markdown, /line three/);
  assert.equal((await store.getPlan(cwd, planId.slice(2))).version, 2, 'bare hex works');
  await assert.rejects(store.getPlan(cwd, planId, 9), /not found/);
});

test('getPlan of a tree returns pages with markers that validate when re-submitted', async () => {
  const store = makeStore();
  const cwd = makeDir('apr-share-tree-');
  const src =
    '# Root plan\n\nintro\n\n<!--doc slug=impl title="Implementation" parent=root-->\nimpl body\n\n' +
    '<!--doc slug=risks title="Risks" parent=impl-->\nrisk body\n';
  const t = await submit(store, cwd, src, { agentId: 'claude:a' });
  const planId = await planIdOf(store, t.projectKey);

  const got = await store.getPlan(cwd, planId);
  assert.match(got.markdown, /<!--doc slug=impl title="Implementation" parent=root-->/);
  assert.match(got.markdown, /<!--doc slug=risks title="Risks" parent=impl-->/);
  assert.ok(got.markdown.startsWith('# Root plan'));

  // Round trip: identical content hashes to a deduped re-presentation.
  const again = await submit(store, cwd, got.markdown, { agentId: 'claude:a' });
  assert.equal(again.deduped, true);
  assert.equal(again.projectKey, t.projectKey);
});

test('getPlan of a legacy worktree plan works by full key and takes its title from the plan', async () => {
  const store = makeStore();
  const cwd = makeDir('apr-share-legacyget-');
  const legacy = await store.recordPlan({ cwd, origin: 'mcp', markdown: '# Legacy title\n\nbody' });
  const got = await store.getPlan(cwd, legacy.projectKey);
  assert.equal(got.worktreePlan, true);
  assert.equal(got.planId, legacy.projectKey);
  assert.equal(got.title, 'Legacy title');
});

test('getPlan with an unknown or foreign plan id fails with the worktree plan list', async () => {
  const store = makeStore();
  const cwd = makeDir('apr-share-getbad-');
  const other = makeDir('apr-share-getbad-other-');
  await submit(store, cwd, '# Mine\n\nx', { agentId: 'claude:a' });
  const foreign = await submit(store, other, '# Foreign\n\nx', { agentId: 'claude:z' });

  await assert.rejects(store.getPlan(cwd, 'p-abcdef'), (err: Error) => {
    assert.ok(err instanceof PlanSelectionError);
    assert.match(err.message, /Unknown plan "p-abcdef"/);
    assert.match(err.message, /Plans in this worktree:/);
    return true;
  });
  await assert.rejects(store.getPlan(cwd, foreign.projectKey), /belongs to another worktree/);
});
