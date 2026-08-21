import type { Review, ReviewStatus } from '../../shared/types.js';
import { RESOLVED_TTL_MS } from '../config.js';
import type { Layout } from './paths.js';
import { ensureDir, listFiles, readJson, writeJson, removePath } from '../util/fs.js';

/**
 * Review persistence. Reviews are top-level (not nested per project) so the
 * pending-count rollups for every project are a single directory scan.
 */
export class ReviewStore {
  constructor(private readonly layout: Layout) {}

  async create(input: {
    projectKey: string;
    version: number;
    origin: Review['origin'];
    cwd: string;
    toolUseId?: string;
  }): Promise<Review> {
    const review: Review = {
      id: crypto.randomUUID(),
      status: 'pending',
      createdAt: new Date().toISOString(),
      ...input,
    };
    await ensureDir(this.layout.reviewsDir);
    await writeJson(this.layout.reviewFile(review.id), review);
    return review;
  }

  async get(id: string): Promise<Review | null> {
    return readJson<Review>(this.layout.reviewFile(id));
  }

  async update(id: string, patch: Partial<Review>): Promise<Review | null> {
    const current = await this.get(id);
    if (!current) return null;
    const next: Review = { ...current, ...patch };
    await writeJson(this.layout.reviewFile(id), next);
    return next;
  }

  /** Decide a pending review; returns null when it was not pending. */
  async decide(id: string, decision: 'approve' | 'reject', payload: { notes?: string; reason?: string }): Promise<Review | null> {
    const current = await this.get(id);
    if (!current || current.status !== 'pending') return null;
    return this.update(id, {
      status: decision === 'approve' ? 'approved' : 'rejected',
      resolvedAt: new Date().toISOString(),
      ...(decision === 'approve' ? { notes: payload.notes } : { reason: payload.reason }),
    });
  }

  async list(filter?: { status?: ReviewStatus; projectKey?: string; version?: number }): Promise<Review[]> {
    await ensureDir(this.layout.reviewsDir);
    const files = await listFiles(this.layout.reviewsDir);
    const reviews: Review[] = [];
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      const r = await readJson<Review>(`${this.layout.reviewsDir}/${f}`);
      if (!r) continue;
      if (filter?.status && r.status !== filter.status) continue;
      if (filter?.projectKey && r.projectKey !== filter.projectKey) continue;
      if (filter?.version != null && r.version !== filter.version) continue;
      reviews.push(r);
    }
    return reviews.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /** Count of pending reviews on a project version. */
  async pendingCount(projectKey: string, version?: number): Promise<number> {
    const pending = await this.list({ status: 'pending', projectKey });
    return version == null ? pending.length : pending.filter((r) => r.version === version).length;
  }

  /** Remove resolved reviews older than the TTL. Called opportunistically. */
  async pruneResolved(): Promise<void> {
    const cutoff = Date.now() - RESOLVED_TTL_MS;
    const files = await listFiles(this.layout.reviewsDir);
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      const file = `${this.layout.reviewsDir}/${f}`;
      const r = await readJson<Review>(file);
      if (!r || r.status === 'pending') continue;
      if (r.resolvedAt && Date.parse(r.resolvedAt) < cutoff) {
        await removePath(file);
      }
    }
  }
}

export const FORCE_REJECT_REASON =
  'This plan was deleted in the review UI — re-present or ask the user how to proceed.';
