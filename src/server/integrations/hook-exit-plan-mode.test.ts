/**
 * End-to-end ExitPlanMode hook run inside a (simulated) Herdr terminal: the
 * review records the terminal link, the pointer file appears when the
 * integration is enabled, and approval still echoes `updatedInput`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

function tmp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

async function waitFor<T>(probe: () => T | undefined, timeoutMs: number): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 100));
  }
}

test('the hook links its review to HC_TERMINAL_ID and approval still echoes updatedInput', async () => {
  const home = tmp('apr-hook-');
  const herdrHome = tmp('apr-hook-herdr-');
  const cwd = tmp('apr-hook-proj-');
  const toolInput = { plan: '# Hook plan\n\nDo it.' };

  const proc = spawn(
    process.execPath,
    ['--import', 'tsx', path.join(REPO_ROOT, 'src', 'server', 'cli.ts'), 'hook-exit-plan-mode'],
    {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        AGENT_PLAN_REVIEW_HOME: home,
        AGENT_PLAN_REVIEW_PORT: String(47000 + (process.pid % 1000)),
        AGENT_PLAN_REVIEW_NO_OPEN: '1',
        AGENT_PLAN_REVIEW_TIMEOUT: '90',
        AGENT_PLAN_REVIEW_HERDR: '1',
        HC_TERMINAL_ID: 'hk1',
        HERDR_APP_HOME: herdrHome,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );
  let stdout = '';
  proc.stdout.setEncoding('utf8');
  proc.stdout.on('data', (chunk: string) => {
    stdout += chunk;
  });
  proc.stderr.on('data', () => {});
  const exited = new Promise<void>((resolve) => proc.on('exit', () => resolve()));
  proc.stdin.end(
    JSON.stringify({
      session_id: 'sess-hook',
      cwd,
      hook_event_name: 'PreToolUse',
      tool_name: 'ExitPlanMode',
      tool_input: toolInput,
      tool_use_id: 'tu-hook-1',
    }),
  );

  const reviewsDir = path.join(home, 'reviews');
  try {
    const reviewFile = await waitFor(() => {
      const files = fs.existsSync(reviewsDir)
        ? fs.readdirSync(reviewsDir).filter((f) => f.endsWith('.json'))
        : [];
      return files[0] ? path.join(reviewsDir, files[0]) : undefined;
    }, 30000);
    const review = JSON.parse(fs.readFileSync(reviewFile, 'utf8')) as Record<string, unknown>;
    assert.deepEqual(review.agent, { terminal: 'hk1', harness: 'claude-code' });

    const pointer = JSON.parse(
      fs.readFileSync(path.join(herdrHome, 'data', 'plan-review', 'hk1.json'), 'utf8'),
    ) as Record<string, unknown>;
    assert.equal(pointer.reviewId, review.id);
    assert.equal(pointer.title, 'Hook plan');

    // Approve the way the UI does (status flip in the store file).
    fs.writeFileSync(
      reviewFile,
      JSON.stringify({ ...review, status: 'approved', resolvedAt: new Date().toISOString() }),
    );
    await exited;
    const out = JSON.parse(stdout) as {
      hookSpecificOutput: { permissionDecision: string };
      updatedInput: unknown;
    };
    assert.equal(out.hookSpecificOutput.permissionDecision, 'allow');
    assert.deepEqual(out.updatedInput, toolInput);
  } finally {
    proc.kill();
    // Stop the review server the hook spawned for this temp home.
    try {
      const server = JSON.parse(fs.readFileSync(path.join(home, 'server.json'), 'utf8')) as { pid: number };
      process.kill(server.pid);
    } catch {
      // already gone
    }
  }
});
