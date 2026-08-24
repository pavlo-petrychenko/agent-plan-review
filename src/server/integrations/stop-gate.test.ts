/**
 * Stop-gate v2 semantics, driven as a real Claude Code hook process:
 *   - first stop while pending → block with one-shot long-call guidance;
 *   - second stop → pass (one reminder per review);
 *   - live plan-review-wake heartbeat → always pass;
 *   - hook-origin reviews are never gated.
 */

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

function makeReview(home: string, over: Partial<{ id: string; origin: string; cwd: string; status: string; ageMs: number }>): string {
  const id = over.id ?? `r-${Math.random().toString(36).slice(2, 8)}`;
  const createdAt = new Date(Date.now() - (over.ageMs ?? 0)).toISOString();
  const review = {
    id,
    projectKey: 'k',
    version: 1,
    status: over.status ?? 'pending',
    origin: over.origin ?? 'mcp',
    cwd: over.cwd ?? process.cwd(),
    createdAt,
  };
  fs.mkdirSync(path.join(home, 'reviews'), { recursive: true });
  fs.writeFileSync(path.join(home, 'reviews', `${id}.json`), JSON.stringify(review));
  return id;
}

interface StopInput {
  session_id?: string;
  cwd?: string;
  stop_hook_active?: boolean;
}

/** Run the hook exactly like Claude Code would: JSON on stdin, JSON on stdout. */
function runGate(input: StopInput): Record<string, unknown> {
  const out = execFileSync(
    process.execPath,
    ['--import', 'tsx', path.join(REPO_ROOT, 'src', 'server', 'cli.ts'), 'stop-gate'],
    {
      input: JSON.stringify(input),
      encoding: 'utf8',
      cwd: REPO_ROOT,
      env: { ...process.env, AGENT_PLAN_REVIEW_HOME: HOME },
    },
  );
  return JSON.parse(out.trim() || '{}') as Record<string, unknown>;
}

let HOME: string;
let projectDir: string;

beforeEach(() => {
  HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'apr-gate-'));
  projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apr-proj-'));
});

test('first stop blocks with one-long-call guidance and writes a sentinel', () => {
  const id = makeReview(HOME, { cwd: projectDir });
  const result = runGate({ cwd: projectDir });

  assert.equal(result.decision, 'block');
  const reason = String(result.reason ?? '');
  assert.match(reason, /ONCE with wait_seconds=3600/);
  assert.match(reason, /Never short-poll/);
  assert.ok(fs.existsSync(path.join(HOME, 'gate', `${id}.reminded`)));
});

test('second stop passes — the reminder fires once per review', () => {
  makeReview(HOME, { cwd: projectDir });
  runGate({ cwd: projectDir });
  assert.deepEqual(runGate({ cwd: projectDir }), {});
});

test('live wake-extension heartbeat makes the gate stand down entirely', () => {
  makeReview(HOME, { cwd: projectDir });
  fs.writeFileSync(
    path.join(HOME, 'wake-active.json'),
    JSON.stringify({ sessions: [{ pid: process.pid, cwd: projectDir, ts: new Date().toISOString() }] }),
  );
  assert.deepEqual(runGate({ cwd: projectDir }), {});
});

test('stale heartbeat entries do not stand the gate down', () => {
  makeReview(HOME, { cwd: projectDir });
  fs.writeFileSync(
    path.join(HOME, 'wake-active.json'),
    JSON.stringify({
      sessions: [{ pid: process.pid, ts: new Date(Date.now() - 10 * 60 * 1000).toISOString() }],
    }),
  );
  assert.equal(runGate({ cwd: projectDir }).decision, 'block');
});

test('hook-origin and old reviews never gate; other-cwd reviews do not gate this session', () => {
  makeReview(HOME, { cwd: projectDir, origin: 'hook' });
  makeReview(HOME, { cwd: projectDir, ageMs: 6 * 3600 * 1000 });
  makeReview(HOME, { cwd: '/somewhere/else' });
  assert.deepEqual(runGate({ cwd: projectDir }), {});
});
