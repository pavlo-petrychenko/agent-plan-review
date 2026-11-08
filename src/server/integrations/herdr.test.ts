/**
 * Herdr integration: terminal capture, the browser decision, and the pointer
 * files the Herdr mod reads — written only when the integration is enabled,
 * atomically, under HERDR_APP_HOME, and never at the cost of a store operation.
 */

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setHerdrSettings } from '../config.js';
import { PlanReviewStore } from '../store/store.js';
import { agentFromEnv, herdrPointerFile, shouldOpenBrowser, type HerdrPointer } from './herdr.js';

function tmp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

let home: string;
let herdrHome: string;

beforeEach(() => {
  home = tmp('apr-herdr-home-');
  herdrHome = tmp('apr-herdr-app-');
  // The store reads these from the process env; never let the developer's own
  // Herdr session leak into a test.
  process.env.HERDR_APP_HOME = herdrHome;
  delete process.env.AGENT_PLAN_REVIEW_HERDR;
});

function pointerDir(): string {
  return path.join(herdrHome, 'data', 'plan-review');
}

function readPointer(terminal: string): HerdrPointer {
  return JSON.parse(fs.readFileSync(path.join(pointerDir(), `${terminal}.json`), 'utf8')) as HerdrPointer;
}

async function submit(store: PlanReviewStore, terminal?: string, markdown = '# Ship it\n\nline two\n') {
  return store.recordPlan({
    cwd: tmp('apr-herdr-proj-'),
    origin: 'mcp',
    markdown,
    agent: terminal ? { terminal, harness: 'pi' } : undefined,
  });
}

// ---------------------------------------------------------------------------
// pure helpers
// ---------------------------------------------------------------------------

test('agentFromEnv reads HC_TERMINAL_ID and the harness', () => {
  assert.equal(agentFromEnv('claude-code', {}), undefined);
  assert.equal(agentFromEnv('claude-code', { HC_TERMINAL_ID: '  ' }), undefined);
  assert.deepEqual(agentFromEnv('claude-code', { HC_TERMINAL_ID: 't3w' }), {
    terminal: 't3w',
    harness: 'claude-code',
  });
  assert.deepEqual(agentFromEnv(undefined, { HC_TERMINAL_ID: 't3w' }), { terminal: 't3w' });
});

test('pointer files live under HERDR_APP_HOME (default ~/.config/herdr-app) and reject unsafe ids', () => {
  assert.equal(
    herdrPointerFile('t3w', { HERDR_APP_HOME: '/x/herdr' }),
    path.join('/x/herdr', 'data', 'plan-review', 't3w.json'),
  );
  assert.equal(
    herdrPointerFile('t3w', {}),
    path.join(os.homedir(), '.config', 'herdr-app', 'data', 'plan-review', 't3w.json'),
  );
  for (const bad of ['../evil', 'a/b', '.hidden', '', 'x'.repeat(200)]) {
    assert.equal(herdrPointerFile(bad, { HERDR_APP_HOME: '/x' }), null, bad);
  }
});

test('browser decision: unchanged unless Herdr is enabled AND the agent is in a Herdr terminal', () => {
  // Disabled (default): always open, terminal or not.
  assert.equal(shouldOpenBrowser(home, undefined, {}), true);
  assert.equal(shouldOpenBrowser(home, 't3w', {}), true);

  setHerdrSettings(home, { enabled: true, openBrowser: false });
  assert.equal(shouldOpenBrowser(home, undefined, {}), true, 'outside Herdr nothing changes');
  assert.equal(shouldOpenBrowser(home, 't3w', {}), false, 'the Herdr mod shows the plan instead');
  assert.equal(shouldOpenBrowser(home, 't3w', { AGENT_PLAN_REVIEW_HERDR: '0' }), true);

  setHerdrSettings(home, { enabled: true, openBrowser: true });
  assert.equal(shouldOpenBrowser(home, 't3w', {}), true, 'openBrowser keeps the tab');
});

// ---------------------------------------------------------------------------
// pointer writer through the store
// ---------------------------------------------------------------------------

test('disabled (default): the agent link is recorded but no pointer file is written', async () => {
  const store = new PlanReviewStore({ home, port: 4999 });
  const recorded = await submit(store, 't3w');
  const review = await store.getReview(recorded.reviewId);
  assert.deepEqual(review?.agent, { terminal: 't3w', harness: 'pi' });
  await store.decideReview(recorded.reviewId, 'approve');
  assert.equal(fs.existsSync(path.join(herdrHome, 'data')), false);
});

test('enabled: no pointer for a review without a terminal', async () => {
  setHerdrSettings(home, { enabled: true, openBrowser: false });
  const store = new PlanReviewStore({ home, port: 4999 });
  const recorded = await submit(store);
  assert.equal((await store.getReview(recorded.reviewId))?.agent, undefined);
  assert.equal(fs.existsSync(pointerDir()), false);
});

test('enabled: submit, Ask, agent reply, resolve and decision each refresh the pointer', async () => {
  setHerdrSettings(home, { enabled: true, openBrowser: false });
  const store = new PlanReviewStore({ home, port: 4999 });
  const recorded = await submit(store, 't3w');

  const first = readPointer('t3w');
  assert.deepEqual(
    { ...first, updatedAt: undefined },
    {
      reviewId: recorded.reviewId,
      projectKey: recorded.projectKey,
      version: 1,
      status: 'pending',
      title: 'Ship it',
      cwd: (await store.getReview(recorded.reviewId))!.cwd,
      updatedAt: undefined,
    },
  );

  let last = first.updatedAt;
  const advanced = async (): Promise<void> => {
    await new Promise((r) => setTimeout(r, 5));
  };
  const expectRefresh = (label: string): void => {
    const now = readPointer('t3w').updatedAt;
    assert.ok(now > last, `${label} must refresh updatedAt`);
    last = now;
  };

  await advanced();
  const ask = await store.addComment(recorded.projectKey, 1, {
    body: 'why?',
    delivery: 'ask',
    reviewId: recorded.reviewId,
  });
  expectRefresh('Ask');

  await advanced();
  await store.addComment(recorded.projectKey, 1, { body: 'later', delivery: 'decision' });
  assert.equal(readPointer('t3w').updatedAt, last, 'a decision-batch comment does not wake the mod');

  await advanced();
  await store.replyToReview(recorded.reviewId, ask.id, 'because');
  expectRefresh('agent reply');

  await advanced();
  await store.resolveComment(recorded.projectKey, 1, ask.id, true);
  expectRefresh('resolve');

  await advanced();
  await store.decideReview(recorded.reviewId, 'reject', 'redo');
  expectRefresh('decision');
  assert.equal(readPointer('t3w').status, 'rejected');

  assert.deepEqual(fs.readdirSync(pointerDir()), ['t3w.json'], 'atomic write leaves no temp files behind');
});

test('enabled: a terminal points at its NEWEST review, tree titles come from the root page', async () => {
  setHerdrSettings(home, { enabled: true, openBrowser: false });
  const store = new PlanReviewStore({ home, port: 4999 });
  const older = await submit(store, 't3w');
  await new Promise((r) => setTimeout(r, 5));
  const newer = await submit(
    store,
    't3w',
    '# Tree root\n\nintro\n\n<!--doc slug=step title="Step" parent=root-->\n\nbody\n',
  );
  assert.equal(readPointer('t3w').reviewId, newer.reviewId);
  assert.equal(readPointer('t3w').title, 'Tree root');

  // An event on the older review must not point the mod backwards.
  await store.decideReview(older.reviewId, 'approve');
  assert.equal(readPointer('t3w').reviewId, newer.reviewId);
});

test('a pointer write failure is logged, never thrown — the store operation still succeeds', async () => {
  setHerdrSettings(home, { enabled: true, openBrowser: false });
  // A FILE where the data directory should be makes every pointer write fail.
  fs.writeFileSync(path.join(herdrHome, 'data'), 'not a directory');
  const store = new PlanReviewStore({ home, port: 4999 });

  const errors: unknown[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    errors.push(args);
  };
  try {
    const recorded = await submit(store, 't3w');
    const decided = await store.decideReview(recorded.reviewId, 'approve');
    assert.equal(decided.review.status, 'approved');
  } finally {
    console.error = original;
  }
  assert.ok(errors.length >= 1, 'the failure is logged');
});
