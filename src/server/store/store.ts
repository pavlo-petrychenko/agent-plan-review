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
  ReviewStatus,
  VersionPayload,
} from '../../shared/types.js';
import { loadConfig, type ServerConfig } from '../config.js';
import { createLayout, type Layout } from './paths.js';
import { CommentStore } from './comments.js';
import { ProjectStore } from './projects.js';
import { ReviewStore, FORCE_REJECT_REASON } from './reviews.js';
import { VersionStore } from './versions.js';
import { recordPlan, type RecordInput, type RecordOutput } from './record.js';
import { compileApproval, compileRejection } from '../../shared/compile.js';
import { renderMarkdown } from '../render/markdown.js';
import { conflict, notFound, badRequest } from '../util/errors.js';

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
      return { slug: 'root', title: 'Plan', parent: null, markdown, html: renderMarkdown(markdown, new Set(['root'])) };
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

  async addComment(key: string, n: number, input: CreateCommentInput): Promise<Comment> {
    const manifest = await this.versions.readManifest(key, n);
    return this.comments.create(key, n, input, this.comments.defaultDoc(manifest ?? undefined));
  }

  async deleteComment(key: string, n: number, commentId: string): Promise<void> {
    const ok = await this.comments.remove(key, n, commentId);
    if (!ok) throw notFound('Comment');
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
  async decideReview(id: string, decision: 'approve' | 'reject', summary?: string): Promise<DecisionResponse> {
    const review = await this.reviews.get(id);
    if (!review) throw notFound('Review');
    if (review.status !== 'pending') throw conflict({ error: `Review is already ${review.status}` });

    const comments = await this.comments.list(review.projectKey, review.version);
    const manifest = (await this.versions.readManifest(review.projectKey, review.version)) ?? undefined;
    // Diff-anchored comments can point at a base version's removed lines, so
    // the resolver needs that version's text too.
    const baseVersions = [
      ...new Set(
        comments.filter((c) => c.side === 'old' && c.baseVersion != null).map((c) => c.baseVersion!),
      ),
    ];
    const resolve = await this.lineSliceResolver(review.projectKey, review.version, manifest, baseVersions);

    let payload: { notes?: string; reason?: string };
    if (decision === 'approve') {
      payload = { notes: compileApproval(comments, manifest, resolve) || undefined };
    } else {
      // An optional human summary is stored as a general comment first so it
      // participates in compilation like any other note.
      if (summary?.trim()) {
        const created = await this.comments.create(review.projectKey, review.version, { body: summary.trim() }, manifest?.root ?? 'root');
        comments.push(created);
      }
      const via = review.origin === 'hook' ? 'ExitPlanMode' : 'plan_review_submit';
      payload = { reason: compileRejection(comments, manifest, resolve, review.version, via) };
    }

    const updated = await this.reviews.decide(id, decision, payload);
    if (!updated) throw conflict({ error: 'Review already resolved' });
    return { review: updated, commentCount: comments.length };
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

    const pending = (await this.reviews.list({ status: 'pending', projectKey: key })).filter((r) => r.version === n);
    if (pending.length > 0 && !force) {
      throw conflict({ error: 'Version has pending reviews', pendingReviews: pending.length });
    }
    for (const r of pending) {
      await this.reviews.decide(r.id, 'reject', { reason: FORCE_REJECT_REASON });
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
      const pending = (await this.reviews.list({ status: 'pending', projectKey: key })).filter((r) => r.version === n);
      if (pending.length > 0 && !force) {
        blocked.push({ n, pendingReviews: pending.length });
        continue;
      }
      for (const r of pending) {
        await this.reviews.decide(r.id, 'reject', { reason: FORCE_REJECT_REASON });
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
          version.kind === 'single' ? ((await this.versions.readMarkdown(fromKey, version.n)) ?? '') : undefined,
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
    }
    await this.projects.remove(key);
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

  listReviews(filter?: { status?: ReviewStatus; projectKey?: string; version?: number }): Promise<Review[]> {
    return this.reviews.list(filter);
  }

  getReview(id: string): Promise<Review | null> {
    return this.reviews.get(id);
  }

  async pruneResolved(): Promise<void> {
    await this.reviews.pruneResolved();
  }
}
