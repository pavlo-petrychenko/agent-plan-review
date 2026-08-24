/**
 * Integration tests for the MCP stdio server, driven over real stdio the way
 * MCP clients speak to it: initialize → tools/call submit → tools/call check.
 *
 * The suite exercises the one-shot long-poll strategy:
 *   - check returns EARLY when the review resolves (wait_seconds is a ceiling);
 *   - wait_seconds clamps to AGENT_PLAN_REVIEW_MAX_WAIT;
 *   - long polls emit periodic notifications/progress keepalives;
 *   - steering text points at a single long call, never a polling loop.
 */

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

interface Rpc {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
}

class McpDriver {
  private proc;
  private buffer = '';
  readonly lines: Rpc[] = [];
  private nextId = 1;
  /** Resolvers waiting for a response with a given id. */
  private pending = new Map<number | string, (msg: Rpc) => void>();

  constructor(readonly home: string, extraEnv: Record<string, string> = {}) {
    this.proc = spawn(
      process.execPath,
      ['--import', 'tsx', path.join(REPO_ROOT, 'src', 'server', 'cli.ts'), 'mcp'],
      {
        cwd: REPO_ROOT,
        env: {
          ...process.env,
          AGENT_PLAN_REVIEW_HOME: home,
          // Never touch the network or a browser from tests.
          AGENT_PLAN_REVIEW_PORT: String(46000 + (process.pid % 1000)),
          AGENT_PLAN_REVIEW_NO_OPEN: '1',
          ...extraEnv,
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    this.proc.stdout.setEncoding('utf8');
    this.proc.stdout.on('data', (chunk: string) => {
      this.buffer += chunk;
      let idx: number;
      while ((idx = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, idx).trim();
        this.buffer = this.buffer.slice(idx + 1);
        if (!line) continue;
        let msg: Rpc;
        try {
          msg = JSON.parse(line) as Rpc;
        } catch {
          continue;
        }
        this.lines.push(msg);
        if (msg.id !== undefined && msg.id !== null) {
          const resolve = this.pending.get(msg.id as number);
          if (resolve) {
            this.pending.delete(msg.id as number);
            resolve(msg);
          }
        }
      }
    });
    this.proc.stderr.on('data', () => {});
  }

  request(method: string, params: Record<string, unknown>): Promise<Rpc> {
    const id = this.nextId++;
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      this.proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }

  async callTool(name: string, args: Record<string, unknown>, meta?: Record<string, unknown>): Promise<string> {
    const params: Record<string, unknown> = { name, arguments: args };
    if (meta) params._meta = meta;
    const res = await this.request('tools/call', params);
    const result = res.result as { content?: { text?: string }[] };
    return result.content?.[0]?.text ?? '';
  }

  textWithId(id: number | string): string {
    const found = this.lines.find((l) => l.id === id);
    const result = found?.result as { content?: { text?: string }[] } | undefined;
    return result?.content?.[0]?.text ?? '';
  }

  progressNotifications(): Rpc[] {
    return this.lines.filter((l) => l.method === 'notifications/progress');
  }

  close(): void {
    this.proc.stdin.end();
    this.proc.kill();
  }
}

async function makeHome(): Promise<string> {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'apr-mcp-'));
}

/** Flip a review's status directly in its store file — what the UI/API does. */
function decideReview(home: string, reviewId: string, status: 'approved' | 'rejected'): void {
  const file = path.join(home, 'reviews', `${reviewId}.json`);
  const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
  raw.status = status;
  raw.resolvedAt = new Date().toISOString();
  fs.writeFileSync(file, JSON.stringify(raw));
}

let home: string;

beforeEach(async () => {
  home = await makeHome();
});

/** initialize handshake + submit a minimal plan; returns driver + reviewId. */
async function submitPlan(driver: McpDriver): Promise<string> {
  await driver.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } });
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apr-proj-'));
  const text = await driver.callTool('plan_review_submit', { cwd: projectDir, markdown: '# Test Plan\n\nDo the thing.' });
  const match = text.match(/"reviewId":\s*"([^"]+)"/);
  assert.ok(match, `submit should return reviewId, got: ${text}`);
  return match[1];
}

test('check returns early when the review resolves — wait_seconds is a ceiling, not a sleep', async () => {
  const driver = new McpDriver(home);
  try {
    const reviewId = await submitPlan(driver);

    const call = driver.callTool('plan_review_check', { reviewId, wait_seconds: 30 });
    // Resolve while the poll loop is running.
    await new Promise((r) => setTimeout(r, 700));
    decideReview(home, reviewId, 'approved');
    const started = Date.now();
    const text = await call;

    assert.ok(Date.now() - started < 5000, 'long-poll must return well before the ceiling');
    assert.match(text, /"status":\s*"approved"/);
  } finally {
    driver.close();
  }
});

test('wait_seconds above AGENT_PLAN_REVIEW_MAX_WAIT clamps and returns pending after the cap', async () => {
  const driver = new McpDriver(home, { AGENT_PLAN_REVIEW_MAX_WAIT: '2' });
  try {
    const reviewId = await submitPlan(driver);
    const started = Date.now();
    const text = await driver.callTool('plan_review_check', { reviewId, wait_seconds: 99999 });
    const elapsedS = (Date.now() - started) / 1000;

    assert.ok(elapsedS >= 1.8 && elapsedS < 10, `should honor ~2s clamp, took ${elapsedS}s`);
    assert.match(text, /"status":\s*"pending"/);
    assert.match(text, /ONCE more/, 'pending guidance should push single re-calls, not loops');
  } finally {
    driver.close();
  }
});

test('long polls emit periodic notifications/progress keepalives', async () => {
  const driver = new McpDriver(home, { AGENT_PLAN_REVIEW_MAX_WAIT: '3', AGENT_PLAN_REVIEW_PROGRESS_MS: '250' });
  try {
    const reviewId = await submitPlan(driver);
    const text = await driver.callTool(
      'plan_review_check',
      { reviewId, wait_seconds: 3 },
      { progressToken: 'tok-1' },
    );

    assert.match(text, /"status":\s*"pending"/);
    const notes = driver.progressNotifications();
    assert.ok(notes.length >= 2, `expected multiple keepalives, got ${notes.length}`);
    for (const n of notes) {
      assert.equal((n.params as { progressToken?: unknown }).progressToken, 'tok-1');
      assert.match((n.params as { message?: string }).message ?? '', /still waiting/);
    }
  } finally {
    driver.close();
  }
});

test('submit steering text prescribes ONE long call and forbids resubmit-while-pending', async () => {
  const driver = new McpDriver(home);
  try {
    await driver.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } });
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apr-proj-'));
    const text = await driver.callTool('plan_review_submit', { cwd: projectDir, markdown: '# P\n\nx' });
    assert.match(text, /ONE long call/);
    assert.match(text, /wait_seconds.*3600/);
    assert.match(text, /do NOT re-call and do NOT re-submit/);

    const checkDesc = await driver.request('tools/list', {});
    const tools = (checkDesc.result as { tools: { name: string; description: string }[] }).tools;
    const check = tools.find((tool) => tool.name === 'plan_review_check');
    assert.ok(check);
    assert.match(check.description, /TRUE LONG-POLL/);
    assert.match(check.description, /recommended: wait_seconds=3600/);
    assert.doesNotMatch(check.description, /Keep calling/);
  } finally {
    driver.close();
  }
});
