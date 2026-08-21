import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Comment } from '../../../shared/types.js';
import { parseBlocks, type MdBlock } from './blocks.js';
import { CommentThread } from '../comments/CommentThread.js';
import { CommentComposer, type ComposerState } from '../comments/CommentComposer.js';
import { EmptyState, cx } from '../primitives.js';
import { IconChat } from '../icons.js';

export interface SectionFilter {
  start: number;
  end: number;
  label: string;
}

export interface PreviewPaneProps {
  html: string | undefined;
  loading: boolean;
  /** All comments for the active version+doc. */
  comments: Comment[];
  section: SectionFilter | null;
  /** Increment to open the general-note composer. */
  generalNoteTick?: number;
  onAddComment: (input: { body: string; quote: string | null; line: number | null; lineEnd: number | null }) => Promise<void>;
  onDeleteComment: (id: string) => void;
  onNavigateDoc: (slug: string) => void;
}

interface ThreadGroup {
  key: string;
  lineEnd: number;
  comments: Comment[];
}

export function PreviewPane({
  html,
  loading,
  comments,
  section,
  generalNoteTick = 0,
  onAddComment,
  onDeleteComment,
  onNavigateDoc,
}: PreviewPaneProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const blockRefs = useRef(new Map<number, HTMLDivElement>());
  const [composer, setComposer] = useState<ComposerState | null>(null);
  const [bubble, setBubble] = useState<{ x: number; y: number } | null>(null);
  const [pendingSelection, setPendingSelection] = useState<
    { quote: string; line: number; lineEnd: number } | null
  >(null);

  const blocks = useMemo(() => (html ? parseBlocks(html) : []), [html]);

  const lineComments = useMemo(() => comments.filter((c) => c.line != null), [comments]);
  const generalComments = useMemo(() => comments.filter((c) => c.line == null), [comments]);

  // Group line comments by their end line — threads hang off the end block.
  const threadsByEnd = useMemo(() => {
    const map = new Map<number, ThreadGroup[]>();
    for (const c of lineComments) {
      const end = c.lineEnd ?? c.line!;
      let groups = map.get(end);
      if (!groups) {
        groups = [];
        map.set(end, groups);
      }
      let group = groups.find((g) => g.key === `${c.doc}:${c.line}-${end}`);
      if (!group) {
        group = { key: `${c.doc}:${c.line}-${end}`, lineEnd: end, comments: [] };
        groups.push(group);
      }
      group.comments.push(c);
    }
    for (const groups of map.values()) {
      for (const g of groups) {
        g.comments.sort((a, b) => (a.line! - b.line!) || (a.createdAt.localeCompare(b.createdAt)));
      }
    }
    return map;
  }, [lineComments]);

  const commentedLines = useMemo(() => {
    return new Set(lineComments.flatMap((c) => range(c.line!, c.lineEnd ?? c.line!)));
  }, [lineComments]);

  const isVisible = useCallback(
    (block: MdBlock) => !section || (block.lineEnd >= section.start && block.lineStart < section.end),
    [section],
  );

  // Clear stale UI when content changes.
  useEffect(() => {
    setBubble(null);
    setPendingSelection(null);
    setComposer(null);
  }, [html]);

  // General-note requests open the composer centered, without a line anchor.
  useEffect(() => {
    if (generalNoteTick === 0) return;
    setComposer({
      x: Math.max(16, window.innerWidth / 2 - 190),
      y: Math.max(80, window.innerHeight / 2 - 160),
      quote: null,
      line: null,
      lineEnd: null,
    });
  }, [generalNoteTick]);

  // ---------------------------------------------------------------------------
  // selection → comment affordance
  // ---------------------------------------------------------------------------

  const handleMouseUp = useCallback(() => {
    // Let click handlers settle first.
    setTimeout(() => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
        setBubble(null);
        setPendingSelection(null);
        return;
      }
      const text = sel.toString();
      if (!text.trim()) {
        setBubble(null);
        return;
      }
      const range = sel.getRangeAt(0);
      const container = containerRef.current;
      if (!container || !container.contains(range.commonAncestorContainer)) {
        setBubble(null);
        return;
      }

      const anchorBlock = findBlock(sel.anchorNode);
      const focusBlock = findBlock(sel.focusNode);
      if (!anchorBlock || !focusBlock) {
        setBubble(null);
        return;
      }

      const first = anchorBlock.compareDocumentPosition(focusBlock) & Node.DOCUMENT_POSITION_FOLLOWING ? anchorBlock : focusBlock;
      const last = first === anchorBlock ? focusBlock : anchorBlock;

      const line = Number(first.getAttribute('data-line-start')) || 1;
      const lineEndRaw = Number(last.getAttribute('data-line-end'));
      const lineEnd = Number.isFinite(lineEndRaw) && lineEndRaw > 0 ? Math.max(lineEndRaw, line) : line;

      const rect = range.getBoundingClientRect();
      setPendingSelection({
        quote: normalizeQuote(text),
        line,
        lineEnd,
      });
      setBubble({
        x: rect.left + rect.width / 2 - 44,
        y: Math.max(8, rect.top - 46),
      });
    }, 10);
  }, []);

  const openComposer = useCallback(() => {
    if (!pendingSelection || !bubble) return;
    setComposer({
      x: bubble.x - 140,
      y: bubble.y + 40,
      quote: pendingSelection.quote,
      line: pendingSelection.line,
      lineEnd: pendingSelection.lineEnd,
    });
    setBubble(null);
    window.getSelection()?.removeAllRanges();
  }, [pendingSelection, bubble]);

  // ---------------------------------------------------------------------------
  // interactions
  // ---------------------------------------------------------------------------

  const handleClick = useCallback(
    (e: React.MouseEvent) => {
      const target = e.target as HTMLElement;
      const link = target.closest('a[data-doc-slug]') as HTMLAnchorElement | null;
      if (link) {
        e.preventDefault();
        onNavigateDoc(link.getAttribute('data-doc-slug')!);
      }
    },
    [onNavigateDoc],
  );

  const scrollToBlock = useCallback((lineEnd: number) => {
    for (const [, el] of blockRefs.current) {
      const ls = Number(el.dataset.ls);
      const le = Number(el.dataset.le);
      if (ls <= lineEnd && le >= lineEnd) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        el.classList.add('md-flash');
        setTimeout(() => el.classList.remove('md-flash'), 1200);
        return;
      }
    }
  }, []);

  if (loading && !html) {
    return (
      <div className="px-8 py-6">
        <div className="mx-auto max-w-[46rem] animate-pulse space-y-4">
          <div className="h-8 w-2/3 rounded-lg bg-surface-2" />
          <div className="h-4 w-full rounded bg-surface-2" />
          <div className="h-4 w-11/12 rounded bg-surface-2" />
          <div className="h-4 w-4/5 rounded bg-surface-2" />
          <div className="h-24 w-full rounded-xl bg-surface-2" />
          <div className="h-4 w-3/4 rounded bg-surface-2" />
        </div>
      </div>
    );
  }

  if (!html) {
    return (
      <EmptyState
        title="Nothing to preview"
        body="This document has no content."
      />
    );
  }

  // Blocks hidden by section filtering still need their threads suppressed.
  const visibleBlocks = blocks.filter(isVisible);

  return (
    <div className="relative flex h-full min-h-0 flex-col">
      <div
        ref={containerRef}
        className="preview-body mx-auto w-full max-w-[46rem] flex-1 overflow-y-auto px-8 pb-40 pt-8 max-md:px-5"
        onMouseUp={handleMouseUp}
        onClick={handleClick}
      >
        {visibleBlocks.length === 0 && section ? (
          <EmptyState title="Section out of range" body="The selected outline section has no rendered content." />
        ) : (
          visibleBlocks.map((block) => {
            const commented = intersects(commentedLines, block);
            const groups = threadsByEnd.get(block.lineEnd) ?? [];
            return (
              <Fragment key={block.index}>
                <div
                  ref={(el) => {
                    if (el) blockRefs.current.set(block.index, el);
                    else blockRefs.current.delete(block.index);
                  }}
                  data-ls={block.lineStart}
                  data-le={block.lineEnd}
                  className={cx('md-block-wrap', commented && 'md-commented')}
                  dangerouslySetInnerHTML={{ __html: block.html }}
                />
                {groups.map((group) => (
                  <CommentThread
                    key={group.key}
                    comments={group.comments}
                    onDelete={onDeleteComment}
                    onLocate={() => scrollToBlock(group.lineEnd)}
                  />
                ))}
              </Fragment>
            );
          })
        )}

        {/* Orphaned threads (range beyond last visible block) stay reachable
            when browsing the full document, but stay quiet while filtering. */}
        {!section &&
          [...threadsByEnd.entries()]
            .filter(([end]) => !visibleBlocks.some((b) => b.lineEnd === end))
            .sort((a, b) => a[0] - b[0])
            .map(([, groups]) =>
              groups.map((group) => (
                <CommentThread
                  key={`orphan-${group.key}`}
                  comments={group.comments}
                  onDelete={onDeleteComment}
                />
              )),
            )}

        {generalComments.length > 0 && (
          <div className="mt-14 border-t border-border pt-6">
            <h3 className="mb-3 font-serif text-[17px] font-semibold">General notes</h3>
            <CommentThread comments={generalComments} onDelete={onDeleteComment} compact />
          </div>
        )}
      </div>

      {/* Selection affordance */}
      {bubble && pendingSelection && (
        <button
          className="fixed z-30 flex animate-pop items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-[12.5px] font-medium text-accent-ink shadow-pop transition-transform hover:scale-[1.03]"
          style={{ left: bubble.x, top: bubble.y }}
          onClick={openComposer}
        >
          <IconChat className="h-3.5 w-3.5" />
          Comment
        </button>
      )}

      {/* Composer */}
      {composer && (
        <CommentComposer
          state={composer}
          onSubmit={async (body) => {
            await onAddComment({
              body,
              quote: composer.quote,
              line: composer.line,
              lineEnd: composer.lineEnd,
            });
            setComposer(null);
          }}
          onCancel={() => setComposer(null)}
        />
      )}
    </div>
  );
}

// -----------------------------------------------------------------------------
// helpers
// -----------------------------------------------------------------------------

function findBlock(node: Node | null): HTMLElement | null {
  let cur: Node | null = node;
  while (cur) {
    if (cur instanceof HTMLElement && cur.classList.contains('md-block')) return cur;
    cur = cur.parentNode;
  }
  return null;
}

function normalizeQuote(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, 2000);
}

function intersects(set: Set<number>, block: MdBlock): boolean {
  for (let l = block.lineStart; l <= block.lineEnd; l++) {
    if (set.has(l)) return true;
  }
  return false;
}

function range(from: number, to: number): number[] {
  const out: number[] = [];
  const cappedTo = Math.min(to, from + 400);
  for (let i = from; i <= cappedTo; i++) out.push(i);
  return out;
}
