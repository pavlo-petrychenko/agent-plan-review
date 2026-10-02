/**
 * Unit test for the plan-review-wake pi extension source.
 *
 * The extension ships as a source string (installed verbatim into
 * ~/.pi/agent/extensions). We materialize it into a temp file, import it as a
 * real ES module, and drive it with a mock pi ExtensionAPI:
 *   - seeds without waking for pre-existing (historical) reviews;
 *   - wakes exactly once on pending → approved / rejected transitions;
 *   - never wakes for hook-origin reviews or other cwds;
 *   - maintains the wake-active.json heartbeat the stop-gate consumes.
 */

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { PI_WAKE_EXTENSION_SOURCE } from './pi-wake-source.js';

process.env.AGENT_PLAN_REVIEW_WAKE_HEARTBEAT_MS = '500';

interface SentMessage {
  customType?: string;
  content?: string;
  triggerTurn?: boolean;
}

interface Harness {
  messages: SentMessage[];
  emit(event: string, ctx?: unknown): Promise<void>;
}

async function loadExtension(): Promise<{ harness: Harness; home: string }> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'apr-wake-'));
  const reviewsDir = path.join(home, 'reviews');
  fs.mkdirSync(reviewsDir, { recursive: true });
  // The extension resolves its store via env — isolate it from the real home.
  process.env.AGENT_PLAN_REVIEW_HOME = home;

  const file = path.join(home, 'plan-review-wake.test.ts');
  fs.writeFileSync(file, PI_WAKE_EXTENSION_SOURCE);

  const mod = await import(pathToFileURL(file).href);
  assert.equal(typeof mod.default, 'function', 'extension must default-export its setup fn');

  const handlers = new Map<string, (event: unknown, ctx: unknown) => Promise<void>>();
  const messages: SentMessage[] = [];
  const pi = {
    on: (event: string, handler: (event: unknown, ctx: unknown) => Promise<void>) => {
      handlers.set(event, handler);
    },
    sendMessage: (msg: SentMessage, opts: { triggerTurn?: boolean }) => {
      messages.push({ ...msg, triggerTurn: opts?.triggerTurn });
      return Promise.resolve();
    },
  };
  mod.default(pi);

  const harness: Harness = {
    messages,
    emit: (event, ctx) => (handlers.get(event) as (e: unknown, c: unknown) => Promise<void>)(event, ctx),
  };
  const dispose = (mod.default(pi) as { dispose?: () => void }).dispose;
  DISPOSERS.push(() => dispose?.());
  return { harness, home };
}

// The extension filters review.cwd against process.cwd() — use this process'
// cwd as the "project directory" so matched reviews line up.
const PROJECT_CWD = process.cwd();

const DISPOSERS: (() => void)[] = [];
afterEach(() => {
  while (DISPOSERS.length) DISPOSERS.pop()?.();
});

function writeReview(home: string, review: Record<string, unknown>): void {
  fs.writeFileSync(path.join(home, 'reviews', `${review.id as string}.json`), JSON.stringify(review));
}

function writeHumanComment(
  home: string,
  review: Record<string, unknown>,
  body: string,
  delivery: 'ask' | 'decision',
  wakeReviewId?: string,
): string {
  const dir = path.join(home, 'projects', review.projectKey as string, 'comments');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${String(review.version).padStart(4, '0')}.json`);
  const comments = fs.existsSync(file)
    ? (JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>[])
    : [];
  const id = `c${comments.length + 1}`;
  comments.push({
    id,
    doc: 'root',
    line: 1,
    lineEnd: 1,
    quote: null,
    body,
    author: 'me',
    createdAt: new Date().toISOString(),
    delivery,
    ...(wakeReviewId ? { wakeReviewId } : {}),
  });
  fs.writeFileSync(file, JSON.stringify(comments));
  return id;
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

let projectDir: string;

beforeEach(() => {
  projectDir = PROJECT_CWD;
});

test('wakes exactly once per review on pending→resolved, never for history/other-cwd/hook', async () => {
  // Pre-existing history BEFORE session start: resolved + still-pending.
  const { harness, home } = await loadExtension();
  writeReview(home, { id: 'old-approved', status: 'approved', origin: 'mcp', cwd: projectDir, version: 1 });
  writeReview(home, { id: 'other-cwd', status: 'pending', origin: 'mcp', cwd: '/elsewhere', version: 1 });

  await harness.emit('session_start', { cwd: projectDir });
  await wait(50);
  assert.equal(harness.messages.length, 0, 'no wakes at seed time');

  // Transition the in-cwd pending review → rejected: one message.
  writeReview(home, {
    id: 'other-cwd',
    status: 'rejected',
    origin: 'mcp',
    cwd: projectDir,
    reason: 'fix X',
    version: 2,
  });
  await wait(300);

  assert.equal(harness.messages.length, 1);
  const msg = harness.messages[0];
  assert.equal(msg.customType, 'plan-review-wake');
  assert.equal(msg.triggerTurn, true);
  assert.match(msg.content ?? '', /REQUESTED CHANGES/);
  assert.match(msg.content ?? '', /fix X/);

  // Repeated scans / duplicate writes stay quiet.
  writeReview(home, {
    id: 'other-cwd',
    status: 'rejected',
    origin: 'mcp',
    cwd: projectDir,
    reason: 'fix X',
    version: 2,
  });
  await wait(300);
  assert.equal(harness.messages.length, 1, 'must not double-wake');
});

test('hook-origin resolutions never wake', async () => {
  const { harness, home } = await loadExtension();
  await harness.emit('session_start', { cwd: projectDir });
  writeReview(home, { id: 'hooky', status: 'pending', origin: 'hook', cwd: projectDir });
  await wait(250); // let the seed scan see pending
  writeReview(home, { id: 'hooky', status: 'approved', origin: 'hook', cwd: projectDir });
  await wait(300);
  assert.equal(harness.messages.length, 0);
});

test('comment polling wakes only for an Ask targeted at this review', async () => {
  const { harness, home } = await loadExtension();
  const review = {
    id: 'ask-review',
    status: 'pending',
    origin: 'mcp',
    cwd: projectDir,
    projectKey: 'ask-project',
    version: 1,
  };
  writeReview(home, review);
  await harness.emit('session_start', { cwd: projectDir });
  await wait(100);

  writeHumanComment(home, review, 'answer this now', 'ask', 'ask-review');
  await wait(2300);
  assert.equal(harness.messages.length, 1);
  assert.match(harness.messages[0].content ?? '', /chose Ask agent/);
  assert.match(harness.messages[0].content ?? '', /answer this now/);

  writeHumanComment(home, review, 'wait for the decision', 'decision');
  writeHumanComment(home, review, 'wrong review', 'ask', 'another-review');
  await wait(2300);
  assert.equal(harness.messages.length, 1, 'batched and cross-review comments stay silent');
});

test('comment polling skips resolved and already acknowledged Asks', async () => {
  const { harness, home } = await loadExtension();
  const resolvedReview = {
    id: 'resolved-ask',
    status: 'pending',
    origin: 'mcp',
    cwd: projectDir,
    projectKey: 'resolved-project',
    version: 1,
  };
  const acknowledgedReview = {
    id: 'acknowledged-ask',
    status: 'pending',
    origin: 'mcp',
    cwd: projectDir,
    projectKey: 'acknowledged-project',
    version: 1,
    agentCursor: '2099-01-01T00:00:00.000Z',
  };
  writeReview(home, resolvedReview);
  writeReview(home, acknowledgedReview);
  await harness.emit('session_start', { cwd: projectDir });
  await wait(100);

  const resolvedId = writeHumanComment(home, resolvedReview, 'already resolved', 'ask', 'resolved-ask');
  const resolvedFile = path.join(home, 'projects', resolvedReview.projectKey, 'comments', '0001.json');
  const resolvedComments = JSON.parse(fs.readFileSync(resolvedFile, 'utf8')) as Record<string, unknown>[];
  Object.assign(
    resolvedComments.find((comment) => comment.id === resolvedId)!,
    { resolved: true },
  );
  fs.writeFileSync(resolvedFile, JSON.stringify(resolvedComments));
  writeHumanComment(home, acknowledgedReview, 'already acknowledged', 'ask', 'acknowledged-ask');

  await wait(2300);
  assert.equal(harness.messages.length, 0);
});

test('heartbeat file lists this process and refreshes over time', async () => {
  const { harness, home } = await loadExtension();
  await harness.emit('session_start', { cwd: projectDir });

  const marker = path.join(home, 'wake-active.json');
  const first = JSON.parse(fs.readFileSync(marker, 'utf8')) as { sessions: { pid: number; ts: string }[] };
  assert.ok(first.sessions.some((s) => s.pid === process.pid));
  await wait(1100); // HEARTBEAT_MS is 500 in tests via AGENT_PLAN_REVIEW_WAKE_HEARTBEAT_MS
  const second = JSON.parse(fs.readFileSync(marker, 'utf8')) as { sessions: { ts: string }[] };
  assert.notEqual(first.sessions[0].ts, second.sessions[0].ts, 'heartbeat should refresh');
});
