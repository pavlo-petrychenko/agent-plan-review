import type {
  Comment,
  CommentAuthor,
  CreateCommentInput,
  Manifest,
  VersionInfo,
} from '../../shared/types.js';
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

  /** Overwrite a version's comment file (used by cross-version carry-forward). */
  async writeAll(projectKey: string, n: number, comments: Comment[]): Promise<void> {
    if (comments.length === 0) {
      await removePath(this.layout.commentsFile(projectKey, n));
      return;
    }
    await writeJson(this.layout.commentsFile(projectKey, n), comments);
  }

  /**
   * Create a comment. A reply (`input.parentId`) inherits its anchor — doc,
   * line range, side/baseVersion and quote — from the thread root, so clients
   * only need to send `{ parentId, body }`.
   */
  async create(
    projectKey: string,
    n: number,
    input: CreateCommentInput,
    defaultDoc: string,
    author: CommentAuthor = 'me',
  ): Promise<Comment> {
    const comments = await this.list(projectKey, n);

    let anchor: Pick<Comment, 'doc' | 'line' | 'lineEnd' | 'side' | 'baseVersion' | 'quote'>;
    if (input.parentId != null) {
      const root = comments.find((c) => c.id === input.parentId);
      if (!root) throw new Error('Parent comment not found');
      anchor = {
        doc: root.doc,
        line: root.line,
        lineEnd: root.lineEnd,
        quote: root.quote,
        ...(root.side === 'old' ? { side: root.side, baseVersion: root.baseVersion } : {}),
      };
    } else {
      anchor = {
        doc: input.doc?.trim() || defaultDoc,
        line: input.line ?? null,
        lineEnd: input.lineEnd ?? null,
        quote: input.quote ? input.quote.slice(0, MAX_QUOTE_LEN) : null,
        ...(input.side === 'old' ? { side: input.side, baseVersion: input.baseVersion } : {}),
      };
    }

    const comment: Comment = {
      id: crypto.randomUUID(),
      ...anchor,
      body: input.body.trim(),
      author,
      createdAt: nextTimestamp(comments),
      ...(input.parentId != null ? { parentId: input.parentId } : {}),
    };
    comments.push(comment);
    await writeJson(this.layout.commentsFile(projectKey, n), comments);
    return comment;
  }

  /** Mark a thread root resolved/unresolved. Returns the updated comment. */
  async setResolved(projectKey: string, n: number, commentId: string, resolved: boolean): Promise<Comment | null> {
    const comments = await this.list(projectKey, n);
    const comment = comments.find((c) => c.id === commentId);
    if (!comment || comment.parentId != null) return null;
    if (resolved) {
      comment.resolved = true;
      comment.resolvedAt = new Date().toISOString();
    } else {
      delete comment.resolved;
      delete comment.resolvedAt;
    }
    await writeJson(this.layout.commentsFile(projectKey, n), comments);
    return comment;
  }

  async remove(projectKey: string, n: number, commentId: string): Promise<boolean> {
    const comments = await this.list(projectKey, n);
    // Deleting a root removes its replies too.
    const next = comments.filter((c) => c.id !== commentId && c.parentId !== commentId);
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

/**
 * A timestamp strictly greater than every existing comment's. Comments are
 * appended in order and the agent's conversation cursor compares timestamps, so
 * two comments written within the same millisecond must not tie.
 */
function nextTimestamp(comments: Comment[]): string {
  const now = Date.now();
  let last = 0;
  for (const c of comments) {
    const t = Date.parse(c.createdAt);
    if (Number.isFinite(t) && t > last) last = t;
  }
  return new Date(Math.max(now, last + 1)).toISOString();
}

export type { VersionInfo };
