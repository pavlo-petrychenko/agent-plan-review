/**
 * Thread grouping — pure helpers shared by the server (compilation) and the web
 * client (rendering). A thread is a root comment plus the replies pointing at
 * it via `parentId`; replies inherit the root's anchor.
 */

import type { Comment, CommentThreadView } from './types.js';

export function isThreadRoot(c: Comment): boolean {
  return c.parentId == null;
}

/** Group comments into threads, oldest root first and replies oldest first. */
export function groupThreads(comments: Comment[]): CommentThreadView[] {
  const roots = comments.filter(isThreadRoot);
  const byParent = new Map<string, Comment[]>();
  for (const c of comments) {
    if (c.parentId == null) continue;
    const bucket = byParent.get(c.parentId);
    if (bucket) bucket.push(c);
    else byParent.set(c.parentId, [c]);
  }
  const byTime = (a: Comment, b: Comment) => a.createdAt.localeCompare(b.createdAt);
  return roots
    .sort(byTime)
    .map((root) => ({ root, replies: (byParent.get(root.id) ?? []).sort(byTime) }));
}

/**
 * The message an unresolved thread contributes to agent feedback: the newest
 * human-authored message (a follow-up can supersede the original ask), falling
 * back to the root when it has no human replies.
 */
export function actionableMessage(thread: CommentThreadView): Comment {
  const human = thread.replies.filter((c) => c.author === 'me');
  return human.length > 0 ? human[human.length - 1] : thread.root;
}

/** Threads that still need the agent: unresolved and not last answered by it. */
export function isOpenThread(thread: CommentThreadView): boolean {
  return !thread.root.resolved;
}

/** Latest comment timestamp across a set of comments (ISO) or null. */
export function latestCreatedAt(comments: Comment[]): string | null {
  let latest: string | null = null;
  for (const c of comments) {
    if (latest == null || c.createdAt > latest) latest = c.createdAt;
  }
  return latest;
}
