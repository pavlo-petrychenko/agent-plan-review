/**
 * MCP stdio server: `plan_review_submit` + `plan_review_check` (+ reply and
 * attach-image helpers).
 *
 * Newline-delimited JSON-RPC over stdin/stdout, hand-rolled to keep the
 * dependency footprint at zero. Submit validates and records through the
 * SAME store path as the hook, returns the review coordinates and opens the
 * browser. Check TRUE LONG-POLLS (returns the moment the decision lands;
 * wait_seconds is only a ceiling) and emits periodic progress notifications
 * so long calls survive client idle-timeouts. Loop-oriented guidance steers
 * agents toward ONE long call instead of a polling loop.
 */

import {
  APP_NAME,
  APP_VERSION,
  checkProgressIntervalMs,
  loadConfig,
  maxCheckWaitSeconds,
} from '../config.js';
import { PlanReviewStore } from '../store/store.js';
import { storePlanImage } from '../store/images.js';
import { ApiError, PlanValidationError } from '../util/errors.js';
import { sameProjectCwd } from '../util/project-cwd.js';
import { compileIssues } from '../../shared/compile.js';
import type { Comment, Review } from '../../shared/types.js';
import { ensureServerRunning } from './spawn-server.js';
import { openReview } from './browser.js';
import { agentFromEnv } from './herdr.js';
import { agentIdFrom, processAgentId } from '../agent-id.js';

interface RpcRequest {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: Record<string, unknown>;
}

const TOOLS = [
  {
    name: 'plan_review_resolve',
    description:
      'Mark a human comment thread resolved once you have answered it, or reopen it with resolved:false. ' +
      'Close a thread when it is genuinely dealt with — a question you answered, a change you made, a point ' +
      'you explained and the human did not push back. Do NOT resolve a thread to silence feedback you have not ' +
      'addressed; the human can always reopen it. Resolving stops the thread being delivered again and keeps it ' +
      'from carrying into your next version. Works on any review of the project, decided or still pending, so you ' +
      'can also clear threads while working through "request changes" before re-submitting.',
    inputSchema: {
      type: 'object',
      required: ['commentId'],
      properties: {
        reviewId: {
          type: 'string',
          description: 'Review id the thread belongs to; omit to use your newest pending review.',
        },
        commentId: {
          type: 'string',
          description: 'Thread root id (the threadId from plan_review_check newComments or the review UI).',
        },
        resolved: {
          type: 'boolean',
          description: 'true (default) marks the thread resolved; false reopens it.',
        },
      },
    },
  },
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
        cwd: {
          type: 'string',
          description:
            'Absolute path of the repo/worktree ROOT the plan belongs to (its git toplevel). Subdirectories are folded into the containing project automatically.',
        },
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
        images: {
          type: 'array',
          description:
            'Images to embed in the plan. Reference each one from the markdown as ![alt](image:<name>) and it is ' +
            'rewritten to a served URL. Screenshots are stored content-addressed, so re-submitting the same file ' +
            'costs nothing.',
          items: {
            type: 'object',
            required: ['name'],
            properties: {
              name: { type: 'string', description: 'Short handle used as image:<name> in the markdown.' },
              path: { type: 'string', description: 'Path to the image file (absolute, or relative to cwd).' },
              dataBase64: {
                type: 'string',
                description: 'Or the bytes inline as base64 (a data: URL is accepted).',
              },
            },
          },
        },
      },
    },
  },
  {
    name: 'plan_review_attach_image',
    description:
      'Store one image and get back a URL to embed in a plan (useful when the plan is composed after the ' +
      'screenshot was taken). Equivalent to passing images[] to plan_review_submit.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the image file (absolute, or relative to cwd).' },
        dataBase64: { type: 'string', description: 'Or the bytes inline as base64.' },
        name: { type: 'string', description: 'Optional handle, returned for convenience.' },
        cwd: {
          type: 'string',
          description: 'Base directory for a relative path. Defaults to the MCP server cwd.',
        },
      },
    },
  },
  {
    name: 'plan_review_check',
    description:
      'Wait for the human decision on a submitted plan. TRUE LONG-POLL: returns the moment the ' +
      'decision lands or wait_seconds elapses, whichever is first — so ONE long call beats a loop ' +
      'of short calls (recommended: wait_seconds=172800). It ALSO returns early only when the human ' +
      'chooses Ask agent on a comment thread: the result then has status "pending" with newComments — ' +
      'answer each via plan_review_reply (commentId = threadId), then call plan_review_check again. ' +
      'Comments added to the decision batch stay silent until approval or requested changes. If your ' +
      'harness moves the call to the background (Claude Code auto-backgrounds after ~2 min): do NOT ' +
      'call again and do NOT re-submit; the result arrives automatically when the human decides.',
    inputSchema: {
      type: 'object',
      properties: {
        reviewId: {
          type: 'string',
          description: 'Review id from plan_review_submit. Omit to use your newest pending review.',
        },
        wait_seconds: {
          type: 'number',
          description:
            'Max seconds to long-poll (default 0; ceiling AGENT_PLAN_REVIEW_MAX_WAIT, default 172800 = 48 h).',
        },
        since: {
          type: 'string',
          description:
            'Optional cursor from a previous check; omit — the server tracks what you have already seen.',
        },
      },
    },
  },
  {
    name: 'plan_review_reply',
    description:
      'Reply to an Ask agent comment thread on a pending plan review. Use the threadId from ' +
      'plan_review_check newComments. Decision-batch threads are not conversational until the ' +
      'human decides. Answer questions, explain trade-offs, and ask for clarification. Not every ' +
      'thread needs a plan change. After replying, call plan_review_check again to keep waiting for ' +
      'the decision or the next Ask.',
    inputSchema: {
      type: 'object',
      required: ['commentId', 'body'],
      properties: {
        reviewId: { type: 'string', description: 'Review id; omit to use your newest pending review.' },
        commentId: {
          type: 'string',
          description: 'threadId of the thread to reply to (from plan_review_check newComments).',
        },
        body: { type: 'string', description: 'Your reply text.' },
      },
    },
  },
];

export async function runMcpServer(): Promise<void> {
  const store = new PlanReviewStore(loadConfig());
  /** MCP client name from `initialize` clientInfo (e.g. "claude-code", "pi"). */
  let clientName: string | undefined;
  /** This process's agent id, fixed on first use so it stays stable for the process lifetime. */
  let ownAgentId: string | undefined;
  const myAgentId = (): string =>
    (ownAgentId ??= agentIdFrom({ env: process.env, harness: clientName }) ?? processAgentId());

  const write = (obj: unknown): void => {
    process.stdout.write(`${JSON.stringify(obj)}\n`);
  };

  const handle = async (msg: RpcRequest): Promise<unknown | undefined> => {
    if (!msg || typeof msg.method !== 'string') return undefined;
    if (msg.method === 'ping') {
      return {};
    }
    if (msg.method === 'initialize') {
      // Remember who we talk to: the client name becomes the review's harness.
      const info = (msg.params as { clientInfo?: { name?: unknown } } | undefined)?.clientInfo;
      if (typeof info?.name === 'string' && info.name.trim()) clientName = info.name.trim();
      const requested = String(
        (msg.params as { protocolVersion?: string } | undefined)?.protocolVersion ?? '',
      );
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
        return await callTool(store, name, args, msg.params?._meta as Record<string, unknown> | undefined);
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

  async function callTool(
    store: PlanReviewStore,
    name: string,
    args: Record<string, unknown>,
    meta?: Record<string, unknown>,
  ): Promise<unknown> {
    if (name === 'plan_review_submit') return submit(store, args);
    if (name === 'plan_review_check') return check(store, args, meta);
    if (name === 'plan_review_reply') return reply(store, args);
    if (name === 'plan_review_resolve') return resolveThread(store, args);
    if (name === 'plan_review_attach_image') return attachImage(store, args);
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
    const images = Array.isArray(args.images)
      ? (args.images as { name: string; path?: string; dataBase64?: string }[])
      : undefined;
    // Herdr terminal link (HC_TERMINAL_ID) — plain metadata, always recorded.
    const agent = agentFromEnv(clientName);
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
        agent,
        agentId: myAgentId(),
        markdown,
        docs,
        images,
      });
      if (!result.isLoser && !serverWarning) {
        openReview(result.reviewUrl, { home: store.config.home, terminal: agent?.terminal });
      }
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
          '\n\nPlan submitted for human review. Wait for the decision with ONE long call:\n' +
          'plan_review_check { "reviewId": "<id>", "wait_seconds": 172800 }. It is a true long-poll — it returns the moment the human decides, so one call is enough.\n' +
          '- If the human chooses Ask agent on a comment thread, that same call returns early with status "pending" and newComments: answer each with plan_review_reply { "reviewId": "<id>", "commentId": "<threadId>", "body": "..." }, then call plan_review_check again. These are a conversation — not every thread needs a plan change.\n' +
          '- Comments the human adds to the decision batch do not wake you. They arrive only in the final approved notes or requested-changes feedback.\n' +
          '- If your harness moves that call to the background (e.g. Claude Code after ~2 min), do NOT re-call and do NOT re-submit; you will be woken with the result.\n' +
          '- Never loop short waits; never re-submit while a review is pending.',
      );
    } catch (err) {
      if (err instanceof PlanValidationError) {
        return toolText(
          `The plan failed validation and was NOT recorded:\n${compileIssues(err.issues, 'plan_review_submit')}`,
        );
      }
      if (err instanceof ApiError) return toolText(`The plan was NOT recorded: ${err.message}`);
      throw err;
    }
  }

  /** Upload one image and hand back the URL/markdown to embed. */
  async function attachImage(store: PlanReviewStore, args: Record<string, unknown>) {
    const filePath = typeof args.path === 'string' && args.path.trim() ? args.path.trim() : undefined;
    const dataBase64 = typeof args.dataBase64 === 'string' && args.dataBase64 ? args.dataBase64 : undefined;
    const name = typeof args.name === 'string' && args.name.trim() ? args.name.trim() : 'image';
    const cwd = typeof args.cwd === 'string' && args.cwd.trim() ? args.cwd.trim() : undefined;
    if (!filePath && !dataBase64) return toolError('Provide path or dataBase64.');
    try {
      const stored = await storePlanImage(store.layout, { name, path: filePath, dataBase64 }, cwd);
      return toolText(
        `${JSON.stringify({ name, url: stored.url, bytes: stored.bytes, sha: stored.sha, contentType: stored.contentType }, null, 2)}\n\n` +
          `Embed it as ![${name === 'image' ? 'caption' : name}](${stored.url}) — or reference it as ![caption](image:${name}) and pass ` +
          `images: [{ name: "${name}", path: "…" }] to plan_review_submit.`,
      );
    } catch (err) {
      if (err instanceof ApiError) return toolText(`Image was NOT stored: ${err.message}`);
      throw err;
    }
  }

  async function check(
    store: PlanReviewStore,
    args: Record<string, unknown>,
    meta?: Record<string, unknown>,
  ) {
    const wait = Math.min(Math.max(Number(args.wait_seconds ?? 0) || 0, 0), maxCheckWaitSeconds());
    const since = typeof args.since === 'string' && args.since ? args.since : undefined;
    let review = await resolveReview(store, args);
    if (!review) {
      return toolText(
        JSON.stringify({ status: 'not_found' }) +
          '\n\nNo matching review found. Re-submit with plan_review_submit.',
      );
    }

    // Periodic progress notifications keep client idle-timeouts from reaping a
    // silent stdio connection mid-poll (Claude Code ~30 min watchdog, pi adapter
    // 10 min idle disconnect). Echo the client's token when it sent one;
    // otherwise synthesize one — unmatched tokens are dropped by clients.
    const token = (meta?.progressToken as string | number | undefined) ?? 'plan-review-keepalive';
    const intervalMs = checkProgressIntervalMs();
    const started = Date.now();
    const deadline = started + wait * 1000;
    let lastProgress = 0;
    while (review.status === 'pending') {
      const messages = await store.getReviewMessages(review.id, since);
      if (messages.comments.length > 0) {
        await store.markAgentCursor(review.id, messages.cursor);
        return pendingWithComments(review, messages.comments, messages.cursor);
      }

      const now = Date.now();
      if (now - lastProgress >= intervalMs && review.status === 'pending') {
        lastProgress = now;
        write({
          jsonrpc: '2.0',
          method: 'notifications/progress',
          params: {
            progressToken: token,
            progress: Math.round((now - started) / 1000),
            message: `plan_review_check still waiting for the human decision (${Math.round((now - started) / 1000)}s elapsed)`,
          },
        });
      }
      if (now >= deadline) break;
      await sleep(300);
      review = (await store.getReview(review.id)) ?? review;
    }

    if (review.status === 'pending') {
      return toolText(
        `${JSON.stringify({ status: 'pending', reviewId: review.id })}\n\nStill pending after ${wait}s. Call plan_review_check ONCE more with wait_seconds=172800 — never short-poll in a loop. Do not re-submit the plan.`,
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

  async function reply(store: PlanReviewStore, args: Record<string, unknown>) {
    const commentId = typeof args.commentId === 'string' ? args.commentId : '';
    const body = typeof args.body === 'string' ? args.body.trim() : '';
    if (!commentId)
      return toolError('commentId is required (the threadId from plan_review_check newComments)');
    if (!body) return toolError('body is required');

    const review = await resolveReview(store, args);
    if (!review) return toolError('No matching pending review found.');
    const target = await store.replyToReview(review.id, commentId, body);
    const created = target.comment;
    return toolText(
      `${JSON.stringify({ status: 'replied', commentId: created.parentId ?? created.id, version: target.version })}\n\n` +
        'Reply posted. Call plan_review_check again to keep waiting for the decision or the next Ask.',
    );
  }

  /**
   * Close (or reopen) a thread. Deliberately accepts a review in ANY status:
   * the useful cases are all outside a pending wait — clearing threads you just
   * addressed while working through "request changes", or closing one you
   * answered with plan_review_reply. It therefore never waits on a live
   * consumer, which is what lets it work on the blocking ExitPlanMode path too.
   */
  async function resolveThread(store: PlanReviewStore, args: Record<string, unknown>) {
    const commentId = typeof args.commentId === 'string' ? args.commentId.trim() : '';
    if (!commentId) return toolError('commentId is required (the thread root id)');
    const resolved = args.resolved !== false;

    const review = await resolveReview(store, args);
    if (!review) return toolError('No matching review found.');

    // Threads live on the version they were written on, and carry-forward keeps
    // the id — so route by comment id, not by the version on the review.
    const version = await store.findCommentVersion(review.projectKey, commentId);
    if (version == null) return toolError(`No thread ${commentId} in this project.`);
    try {
      const updated = await store.resolveComment(review.projectKey, version, commentId, resolved);
      return toolText(
        `${JSON.stringify({ status: resolved ? 'resolved' : 'reopened', commentId: updated.id, version })}\n\n` +
          (resolved
            ? 'Thread marked resolved. It will not be delivered again and will not carry into your next version. The human can still reopen it in the review UI.'
            : 'Thread reopened. It is live again — resolve it once it is genuinely dealt with.'),
      );
    } catch (err) {
      if (err instanceof ApiError) {
        return toolError(
          err.status === 404
            ? `${commentId} is not a thread root — pass the root id, not a reply id.`
            : err.message,
        );
      }
      throw err;
    }
  }

  async function resolveReview(
    store: PlanReviewStore,
    args: Record<string, unknown>,
  ): Promise<Review | undefined> {
    if (typeof args.reviewId === 'string' && args.reviewId) {
      return (await store.getReview(args.reviewId)) ?? undefined;
    }
    // Only this agent's own reviews: another agent's pending review in the same
    // cwd must never be waited on, answered or resolved by mistake. Reviews that
    // predate agent ids carry none and keep the old cwd match.
    const pending = await store.listReviews({ status: 'pending' });
    const me = myAgentId();
    const cwd = process.cwd();
    return pending.find((r) =>
      r.agentId
        ? r.agentId === me
        : sameProjectCwd(r.cwd, cwd) || (r.agentCwd != null && sameProjectCwd(r.agentCwd, cwd)),
    );
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Present new human messages as a conversation turn the agent can answer. */
function pendingWithComments(review: Review, comments: Comment[], cursor: string | null) {
  const messages = comments.map((c) => ({
    threadId: c.parentId ?? c.id,
    commentId: c.id,
    author: c.author,
    doc: c.doc,
    line: c.line,
    lineEnd: c.lineEnd,
    quote: c.quote,
    body: c.body,
    delivery: 'ask',
    createdAt: c.createdAt,
  }));
  return toolText(
    `${JSON.stringify({ status: 'pending', reviewId: review.id, cursor, newComments: messages }, null, 2)}\n\n` +
      'The human chose Ask agent. This is a DISCUSSION thread — answer with plan_review_reply ' +
      '{ "reviewId": "' +
      review.id +
      '", "commentId": "<threadId>", "body": "..." } for each. ' +
      'Then call plan_review_check again to keep waiting for the decision or the next Ask. ' +
      'Only revise and re-submit the plan if the discussion calls for a change.',
  );
}

function toolText(text: string) {
  return { content: [{ type: 'text', text }] };
}

function toolError(message: string) {
  return { content: [{ type: 'text', text: message }], isError: true };
}
