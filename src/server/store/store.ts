import type {
  BulkDeleteResponse,
  Comment,
  CreateCommentInput,
  DecisionResponse,
  DiffDocEntry,
  DiffDocStatus,
  DiffResponse,
  DocPayload,
  Manifest,
  MoveVersionsResponse,
  ProjectDetail,
  ProjectMeta,
  ProjectSummary,
  Review,
  ReviewMessagesPayload,
  VersionPayload,
} from '../../shared/types.js';
import { loadConfig, type ServerConfig } from '../config.js';
import { createLayout, type Layout } from './paths.js';
import { CommentStore } from './comments.js';
import { ProjectStore } from './projects.js';
import { ReviewStore, FORCE_REJECT_REASON, type ReviewFilter } from './reviews.js';
import { VersionStore } from './versions.js';
import { recordPlan, type RecordInput, type RecordOutput } from './record.js';
import { compileApproval, compileRejection } from '../../shared/compile.js';
import { actionableComments } from '../../shared/compile.js';
import { commentDelivery, groupThreads, latestCreatedAt } from '../../shared/threads.js';
import { renderMarkdown } from '../render/markdown.js';
import { conflict, notFound, badRequest } from '../util/errors.js';
import { withFileLock } from '../util/fs.js';
import { syncHerdrPointers, type HerdrScope } from '../integrations/herdr.js';
import {
  joinWorktreePlan,
  listWorktreePlans,
  readWorktreePlan,
  type PlanListEntry,
  type PlanSnapshot,
} from './sharing.js';
import { forgetProjectsUnlocked, type ForgetResult } from './forget.js';

/**
 * Facade over the storage layer used by API routes and integrations.
 * One instance per process; all methods are async and fs-backed.
 */
export class PlanReviewStore {
  readonly config: ServerConfig;
  readonly layout: Layout;
  readonly projects: ProjectStore;
  readonly versions: VersionStore;
  readonly comments: CommentStore;
  readonly reviews: ReviewStore;

  constructor(config: ServerConfig = loadConfig()) {
    this.config = config;
    this.layout = createLayout(config);
    this.projects = new ProjectStore(this.layout);
    this.versions = new VersionStore(this.layout);
    this.comments = new CommentStore(this.layout);
    this.reviews = new ReviewStore(this.layout);
  }

  recordPlan(input: RecordInput): Promise<RecordOutput> {
    return this.coordinate(async () => {
      const recorded = await this.recordPlanUnlocked(input);
      await this.syncHerdr({ reviewId: recorded.reviewId });
      return recorded;
    });
  }

  /** The plans of the worktree containing `cwd`, newest first; `mine` is relative to `agentId`. */
  listPlans(cwd: string, agentId: string): Promise<PlanListEntry[]> {
    return listWorktreePlans(this, cwd, agentId);
  }

  /** One plan of the worktree (markdown + open threads). Read only. */
  getPlan(cwd: string, planId: string, version?: number): Promise<PlanSnapshot> {
    return readWorktreePlan(this, cwd, planId, version);
  }

  /** Make `agentId` a participant of a plan; its next submit without `planId` lands there. */
  joinPlan(cwd: string, planId: string, agentId: string): Promise<ProjectMeta> {
    return this.coordinate(() => joinWorktreePlan(this, cwd, planId, agentId));
  }

  private recordPlanUnlocked(input: RecordInput): Promise<RecordOutput> {
    return recordPlan(this.layout, this.projects, this.reviews, this.config.port, input);
  }

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  async listProjects(): Promise<ProjectSummary[]> {
    const metas = await this.projects.list();
    const summaries: ProjectSummary[] = [];
    for (const meta of metas) {
      const versions = await this.versions.listMetas(meta.key);
      const pending = await this.reviews.pendingCount(meta.key);
      summaries.push({ ...meta, pending, versionCount: versions.length });
    }
    return summaries;
  }

  async getProjectDetail(key: string): Promise<ProjectDetail> {
    const meta = await this.projects.get(key);
    if (!meta) throw notFound('Project');
    const versions = await this.versions.listMetas(key);
    return { meta, versions };
  }

  async getVersionPayload(key: string, n: number): Promise<VersionPayload> {
    const meta = await this.versions.readMeta(key, n);
    if (!meta) throw notFound('Version');
    if (meta.kind === 'single') {
      const markdown = await this.versions.readMarkdown(key, n);
      const html = markdown != null ? renderMarkdown(markdown, new Set(['root'])) : undefined;
      return { n, kind: meta.kind, meta, markdown: markdown ?? '', html };
    }
    const manifest = await this.versions.readManifest(key, n);
    return { n, kind: meta.kind, meta, manifest: manifest ?? undefined };
  }

  async getDocPayload(key: string, n: number, slug: string): Promise<DocPayload> {
    const manifest = await this.versions.readManifest(key, n);
    if (!manifest) {
      // Single-doc versions behave as one implicit root document.
      const meta = await this.versions.readMeta(key, n);
      if (!meta || meta.kind !== 'single' || slug !== 'root') throw notFound('Document');
      const markdown = (await this.versions.readMarkdown(key, n)) ?? '';
      return {
        slug: 'root',
        title: 'Plan',
        parent: null,
        markdown,
        html: renderMarkdown(markdown, new Set(['root'])),
      };
    }
    const docMeta = manifest.docs.find((d) => d.slug === slug);
    if (!docMeta) throw notFound('Document');
    const markdown = await this.versions.readDoc(key, n, slug);
    if (markdown == null) throw notFound('Document');
    const slugs = new Set(manifest.docs.map((d) => d.slug));
    return { ...docMeta, markdown, html: renderMarkdown(markdown, slugs) };
  }

  async listComments(key: string, n: number, doc?: string): Promise<Comment[]> {
    return this.comments.list(key, n, doc);
  }

  /**
   * Human messages on a review the agent has not seen yet, for the conversation
   * loop. `since` defaults to the cursor already persisted on the review, so a
   * forgetful agent cannot be handed the same question twice.
   */
  async getReviewMessages(id: string, since?: string | null): Promise<ReviewMessagesPayload> {
    const review = await this.reviews.get(id);
    if (!review) throw notFound('Review');
    if (review.status !== 'pending') return { cursor: review.agentCursor ?? null, comments: [] };
    const all = await this.comments.list(review.projectKey, review.version);
    const resolvedRoots = new Set(all.filter((c) => c.parentId == null && c.resolved).map((c) => c.id));
    const asks = all.filter(
      (c) =>
        c.author === 'me' &&
        commentDelivery(c) === 'ask' &&
        c.wakeReviewId === id &&
        !resolvedRoots.has(c.parentId ?? c.id),
    );
    const cursor = since ?? review.agentCursor ?? null;
    const comments = cursor ? asks.filter((c) => c.createdAt > cursor) : asks;
    return { cursor: latestCreatedAt(comments) ?? cursor, comments };
  }

  /** Persist the conversation cursor after delivering messages to the agent. */
  async markAgentCursor(id: string, cursor: string | null): Promise<void> {
    return this.coordinate(() => this.markAgentCursorUnlocked(id, cursor));
  }

  private async markAgentCursorUnlocked(id: string, cursor: string | null): Promise<void> {
    if (!cursor) return;
    const review = await this.reviews.get(id);
    if (!review) throw notFound('Review');
    if (review.agentCursor != null && review.agentCursor >= cursor) return;
    await this.reviews.update(id, { agentCursor: cursor });
  }

  async addComment(key: string, n: number, input: CreateCommentInput): Promise<Comment> {
    return this.coordinate(async () => {
      const comment = await this.addCommentUnlocked(key, n, input);
      // Only an Ask reaches the agent; decision-batch comments stay silent.
      if (comment.wakeReviewId) await this.syncHerdr({ reviewId: comment.wakeReviewId });
      return comment;
    });
  }

  private async addCommentUnlocked(key: string, n: number, input: CreateCommentInput): Promise<Comment> {
    const delivery = input.delivery ?? 'decision';
    if (delivery !== 'ask' && delivery !== 'decision')
      throw badRequest('delivery must be "ask" or "decision"');
    const targetReviewId = input.reviewId;
    if (delivery === 'ask' && !targetReviewId) throw badRequest('reviewId is required for ask comments');
    if (targetReviewId) {
      const review = await this.reviews.get(targetReviewId);
      if (!review) throw notFound('Review');
      if (review.projectKey !== key || review.version !== n) {
        throw badRequest(
          delivery === 'ask'
            ? 'Ask review does not match this project version'
            : 'Review does not match this project version',
        );
      }
      if (review.status !== 'pending') throw conflict({ error: `Review is already ${review.status}` });
      // An Ask needs someone who will actually deliver it. Hook reviews are read
      // by the blocking ExitPlanMode hook, which returns control on the question
      // so the agent gets a turn to reply; mcp reviews are read by
      // plan_review_check. An api review has neither — the browser is the only
      // consumer — so it may still join a decision batch but never an Ask.
      if (delivery === 'ask' && review.origin !== 'mcp' && review.origin !== 'hook') {
        throw badRequest('Ask is only available for MCP and plan-mode hook reviews');
      }
    }
    const manifest = await this.versions.readManifest(key, n);
    try {
      return await this.comments.create(
        key,
        n,
        { ...input, delivery, reviewId: delivery === 'ask' ? targetReviewId : undefined },
        this.comments.defaultDoc(manifest ?? undefined),
        'me',
      );
    } catch (err) {
      throw mapParentError(err);
    }
  }

  /** Agent reply into an existing thread (author is set server-side). */
  async addAgentReply(key: string, n: number, rootId: string, body: string): Promise<Comment> {
    return this.coordinate(async () => {
      const comment = await this.createAgentReply(key, n, rootId, body);
      await this.syncHerdr({ projectKey: key, version: n });
      return comment;
    });
  }

  async replyToReview(
    reviewId: string,
    rootId: string,
    body: string,
  ): Promise<{ comment: Comment; version: number }> {
    return this.coordinate(async () => {
      const target = await this.reviewReplyTarget(reviewId, rootId);
      const comment = await this.createAgentReply(target.review.projectKey, target.version, rootId, body);
      await this.syncHerdr({ reviewId });
      return { comment, version: target.version };
    });
  }

  private async createAgentReply(key: string, n: number, rootId: string, body: string): Promise<Comment> {
    const manifest = await this.versions.readManifest(key, n);
    try {
      return await this.comments.create(
        key,
        n,
        { parentId: rootId, body },
        this.comments.defaultDoc(manifest ?? undefined),
        'agent',
      );
    } catch (err) {
      throw mapParentError(err);
    }
  }

  async reviewReplyTarget(reviewId: string, rootId: string): Promise<{ review: Review; version: number }> {
    const review = await this.reviews.get(reviewId);
    if (!review) throw notFound('Review');
    if (review.status !== 'pending') throw conflict({ error: `Review is already ${review.status}` });
    const version = await this.findCommentVersion(review.projectKey, rootId);
    if (version == null) throw notFound('Thread');
    const comments = await this.comments.list(review.projectKey, version);
    const thread = groupThreads(comments).find((candidate) => candidate.root.id === rootId);
    if (!thread) throw badRequest('commentId must be a thread root');
    const targetedAsk = [thread.root, ...thread.replies].some(
      (comment) =>
        comment.author === 'me' && commentDelivery(comment) === 'ask' && comment.wakeReviewId === review.id,
    );
    if (!targetedAsk) throw badRequest('Comment thread is not an Ask for this review');
    return { review, version };
  }

  /**
   * Which version of a project owns this comment id, newest first. Threads are
   * stored per version, so an agent answering a question must be routed to the
   * version the thread actually lives on — including the case where the human
   * is looking at a newer version than the one the thread was written on.
   */
  async findCommentVersion(key: string, commentId: string): Promise<number | null> {
    const detail = await this.getProjectDetail(key);
    const newestFirst = [...detail.versions].sort((a, b) => b.n - a.n);
    for (const v of newestFirst) {
      const comments = await this.comments.list(key, v.n);
      if (comments.some((c) => c.id === commentId)) return v.n;
    }
    return null;
  }

  async resolveComment(key: string, n: number, commentId: string, resolved: boolean): Promise<Comment> {
    return this.coordinate(async () => {
      const updated = await this.comments.setResolved(key, n, commentId, resolved);
      if (!updated) throw notFound('Thread');
      await this.syncHerdr({ projectKey: key, version: n });
      return updated;
    });
  }

  async deleteComment(key: string, n: number, commentId: string): Promise<void> {
    return this.coordinate(async () => {
      const ok = await this.comments.remove(key, n, commentId);
      if (!ok) throw notFound('Comment');
    });
  }

  /**
   * Whole-plan diff payload: every document of both sides, so the reviewer can
   * see all pages of a revision in one pass instead of switching documents.
   */
  async getDiffPayload(key: string, from: number, to: number): Promise<DiffResponse> {
    const [fromMeta, toMeta, fromManifest, toManifest] = await Promise.all([
      this.versions.readMeta(key, from),
      this.versions.readMeta(key, to),
      this.versions.readManifest(key, from),
      this.versions.readManifest(key, to),
    ]);
    if (!fromMeta) throw notFound('Version');
    if (!toMeta) throw notFound('Version');

    const fromDocs = await this.docBodies(key, from, fromMeta.kind, fromManifest);
    const toDocs = await this.docBodies(key, to, toMeta.kind, toManifest);

    // New-side order first, then documents that only exist on the base side.
    const slugs = [...toDocs.keys(), ...[...fromDocs.keys()].filter((s) => !toDocs.has(s))];
    const docs: DiffDocEntry[] = slugs.map((slug) => {
      const fromMd = fromDocs.get(slug);
      const toMd = toDocs.get(slug);
      const toDoc = toManifest?.docs.find((d) => d.slug === slug);
      const fromDoc = fromManifest?.docs.find((d) => d.slug === slug);
      const status: DiffDocStatus =
        fromMd == null ? 'added' : toMd == null ? 'removed' : fromMd === toMd ? 'unchanged' : 'modified';
      const entry: DiffDocEntry = {
        slug,
        title: (toMd == null ? fromDoc?.title : toDoc?.title) ?? (slug === 'root' ? 'Plan' : slug),
        parent: (toMd == null ? fromDoc?.parent : toDoc?.parent) ?? null,
        status,
      };
      if (status !== 'unchanged') {
        entry.from = fromMd ?? '';
        entry.to = toMd ?? '';
      }
      return entry;
    });

    return {
      from: { n: from, manifest: fromManifest ?? undefined },
      to: { n: to, manifest: toManifest ?? undefined },
      docs,
    };
  }

  /** slug → source text for one side of a diff (single versions act as `root`). */
  private async docBodies(
    key: string,
    n: number,
    kind: string,
    manifest: Manifest | null,
  ): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    if (kind === 'single' || !manifest) {
      map.set('root', (await this.versions.readMarkdown(key, n)) ?? '');
      return map;
    }
    for (const doc of manifest.docs) {
      map.set(doc.slug, (await this.versions.readDoc(key, n, doc.slug)) ?? '');
    }
    return map;
  }

  async getManifest(key: string, n: number): Promise<Manifest | null> {
    return this.versions.readManifest(key, n);
  }

  // -------------------------------------------------------------------------
  // Decisions
  // -------------------------------------------------------------------------

  /**
   * Resolve a review. The compiled reason/notes are built here so every
   * integration path produces identical agent-facing feedback.
   */
  async decideReview(
    id: string,
    decision: 'approve' | 'reject',
    summary?: string,
  ): Promise<DecisionResponse> {
    return this.coordinate(async () => {
      const decided = await this.decideReviewUnlocked(id, decision, summary);
      await this.syncHerdr({ reviewId: id });
      return decided;
    });
  }

  private async decideReviewUnlocked(
    id: string,
    decision: 'approve' | 'reject',
    summary?: string,
  ): Promise<DecisionResponse> {
    const review = await this.reviews.get(id);
    if (!review) throw notFound('Review');
    if (review.status !== 'pending') throw conflict({ error: `Review is already ${review.status}` });

    const storedComments = await this.comments.list(review.projectKey, review.version);
    const feedbackComments = storedComments.filter(
      (comment) => comment.decisionReviewId == null || comment.decisionReviewId === id,
    );
    const manifest = (await this.versions.readManifest(review.projectKey, review.version)) ?? undefined;
    // Diff-anchored comments can point at a base version's removed lines, so
    // the resolver needs that version's text too.
    const baseVersions = [
      ...new Set(
        feedbackComments.filter((c) => c.side === 'old' && c.baseVersion != null).map((c) => c.baseVersion!),
      ),
    ];
    const resolve = await this.lineSliceResolver(review.projectKey, review.version, manifest, baseVersions);

    let payload: { notes?: string; reason?: string };
    if (decision === 'approve') {
      payload = { notes: compileApproval(feedbackComments, manifest, resolve) || undefined };
    } else {
      // An optional human summary is stored as a general comment first so it
      // participates in compilation like any other note.
      if (summary?.trim()) {
        const created = await this.comments.create(
          review.projectKey,
          review.version,
          { body: summary.trim(), delivery: 'decision', decisionReviewId: id },
          manifest?.root ?? 'root',
        );
        feedbackComments.push(created);
      }
      const via = review.origin === 'hook' ? 'ExitPlanMode' : 'plan_review_submit';
      payload = { reason: compileRejection(feedbackComments, manifest, resolve, review.version, via) };
    }

    const updated = await this.reviews.decide(id, decision, payload);
    if (!updated) throw conflict({ error: 'Review already resolved' });
    return { review: updated, commentCount: actionableComments(feedbackComments).length };
  }

  private async lineSliceResolver(
    key: string,
    n: number,
    manifest?: Manifest,
    baseVersions: number[] = [],
  ): Promise<(doc: string, line: number, lineEnd: number, baseVersion?: number) => string | null> {
    // Pre-resolve every doc body once; the returned resolver is synchronous.
    const cache = new Map<string, string[]>();
    const load = async (version: number, manifestOf: Manifest | undefined): Promise<void> => {
      const docsToLoad = manifestOf ? manifestOf.docs.map((d) => d.slug) : ['root'];
      for (const slug of docsToLoad) {
        const raw =
          manifestOf == null
            ? await this.versions.readMarkdown(key, version)
            : await this.versions.readDoc(key, version, slug);
        if (raw != null) cache.set(`${version}:${slug}`, raw.split('\n'));
      }
    };
    await load(n, manifest);
    for (const base of baseVersions) {
      if (base === n) continue;
      const baseManifest = (await this.versions.readManifest(key, base)) ?? undefined;
      await load(base, baseManifest);
    }
    return (doc, line, lineEnd, baseVersion) => {
      const lines = cache.get(`${baseVersion ?? n}:${doc}`);
      if (!lines) return null;
      const slice = lines.slice(Math.max(0, line - 1), lineEnd);
      return slice.join('\n').trim() || null;
    };
  }

  // -------------------------------------------------------------------------
  // Deletion
  // -------------------------------------------------------------------------

  async deleteVersion(key: string, n: number, force: boolean): Promise<{ projectRemoved: boolean }> {
    const meta = await this.projects.get(key);
    if (!meta) throw notFound('Project');
    const versionMeta = await this.versions.readMeta(key, n);
    if (!versionMeta) throw notFound('Version');

    const pending = (await this.reviews.list({ status: 'pending', projectKey: key })).filter(
      (r) => r.version === n,
    );
    if (pending.length > 0 && !force) {
      throw conflict({ error: 'Version has pending reviews', pendingReviews: pending.length });
    }
    for (const r of pending) {
      await this.reviews.decide(r.id, 'reject', { reason: FORCE_REJECT_REASON });
      await this.syncHerdr({ reviewId: r.id });
    }

    await this.versions.deleteFiles(key, n);
    await this.comments.drop(key, n);
    const projectRemoved = await this.recomputeAfterDeletion(meta);
    return { projectRemoved };
  }

  /** Always-200 partial-success bulk deletion. */
  async bulkDeleteVersions(key: string, ns: number[], force: boolean): Promise<BulkDeleteResponse> {
    const meta = await this.projects.get(key);
    if (!meta) throw notFound('Project');

    const deleted: number[] = [];
    const blocked: { n: number; pendingReviews: number }[] = [];
    for (const n of ns) {
      const pending = (await this.reviews.list({ status: 'pending', projectKey: key })).filter(
        (r) => r.version === n,
      );
      if (pending.length > 0 && !force) {
        blocked.push({ n, pendingReviews: pending.length });
        continue;
      }
      for (const r of pending) {
        await this.reviews.decide(r.id, 'reject', { reason: FORCE_REJECT_REASON });
        await this.syncHerdr({ reviewId: r.id });
      }
      const versionMeta = await this.versions.readMeta(key, n);
      if (!versionMeta) {
        blocked.push({ n, pendingReviews: 0 });
        continue;
      }
      await this.versions.deleteFiles(key, n);
      await this.comments.drop(key, n);
      deleted.push(n);
    }

    const projectRemoved = await this.recomputeAfterDeletion(meta);
    const freshMeta = projectRemoved ? null : await this.projects.get(key);
    return { deleted, blocked, meta: freshMeta };
  }

  /**
   * Move versions (all of them by default) into another project, renumbering
   * them onto the target's sequence. Comments travel with their version and
   * reviews are re-pointed, so a pending decision still resolves correctly.
   * Used to repair plans that were recorded under a stray project key.
   */
  async moveVersions(fromKey: string, toKey: string, ns?: number[]): Promise<MoveVersionsResponse> {
    if (fromKey === toKey) throw badRequest('Source and target projects are the same');
    const fromMeta = await this.projects.get(fromKey);
    if (!fromMeta) throw notFound('Project');
    const toMeta = await this.projects.get(toKey);
    if (!toMeta) throw notFound('Target project');

    const available = await this.versions.listMetas(fromKey);
    const selected = ns && ns.length > 0 ? available.filter((v) => ns.includes(v.n)) : available;
    if (selected.length === 0) throw badRequest('No versions to move');

    let next = await this.versions.maxSurvivor(toKey);
    const moved: { from: number; to: number }[] = [];
    for (const version of selected) {
      next += 1;
      const manifest = version.kind === 'tree' ? await this.versions.readManifest(fromKey, version.n) : null;
      const docBodies = new Map<string, string>();
      if (manifest) {
        for (const doc of manifest.docs) {
          docBodies.set(doc.slug, (await this.versions.readDoc(fromKey, version.n, doc.slug)) ?? '');
        }
      }
      await this.versions.write(toKey, {
        n: next,
        kind: version.kind,
        hash: version.hash,
        createdAt: version.createdAt,
        markdown:
          version.kind === 'single'
            ? ((await this.versions.readMarkdown(fromKey, version.n)) ?? '')
            : undefined,
        manifest: manifest ?? undefined,
        docBodies,
      });
      await this.comments.move(fromKey, version.n, toKey, next);
      for (const review of await this.reviews.list({ projectKey: fromKey, version: version.n })) {
        await this.reviews.update(review.id, { projectKey: toKey, version: next });
      }
      await this.versions.deleteFiles(fromKey, version.n);
      moved.push({ from: version.n, to: next });
    }

    const sourceRemoved = await this.recomputeAfterDeletion(fromMeta);
    await this.recomputeAfterDeletion(toMeta);
    return { to: toKey, moved, sourceRemoved };
  }

  async deleteProject(key: string, force: boolean): Promise<void> {
    const meta = await this.projects.get(key);
    if (!meta) throw notFound('Project');
    const pending = await this.reviews.list({ status: 'pending', projectKey: key });
    if (pending.length > 0 && !force) {
      throw conflict({ error: 'Project has pending reviews', pendingReviews: pending.length });
    }
    for (const r of pending) {
      await this.reviews.decide(r.id, 'reject', { reason: FORCE_REJECT_REASON });
      await this.syncHerdr({ reviewId: r.id });
    }
    await this.projects.remove(key);
  }

  /**
   * Remove whole projects with everything that hangs off them: versions,
   * comments, their reviews, and plan images no surviving project uses. Unlike
   * `deleteProject` this neither refuses on pending reviews nor rejects them:
   * the worktree they belong to is gone, so they are simply removed.
   * With `dryRun` nothing is touched; the result says what would go.
   */
  forgetProjects(keys: string[], dryRun = false): Promise<ForgetResult> {
    return this.coordinate(() =>
      forgetProjectsUnlocked(this.layout, this.projects, this.reviews, keys, dryRun),
    );
  }

  /**
   * Recompute currentVersion/latestHash after deletions; remove the project
   * when no versions survive.
   */
  private async recomputeAfterDeletion(meta: ProjectMeta): Promise<boolean> {
    const survivors = await this.versions.listMetas(meta.key);
    if (survivors.length === 0) {
      await this.projects.remove(meta.key);
      return true;
    }
    const latest = survivors[survivors.length - 1];
    meta.currentVersion = latest.n;
    meta.latestHash = latest.hash;
    meta.updatedAt = new Date().toISOString();
    await this.projects.save(meta);
    return false;
  }

  // -------------------------------------------------------------------------
  // Reviews helpers
  // -------------------------------------------------------------------------

  listReviews(filter?: ReviewFilter): Promise<Review[]> {
    return this.reviews.list(filter);
  }

  getReview(id: string): Promise<Review | null> {
    return this.reviews.get(id);
  }

  async pruneResolved(): Promise<void> {
    return this.coordinate(() => this.reviews.pruneResolved());
  }

  /**
   * Refresh Herdr pointer files after a mutation. A no-op unless the Herdr
   * integration is enabled; never throws (see integrations/herdr.ts).
   */
  private syncHerdr(scope: HerdrScope): Promise<void> {
    return syncHerdrPointers(this, scope);
  }

  private coordinate<T>(fn: () => Promise<T>): Promise<T> {
    return withFileLock(this.layout.reviewFile('__coordination__'), fn);
  }
}

/** A reply whose thread root is gone is a 404, not a 500. */
function mapParentError(err: unknown): unknown {
  if (err instanceof Error && err.message === 'Parent comment not found') return notFound('Thread');
  if (err instanceof Error && err.message === 'Parent thread is resolved') {
    return badRequest('Reopen the thread before replying');
  }
  return err;
}
