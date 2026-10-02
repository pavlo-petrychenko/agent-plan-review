/**
 * Cross-version thread carry-forward.
 *
 * When a new version is recorded, open threads from the version it revises are
 * copied onto it, re-anchored through the line diff (an unchanged line maps
 * old→new; a rewritten line falls back to the nearest surviving line before it,
 * and a vanished one becomes a general thread). Resolved threads stay behind as
 * history, and a comment id is never duplicated onto a version that already has
 * it.
 *
 * Removed-line (`side: 'old'`) threads travel too: a comment on a deleted line
 * is still a question the agent must answer, and leaving it behind made it
 * unanswerable (`Thread not found`). A carried anchor always refers to the NEW
 * version's own lines, so `side`/`baseVersion` are dropped on the way.
 */

import type { Comment } from '../../shared/types.js';
import { diffTexts, toViewRows } from '../../shared/differ.js';
import type { CommentStore } from './comments.js';
import type { VersionStore } from './versions.js';

export async function carryOpenThreads(args: {
  comments: CommentStore;
  versions: VersionStore;
  key: string;
  fromN: number;
  toN: number;
  toKind: 'single' | 'tree';
  /** New-side doc bodies by slug ('root' for single-doc versions). */
  toBodies: Map<string, string>;
}): Promise<number> {
  const { comments, versions, key, fromN, toN, toKind, toBodies } = args;
  const all = await comments.list(key, fromN);
  if (all.length === 0) return 0;

  const roots = all.filter((c) => c.parentId == null && !c.resolved && c.decisionReviewId == null);
  if (roots.length === 0) return 0;
  const repliesByRoot = new Map<string, Comment[]>();
  for (const c of all) {
    if (c.parentId == null) continue;
    const bucket = repliesByRoot.get(c.parentId);
    if (bucket) bucket.push(c);
    else repliesByRoot.set(c.parentId, [c]);
  }

  const maps = new Map<string, Map<number, number>>();
  const loadMap = async (slug: string): Promise<Map<number, number> | null> => {
    const cached = maps.get(slug);
    if (cached) return cached;
    const toText = toBodies.get(slug);
    if (toText == null) return null; // document gone on the new side
    const fromText =
      toKind === 'tree'
        ? await versions.readDoc(key, fromN, slug)
        : await versions.readMarkdown(key, fromN);
    if (fromText == null) return null;
    const map = new Map<number, number>();
    // Split rows pair a rewritten line's old+new numbers, so a comment on an
    // edited line re-anchors to that same line instead of the one above it
    // (unified rows would leave modified lines unmapped).
    for (const row of toViewRows(diffTexts(fromText, toText), 'split')) {
      if (row.oldLine != null && row.newLine != null) map.set(row.oldLine, row.newLine);
    }
    maps.set(slug, map);
    return map;
  };

  const remap = (line: number | null, map: Map<number, number>): number | null => {
    if (line == null) return null;
    const exact = map.get(line);
    if (exact != null) return exact;
    for (let l = line - 1; l >= 1; l--) {
      const before = map.get(l);
      if (before != null) return before;
    }
    return null;
  };

  const carried: Comment[] = [];
  for (const root of roots) {
    const map = await loadMap(root.doc);
    if (!map) continue; // anchor's document no longer exists
    const line = remap(root.line, map);
    const lineEnd = line == null ? null : remap(root.lineEnd, map) ?? line;
    // A carried anchor now points at the NEW version's own lines: the old-side /
    // base-version framing described a line of a version that is no longer under
    // review, and keeping it would make replies resolve against the wrong side.
    const rebase = (c: Comment): Comment => ({
      ...c,
      line,
      lineEnd,
      side: undefined,
      baseVersion: undefined,
    });
    carried.push(rebase(root));
    for (const reply of repliesByRoot.get(root.id) ?? []) carried.push(rebase(reply));
  }

  if (carried.length === 0) return 0;
  await comments.writeAll(key, toN, carried);
  return carried.filter((c) => c.parentId == null).length;
}
