import type { Comment, CreateCommentInput, Manifest, VersionInfo } from '../../shared/types.js';
import { MAX_QUOTE_LEN } from '../../shared/types.js';
import type { Layout } from './paths.js';
import { readJson, removePath, writeJson } from '../util/fs.js';

/** Comment persistence: one JSON file per version. */
export class CommentStore {
  constructor(private readonly layout: Layout) {}

  async list(projectKey: string, n: number, doc?: string): Promise<Comment[]> {
    const all = (await readJson<Comment[]>(this.layout.commentsFile(projectKey, n))) ?? [];
    return doc ? all.filter((c) => c.doc === doc) : all;
  }

  async create(projectKey: string, n: number, input: CreateCommentInput, defaultDoc: string): Promise<Comment> {
    const comments = await this.list(projectKey, n);
    const comment: Comment = {
      id: crypto.randomUUID(),
      doc: input.doc?.trim() || defaultDoc,
      line: input.line ?? null,
      lineEnd: input.lineEnd ?? null,
      quote: input.quote ? input.quote.slice(0, MAX_QUOTE_LEN) : null,
      body: input.body.trim(),
      author: 'me',
      createdAt: new Date().toISOString(),
      ...(input.side === 'old' ? { side: input.side, baseVersion: input.baseVersion } : {}),
    };
    comments.push(comment);
    await writeJson(this.layout.commentsFile(projectKey, n), comments);
    return comment;
  }

  async remove(projectKey: string, n: number, commentId: string): Promise<boolean> {
    const comments = await this.list(projectKey, n);
    const next = comments.filter((c) => c.id !== commentId);
    if (next.length === comments.length) return false;
    await writeJson(this.layout.commentsFile(projectKey, n), next);
    return true;
  }

  /** Carry a version's comments to another project/version (move between projects). */
  async move(fromKey: string, fromN: number, toKey: string, toN: number): Promise<number> {
    const comments = await this.list(fromKey, fromN);
    if (comments.length > 0) await writeJson(this.layout.commentsFile(toKey, toN), comments);
    await removePath(this.layout.commentsFile(fromKey, fromN));
    return comments.length;
  }

  /** Drop every comment on a version (used when its files are deleted). */
  async drop(projectKey: string, n: number): Promise<void> {
    await removePath(this.layout.commentsFile(projectKey, n));
  }

  /** Default document slug for new comments on a version. */
  defaultDoc(manifest?: Manifest): string {
    return manifest?.root ?? 'root';
  }
}

export type { VersionInfo };
