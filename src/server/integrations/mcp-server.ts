/**
 * MCP stdio server: `plan_review_submit` + `plan_review_check`.
 *
 * Newline-delimited JSON-RPC over stdin/stdout, hand-rolled to keep the
 * dependency footprint at zero. Submit validates and records through the
 * SAME store path as the hook, returns the review coordinates and opens the
 * browser. Check LONG-POLLS (wait_seconds, default 0, cap 120) and returns
 * loop-oriented guidance.
 */

import { APP_NAME, APP_VERSION, loadConfig } from '../config.js';
import { PlanReviewStore } from '../store/store.js';
import { PlanValidationError } from '../util/errors.js';
import { compileIssues } from '../../shared/compile.js';
import type { Review } from '../../shared/types.js';
import { ensureServerRunning } from './spawn-server.js';
import { openBrowser } from './browser.js';

interface RpcRequest {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: Record<string, unknown>;
}

const TOOLS = [
  {
    name: 'plan_review_submit',
    description:
      'Submit an implementation plan for human review. The plan opens in a browser review UI; ' +
      'call plan_review_check afterwards to wait for the decision. Provide exactly one of: ' +
      'docs[] (multi-document), markdown (single document), or plan (raw string with optional <!--doc ...--> markers).',
    inputSchema: {
      type: 'object',
      required: ['cwd'],
      properties: {
        cwd: { type: 'string', description: 'Absolute path of the project directory the plan belongs to.' },
        name: { type: 'string', description: 'Optional display name for the project.' },
        markdown: { type: 'string', description: 'Single-document plan markdown.' },
        plan: { type: 'string', description: 'Raw plan string (markers allowed); treated like markdown.' },
        docs: {
          type: 'array',
          description: 'Structured multi-document plan.',
          items: {
            type: 'object',
            required: ['slug', 'title', 'markdown'],
            properties: {
              slug: { type: 'string' },
              title: { type: 'string' },
              parent: { type: ['string', 'null'] },
              markdown: { type: 'string' },
            },
          },
        },
      },
    },
  },
  {
    name: 'plan_review_check',
    description:
      'Wait for the human decision on a submitted plan. Long-polls up to wait_seconds (default 0, max 120; recommended 20). ' +
      'Returns status pending/approved/rejected with notes or compiled feedback. Keep calling until resolved.',
    inputSchema: {
      type: 'object',
      properties: {
        reviewId: { type: 'string', description: 'Review id from plan_review_submit. Omit to use the newest pending review in cwd.' },
        wait_seconds: { type: 'number', description: 'Seconds to long-poll (0-120, recommended 20).' },
      },
    },
  },
];

export async function runMcpServer(): Promise<void> {
  const store = new PlanReviewStore(loadConfig());

  const write = (obj: unknown): void => {
    process.stdout.write(`${JSON.stringify(obj)}\n`);
  };

  const handle = async (msg: RpcRequest): Promise<unknown | undefined> => {
    if (!msg || typeof msg.method !== 'string') return undefined;
    if (msg.method === 'ping') {
      return {};
    }
    if (msg.method === 'initialize') {
      const requested = String((msg.params as { protocolVersion?: string } | undefined)?.protocolVersion ?? '');
      return {
        // Echo the client's requested version when present — maximizes
        // compatibility across MCP clients (pi adapter, Claude Desktop, …).
        protocolVersion: requested || '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: APP_NAME, version: APP_VERSION },
      };
    }
    if (msg.method.startsWith('notifications/')) return undefined;
    if (msg.method === 'tools/list') return { tools: TOOLS };
    if (msg.method === 'tools/call') {
      const name = String(msg.params?.name ?? '');
      const args = (msg.params?.arguments ?? {}) as Record<string, unknown>;
      try {
        return await callTool(store, name, args);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return toolError(message);
      }
    }
    return { error: { code: -32601, message: `Method not found: ${msg.method}` } };
  };

  let buffer = '';
  let closed = false;
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buffer += chunk;
    let idx: number;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      void (async () => {
        let msg: RpcRequest;
        try {
          msg = JSON.parse(line) as RpcRequest;
        } catch {
          return;
        }
        const result = await handle(msg);
        if (result === undefined) return;
        if (msg.id !== undefined && msg.id !== null) {
          write({ jsonrpc: '2.0', id: msg.id, result });
        } else if ('error' in (result as object)) {
          write({ jsonrpc: '2.0', id: null, ...result });
        }
      })();
    }
  });
  process.stdin.on('end', () => {
    closed = true;
  });
  // Keep the process alive while stdin stays open.
  setInterval(() => {
    if (closed) process.exit(0);
  }, 1000).unref();

  async function callTool(store: PlanReviewStore, name: string, args: Record<string, unknown>): Promise<unknown> {
    if (name === 'plan_review_submit') return submit(store, args);
    if (name === 'plan_review_check') return check(store, args);
    return toolError(`Unknown tool: ${name}`);
  }

  async function submit(store: PlanReviewStore, args: Record<string, unknown>) {
    const cwd = typeof args.cwd === 'string' ? args.cwd : '';
    if (!cwd.trim()) return toolError('cwd is required');

    let serverWarning = '';
    await ensureServerRunning().catch((err: Error) => {
      // Recording and the check-loop work without the HTTP server (the store
      // is read directly); only the browser URL needs it. Surface the problem
      // instead of silently handing out a dead link.
      serverWarning = `WARNING: review UI unavailable — ${err.message}\n\n`;
    });

    const docs = Array.isArray(args.docs)
      ? (args.docs as { slug: string; title: string; parent?: string | null; markdown: string }[])
      : undefined;
    const markdown =
      typeof args.markdown === 'string'
        ? args.markdown
        : typeof args.plan === 'string'
          ? args.plan
          : undefined;

    try {
      const result = await store.recordPlan({
        cwd,
        name: typeof args.name === 'string' ? args.name : undefined,
        origin: 'mcp',
        markdown,
        docs,
      });
      if (!result.isLoser && !serverWarning) openBrowser(result.reviewUrl);
      return toolText(
        serverWarning +
        JSON.stringify(
          {
            reviewId: result.reviewId,
            reviewUrl: result.reviewUrl,
            projectKey: result.projectKey,
            version: result.version,
          },
          null,
          2,
        ) +
          '\n\nPlan submitted for human review. Call plan_review_check with wait_seconds=20 and keep polling until the status is approved or rejected.',
      );
    } catch (err) {
      if (err instanceof PlanValidationError) {
        return toolText(`The plan failed validation and was NOT recorded:\n${compileIssues(err.issues, 'plan_review_submit')}`);
      }
      throw err;
    }
  }

  async function check(store: PlanReviewStore, args: Record<string, unknown>) {
    const wait = Math.min(Math.max(Number(args.wait_seconds ?? 0) || 0, 0), 120);
    let review = await resolveReview(store, args);
    if (!review) {
      return toolText(JSON.stringify({ status: 'not_found' }) + '\n\nNo matching review found. Re-submit with plan_review_submit.');
    }

    const deadline = Date.now() + wait * 1000;
    while (review.status === 'pending' && Date.now() < deadline) {
      await sleep(300);
      review = (await store.getReview(review.id)) ?? review;
    }

    if (review.status === 'pending') {
      return toolText(
        `${JSON.stringify({ status: 'pending', reviewId: review.id })}\n\nStill pending — do not end your turn. Call plan_review_check again (wait_seconds=20).`,
      );
    }
    if (review.status === 'approved') {
      const notes = review.notes ? `\n\nApproval notes to incorporate:\n${review.notes}` : '';
      return toolText(
        `${JSON.stringify({ status: 'approved', reviewId: review.id })}\n\nThe human APPROVED the plan. Proceed with implementation.${notes}`,
      );
    }
    return toolText(
      `${JSON.stringify({ status: 'rejected', reviewId: review.id })}\n\nThe human REQUESTED CHANGES:\n${review.reason ?? ''}\n\nAddress every comment, then re-submit the revised plan via plan_review_submit.`,
    );
  }

  async function resolveReview(store: PlanReviewStore, args: Record<string, unknown>): Promise<Review | undefined> {
    if (typeof args.reviewId === 'string' && args.reviewId) {
      return (await store.getReview(args.reviewId)) ?? undefined;
    }
    const pending = await store.listReviews({ status: 'pending' });
    const match = pending.find((r) => r.cwd === process.cwd()) ?? pending[0];
    return match;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function toolText(text: string) {
  return { content: [{ type: 'text', text }] };
}

function toolError(message: string) {
  return { content: [{ type: 'text', text: message }], isError: true };
}
