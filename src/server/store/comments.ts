import type { Comment, CreateCommentInput, Manifest, VersionInfo } from '../../shared/types.js';
import { MAX_QUOTE_LEN } from '../../shared/types.js';
import type { Layout } from './paths.js';
import { readJson, writeJson } from '../util/fs.js';

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

  /** Default document slug for new comments on a version. */
  defaultDoc(manifest?: Manifest): string {
    return manifest?.root ?? 'root';
  }
}

export type { VersionInfo };
