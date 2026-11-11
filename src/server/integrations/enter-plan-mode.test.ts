/**
 * EnterPlanMode hook: the multi-document guidance stays, and an agent that
 * enters plan mode in a worktree that already holds other agents' plans gets a
 * short list of them. Runs against temp store homes only.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PlanReviewStore } from '../store/store.js';
import { sanitizeProjectKey } from '../../shared/keys.js';
import { worktreePlansHint } from './enter-plan-mode.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

function makeStore(): PlanReviewStore {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'apr-epm-'));
  return new PlanReviewStore({ home, port: 4999 });
}

const makeDir = (): string => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'apr-epm-proj-')));
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 5));

async function submit(
  store: PlanReviewStore,
  cwd: string,
  title: string,
  agentId?: string,
): Promise<{ reviewId: string; projectKey: string }> {
  await tick();
  return store.recordPlan({ cwd, origin: 'mcp', markdown: `# ${title}\n\nbody`, agentId });
}

function setStatus(store: PlanReviewStore, reviewId: string, status: 'approved' | 'rejected'): void {
  const file = path.join(store.config.home, 'reviews', `${reviewId}.json`);
  const review = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
  fs.writeFileSync(file, JSON.stringify({ ...review, status }));
}

function runHook(home: string, input: Record<string, unknown>): string {
  const out = execFileSync(
    process.execPath,
    ['--import', 'tsx', path.join(REPO_ROOT, 'src', 'server', 'cli.ts'), 'enter-plan-mode'],
    {
      input: JSON.stringify(input),
      encoding: 'utf8',
      cwd: REPO_ROOT,
      env: { ...process.env, AGENT_PLAN_REVIEW_HOME: home, CLAUDE_CODE_SESSION_ID: '', HC_TERMINAL_ID: '' },
    },
  );
  const parsed = JSON.parse(out.trim() || '{}') as { hookSpecificOutput?: { additionalContext?: string } };
  return parsed.hookSpecificOutput?.additionalContext ?? '';
}

test('lists other agents\' plans with version, status and date; excludes the agent\'s own and shows its line', async () => {
  const store = makeStore();
  const cwd = makeDir();
  const a = await submit(store, cwd, 'Plan A', 'claude:a');
  await submit(store, cwd, 'Plan B', 'claude:b');
  setStatus(store, a.reviewId, 'approved');

  const hintForB = await worktreePlansHint(store, cwd, 'claude:b');
  assert.match(hintForB, /Your plan here: p-[0-9a-f]{6} "Plan B", v1 — your next ExitPlanMode continues it\./);
  assert.match(hintForB, /Other plans in this worktree \(written by other agents; you do not need them\):/);
  assert.match(hintForB, /- p-[0-9a-f]{6} "Plan A" — v1, approved, updated \d{4}-\d{2}-\d{2}/);
  assert.doesNotMatch(hintForB, /"Plan B" — v1/);
  assert.match(hintForB, /plan_review_get \{ planId \}/);
  assert.match(hintForB, /plan_review_join \{ planId \} before ExitPlanMode/);

  // A newcomer has no plan of its own: only the listing, newest first.
  const hintForC = await worktreePlansHint(store, cwd, 'claude:c');
  assert.doesNotMatch(hintForC, /Your plan here/);
  assert.ok(hintForC.indexOf('"Plan B"') < hintForC.indexOf('"Plan A"'), 'newest first');
});

test('shows at most five other plans, newest first', async () => {
  const store = makeStore();
  const cwd = makeDir();
  for (let i = 1; i <= 7; i++) await submit(store, cwd, `Plan ${i}`, `claude:agent${i}`);

  const hint = await worktreePlansHint(store, cwd, 'claude:me');
  const entries = hint.split('\n').filter((l) => l.startsWith('- '));
  assert.equal(entries.length, 5);
  assert.match(entries[0], /"Plan 7"/);
  assert.match(entries[4], /"Plan 3"/);
});

test('a legacy worktree project is listed under its key; status reflects the current version', async () => {
  const store = makeStore();
  const cwd = makeDir();
  const legacy = await submit(store, cwd, 'Old plan');
  assert.equal(legacy.projectKey, sanitizeProjectKey(cwd));
  setStatus(store, legacy.reviewId, 'approved');
  await submit(store, cwd, 'Old plan, revised'); // legacy v2, new pending review → pending

  const hint = await worktreePlansHint(store, cwd, 'claude:me');
  assert.match(hint, new RegExp(`- ${legacy.projectKey} \\(worktree plan\\) — v2, pending, updated \\d{4}-`));
});

test('says nothing when there are no other plans, or the agent has no id', async () => {
  const store = makeStore();
  const cwd = makeDir();
  assert.equal(await worktreePlansHint(store, cwd, 'claude:a'), '');
  await submit(store, cwd, 'Plan A', 'claude:a');
  // Only its own plan: just the continuation line, no listing.
  const own = await worktreePlansHint(store, cwd, 'claude:a');
  assert.match(own, /^Your plan here: /);
  assert.doesNotMatch(own, /Other plans/);
  assert.equal(await worktreePlansHint(store, cwd, undefined), '');
});

test('plans of another worktree are not listed', async () => {
  const store = makeStore();
  await submit(store, makeDir(), 'Elsewhere', 'claude:x');
  assert.equal(await worktreePlansHint(store, makeDir(), 'claude:me'), '');
});

test('the hook appends the hint after the guidance and folds a subdirectory onto the worktree', async () => {
  const store = makeStore();
  const cwd = makeDir();
  const sub = path.join(cwd, 'src');
  fs.mkdirSync(sub);
  await submit(store, cwd, 'Plan A', 'claude:a');

  const withHint = runHook(store.config.home, {
    tool_name: 'EnterPlanMode',
    session_id: 'me',
    cwd: sub,
  });
  assert.match(withHint, /multi-document format/, 'existing guidance intact');
  assert.match(withHint, /\n\nOther plans in this worktree/);
  assert.match(withHint, /"Plan A"/);

  // Same store, but no other plans for the plan's own session: guidance only.
  const plain = runHook(store.config.home, { tool_name: 'EnterPlanMode', session_id: 'a', cwd });
  assert.match(plain, /multi-document format/);
  assert.doesNotMatch(plain, /Other plans/);
});

test('the hook fails open to the plain guidance when the store cannot be read', () => {
  const blocker = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'apr-epm-bad-')), 'file');
  fs.writeFileSync(blocker, 'not a directory');
  const out = runHook(path.join(blocker, 'home'), { tool_name: 'EnterPlanMode', session_id: 'a', cwd: makeDir() });
  assert.match(out, /multi-document format/);
  assert.doesNotMatch(out, /Other plans/);
});
