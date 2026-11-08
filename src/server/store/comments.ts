import type {
  Comment,
  CommentAuthor,
  CreateCommentInput,
  Manifest,
  VersionInfo,
} from '../../shared/types.js';
import { MAX_QUOTE_LEN } from '../../shared/types.js';
import type { Layout } from './paths.js';
import { readJson, removePath, withFileLock, writeJson } from '../util/fs.js';

type StoredCommentInput = CreateCommentInput & { decisionReviewId?: string };

/** Comment persistence: one JSON file per version. */
export class CommentStore {
  constructor(private readonly layout: Layout) {}

  async list(projectKey: string, n: number, doc?: string): Promise<Comment[]> {
    return withFileLock(this.layout.commentsFile(projectKey, n), async () => {
      const all = (await readJson<Comment[]>(this.layout.commentsFile(projectKey, n))) ?? [];
      return doc ? all.filter((c) => c.doc === doc) : all;
    });
  }

  /** Overwrite a version's comment file (used by cross-version carry-forward). */
  async writeAll(projectKey: string, n: number, comments: Comment[]): Promise<void> {
    await withFileLock(this.layout.commentsFile(projectKey, n), async () => {
      if (comments.length === 0) {
        await removePath(this.layout.commentsFile(projectKey, n));
        return;
      }
      await writeJson(this.layout.commentsFile(projectKey, n), comments);
    });
  }

  /**
   * Create a comment. A reply (`input.parentId`) inherits its anchor — doc,
   * line range, side/baseVersion and quote — from the thread root, so clients
   * only need to send `{ parentId, body }`.
   */
  async create(
    projectKey: string,
    n: number,
    input: StoredCommentInput,
    defaultDoc: string,
    author: CommentAuthor = 'me',
  ): Promise<Comment> {
    return withFileLock(this.layout.commentsFile(projectKey, n), async () => {
      const comments = await this.list(projectKey, n);

      let anchor: Pick<Comment, 'doc' | 'line' | 'lineEnd' | 'side' | 'baseVersion' | 'quote' | 'range'>;
      if (input.parentId != null) {
        const root = comments.find((c) => c.id === input.parentId && c.parentId == null);
        if (!root) throw new Error('Parent comment not found');
        if (root.resolved) throw new Error('Parent thread is resolved');
        anchor = {
          doc: root.doc,
          line: root.line,
          lineEnd: root.lineEnd,
          quote: root.quote,
          ...(root.range ? { range: root.range } : {}),
          ...(root.side === 'old' ? { side: root.side, baseVersion: root.baseVersion } : {}),
        };
      } else {
        anchor = {
          doc: input.doc?.trim() || defaultDoc,
          line: input.line ?? null,
          lineEnd: input.lineEnd ?? null,
          quote: input.quote ? input.quote.slice(0, MAX_QUOTE_LEN) : null,
          ...(input.range ? { range: { start: input.range.start, end: input.range.end } } : {}),
          ...(input.side === 'old' ? { side: input.side, baseVersion: input.baseVersion } : {}),
        };
      }

      const comment: Comment = {
        id: crypto.randomUUID(),
        ...anchor,
        body: input.body.trim(),
        author,
        createdAt: nextTimestamp(comments),
        ...(author === 'me' ? { delivery: input.delivery ?? 'decision' } : {}),
        ...(author === 'me' && input.delivery === 'ask' && input.reviewId
          ? { wakeReviewId: input.reviewId }
          : {}),
        ...(author === 'me' && input.decisionReviewId ? { decisionReviewId: input.decisionReviewId } : {}),
        ...(input.parentId != null ? { parentId: input.parentId } : {}),
      };
      comments.push(comment);
      await writeJson(this.layout.commentsFile(projectKey, n), comments);
      return comment;
    });
  }

  /** Mark a thread root resolved/unresolved. Returns the updated comment. */
  async setResolved(
    projectKey: string,
    n: number,
    commentId: string,
    resolved: boolean,
  ): Promise<Comment | null> {
    return withFileLock(this.layout.commentsFile(projectKey, n), async () => {
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
    });
  }

  async remove(projectKey: string, n: number, commentId: string): Promise<boolean> {
    return withFileLock(this.layout.commentsFile(projectKey, n), async () => {
      const comments = await this.list(projectKey, n);
      const next = comments.filter((c) => c.id !== commentId && c.parentId !== commentId);
      if (next.length === comments.length) return false;
      await writeJson(this.layout.commentsFile(projectKey, n), next);
      return true;
    });
  }

  /** Carry a version's comments to another project/version (move between projects). */
  async move(fromKey: string, fromN: number, toKey: string, toN: number): Promise<number> {
    const files = [this.layout.commentsFile(fromKey, fromN), this.layout.commentsFile(toKey, toN)].sort();
    const run = async (): Promise<number> => {
      const comments = await this.list(fromKey, fromN);
      if (comments.length > 0) await writeJson(this.layout.commentsFile(toKey, toN), comments);
      await removePath(this.layout.commentsFile(fromKey, fromN));
      return comments.length;
    };
    if (files[0] === files[1]) return withFileLock(files[0], run);
    return withFileLock(files[0], () => withFileLock(files[1], run));
  }

  /** Drop every comment on a version (used when its files are deleted). */
  async drop(projectKey: string, n: number): Promise<void> {
    await withFileLock(this.layout.commentsFile(projectKey, n), () =>
      removePath(this.layout.commentsFile(projectKey, n)),
    );
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
