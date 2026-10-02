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

  constructor(
    readonly home: string,
    extraEnv: Record<string, string> = {},
  ) {
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

  async callTool(
    name: string,
    args: Record<string, unknown>,
    meta?: Record<string, unknown>,
  ): Promise<string> {
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

/** Rewrite arbitrary fields on a review file — what the UI/API does. */
function patchReview(home: string, reviewId: string, patch: Record<string, unknown>): void {
  const file = path.join(home, 'reviews', `${reviewId}.json`);
  const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
  Object.assign(raw, patch);
  fs.writeFileSync(file, JSON.stringify(raw));
}

/** Flip a review's status directly in its store file — what the UI/API does. */
function decideReview(home: string, reviewId: string, status: 'approved' | 'rejected'): void {
  patchReview(home, reviewId, { status, resolvedAt: new Date().toISOString() });
}

/** Append a human comment to a review's version — what the UI/API does. */
function addHumanComment(
  home: string,
  reviewId: string,
  body: string,
  delivery: 'ask' | 'decision' = 'ask',
  wakeReviewId = reviewId,
): string {
  const review = JSON.parse(fs.readFileSync(path.join(home, 'reviews', `${reviewId}.json`), 'utf8')) as {
    projectKey: string;
    version: number;
  };
  const dir = path.join(home, 'projects', review.projectKey, 'comments');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${String(review.version).padStart(4, '0')}.json`);
  const comments = fs.existsSync(file)
    ? (JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>[])
    : [];
  const comment = {
    id: `c${comments.length + 1}`,
    doc: 'root',
    line: 1,
    lineEnd: 1,
    quote: null,
    body,
    author: 'me',
    createdAt: new Date().toISOString(),
    delivery,
    ...(delivery === 'ask' ? { wakeReviewId } : {}),
  };
  comments.push(comment);
  fs.writeFileSync(file, JSON.stringify(comments));
  return comment.id;
}

function readComments(home: string, reviewId: string): Record<string, unknown>[] {
  const review = JSON.parse(fs.readFileSync(path.join(home, 'reviews', `${reviewId}.json`), 'utf8')) as {
    projectKey: string;
    version: number;
  };
  const file = path.join(
    home,
    'projects',
    review.projectKey,
    'comments',
    `${String(review.version).padStart(4, '0')}.json`,
  );
  return fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>[]) : [];
}

let home: string;

beforeEach(async () => {
  home = await makeHome();
});

/** Submit a plan body against the driver's cwd; returns the reviewId. */
async function submitBody(driver: McpDriver, markdown: string): Promise<string> {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apr-proj-'));
  const text = await driver.callTool('plan_review_submit', { cwd: projectDir, markdown });
  const match = text.match(/"reviewId":\s*"([^"]+)"/);
  assert.ok(match, `submit should return reviewId, got: ${text}`);
  return match[1];
}

/** initialize handshake + submit a minimal plan; returns driver + reviewId. */
async function submitPlan(driver: McpDriver): Promise<string> {
  await driver.request('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'test', version: '0' },
  });
  return submitBody(driver, '# Test Plan\n\nDo the thing.');
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
  const driver = new McpDriver(home, {
    AGENT_PLAN_REVIEW_MAX_WAIT: '3',
    AGENT_PLAN_REVIEW_PROGRESS_MS: '250',
  });
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
    await driver.request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 't', version: '0' },
    });
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apr-proj-'));
    const text = await driver.callTool('plan_review_submit', { cwd: projectDir, markdown: '# P\n\nx' });
    assert.match(text, /ONE long call/);
    assert.match(text, /wait_seconds.*172800/);
    assert.match(text, /do NOT re-call and do NOT re-submit/);
    assert.match(text, /decision batch do not wake you/i);

    const checkDesc = await driver.request('tools/list', {});
    const tools = (checkDesc.result as { tools: { name: string; description: string }[] }).tools;
    const check = tools.find((tool) => tool.name === 'plan_review_check');
    assert.ok(check);
    assert.match(check.description, /TRUE LONG-POLL/);
    assert.match(check.description, /recommended: wait_seconds.*172800/);
    assert.match(check.description, /decision batch stay silent/i);
    assert.doesNotMatch(check.description, /Keep calling/);
  } finally {
    driver.close();
  }
});

test('check surfaces a targeted Ask and plan_review_reply answers it once', async () => {
  const driver = new McpDriver(home);
  try {
    const reviewId = await submitPlan(driver);

    const call = driver.callTool('plan_review_check', { reviewId, wait_seconds: 30 });
    await new Promise((r) => setTimeout(r, 500));
    const commentId = addHumanComment(home, reviewId, 'why this approach?');
    const text = await call;

    assert.match(text, /"status":\s*"pending"/);
    assert.match(text, /newComments/);
    assert.match(text, /why this approach\?/);
    assert.match(text, new RegExp(`"threadId":\\s*"${commentId}"`));

    const replyText = await driver.callTool('plan_review_reply', {
      reviewId,
      commentId,
      body: 'because of latency',
    });
    assert.match(replyText, /"status":\s*"replied"/);

    const stored = readComments(home, reviewId);
    const reply = stored.find((c) => c.author === 'agent');
    assert.ok(reply, 'agent reply should be stored');
    assert.equal(reply?.body, 'because of latency');
    assert.equal(reply?.parentId, commentId);

    // The cursor means the same message is not handed over twice.
    const again = await driver.callTool('plan_review_check', { reviewId, wait_seconds: 1 });
    assert.doesNotMatch(again, /why this approach\?/);
  } finally {
    driver.close();
  }
});

test('wait_seconds zero still checks for an Ask already posted', async () => {
  const driver = new McpDriver(home);
  try {
    const reviewId = await submitPlan(driver);
    addHumanComment(home, reviewId, 'already waiting');
    const text = await driver.callTool('plan_review_check', { reviewId, wait_seconds: 0 });
    assert.match(text, /newComments/);
    assert.match(text, /already waiting/);
  } finally {
    driver.close();
  }
});

test('review lookup without reviewId never falls back to another project', async () => {
  const driver = new McpDriver(home);
  try {
    await submitPlan(driver);
    const text = await driver.callTool('plan_review_check', { wait_seconds: 0 });
    assert.match(text, /"status":\s*"not_found"/);
  } finally {
    driver.close();
  }
});

test('decision-batch comments do not wake a pending check', async () => {
  const driver = new McpDriver(home);
  try {
    const reviewId = await submitPlan(driver);
    addHumanComment(home, reviewId, 'wait until I decide', 'decision');
    const text = await driver.callTool('plan_review_check', { reviewId, wait_seconds: 1 });
    assert.match(text, /"status":\s*"pending"/);
    assert.doesNotMatch(text, /newComments/);
    assert.doesNotMatch(text, /wait until I decide/);
  } finally {
    driver.close();
  }
});

test('plan_review_reply rejects a decision-batch thread', async () => {
  const driver = new McpDriver(home);
  try {
    const reviewId = await submitPlan(driver);
    const commentId = addHumanComment(home, reviewId, 'not conversational yet', 'decision');
    const text = await driver.callTool('plan_review_reply', { reviewId, commentId, body: 'answer' });
    assert.match(text, /not an Ask for this review/);
    assert.equal(
      readComments(home, reviewId).some((comment) => comment.author === 'agent'),
      false,
    );
  } finally {
    driver.close();
  }
});

test('plan_review_resolve closes a thread and stops it being delivered', async () => {
  const driver = new McpDriver(home);
  try {
    const reviewId = await submitPlan(driver);
    const commentId = addHumanComment(home, reviewId, 'resolved before the agent ever saw it');

    const resolved = await driver.callTool('plan_review_resolve', { reviewId, commentId });
    assert.match(resolved, /"status":\s*"resolved"/);
    assert.equal(readComments(home, reviewId).find((c) => c.id === commentId)?.resolved, true);

    // Resolution, not the cursor, is what suppresses delivery here.
    const text = await driver.callTool('plan_review_check', { reviewId, wait_seconds: 0 });
    assert.doesNotMatch(text, /resolved before the agent ever saw it/);
    assert.doesNotMatch(text, /newComments/);

    const reopened = await driver.callTool('plan_review_resolve', {
      reviewId,
      commentId,
      resolved: false,
    });
    assert.match(reopened, /"status":\s*"reopened"/);
    assert.equal(readComments(home, reviewId).find((c) => c.id === commentId)?.resolved, undefined);

    // Reopening makes it conversational again.
    const after = await driver.callTool('plan_review_check', { reviewId, wait_seconds: 0 });
    assert.match(after, /resolved before the agent ever saw it/);
  } finally {
    driver.close();
  }
});

test('plan_review_resolve works on a decided hook-origin review (the plan-mode path)', async () => {
  const driver = new McpDriver(home);
  try {
    const reviewId = await submitPlan(driver);
    const commentId = addHumanComment(home, reviewId, 'fix the retry loop', 'decision');
    // The ExitPlanMode path records origin:hook and the human may already have
    // clicked "request changes" — resolving must not require a pending review.
    patchReview(home, reviewId, {
      origin: 'hook',
      status: 'rejected',
      resolvedAt: new Date().toISOString(),
    });

    const text = await driver.callTool('plan_review_resolve', { reviewId, commentId });
    assert.match(text, /"status":\s*"resolved"/);
    assert.match(text, /"version":\s*1/);
    assert.equal(readComments(home, reviewId).find((c) => c.id === commentId)?.resolved, true);
  } finally {
    driver.close();
  }
});

test('plan_review_resolve routes a thread that carried forward onto the newer version', async () => {
  const driver = new McpDriver(home);
  try {
    await driver.request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'test', version: '0' },
    });
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apr-proj-'));
    const submit = async (markdown: string) => {
      const text = await driver.callTool('plan_review_submit', { cwd: projectDir, markdown });
      return text.match(/"reviewId":\s*"([^"]+)"/)![1];
    };

    const first = await submit('# Plan\n\nDo the thing.');
    const commentId = addHumanComment(home, first, 'use exponential backoff', 'decision');
    const second = await submit('# Plan\n\nDo the thing, with backoff.');
    assert.notEqual(second, first);

    // The thread kept its id on v2, so resolving must land there, not on the
    // version named by the older review.
    const text = await driver.callTool('plan_review_resolve', { reviewId: second, commentId });
    assert.match(text, /"version":\s*2/);
    assert.equal(readComments(home, second).find((c) => c.id === commentId)?.resolved, true);
  } finally {
    driver.close();
  }
});

test('plan_review_resolve rejects a reply id, an unknown thread, and a missing commentId', async () => {
  const driver = new McpDriver(home);
  try {
    const reviewId = await submitPlan(driver);
    const rootId = addHumanComment(home, reviewId, 'root thread');
    // A real agent reply, so the reply id we then misuse actually exists.
    await driver.callTool('plan_review_reply', { reviewId, commentId: rootId, body: 'answered' });
    const reply = readComments(home, reviewId).find((c) => c.author === 'agent');
    assert.ok(reply?.id, 'agent reply should be stored');

    const onReply = await driver.callTool('plan_review_resolve', {
      reviewId,
      commentId: reply!.id as string,
    });
    assert.match(onReply, /is not a thread root/);

    const unknown = await driver.callTool('plan_review_resolve', {
      reviewId,
      commentId: 'definitely-not-a-thread',
    });
    assert.match(unknown, /No thread definitely-not-a-thread/);

    const missing = await driver.callTool('plan_review_resolve', { reviewId });
    assert.match(missing, /commentId is required/);
  } finally {
    driver.close();
  }
});
