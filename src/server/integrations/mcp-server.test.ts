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

import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PlanReviewStore } from '../store/store.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

interface Rpc {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
}

/** The port every test server is asked to use (never the user's own :4620). */
const TEST_PORT = 46000 + (process.pid % 1000);

/** Homes an MCP process was started in: their review server may still be booting. */
const usedHomes = new Set<string>();

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
    usedHomes.add(home);
    this.proc = spawn(
      process.execPath,
      ['--import', 'tsx', path.join(REPO_ROOT, 'src', 'server', 'cli.ts'), 'mcp'],
      {
        cwd: REPO_ROOT,
        env: {
          ...process.env,
          AGENT_PLAN_REVIEW_HOME: home,
          // Never touch the network or a browser from tests.
          AGENT_PLAN_REVIEW_PORT: String(TEST_PORT),
          AGENT_PLAN_REVIEW_NO_OPEN: '1',
          // Agent identity comes from the env: start from none, so a test run
          // inside Claude Code or Herdr does not leak its own ids in.
          CLAUDE_CODE_SESSION_ID: '',
          HC_TERMINAL_ID: '',
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
    stopServer(this.home);
  }
}

/** Homes handed out by makeHome(), swept in after() in case a test forgot to close. */
const homes: string[] = [];

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function serverPid(home: string): number | null {
  try {
    const { pid } = JSON.parse(fs.readFileSync(path.join(home, 'server.json'), 'utf8')) as { pid?: number };
    return typeof pid === 'number' && pid > 1 ? pid : null;
  } catch {
    return null;
  }
}

/**
 * The MCP server starts the review server detached (it outlives the MCP
 * process by design), so a test must stop it itself: SIGTERM the pid it
 * recorded in <home>/server.json. Best effort and synchronous; after() does the
 * thorough sweep for a server that had not written server.json yet.
 */
function stopServer(home: string): void {
  const pid = serverPid(home);
  if (pid === null) return;
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    // already gone
  }
}

/** Pids listening on the test port (always 46xxx, never the user's :4620). */
function listenersOnTestPort(): number[] {
  try {
    const out = execFileSync('lsof', ['-ti', `tcp:${TEST_PORT}`, '-sTCP:LISTEN'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out
      .split(/\s+/)
      .map(Number)
      .filter((n) => Number.isInteger(n) && n > 1);
  } catch {
    return []; // lsof exits 1 when nothing listens
  }
}

after(async () => {
  // A server may still be booting when its test ended (npx -> tsx -> node takes a
  // second), so server.json can appear after close(). Wait for each home's server
  // to record itself, in parallel, then stop it.
  const deadline = Date.now() + 6000;
  await Promise.all(
    homes.map(async (h) => {
      while (usedHomes.has(h) && serverPid(h) === null && Date.now() < deadline) await sleep(150);
      stopServer(h);
    }),
  );
  // Last resort: whatever still listens on the test port (a server whose home
  // was never recorded, or one spawned by a later call).
  for (let round = 0; round < 20; round++) {
    const pids = listenersOnTestPort();
    if (pids.length === 0) break;
    for (const pid of pids) {
      try {
        process.kill(pid, round < 10 ? 'SIGTERM' : 'SIGKILL');
      } catch {
        // gone
      }
    }
    await sleep(250);
  }
});

async function makeHome(): Promise<string> {
  const h = fs.mkdtempSync(path.join(os.tmpdir(), 'apr-mcp-'));
  homes.push(h);
  return h;
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

test("review lookup without reviewId never falls back to another agent's review", async () => {
  const driver = new McpDriver(home, { CLAUDE_CODE_SESSION_ID: 'sess-a' });
  const other = new McpDriver(home, { CLAUDE_CODE_SESSION_ID: 'sess-b' });
  try {
    await submitPlan(driver);
    const text = await other.callTool('plan_review_check', { wait_seconds: 0 });
    assert.match(text, /"status":\s*"not_found"/);
  } finally {
    other.close();
    driver.close();
  }
});

/** Two MCP processes (two agents) with a pending plan each in ONE cwd. */
async function twoAgentsInOneCwd(a: McpDriver, b: McpDriver): Promise<{ idA: string; idB: string }> {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'apr-proj-'));
  const submit = async (d: McpDriver, markdown: string): Promise<string> => {
    const text = await d.callTool('plan_review_submit', { cwd, markdown });
    const m = text.match(/"reviewId":\s*"([^"]+)"/);
    assert.ok(m, `submit should return reviewId, got: ${text}`);
    return m[1];
  };
  // Sequential: the first submit boots the review server for this home.
  const idA = await submit(a, '# Plan A\n\nFrom agent A.');
  const idB = await submit(b, '# Plan B\n\nFrom agent B.');
  return { idA, idB };
}

test('two agents in one cwd: check without reviewId returns each its own review', async () => {
  const a = new McpDriver(home, { CLAUDE_CODE_SESSION_ID: 'sess-a' });
  const b = new McpDriver(home, { CLAUDE_CODE_SESSION_ID: 'sess-b' });
  try {
    const { idA, idB } = await twoAgentsInOneCwd(a, b);
    assert.notEqual(idA, idB);
    for (const [driver, id, session] of [
      [a, idA, 'sess-a'],
      [b, idB, 'sess-b'],
    ] as const) {
      const review = JSON.parse(fs.readFileSync(path.join(home, 'reviews', `${id}.json`), 'utf8')) as {
        agentId?: string;
      };
      assert.equal(review.agentId, `claude:${session}`);
      assert.match(await driver.callTool('plan_review_check', { wait_seconds: 0 }), new RegExp(id));
    }

    // A's review is decided: A has nothing pending now, and must not get B's.
    decideReview(home, idA, 'approved');
    const afterDecision = await a.callTool('plan_review_check', { wait_seconds: 0 });
    assert.match(afterDecision, /"status":\s*"not_found"/);
    assert.doesNotMatch(afterDecision, new RegExp(idB));

    // Reply/resolve without reviewId follow the same rule.
    const reply = await a.callTool('plan_review_reply', { commentId: 'c1', body: 'hi' });
    assert.match(reply, /No matching pending review/);
  } finally {
    b.close();
    a.close();
  }
});

test('agents with only a terminal id are kept apart per terminal', async () => {
  const a = new McpDriver(home, { HC_TERMINAL_ID: 'tA' });
  const b = new McpDriver(home, { HC_TERMINAL_ID: 'tB' });
  try {
    const { idA, idB } = await twoAgentsInOneCwd(a, b);
    assert.match(await a.callTool('plan_review_check', { wait_seconds: 0 }), new RegExp(idA));
    assert.match(await b.callTool('plan_review_check', { wait_seconds: 0 }), new RegExp(idB));
  } finally {
    b.close();
    a.close();
  }
});

test('with no env identity each MCP process is its own agent', async () => {
  const a = new McpDriver(home);
  const b = new McpDriver(home);
  try {
    const { idA, idB } = await twoAgentsInOneCwd(a, b);
    const review = JSON.parse(fs.readFileSync(path.join(home, 'reviews', `${idA}.json`), 'utf8')) as {
      agentId?: string;
    };
    assert.match(review.agentId ?? '', /^proc:/);
    assert.match(await a.callTool('plan_review_check', { wait_seconds: 0 }), new RegExp(idA));
    assert.match(await b.callTool('plan_review_check', { wait_seconds: 0 }), new RegExp(idB));
  } finally {
    b.close();
    a.close();
  }
});

test('a legacy review without agentId is still found by cwd', async () => {
  const driver = new McpDriver(home, { CLAUDE_CODE_SESSION_ID: 'sess-a' });
  try {
    const reviewId = await submitPlan(driver);
    // What a review stored before agent ids looks like, in the MCP server's cwd.
    patchReview(home, reviewId, { agentId: undefined, cwd: REPO_ROOT });
    const text = await driver.callTool('plan_review_check', { wait_seconds: 0 });
    assert.match(text, new RegExp(reviewId));
    assert.match(text, /"status":\s*"pending"/);
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

test('plan_review_submit links the review to HC_TERMINAL_ID with the MCP client name as harness', async () => {
  const herdrHome = fs.mkdtempSync(path.join(os.tmpdir(), 'apr-mcp-herdr-'));
  const driver = new McpDriver(home, { HC_TERMINAL_ID: 't3w', HERDR_APP_HOME: herdrHome });
  try {
    await driver.request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'pi', version: '1' },
    });
    const reviewId = await submitBody(driver, '# Linked\n\nbody');
    const review = JSON.parse(fs.readFileSync(path.join(home, 'reviews', `${reviewId}.json`), 'utf8')) as {
      agent?: unknown;
    };
    assert.deepEqual(review.agent, { terminal: 't3w', harness: 'pi' });
    // The integration is off by default: the link is metadata only.
    assert.equal(fs.existsSync(path.join(herdrHome, 'data')), false, 'no pointer file while disabled');
  } finally {
    driver.close();
  }
});

test('plan_review_submit writes the Herdr pointer when the integration is enabled', async () => {
  const herdrHome = fs.mkdtempSync(path.join(os.tmpdir(), 'apr-mcp-herdr-'));
  fs.writeFileSync(
    path.join(home, 'config.json'),
    JSON.stringify({ integrations: { herdr: { enabled: true, openBrowser: false } } }),
  );
  const driver = new McpDriver(home, { HC_TERMINAL_ID: 't9z', HERDR_APP_HOME: herdrHome });
  try {
    const reviewId = await submitPlan(driver);
    const pointer = JSON.parse(
      fs.readFileSync(path.join(herdrHome, 'data', 'plan-review', 't9z.json'), 'utf8'),
    ) as { reviewId: string; status: string; title: string };
    assert.equal(pointer.reviewId, reviewId);
    assert.equal(pointer.status, 'pending');
    assert.equal(pointer.title, 'Test Plan');
  } finally {
    driver.close();
  }
});

// ---------------------------------------------------------------------------
// Sharing plans: plan_review_list / _get / _join, and planId / newPlan on submit
// ---------------------------------------------------------------------------

const newCwd = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'apr-proj-'));

/** The JSON object a tool prints before its guidance text. */
function head<T = Record<string, unknown>>(text: string): T {
  return JSON.parse(text.split('\n\n')[0]) as T;
}

interface Submitted {
  reviewId: string;
  projectKey: string;
  version: number;
}

const submitTo = async (
  driver: McpDriver,
  cwd: string,
  markdown: string,
  extra: Record<string, unknown> = {},
): Promise<Submitted> => {
  const text = await driver.callTool('plan_review_submit', { cwd, markdown, ...extra });
  assert.match(text, /"reviewId"/, `submit should succeed, got: ${text}`);
  return head<Submitted>(text.replace(/^WARNING.*\n\n/s, ''));
};

/** A store on the drivers' home, to set up or inspect what the MCP processes wrote. */
const storeAt = (h: string): PlanReviewStore => new PlanReviewStore({ home: h, port: TEST_PORT });

interface ListedPlan {
  planId: string;
  worktreePlan: boolean;
  title: string;
  currentVersion: number;
  status: string;
  mine: boolean;
  lastAgentTerminal?: string;
}

test("plan_review_list shows both agents' plans and the legacy one, newest first, with mine and status", async () => {
  const a = new McpDriver(home, { CLAUDE_CODE_SESSION_ID: 'sess-a', HC_TERMINAL_ID: 'tA' });
  const b = new McpDriver(home, { CLAUDE_CODE_SESSION_ID: 'sess-b' });
  try {
    const cwd = newCwd();
    const legacy = await storeAt(home).recordPlan({ cwd, origin: 'mcp', markdown: '# Old shared\n\nold' });
    const planA = await submitTo(a, cwd, '# Plan A\n\nalpha');
    const planB = await submitTo(b, cwd, '# Plan B\n\nbeta');
    decideReview(home, planA.reviewId, 'approved');

    const text = await b.callTool('plan_review_list', { cwd });
    const { plans } = head<{ plans: ListedPlan[] }>(text);
    assert.deepEqual(
      plans.map((p) => p.title),
      ['Plan B', 'Plan A', 'Old shared'],
    );
    const [pb, pa, old] = plans;
    assert.deepEqual([pb.mine, pa.mine, old.mine], [true, false, false]);
    assert.deepEqual([pb.status, pa.status, old.status], ['pending', 'approved', 'pending']);
    assert.equal(pa.lastAgentTerminal, 'tA');
    assert.equal(pb.lastAgentTerminal, undefined);
    assert.equal(pb.planId, planB.projectKey.split('.').pop());
    assert.equal(old.planId, legacy.projectKey);
    assert.equal(old.worktreePlan, true);
    assert.equal(pa.worktreePlan, false);
    assert.match(text, /plan_review_join/, 'one line of guidance follows the JSON');

    // From A's seat the flags flip.
    const asA = head<{ plans: ListedPlan[] }>(await a.callTool('plan_review_list', { cwd })).plans;
    assert.deepEqual(
      asA.map((p) => p.mine),
      [false, true, false],
    );
  } finally {
    b.close();
    a.close();
  }
});

test('plan_review_list defaults to the MCP server cwd and reports an empty worktree', async () => {
  const driver = new McpDriver(home, { CLAUDE_CODE_SESSION_ID: 'sess-a' });
  try {
    const empty = await driver.callTool('plan_review_list', { cwd: newCwd() });
    assert.deepEqual(head(empty), { plans: [] });
    // No cwd: the server's own cwd (REPO_ROOT here), which has no plans in this fresh home.
    assert.deepEqual(head(await driver.callTool('plan_review_list', {})), { plans: [] });
  } finally {
    driver.close();
  }
});

test('plan_review_get returns the markdown and only open threads, and does not change agents', async () => {
  const a = new McpDriver(home, { CLAUDE_CODE_SESSION_ID: 'sess-a' });
  const b = new McpDriver(home, { CLAUDE_CODE_SESSION_ID: 'sess-b' });
  try {
    const cwd = newCwd();
    const planA = await submitTo(a, cwd, '# Plan A\n\nline one\nline two');
    const store = storeAt(home);
    const open = await store.addComment(planA.projectKey, 1, { body: 'still open', doc: 'root', line: 3 });
    const closed = await store.addComment(planA.projectKey, 1, {
      body: 'already done',
      doc: 'root',
      line: 4,
    });
    await store.addAgentReply(planA.projectKey, 1, open.id, 'my answer');
    await store.resolveComment(planA.projectKey, 1, closed.id, true);
    const planId = planA.projectKey.split('.').pop()!;
    const metaFile = path.join(home, 'projects', planA.projectKey, 'meta.json');
    const before = fs.readFileSync(metaFile, 'utf8');

    const text = await b.callTool('plan_review_get', { planId, cwd });
    const got = head<{
      planId: string;
      title: string;
      version: number;
      openThreads: {
        threadId: string;
        doc: string;
        line: number;
        quote: unknown;
        body: string;
        author: string;
        replies: { author: string; body: string }[];
      }[];
    }>(text);
    assert.equal(got.planId, planId);
    assert.equal(got.title, 'Plan A');
    assert.equal(got.version, 1);
    assert.equal(got.openThreads.length, 1);
    assert.equal(got.openThreads[0].threadId, open.id);
    assert.equal(got.openThreads[0].body, 'still open');
    assert.equal(got.openThreads[0].author, 'me');
    assert.equal(got.openThreads[0].doc, 'root');
    assert.equal(got.openThreads[0].line, 3);
    assert.deepEqual(got.openThreads[0].replies, [{ author: 'agent', body: 'my answer' }]);
    assert.doesNotMatch(text, /already done/);
    assert.match(text, /# Plan A\n\nline one\nline two/);
    assert.equal(fs.readFileSync(metaFile, 'utf8'), before, 'get is read only: agents and updatedAt stay');
    assert.deepEqual(JSON.parse(before).agents, ['claude:sess-a']);
  } finally {
    b.close();
    a.close();
  }
});

test('plan_review_get of a tree plan prints pages with doc markers; version selects an older one', async () => {
  const driver = new McpDriver(home, { CLAUDE_CODE_SESSION_ID: 'sess-a' });
  try {
    const cwd = newCwd();
    const tree =
      '# Root plan\n\nintro\n\n<!--doc slug=impl title="Implementation" parent=root-->\nimpl body\n';
    const v1 = await submitTo(driver, cwd, tree);
    await submitTo(driver, cwd, '# Root plan\n\nsingle now');
    const planId = v1.projectKey.split('.').pop()!;

    const text = await driver.callTool('plan_review_get', { planId, version: 1, cwd });
    assert.match(
      text.replace(/.*--- plan markdown ---\n/s, ''),
      /^# Root plan\n\nintro\n\n<!--doc slug=impl title="Implementation" parent=root-->\nimpl body/,
    );
    assert.doesNotMatch(text, /single now/);
    assert.match(await driver.callTool('plan_review_get', { planId, cwd }), /single now/);
  } finally {
    driver.close();
  }
});

test('plan_review_get and plan_review_join fail clearly on unknown, foreign or missing plan ids', async () => {
  const driver = new McpDriver(home, { CLAUDE_CODE_SESSION_ID: 'sess-a' });
  try {
    const cwd = newCwd();
    const mine = await submitTo(driver, cwd, '# Mine\n\nx');
    const foreign = await submitTo(driver, newCwd(), '# Elsewhere\n\ny');
    const metaFile = path.join(home, 'projects', foreign.projectKey, 'meta.json');
    const before = fs.readFileSync(metaFile, 'utf8');

    for (const tool of ['plan_review_get', 'plan_review_join']) {
      const unknown = await driver.request('tools/call', {
        name: tool,
        arguments: { planId: 'p-abcdef', cwd },
      });
      const result = unknown.result as { isError?: boolean; content: { text: string }[] };
      assert.equal(result.isError, true);
      assert.match(result.content[0].text, /Unknown plan "p-abcdef"/);
      assert.ok(
        result.content[0].text.includes(mine.projectKey.split('.').pop()!),
        "lists the worktree's plans",
      );

      assert.match(
        await driver.callTool(tool, { planId: foreign.projectKey, cwd }),
        /belongs to another worktree/,
      );
      assert.match(await driver.callTool(tool, { cwd }), /planId is required/);
    }
    assert.equal(fs.readFileSync(metaFile, 'utf8'), before, 'a refused join writes nothing');
  } finally {
    driver.close();
  }
});

test("plan_review_join then submit without planId lands in the joined plan, not the agent's newer own plan", async () => {
  const a = new McpDriver(home, { CLAUDE_CODE_SESSION_ID: 'sess-a' });
  const b = new McpDriver(home, { CLAUDE_CODE_SESSION_ID: 'sess-b' });
  try {
    const cwd = newCwd();
    const planA = await submitTo(a, cwd, '# Plan A\n\nalpha');
    const planB = await submitTo(b, cwd, '# Plan B\n\nbeta');
    const planId = planA.projectKey.split('.').pop()!;

    const joined = await b.callTool('plan_review_join', { planId, cwd });
    const info = head<{ joined: boolean; planId: string; title: string; currentVersion: number }>(joined);
    assert.deepEqual(info, { joined: true, planId, title: 'Plan A', currentVersion: 1 });
    const metaA = JSON.parse(
      fs.readFileSync(path.join(home, 'projects', planA.projectKey, 'meta.json'), 'utf8'),
    );
    assert.deepEqual(metaA.agents, ['claude:sess-a', 'claude:sess-b']);
    assert.equal(metaA.currentVersion, 1, 'join does not create a version');

    const next = await submitTo(b, cwd, '# Plan A\n\nalpha, revised by B');
    assert.equal(next.projectKey, planA.projectKey);
    assert.equal(next.version, 2);
    assert.equal(
      JSON.parse(fs.readFileSync(path.join(home, 'projects', planB.projectKey, 'meta.json'), 'utf8'))
        .currentVersion,
      1,
    );
  } finally {
    b.close();
    a.close();
  }
});

test('plan_review_join via MCP, then an ExitPlanMode hook submit of the same session lands in the joined plan', async () => {
  const a = new McpDriver(home, { CLAUDE_CODE_SESSION_ID: 'sess-a' });
  const b = new McpDriver(home, { CLAUDE_CODE_SESSION_ID: 'sess-b' });
  try {
    const cwd = newCwd();
    const planA = await submitTo(a, cwd, '# Plan A\n\nalpha');
    const planB = await submitTo(b, cwd, '# Plan B\n\nbeta');
    await b.callTool('plan_review_join', { planId: planA.projectKey.split('.').pop()!, cwd });

    // What the hook sends: session_id → agentId claude:<session>, origin 'hook'.
    const viaHook = await storeAt(home).recordPlan({
      cwd,
      origin: 'hook',
      sessionId: 'sess-b',
      agentId: 'claude:sess-b',
      toolUseId: 'toolu_1',
      markdown: '# Plan A\n\nfrom ExitPlanMode',
    });
    assert.equal(viaHook.projectKey, planA.projectKey);
    assert.equal(viaHook.version, 2);
    assert.notEqual(viaHook.projectKey, planB.projectKey);
  } finally {
    b.close();
    a.close();
  }
});

test('plan_review_submit with planId writes to that plan; a foreign planId is refused; newPlan starts a fresh one', async () => {
  const a = new McpDriver(home, { CLAUDE_CODE_SESSION_ID: 'sess-a' });
  const b = new McpDriver(home, { CLAUDE_CODE_SESSION_ID: 'sess-b' });
  try {
    const cwd = newCwd();
    const planA = await submitTo(a, cwd, '# Plan A\n\nalpha');
    const planB = await submitTo(b, cwd, '# Plan B\n\nbeta');
    const idA = planA.projectKey.split('.').pop()!;

    // planId: next version of A's plan, written by B; B's own plan is untouched.
    const viaId = await submitTo(b, cwd, '# Plan A\n\nalpha plus B', { planId: idA });
    assert.equal(viaId.projectKey, planA.projectKey);
    assert.equal(viaId.version, 2);

    // Not in this worktree: nothing is recorded, and the worktree's plans are listed.
    const foreign = await submitTo(a, newCwd(), '# Elsewhere\n\nz');
    const refused = await b.callTool('plan_review_submit', {
      cwd,
      markdown: '# X\n\nx',
      planId: foreign.projectKey,
    });
    assert.match(refused, /NOT recorded/);
    assert.match(refused, /belongs to another worktree/);

    // newPlan: B has plans already, still gets a third one.
    const fresh = await submitTo(b, cwd, '# Plan B again\n\nnew', { newPlan: true });
    assert.notEqual(fresh.projectKey, planA.projectKey);
    assert.notEqual(fresh.projectKey, planB.projectKey);
    assert.equal(fresh.version, 1);
    const plans = head<{ plans: ListedPlan[] }>(await b.callTool('plan_review_list', { cwd })).plans;
    assert.equal(plans.length, 3);
  } finally {
    b.close();
    a.close();
  }
});

test('the plan tools are listed with their required arguments', async () => {
  const driver = new McpDriver(home);
  try {
    const res = await driver.request('tools/list', {});
    const tools = (
      res.result as {
        tools: { name: string; inputSchema: { required?: string[]; properties: Record<string, unknown> } }[];
      }
    ).tools;
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    assert.deepEqual(byName.plan_review_get.inputSchema.required, ['planId']);
    assert.deepEqual(byName.plan_review_join.inputSchema.required, ['planId']);
    assert.ok('cwd' in byName.plan_review_list.inputSchema.properties);
    assert.ok('planId' in byName.plan_review_submit.inputSchema.properties);
    assert.ok('newPlan' in byName.plan_review_submit.inputSchema.properties);
  } finally {
    driver.close();
  }
});
