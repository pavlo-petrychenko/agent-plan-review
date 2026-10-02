import { Router } from 'express';
import path from 'node:path';
import type { CreateCommentInput } from '../../shared/types.js';
import type { PlanReviewStore } from '../store/store.js';
import { APP_VERSION } from '../config.js';
import { gistReadiness, saveGist, GistError } from '../channels/gist.js';
import { badRequest, conflict, notFound } from '../util/errors.js';
import { forceFlag, parseVersionParam, wrap } from './helpers.js';
import { IMAGE_FILE_RE, contentTypeFor, storePlanImage } from '../store/images.js';
import { renderCommentBody } from '../render/comments.js';

/** Assemble the full /api router. */
export function createApiRouter(store: PlanReviewStore): Router {
  const api = Router();

  // -------------------------------------------------------------------------
  // system
  // -------------------------------------------------------------------------
  api.get('/health', (_req, res) => {
    // `home` lets integrations verify they are talking to an instance sharing
    // their storage root, not a foreign instance that happens to own the port.
    res.json({ ok: true, home: store.config.home });
  });

  api.get('/version', (_req, res) => {
    res.json({ version: APP_VERSION });
  });

  api.get('/channels', wrap(async (_req, res) => {
    res.json([await gistReadiness()]);
  }));

  // -------------------------------------------------------------------------
  // plan images (content-addressed; referenced from markdown as /api/images/<f>)
  // -------------------------------------------------------------------------
  api.post('/images', wrap(async (req, res) => {
    const body = req.body ?? {};
    const source = typeof body.dataBase64 === 'string' && body.dataBase64
      ? { name: typeof body.name === 'string' ? body.name : 'image', dataBase64: body.dataBase64 }
      : null;
    if (!source) throw badRequest('body.dataBase64 is required (optionally with body.name).');
    const stored = await storePlanImage(store.layout, source);
    res.status(201).json(stored);
  }));

  api.get('/images/:file', wrap(async (req, res) => {
    const file = req.params.file;
    if (!IMAGE_FILE_RE.test(file)) throw notFound('Image');
    res.type(contentTypeFor(file));
    // Content-addressed: the bytes behind a name never change.
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.sendFile(path.join(store.layout.imagesDir, file));
  }));

  // -------------------------------------------------------------------------
  // projects
  // -------------------------------------------------------------------------
  api.get('/projects', wrap(async (_req, res) => {
    await store.pruneResolved();
    res.json(await store.listProjects());
  }));

  api.get('/projects/:key', wrap(async (req, res) => {
    res.json(await store.getProjectDetail(req.params.key));
  }));

  api.delete('/projects/:key', wrap(async (req, res) => {
    await store.deleteProject(req.params.key, forceFlag(req));
    res.json({ ok: true });
  }));

  api.post('/projects/:key/move', wrap(async (req, res) => {
    const to = req.body?.to;
    if (typeof to !== 'string' || !to.trim()) throw badRequest('body.to (target project key) is required');
    const versions = req.body?.versions;
    if (
      versions != null &&
      (!Array.isArray(versions) || versions.some((v) => !Number.isInteger(v)))
    ) {
      throw badRequest('body.versions must be an array of integers when provided');
    }
    res.json(await store.moveVersions(req.params.key, to.trim(), versions as number[] | undefined));
  }));

  api.post('/projects/:key/bulk-delete', wrap(async (req, res) => {
    const versions = req.body?.versions;
    if (!Array.isArray(versions) || versions.some((v) => !Number.isInteger(v))) {
      throw badRequest('body.versions must be an array of integers');
    }
    const result = await store.bulkDeleteVersions(req.params.key, versions as number[], Boolean(req.body?.force));
    // Partial success is always a 200 — the payload tells the story.
    res.json(result);
  }));

  // -------------------------------------------------------------------------
  // storage channels
  // -------------------------------------------------------------------------
  api.get('/projects/:key/storage', wrap(async (req, res) => {
    const detail = await store.getProjectDetail(req.params.key);
    res.json({ gist: detail.meta.storage?.gist ?? null });
  }));

  api.post('/projects/:key/versions/:n/save', wrap(async (req, res) => {
    const key = req.params.key;
    const n = parseVersionParam(req.params.n);
    const { channel, description, filename } = req.body ?? {};
    if (channel !== 'gist') throw badRequest('Unknown channel');
    if (typeof filename !== 'string' || !filename.trim()) throw badRequest('filename is required');

    const readiness = await gistReadiness();
    if (!readiness.ready) {
      throw conflict({ error: readiness.reason ?? 'Channel not ready', fixCommand: readiness.fixCommand, fixUrl: readiness.fixUrl });
    }

    const detail = await store.getProjectDetail(key);
    const versionMeta = detail.versions.find((v) => v.n === n);
    if (!versionMeta) throw notFound('Version');

    const content =
      versionMeta.kind === 'single'
        ? (await store.getVersionPayload(key, n)).markdown ?? ''
        : await composeTreeMarkdown(key, n, store);

    try {
      const { binding, created } = await saveGist(detail.meta.storage?.gist, {
        description: typeof description === 'string' && description.trim() ? description.trim() : `${detail.meta.name} — plan`,
        filename: filename.trim(),
        content,
      });
      binding.savedVersion = n;
      binding.savedAt = new Date().toISOString();
      await store.projects.setGistBinding(key, binding);
      res.json({ ...binding, created });
    } catch (err) {
      if (err instanceof GistError) {
        throw conflict({ error: err.message, fixCommand: err.fixCommand });
      }
      throw err;
    }
  }));

  // -------------------------------------------------------------------------
  // versions
  // -------------------------------------------------------------------------
  api.get('/projects/:key/versions/:n', wrap(async (req, res) => {
    res.json(await store.getVersionPayload(req.params.key, parseVersionParam(req.params.n)));
  }));

  api.delete('/projects/:key/versions/:n', wrap(async (req, res) => {
    await store.deleteVersion(req.params.key, parseVersionParam(req.params.n), forceFlag(req));
    res.json({ ok: true });
  }));

  api.get('/projects/:key/versions/:n/docs/:slug', wrap(async (req, res) => {
    res.json(await store.getDocPayload(req.params.key, parseVersionParam(req.params.n), req.params.slug));
  }));

  // -------------------------------------------------------------------------
  // comments
  // -------------------------------------------------------------------------
  api.get('/projects/:key/versions/:n/comments', wrap(async (req, res) => {
    const doc = typeof req.query.doc === 'string' ? req.query.doc : undefined;
    const comments = await store.listComments(req.params.key, parseVersionParam(req.params.n), doc);
    // Bodies are markdown (humans and agents both write it). `html` is derived for
    // display only and never persisted; raw HTML inside a body is dropped.
    res.json({ comments: comments.map((c) => ({ ...c, html: renderCommentBody(c.body) })) });
  }));

  api.post('/projects/:key/versions/:n/comments', wrap(async (req, res) => {
    const body = validateCommentBody(req.body);
    const comment = await store.addComment(req.params.key, parseVersionParam(req.params.n), body);
    res.status(201).json(comment);
  }));

  api.delete('/projects/:key/versions/:n/comments/:id', wrap(async (req, res) => {
    await store.deleteComment(req.params.key, parseVersionParam(req.params.n), req.params.id);
    res.json({ ok: true });
  }));

  // Human reply into a thread — anchor inherited from the root.
  api.post('/projects/:key/versions/:n/comments/:id/replies', wrap(async (req, res) => {
    const body = validateCommentBody(req.body);
    const comment = await store.addComment(req.params.key, parseVersionParam(req.params.n), {
      ...body,
      parentId: req.params.id,
    });
    res.status(201).json(comment);
  }));

  // Resolve/unresolve a thread root.
  api.post('/projects/:key/versions/:n/comments/:id/resolve', wrap(async (req, res) => {
    const resolved = req.body?.resolved !== false;
    res.json(await store.resolveComment(req.params.key, parseVersionParam(req.params.n), req.params.id, resolved));
  }));

  // -------------------------------------------------------------------------
  // diff
  // -------------------------------------------------------------------------
  api.get('/projects/:key/diff', wrap(async (req, res) => {
    const key = req.params.key;
    const from = Number.parseInt(String(req.query.from ?? ''), 10);
    const to = Number.parseInt(String(req.query.to ?? ''), 10);
    if (!Number.isInteger(from) || !Number.isInteger(to)) throw badRequest('from and to are required integers');
    res.json(await store.getDiffPayload(key, from, to));
  }));

  // -------------------------------------------------------------------------
  // plans (tools-first creation fallback)
  // -------------------------------------------------------------------------
  api.post('/plans', wrap(async (req, res) => {
    const { cwd, markdown, plan, docs, name, images } = req.body ?? {};
    if (typeof cwd !== 'string' || !cwd.trim()) throw badRequest('cwd is required');
    const source = docs ? { docs } : typeof markdown === 'string' ? { markdown } : typeof plan === 'string' ? { markdown: plan } : null;
    if (!source) throw badRequest('Provide one of: docs[], markdown, plan');
    if (images != null && !Array.isArray(images)) throw badRequest('images must be an array of { name, path | dataBase64 }');

    const result = await store.recordPlan({
      cwd,
      name,
      origin: 'api',
      markdown: source.markdown,
      docs: source.docs,
      images,
    });
    if (!result.isLoser) {
      const { openBrowser } = await import('../integrations/browser.js');
      openBrowser(result.reviewUrl);
    }
    res.status(201).json(result);
  }));

  // -------------------------------------------------------------------------
  // reviews
  // -------------------------------------------------------------------------
  api.get('/reviews', wrap(async (req, res) => {
    const filter: Parameters<PlanReviewStore['listReviews']>[0] = {};
    if (typeof req.query.project === 'string') filter.projectKey = req.query.project;
    if (typeof req.query.version === 'string' && req.query.version !== '') filter.version = Number.parseInt(req.query.version, 10);
    if (typeof req.query.status === 'string') filter.status = req.query.status as never;
    res.json(await store.listReviews(filter));
  }));

  api.get('/reviews/pending', wrap(async (_req, res) => {
    res.json(await store.listReviews({ status: 'pending' }));
  }));

  api.get('/reviews/:id', wrap(async (req, res) => {
    const review = await store.getReview(req.params.id);
    if (!review) throw notFound('Review');
    res.json(review);
  }));

  api.post('/reviews/:id/decision', wrap(async (req, res) => {
    const decision = req.body?.decision;
    if (decision !== 'approve' && decision !== 'reject') throw badRequest('decision must be "approve" or "reject"');
    const summary = typeof req.body?.summary === 'string' ? req.body.summary : undefined;
    res.json(await store.decideReview(req.params.id, decision, summary));
  }));

  // -------------------------------------------------------------------------
  // agent conversation (thread replies) — author is set server-side
  // -------------------------------------------------------------------------
  api.get('/reviews/:id/messages', wrap(async (req, res) => {
    const since = typeof req.query.since === 'string' && req.query.since ? req.query.since : undefined;
    res.json(await store.getReviewMessages(req.params.id, since));
  }));

  api.post('/reviews/:id/replies', wrap(async (req, res) => {
    const review = await store.getReview(req.params.id);
    if (!review) throw notFound('Review');
    const commentId = typeof req.body?.commentId === 'string' ? req.body.commentId : '';
    const body = typeof req.body?.body === 'string' ? req.body.body.trim() : '';
    if (!commentId) throw badRequest('commentId is required');
    if (!body) throw badRequest('body is required');
    const { comment } = await store.replyToReview(review.id, commentId, body);
    res.status(201).json(comment);
  }));

  return api;
}

// -----------------------------------------------------------------------------
// helpers
// -----------------------------------------------------------------------------

function validateCommentBody(body: unknown): CreateCommentInput {
  const b = body as Record<string, unknown>;
  if (typeof b?.body !== 'string' || !b.body.trim()) throw badRequest('Comment body is required');
  if (b.delivery != null && b.delivery !== 'ask' && b.delivery !== 'decision') {
    throw badRequest('delivery must be "ask" or "decision"');
  }
  const line = b.line == null ? null : Number(b.line);
  const lineEnd = b.lineEnd == null ? null : Number(b.lineEnd);
  for (const [label, v] of [['line', line], ['lineEnd', lineEnd]] as const) {
    if (v != null && (!Number.isInteger(v) || v < 1)) throw badRequest(`${label} must be a positive integer`);
  }
  if (line != null && lineEnd != null && lineEnd < line) throw badRequest('lineEnd must be ≥ line');

  const side = b.side === 'old' || b.side === 'new' ? b.side : undefined;
  const baseVersion = b.baseVersion == null ? undefined : Number(b.baseVersion);
  if (baseVersion != null && (!Number.isInteger(baseVersion) || baseVersion < 1)) {
    throw badRequest('baseVersion must be a positive integer');
  }
  if (side === 'old' && baseVersion == null) {
    throw badRequest('baseVersion is required for old-side (removed-line) comments');
  }

  return {
    doc: typeof b.doc === 'string' ? b.doc : undefined,
    line,
    lineEnd,
    quote: typeof b.quote === 'string' ? b.quote : null,
    body: b.body,
    delivery: b.delivery === 'ask' || b.delivery === 'decision' ? b.delivery : undefined,
    reviewId: typeof b.reviewId === 'string' && b.reviewId ? b.reviewId : undefined,
    side,
    baseVersion,
  };
}

async function composeTreeMarkdown(key: string, n: number, store: PlanReviewStore): Promise<string> {
  const payload = await store.getVersionPayload(key, n);
  const manifest = payload.manifest;
  if (!manifest) return '';
  const parts: string[] = [];
  for (const doc of manifest.docs) {
    const md = await store.getDocPayload(key, n, doc.slug).then((d) => d.markdown);
    if (doc.slug === manifest.root) {
      // The root document is the preamble — no marker needed.
      parts.push(md);
    } else {
      parts.push(`<!--doc slug=${doc.slug} title="${doc.title}"${doc.parent ? ` parent=${doc.parent}` : ''}-->\n\n${md}`);
    }
  }
  return parts.join('\n\n');
}
