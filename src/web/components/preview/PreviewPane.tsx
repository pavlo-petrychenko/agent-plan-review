import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Comment, CommentThreadView } from '../../../shared/types.js';
import { groupThreads } from '../../../shared/threads.js';
import { parseBlocks, type MdBlock } from './blocks.js';
import { CommentThread } from '../comments/CommentThread.js';
import { CommentComposer, type ComposerState } from '../comments/CommentComposer.js';
import { ImageLightbox } from './ImageLightbox.js';
import { EmptyState, cx } from '../primitives.js';
import { IconChat } from '../icons.js';
import { useTheme } from '../../state/theme.js';
import { renderMermaidBlocks } from './mermaid.js';

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
  onReply: (rootId: string, body: string) => Promise<void>;
  onResolve: (rootId: string, resolved: boolean) => void;
  onNavigateDoc: (slug: string) => void;
}

export function PreviewPane({
  html,
  loading,
  comments,
  section,
  generalNoteTick = 0,
  onAddComment,
  onDeleteComment,
  onReply,
  onResolve,
  onNavigateDoc,
}: PreviewPaneProps) {
  const { theme } = useTheme();
  const containerRef = useRef<HTMLDivElement>(null);
  const blockRefs = useRef(new Map<number, HTMLDivElement>());
  const [composer, setComposer] = useState<ComposerState | null>(null);
  const [bubble, setBubble] = useState<{ x: number; y: number } | null>(null);
  const [zoom, setZoom] = useState<{ src: string; alt: string; line: number | null } | null>(null);
  const [pendingSelection, setPendingSelection] = useState<
    { quote: string; line: number; lineEnd: number } | null
  >(null);

  const blocks = useMemo(() => (html ? parseBlocks(html) : []), [html]);

  const lineComments = useMemo(() => comments.filter((c) => c.line != null), [comments]);
  const generalComments = useMemo(() => comments.filter((c) => c.line == null), [comments]);

  // Threads group a root comment with its replies. Line threads hang off the
  // block their root ends on; general threads render at the bottom.
  const threadsByEnd = useMemo(() => {
    const map = new Map<number, CommentThreadView[]>();
    for (const thread of groupThreads(lineComments)) {
      const end = thread.root.lineEnd ?? thread.root.line!;
      const bucket = map.get(end);
      if (bucket) bucket.push(thread);
      else map.set(end, [thread]);
    }
    return map;
  }, [lineComments]);

  const generalThreads = useMemo(() => groupThreads(generalComments), [generalComments]);

  const commentedLines = useMemo(() => {
    // Resolved threads keep their card (below) but lose the tint: the highlight
    // answers "what is still open?", and a closed question is not.
    const closed = new Set(comments.filter((c) => c.resolved).map((c) => c.id));
    const active = lineComments.filter((c) => !closed.has(c.parentId ?? c.id));
    return new Set(active.flatMap((c) => range(c.line!, c.lineEnd ?? c.line!)));
  }, [lineComments, comments]);

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

  // Render ```mermaid code blocks in-place (no-ops when none present).
  // Depends on section/theme too: filtering remounts blocks, toggling the
  // theme should re-theme diagrams. React wipes our DOM edits whenever block
  // html changes, so stale renders can't accumulate.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    void renderMermaidBlocks(container, theme === 'dark').catch(() => {});
  }, [blocks, section, theme]);

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
      // Keep the affordance inside the reading pane: anchored to a selection near
      // the top it used to sit over the toolbar, and a wide selection could push
      // it off either edge.
      const paneTop = containerRef.current?.getBoundingClientRect().top ?? 0;
      setBubble({
        x: Math.min(Math.max(8, rect.left + rect.width / 2 - 44), Math.max(8, window.innerWidth - 118)),
        y: Math.max(paneTop + 8, rect.top - 46),
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
      // Images open in a viewer: a plan screenshot is unreadable at column width.
      if (target.tagName === 'IMG') {
        const img = target as HTMLImageElement;
        const block = img.closest('.md-block');
        setZoom({
          src: img.currentSrc || img.src,
          alt: img.alt,
          // Cap to the block's source range: a stable, useful caption.
          line: block ? Number(block.getAttribute('data-line-start')) || null : null,
        });
        return;
      }
      const link = target.closest('a[data-doc-slug]') as HTMLAnchorElement | null;
      if (link) {
        e.preventDefault();
        onNavigateDoc(link.getAttribute('data-doc-slug')!);
      }
    },
    [onNavigateDoc],
  );

  // Mark failed images so a broken link reads as a deliberate placeholder
  // instead of stray alt text. Keyed on `html` (React re-creates these nodes on
  // every content change). Repeated sweeps rather than event listeners alone:
  // a fast DNS failure can fire before we can listen, and a re-render can
  // replace the node the listener was attached to.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const sweep = (): void => {
      for (const img of el.querySelectorAll('img')) {
        if (img.complete && img.naturalWidth === 0) img.classList.add('md-img-broken');
      }
    };
    sweep();
    const interval = setInterval(sweep, 250);
    const stop = setTimeout(() => clearInterval(interval), 6000);
    return () => {
      clearInterval(interval);
      clearTimeout(stop);
    };
  }, [html]);

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
            const threads = threadsByEnd.get(block.lineEnd) ?? [];
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
                {threads.map((thread) => (
                  <CommentThread
                    key={thread.root.id}
                    thread={thread}
                    onDelete={onDeleteComment}
                    onReply={onReply}
                    onResolve={onResolve}
                    onLocate={() => scrollToBlock(thread.root.lineEnd ?? block.lineEnd)}
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
            .map(([, threads]) =>
              threads.map((thread) => (
                <CommentThread
                  key={`orphan-${thread.root.id}`}
                  thread={thread}
                  onDelete={onDeleteComment}
                  onReply={onReply}
                  onResolve={onResolve}
                />
              )),
            )}

        {generalThreads.length > 0 && (
          <div className="mt-14 border-t border-border pt-6">
            <h3 className="mb-3 font-serif text-[17px] font-semibold">General notes</h3>
            <div className="flex flex-col">
              {generalThreads.map((thread) => (
                <CommentThread
                  key={thread.root.id}
                  thread={thread}
                  onDelete={onDeleteComment}
                  onReply={onReply}
                  onResolve={onResolve}
                  compact
                />
              ))}
            </div>
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
      {zoom && <ImageLightbox src={zoom.src} alt={zoom.alt} line={zoom.line} onClose={() => setZoom(null)} />}
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
