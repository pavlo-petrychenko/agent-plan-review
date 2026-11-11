/**
 * HTTP routes added for the Herdr integration:
 *   - GET /api/reviews?terminal=<id> lists one terminal's reviews;
 *   - comment `range` is validated, persisted and returned untouched.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createApiRouter } from './router.js';
import { errorHandler } from './helpers.js';
import { PlanReviewStore } from '../store/store.js';
import type { Comment, MoveVersionsResponse, ProjectSummary, Review } from '../../shared/types.js';

let server: Server;
let base: string;
let store: PlanReviewStore;

before(async () => {
  process.env.AGENT_PLAN_REVIEW_NO_OPEN = '1'; // POST /plans must not pop a browser
  process.env.HERDR_APP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'apr-router-herdr-'));
  store = new PlanReviewStore({ home: fs.mkdtempSync(path.join(os.tmpdir(), 'apr-router-')), port: 4999 });
  const app = express();
  app.use(express.json());
  app.use('/api', createApiRouter(store));
  app.use(errorHandler);
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve());
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
});

after(() => {
  server.close();
});

function project(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'apr-router-proj-'));
}

test('GET /reviews?terminal= returns that terminal’s reviews, newest first, any status', async () => {
  const a1 = await store.recordPlan({
    cwd: project(),
    origin: 'mcp',
    markdown: '# A1\n',
    agent: { terminal: 'tA' },
  });
  await new Promise((r) => setTimeout(r, 5));
  const b1 = await store.recordPlan({
    cwd: project(),
    origin: 'mcp',
    markdown: '# B1\n',
    agent: { terminal: 'tB' },
  });
  await new Promise((r) => setTimeout(r, 5));
  const a2 = await store.recordPlan({
    cwd: project(),
    origin: 'mcp',
    markdown: '# A2\n',
    agent: { terminal: 'tA' },
  });
  await store.recordPlan({ cwd: project(), origin: 'mcp', markdown: '# none\n' });
  await store.decideReview(a1.reviewId, 'approve');

  const res = await fetch(`${base}/reviews?terminal=tA`);
  assert.equal(res.status, 200);
  const reviews = (await res.json()) as Review[];
  assert.deepEqual(
    reviews.map((r) => r.id),
    [a2.reviewId, a1.reviewId],
  );
  assert.deepEqual(
    reviews.map((r) => r.status),
    ['pending', 'approved'],
  );

  // The filter composes with the existing ones; without it nothing changes.
  const pendingA = (await (await fetch(`${base}/reviews?terminal=tA&status=pending`)).json()) as Review[];
  assert.deepEqual(
    pendingA.map((r) => r.id),
    [a2.reviewId],
  );
  const all = (await (await fetch(`${base}/reviews`)).json()) as Review[];
  assert.ok(all.length >= 4);
  assert.ok(all.some((r) => r.id === b1.reviewId));
  const none = (await (await fetch(`${base}/reviews?terminal=nobody`)).json()) as Review[];
  assert.deepEqual(none, []);
});

test('comment range round-trips through POST and GET; replies inherit it', async () => {
  const rec = await store.recordPlan({ cwd: project(), origin: 'mcp', markdown: '# Plan\n\nhello world\n' });
  const url = `${base}/projects/${encodeURIComponent(rec.projectKey)}/versions/${rec.version}/comments`;
  const created = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      line: 3,
      lineEnd: 3,
      quote: 'world',
      body: 'why world?',
      range: { start: 14, end: 19 },
    }),
  });
  assert.equal(created.status, 201);
  const root = (await created.json()) as Comment;
  assert.deepEqual(root.range, { start: 14, end: 19 });

  const reply = (await (
    await fetch(`${url}/${root.id}/replies`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ body: 'follow-up', range: { start: 0, end: 1 } }),
    })
  ).json()) as Comment;
  assert.deepEqual(reply.range, { start: 14, end: 19 }, 'a reply takes the root anchor');

  const listed = (await (await fetch(url)).json()) as { comments: Comment[] };
  assert.deepEqual(listed.comments.find((c) => c.id === root.id)?.range, { start: 14, end: 19 });

  // Without range nothing new is stored.
  const plain = (await (
    await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ body: 'general' }),
    })
  ).json()) as Comment;
  assert.equal('range' in plain, false);
});

test('a malformed comment range is a 400', async () => {
  const rec = await store.recordPlan({ cwd: project(), origin: 'mcp', markdown: '# Plan\n\nbody\n' });
  const url = `${base}/projects/${encodeURIComponent(rec.projectKey)}/versions/${rec.version}/comments`;
  for (const range of [
    { start: -1, end: 2 },
    { start: 3, end: 3 },
    { start: 1.5, end: 4 },
    { start: 0 },
    [0, 1],
    'x',
  ]) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ body: 'x', range }),
    });
    assert.equal(res.status, 400, JSON.stringify(range));
  }
});

const postJson = (url: string, body: unknown) =>
  fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

test('POST /plans routes by agentId/planId/newPlan; GET /projects?cwd= lists one worktree with its terminals', async () => {
  const cwd = project();
  const plan = (markdown: string, extra: object) => postJson(`${base}/plans`, { cwd, markdown, ...extra });
  const a = (await (await plan('# Alpha\n', { agentId: 'claude:a', agent: { terminal: 'tA' } })).json()) as { projectKey: string };
  const b = (await (await plan('# Beta\n', { agentId: 'claude:b' })).json()) as { projectKey: string };
  const c = (await (await plan('# Gamma\n', { agentId: 'claude:a', newPlan: true })).json()) as { projectKey: string };
  const back = (await (await plan('# Alpha 2\n', { planId: a.projectKey })).json()) as { projectKey: string; version: number };
  assert.equal(new Set([a.projectKey, b.projectKey, c.projectKey]).size, 3);
  assert.equal(back.projectKey, a.projectKey);
  assert.equal(back.version, 2);
  // a second worktree with a plan of its own
  await store.recordPlan({ cwd: project(), origin: 'mcp', markdown: '# Elsewhere\n', agentId: 'claude:z' });

  const listed = (await (await fetch(`${base}/projects?cwd=${encodeURIComponent(cwd)}`)).json()) as ProjectSummary[];
  assert.deepEqual(listed.map((p) => p.key).sort(), [a.projectKey, b.projectKey, c.projectKey].sort());
  assert.equal(listed.find((p) => p.key === a.projectKey)?.lastTerminal, 'tA');
  assert.equal(listed.find((p) => p.key === b.projectKey)?.lastTerminal, undefined);
  const everything = (await (await fetch(`${base}/projects`)).json()) as ProjectSummary[];
  assert.ok(everything.length > listed.length);

  const nothing = (await (await fetch(`${base}/projects?cwd=${encodeURIComponent(project())}`)).json()) as ProjectSummary[];
  assert.deepEqual(nothing, []);
});

test('POST /projects/:key/move with to "new-plan" moves the versions into a new plan of the worktree', async () => {
  const cwd = project();
  const one = await store.recordPlan({ cwd, origin: 'api', markdown: '# First\n\none' });
  await store.recordPlan({ cwd, origin: 'api', markdown: '# Second\n\ntwo' });

  const res = await postJson(`${base}/projects/${encodeURIComponent(one.projectKey)}/move`, { to: 'new-plan', versions: [2] });
  assert.equal(res.status, 200);
  const moved = (await res.json()) as MoveVersionsResponse;
  assert.match(moved.to, /\.p-[0-9a-f]{6}$/);
  assert.deepEqual(moved.moved, [{ from: 2, to: 1 }]);
  assert.equal(moved.sourceRemoved, false);

  const listed = (await (await fetch(`${base}/projects?cwd=${encodeURIComponent(cwd)}`)).json()) as ProjectSummary[];
  assert.equal(listed.length, 2);
  assert.equal(listed.find((p) => p.key === moved.to)?.plan?.title, 'Second');

  const missing = await postJson(`${base}/projects/nope/move`, { to: 'new-plan' });
  assert.equal(missing.status, 404);
});
