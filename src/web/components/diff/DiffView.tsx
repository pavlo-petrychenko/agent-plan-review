import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createContext, useContext } from 'react';
import type { Comment, CommentThreadView, DiffDocEntry, DiffDocStatus, DiffResponse, VersionInfo } from '../../../shared/types.js';
import { groupThreads } from '../../../shared/threads.js';
import {
  computeHunks,
  diffSegments,
  diffTexts,
  toViewRows,
  type DiffSegment,
  type LineDiff,
  type ViewRow,
} from '../../../shared/differ.js';
import { useApi } from '../../api/cache.js';
import { endpoints, keys } from '../../api/endpoints.js';
import { EmptyState, ErrorNote, Pill, Select, Spinner, cx } from '../primitives.js';
import { IconChat, IconCheck, IconDiff, IconEye } from '../icons.js';
import { CommentComposer, type ComposerState } from '../comments/CommentComposer.js';
import { CommentThread } from '../comments/CommentThread.js';

export type DiffSide = 'old' | 'new';

export interface DiffCommentInput {
  doc: string;
  side: DiffSide;
  baseVersion?: number;
  line: number;
  lineEnd: number;
  quote: string | null;
  body: string;
}

/** A word-level selection resolved to a diff anchor. */
interface SelectionCommentArgs {
  doc: string;
  side: DiffSide;
  line: number;
  lineEnd: number;
  quote: string;
  x: number;
  y: number;
}

export interface DiffViewProps {
  projectKey: string;
  versions: VersionInfo[];
  activeVersion: number;
  /** Active doc slug; a sidebar page click retargets the page filter. */
  activeDoc: string | null;
  /** Every comment on the reviewed version (all docs). */
  comments: Comment[];
  onAddComment: (input: DiffCommentInput) => Promise<void>;
  onDeleteComment: (id: string) => void;
  onReply: (rootId: string, body: string) => Promise<void>;
  onResolve: (rootId: string, resolved: boolean) => void;
}

type Mode = 'split' | 'unified';

/** Slugs of pages marked reviewed for the current diff pair. */
const ViewedDocsContext = createContext<{
  viewed: Set<string>;
  toggle: (slug: string) => void;
}>({ viewed: new Set(), toggle: () => {} });

/**
 * Per-page "viewed" flags for one diff pair, persisted in localStorage so the
 * review survives reloads. The key includes the diff pair, so switching base
 * or target versions starts a fresh review pass.
 */
export function useViewedDocs(projectKey: string, from: number | null, to: number | null) {
  const pairKey = from != null && to != null ? `${projectKey}:${from}:${to}` : null;
  const [viewed, setViewed] = useState<Set<string>>(() => readViewed(pairKey));

  useEffect(() => {
    setViewed(readViewed(pairKey));
  }, [pairKey]);

  const toggle = useCallback(
    (slug: string) => {
      if (!pairKey) return;
      setViewed((prev) => {
        const next = new Set(prev);
        if (next.has(slug)) next.delete(slug);
        else next.add(slug);
        writeViewed(pairKey, next);
        return next;
      });
    },
    [pairKey],
  );

  return { viewed, toggleViewed: toggle };
}

const VIEWED_PREFIX = 'plan-review.viewed:';

function readViewed(pairKey: string | null): Set<string> {
  if (!pairKey) return new Set();
  try {
    const raw = window.localStorage.getItem(VIEWED_PREFIX + pairKey);
    return raw ? new Set(JSON.parse(raw) as string[]) : new Set();
  } catch {
    return new Set();
  }
}

function writeViewed(pairKey: string, viewed: Set<string>): void {
  try {
    window.localStorage.setItem(VIEWED_PREFIX + pairKey, JSON.stringify([...viewed]));
  } catch {
    // Storage full or unavailable — viewed state just won't persist.
  }
}

/**
 * Version diff, GitHub "files changed" style: every page of the plan in one
 * scroll, each changed page collapsed to hunks of ±3 context lines, with
 * comment affordances on both the removed and the added side.
 */
export function DiffView({
  projectKey,
  versions,
  activeVersion,
  activeDoc,
  comments,
  onAddComment,
  onDeleteComment,
  onReply,
  onResolve,
}: DiffViewProps) {
  const others = versions.filter((v) => v.n !== activeVersion);
  const [base, setBase] = useState<number | null>(null);
  const [mode, setMode] = useState<Mode>('split');
  const [docFilter, setDocFilter] = useState<'all' | string>('all');
  const [gapOverride, setGapOverride] = useState<Map<string, boolean>>(new Map());
  const [collapsedDocs, setCollapsedDocs] = useState<Set<string>>(new Set());
  const [composer, setComposer] = useState<{ state: ComposerState; doc: string; side: DiffSide } | null>(null);
  const [bubble, setBubble] = useState<{ x: number; y: number; args: SelectionCommentArgs } | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const fromVersion =
    base ?? others.find((v) => v.n === activeVersion - 1)?.n ?? others[others.length - 1]?.n ?? null;

  const { viewed, toggleViewed } = useViewedDocs(projectKey, fromVersion, activeVersion);

  const { data, loading, error, reload } = useApi<DiffResponse>(
    fromVersion != null ? keys.diff(projectKey, fromVersion, activeVersion) : null,
    () => endpoints.getDiff(projectKey, fromVersion!, activeVersion),
  );

  // Picking a page in the sidebar filters the diff; "All pages" stays local.
  const lastActiveDoc = useRef(activeDoc);
  useEffect(() => {
    if (activeDoc === lastActiveDoc.current) return;
    lastActiveDoc.current = activeDoc;
    if (activeDoc) setDocFilter(activeDoc);
  }, [activeDoc]);

  const diffs = useMemo(() => {
    const map = new Map<string, LineDiff>();
    for (const entry of data?.docs ?? []) {
      if (entry.status === 'unchanged') continue;
      map.set(entry.slug, diffTexts(entry.from ?? '', entry.to ?? ''));
    }
    return map;
  }, [data]);

  const visibleDocs = useMemo(() => {
    const docs = data?.docs ?? [];
    const filtered = docFilter === 'all' ? docs : docs.filter((d) => d.slug === docFilter);
    // Changed pages first, untouched pages summarized at the end.
    return [
      ...filtered.filter((d) => d.status !== 'unchanged'),
      ...filtered.filter((d) => d.status === 'unchanged'),
    ];
  }, [data, docFilter]);

  const totals = useMemo(() => {
    let added = 0;
    let removed = 0;
    for (const diff of diffs.values()) {
      added += diff.stats.added;
      removed += diff.stats.removed;
    }
    return { added, removed };
  }, [diffs]);

  /** `${doc}:${side}:${line}` → comments anchored there. */
  const commentIndex = useMemo(() => {
    const map = new Map<string, Comment[]>();
    for (const c of comments) {
      if (c.line == null) continue;
      const side = commentSide(c);
      const end = Math.min(c.lineEnd ?? c.line, c.line + 400);
      for (let line = c.line; line <= end; line++) {
        const key = indexKey(c.doc, side, line);
        const bucket = map.get(key);
        if (bucket) bucket.push(c);
        else map.set(key, [c]);
      }
    }
    return map;
  }, [comments]);

  const toggleGap = useCallback((key: string, currentlyOpen: boolean) => {
    setGapOverride((prev) => new Map(prev).set(key, !currentlyOpen));
  }, []);

  const toggleDoc = useCallback((slug: string, collapsed: boolean) => {
    setCollapsedDocs((prev) => {
      const next = new Set(prev);
      if (collapsed) next.add(slug);
      else next.delete(slug);
      return next;
    });
  }, []);

  const openComposer = useCallback(
    (args: { doc: string; side: DiffSide; line: number; lineEnd: number; quote: string; x: number; y: number }) => {
      setComposer({
        doc: args.doc,
        side: args.side,
        state: { x: args.x, y: args.y, quote: args.quote, line: args.line, lineEnd: args.lineEnd },
      });
    },
    [],
  );

  // ---------------------------------------------------------------------------
  // selection → comment affordance (word-level, like the preview pane)
  // ---------------------------------------------------------------------------

  const handleMouseUp = useCallback(() => {
    // Let click handlers settle first.
    setTimeout(() => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
        setBubble(null);
        return;
      }
      const text = sel.toString();
      if (!text.trim()) {
        setBubble(null);
        return;
      }
      const range = sel.getRangeAt(0);
      const container = scrollRef.current;
      if (!container || !container.contains(range.commonAncestorContainer)) {
        setBubble(null);
        return;
      }

      const anchorCell = findCell(sel.anchorNode);
      const focusCell = findCell(sel.focusNode);
      if (!anchorCell || !focusCell) {
        setBubble(null);
        return;
      }

      // Side from the cell where the selection starts; a span that crosses
      // sides (shouldn't happen — gutter cells aren't selectable) is dropped.
      const side = anchorCell.dataset.side as DiffSide | undefined;
      if (!side || side !== focusCell.dataset.side) {
        setBubble(null);
        return;
      }

      const doc = anchorCell.closest<HTMLElement>('section[data-slug]')?.dataset.slug;
      if (!doc) {
        setBubble(null);
        return;
      }

      const lineOf = (cell: HTMLElement): number | null => {
        const raw = Number(cell.dataset.line);
        return Number.isFinite(raw) && raw > 0 ? raw : null;
      };
      const anchorLine = lineOf(anchorCell);
      const focusLine = lineOf(focusCell);
      if (anchorLine == null || focusLine == null) {
        setBubble(null);
        return;
      }
      const line = Math.min(anchorLine, focusLine);
      const lineEnd = Math.max(anchorLine, focusLine);

      const rect = range.getBoundingClientRect();
      setBubble({
        x: Math.min(Math.max(8, rect.left + rect.width / 2 - 44), Math.max(8, window.innerWidth - 118)),
        // Keep it below the scroll container's top edge, or it lands on the toolbar.
        y: Math.max((scrollRef.current?.getBoundingClientRect().top ?? 0) + 8, rect.top - 46),
        args: {
          doc,
          side,
          line,
          lineEnd,
          quote: text.replace(/\s+/g, ' ').trim().slice(0, 2000),
          x: rect.left + rect.width / 2 - 190,
          y: Math.max(8, rect.top - 46) + 40,
        },
      });
    }, 10);
  }, []);

  const openSelectionComposer = useCallback(() => {
    if (!bubble) return;
    openComposer(bubble.args);
    setBubble(null);
    window.getSelection()?.removeAllRanges();
  }, [bubble, openComposer]);

  // Clear stale affordances when the diff payload changes.
  useEffect(() => {
    setBubble(null);
  }, [data]);  if (versions.length <= 1) {
    return (
      <EmptyState
        icon={<IconDiff className="h-8 w-8" />}
        title="Nothing to diff yet"
        body="This is the only version of the plan. When Claude re-presents a revised plan it becomes v2 and you can compare the two here."
      />
    );
  }

  const changedCount = [...diffs.values()].filter((d) => d.stats.added + d.stats.removed > 0).length;

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* toolbar */}
      <div className="flex flex-wrap items-center gap-2 border-b border-border bg-surface-0 px-5 py-2.5 max-md:px-3">
        <span className="text-[12px] text-ink-faint">Comparing</span>
        <Select
          size="sm"
          value={fromVersion ?? ''}
          onChange={(e) => setBase(Number(e.target.value))}
          aria-label="Base version"
        >
          {others.map((v) => (
            <option key={v.n} value={v.n}>
              v{v.n}
            </option>
          ))}
        </Select>
        <IconDiff className="h-3.5 w-3.5 text-ink-faint" />
        <Pill tone="accent">v{activeVersion}</Pill>

        {(data?.docs.length ?? 0) > 1 && (
          <Select
            size="sm"
            value={docFilter}
            onChange={(e) => setDocFilter(e.target.value)}
            aria-label="Pages"
            className="max-w-[15rem]"
          >
            <option value="all">All pages</option>
            {(data?.docs ?? []).map((d) => (
              <option key={d.slug} value={d.slug}>
                {d.title}
              </option>
            ))}
          </Select>
        )}

        <span className="flex-1" />

        <span className="flex items-center gap-1.5 font-mono text-[11.5px]">
          {changedCount > 0 && (
            <span className="text-ink-faint">
              {changedCount} page{changedCount === 1 ? '' : 's'} changed
            </span>
          )}
          <span className="rounded-md bg-add-bg px-1.5 py-0.5 text-add-fg">+{totals.added}</span>
          <span className="rounded-md bg-del-bg px-1.5 py-0.5 text-del-fg">−{totals.removed}</span>
        </span>

        <div className="flex overflow-hidden rounded-lg border border-border">
          {(['split', 'unified'] as Mode[]).map((m) => (
            <button
              key={m}
              onClick={() => setMode(m)}
              className={cx(
                'px-2.5 py-1 text-[12px] font-medium capitalize transition-colors',
                mode === m ? 'bg-accent-soft text-accent' : 'bg-surface-1 text-ink-muted hover:bg-surface-2',
              )}
            >
              {m}
            </button>
          ))}
        </div>
      </div>

      {/* content —
        * The vertical padding lives on an inner wrapper, not on this scroll
        * container: padding on the scroller leaves a ~16px band exposed above
        * `position: sticky; top: 0` headers, so rows scroll through the gap
        * instead of disappearing under the stuck header. */}
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto px-5 max-md:px-2" onMouseUp={handleMouseUp}>
        <div className="py-4">
        {loading && !data && <Spinner label="Computing diff…" />}
        {error && <ErrorNote message={error} onRetry={reload} />}
        {data && changedCount === 0 && (
          <EmptyState
            icon={<IconEye className="h-8 w-8" />}
            title={`No changes between v${data.from.n} and v${data.to.n}`}
            body="Both versions render identical content for every page of this plan."
          />
        )}
        {data && changedCount > 0 && (
          <ViewedDocsContext.Provider value={{ viewed, toggle: toggleViewed }}>
            <div className="mx-auto flex max-w-full flex-col gap-5">
              {visibleDocs.map((entry) => (
                <DocSection
                  key={entry.slug}
                  entry={entry}
                  diff={diffs.get(entry.slug)}
                  mode={mode}
                  comments={comments.filter((c) => c.doc === entry.slug)}
                  commentIndex={commentIndex}
                  gapOverride={gapOverride}
                  onToggleGap={toggleGap}
                  collapsed={collapsedDocs.has(entry.slug)}
                  onSetCollapsed={(collapsed) => toggleDoc(entry.slug, collapsed)}
                  onComment={openComposer}
                  onDeleteComment={onDeleteComment}
                  onReply={onReply}
                  onResolve={onResolve}
                />
              ))}
            </div>
          </ViewedDocsContext.Provider>
        )}
        </div>
      </div>

      {/* Selection affordance */}
      {bubble && (
        <button
          className="fixed z-30 flex animate-pop items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-[12.5px] font-medium text-accent-ink shadow-pop transition-transform hover:scale-[1.03]"
          style={{ left: bubble.x, top: bubble.y }}
          onMouseDown={(e) => e.preventDefault()}
          onClick={openSelectionComposer}
        >
          <IconChat className="h-3.5 w-3.5" />
          Comment
        </button>
      )}

      {composer && (
        <CommentComposer
          state={composer.state}
          onSubmit={async (body) => {
            await onAddComment({
              doc: composer.doc,
              side: composer.side,
              baseVersion: composer.side === 'old' ? fromVersion ?? undefined : undefined,
              line: composer.state.line!,
              lineEnd: composer.state.lineEnd ?? composer.state.line!,
              quote: composer.state.quote,
              body,
            });
            setComposer(null);
          }}
          onCancel={() => setComposer(null)}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// one page of the diff
// ---------------------------------------------------------------------------

interface DocSectionProps {
  entry: DiffDocEntry;
  diff: LineDiff | undefined;
  mode: Mode;
  comments: Comment[];
  commentIndex: Map<string, Comment[]>;
  gapOverride: Map<string, boolean>;
  onToggleGap: (key: string, currentlyOpen: boolean) => void;
  collapsed: boolean;
  onSetCollapsed: (collapsed: boolean) => void;
  onComment: (args: {
    doc: string;
    side: DiffSide;
    line: number;
    lineEnd: number;
    quote: string;
    x: number;
    y: number;
  }) => void;
  onDeleteComment: (id: string) => void;
  onReply: (rootId: string, body: string) => Promise<void>;
  onResolve: (rootId: string, resolved: boolean) => void;
}

function DocSection({
  entry,
  diff,
  mode,
  comments,
  commentIndex,
  gapOverride,
  onToggleGap,
  collapsed,
  onSetCollapsed,
  onComment,
  onDeleteComment,
  onReply,
  onResolve,
}: DocSectionProps) {
  // Each mode hunks its own row list, so collapse offsets always index it.
  const rows = useMemo(() => (diff ? toViewRows(diff, mode) : []), [diff, mode]);
  const segments = useMemo(() => diffSegments(rows, computeHunks(rows)), [rows]);
  const general = comments.filter((c) => c.line == null);
  const unchanged = entry.status === 'unchanged';
  const { viewed, toggle } = useContext(ViewedDocsContext);
  const isViewed = viewed.has(entry.slug);

  // Threads render once, at the row their ROOT anchors to (replies inherit the
  // root's anchor, so a multi-line thread must not repeat on every row).
  const threadsByAnchor = useMemo(() => {
    const map = new Map<string, CommentThreadView[]>();
    for (const thread of groupThreads(comments.filter((c) => c.line != null))) {
      const key = indexKey(thread.root.doc, commentSide(thread.root), thread.root.line!);
      const bucket = map.get(key);
      if (bucket) bucket.push(thread);
      else map.set(key, [thread]);
    }
    return map;
  }, [comments]);
  const generalThreads = useMemo(() => groupThreads(general), [general]);
  // Only OPEN threads light up a line. A resolved thread still renders below (so
  // it can be read or reopened) but must stop claiming the line is under
  // discussion — the highlight is the reviewer's "still to do" signal.
  const activeIndex = useMemo(() => {
    const closed = new Set(comments.filter((c) => c.resolved).map((c) => c.id));
    const map = new Map<string, Comment[]>();
    for (const c of comments) {
      if (c.line == null) continue;
      if (closed.has(c.parentId ?? c.id)) continue;
      const side = commentSide(c);
      const end = Math.min(c.lineEnd ?? c.line, c.line + 400);
      for (let line = c.line; line <= end; line++) {
        const key = indexKey(c.doc, side, line);
        const bucket = map.get(key);
        if (bucket) bucket.push(c);
        else map.set(key, [c]);
      }
    }
    return map;
  }, [comments]);
  // Threads anchored to a line; needed for pages whose body is unchanged, where
  // there are no diff rows to hang them under.
  const anchoredThreads = useMemo(() => groupThreads(comments.filter((c) => c.line != null)), [comments]);
  const threadCount = anchoredThreads.length + generalThreads.length;

  // GitHub-style: marking a page reviewed also folds it away (and un-reviewing
  // reopens it), instead of leaving two independent per-page states.
  const handleViewedToggle = (): void => {
    const next = !isViewed;
    toggle(entry.slug);
    onSetCollapsed(next);
  };

  // Gaps that hide a comment open automatically so no thread is ever invisible.
  const autoOpenGaps = useMemo(() => {
    const open = new Set<number>();
    if (rows.length === 0 || comments.length === 0) return open;
    for (const segment of segments) {
      if (segment.kind !== 'gap') continue;
      if (hiddenComments(rows.slice(segment.start, segment.start + segment.count), entry.slug, commentIndex).length > 0) {
        open.add(segment.start);
      }
    }
    return open;
  }, [rows, segments, comments.length, commentIndex, entry.slug]);

  return (
    <section data-slug={entry.slug} className={cx('diff-doc rounded-xl border border-border bg-surface-1 shadow-card', isViewed && 'diff-doc-viewed')}>
      <header className="diff-doc-header">
        <button
          onClick={() => onSetCollapsed(!collapsed)}
          disabled={unchanged}
          className="text-ink-faint transition-colors hover:text-ink disabled:opacity-40"
          aria-label="Toggle page"
          aria-expanded={!collapsed}
        >
          <span className={cx('inline-block text-[10px] transition-transform', !collapsed && 'rotate-90')}>▶</span>
        </button>
        <span
          className="min-w-0 truncate text-[13.5px] font-semibold text-ink"
          title={entry.title}
        >
          {entry.title}
        </span>
        <span className="hidden font-mono text-[11px] text-ink-faint sm:inline">{entry.slug}</span>
        <StatusPill status={entry.status} />
        <span className="flex-1" />
        {diff && (
          <span className="flex items-center gap-1.5 font-mono text-[11.5px]">
            {diff.stats.added > 0 && (
              <span className="rounded-md bg-add-bg px-1.5 py-0.5 text-add-fg">+{diff.stats.added}</span>
            )}
            {diff.stats.removed > 0 && (
              <span className="rounded-md bg-del-bg px-1.5 py-0.5 text-del-fg">−{diff.stats.removed}</span>
            )}
          </span>
        )}
        {unchanged && <span className="text-[11.5px] text-ink-faint">no changes</span>}
        {collapsed && threadCount > 0 && (
          <span className="text-[11.5px] text-ink-faint">
            {threadCount} hidden thread{threadCount === 1 ? '' : 's'}
          </span>
        )}
        {!unchanged && (
          <ViewedButton viewed={isViewed} onToggle={handleViewedToggle} />
        )}
      </header>

      {!collapsed && diff && (
        <div className="overflow-x-auto">
          <table className="diff-table">
            <tbody>
              {segments.map((segment, i) => (
                <Fragment key={`${segment.kind}-${segment.start}-${i}`}>
                  {segment.kind === 'gap' ? (
                    <GapRow
                      segment={segment}
                      rows={rows}
                      doc={entry.slug}
                      mode={mode}
                      commentIndex={commentIndex}
                      open={gapOverride.get(gapKey(entry.slug, segment.start)) ?? autoOpenGaps.has(segment.start)}
                      onToggle={(open) => onToggleGap(gapKey(entry.slug, segment.start), open)}
                    />
                  ) : (
                    rows
                      .slice(segment.start, segment.end)
                      .map((row, offset) => (
                        <Fragment key={segment.start + offset}>
                          {mode === 'split' ? (
                            <SplitRow row={row} doc={entry.slug} commentIndex={activeIndex} onComment={onComment} />
                          ) : (
                            <UnifiedRow row={row} doc={entry.slug} commentIndex={activeIndex} onComment={onComment} />
                          )}
                          {threadRow({
                            row,
                            mode,
                            doc: entry.slug,
                            threadsByAnchor,
                            onDelete: onDeleteComment,
                            onReply,
                            onResolve,
                          })}
                        </Fragment>
                      ))
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {!collapsed && unchanged && anchoredThreads.length > 0 && (
        <div className="border-t border-border px-3.5 py-3">
          <h4 className="mb-2 text-[11.5px] font-semibold tracking-wide text-ink-faint uppercase">
            Comments on this page
          </h4>
          <div className="flex flex-col">
            {anchoredThreads.map((thread) => (
              <CommentThread
                key={thread.root.id}
                thread={thread}
                onDelete={onDeleteComment}
                onReply={onReply}
                onResolve={onResolve}
                label={thread.root.side === 'old' ? `removed in v${thread.root.baseVersion ?? '?'}` : undefined}
                compact
              />
            ))}
          </div>
        </div>
      )}

      {!collapsed && generalThreads.length > 0 && (
        <div className="border-t border-border px-3.5 py-3">
          <h4 className="mb-2 text-[11.5px] font-semibold tracking-wide text-ink-faint uppercase">General notes</h4>
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
    </section>
  );
}

function StatusPill({ status }: { status: DiffDocStatus }) {
  if (status === 'added') return <Pill tone="ok">added</Pill>;
  if (status === 'removed') return <Pill tone="danger">removed</Pill>;
  if (status === 'modified') return <Pill tone="accent">modified</Pill>;
  return <Pill tone="neutral">unchanged</Pill>;
}

/** "Mark as reviewed" toggle in the sticky page header, GitHub file-viewed style. */
function ViewedButton({ viewed, onToggle }: { viewed: boolean; onToggle: () => void }) {
  return (
    <button
      onClick={onToggle}
      className={cx(
        'diff-viewed-btn',
        viewed ? 'diff-viewed-btn-on' : 'diff-viewed-btn-off',
      )}
      title={viewed ? 'Mark as not reviewed' : 'Mark as reviewed'}
      aria-pressed={viewed}
    >
      <IconCheck className="h-3 w-3" />
      {viewed ? 'Reviewed' : 'Mark as reviewed'}
    </button>
  );
}

// ---------------------------------------------------------------------------
// rows
// ---------------------------------------------------------------------------

interface RowProps {
  row: ViewRow;
  doc: string;
  commentIndex: Map<string, Comment[]>;
  onComment: (args: {
    doc: string;
    side: DiffSide;
    line: number;
    lineEnd: number;
    quote: string;
    x: number;
    y: number;
  }) => void;
}

function SplitRow({ row, doc, commentIndex, onComment }: RowProps) {
  const leftCls = row.kind === 'del' || row.kind === 'mod' ? 'diff-del' : '';
  const rightCls = row.kind === 'add' || row.kind === 'mod' ? 'diff-add' : '';
  return (
    <tr>
      <td className={cx('diff-ln', leftCls)}>
        <LineGutter
          line={row.oldLine}
          show={row.oldLine != null && row.kind !== 'eq'}
          count={countFor(commentIndex, doc, 'old', row.oldLine)}
          onComment={(x, y) =>
            onComment({ doc, side: 'old', line: row.oldLine!, lineEnd: row.oldLine!, quote: row.oldText, x, y })
          }
        />
      </td>
      <td
        className={cx(leftCls, !row.oldText && row.oldLine == null && 'opacity-40')}
        data-side="old"
        data-line={row.oldLine ?? ''}
      >
        <span className="diff-sign">{row.kind !== 'eq' ? '−' : ' '}</span>
        {row.oldLine == null ? '' : row.oldText}
      </td>
      <td className={cx('diff-ln', rightCls)}>
        <LineGutter
          line={row.newLine}
          show={row.newLine != null && row.kind !== 'del'}
          count={countFor(commentIndex, doc, 'new', row.newLine)}
          onComment={(x, y) =>
            onComment({ doc, side: 'new', line: row.newLine!, lineEnd: row.newLine!, quote: row.newText, x, y })
          }
        />
      </td>
      <td
        className={cx(rightCls, !row.newText && row.newLine == null && 'opacity-40')}
        data-side="new"
        data-line={row.newLine ?? ''}
      >
        <span className="diff-sign">{row.kind !== 'eq' ? '+' : ' '}</span>
        {row.newLine == null ? '' : row.newText}
      </td>
    </tr>
  );
}

function UnifiedRow({ row, doc, commentIndex, onComment }: RowProps) {
  const cls = row.kind === 'add' ? 'diff-add' : row.kind === 'del' ? 'diff-del' : '';
  const side = row.kind === 'del' ? 'old' : 'new';
  const line = row.kind === 'del' ? row.oldLine : row.newLine;
  const text = row.kind === 'add' ? row.newText : row.oldText || row.newText;
  return (
    <tr className={cls}>
      <td className="diff-ln">
        <LineGutter
          line={row.oldLine}
          show={row.oldLine != null && row.kind !== 'eq'}
          count={countFor(commentIndex, doc, 'old', row.oldLine)}
          onComment={(x, y) =>
            onComment({ doc, side: 'old', line: row.oldLine!, lineEnd: row.oldLine!, quote: row.oldText, x, y })
          }
        />
      </td>
      <td className="diff-ln">
        <LineGutter
          line={row.newLine}
          show={row.newLine != null && row.kind !== 'del'}
          count={countFor(commentIndex, doc, 'new', row.newLine)}
          onComment={(x, y) =>
            onComment({ doc, side: 'new', line: row.newLine!, lineEnd: row.newLine!, quote: row.newText, x, y })
          }
        />
      </td>
      <td data-side={side} data-line={line ?? ''}>
        <span className="diff-sign">{row.kind === 'add' ? '+' : row.kind === 'del' ? '−' : ' '}</span>
        {text}
      </td>
    </tr>
  );
}

/** Line number plus the hover comment affordance. */
function LineGutter({
  line,
  show,
  count,
  onComment,
}: {
  line: number | undefined;
  show: boolean;
  count: number;
  onComment: (x: number, y: number) => void;
}) {
  return (
    <span className="diff-gutter">
      {show && (
        <button
          className="diff-gutter-btn"
          title="Comment on this line"
          aria-label="Comment on this line"
          onClick={(e) => {
            const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
            onComment(rect.left, rect.bottom + 6);
          }}
        >
          <IconChat className="h-3 w-3" />
        </button>
      )}
      <span className={cx(count > 0 && 'text-accent')}>{line ?? ''}</span>
    </span>
  );
}

function threadRow({
  row,
  mode,
  doc,
  threadsByAnchor,
  onDelete,
  onReply,
  onResolve,
}: {
  row: ViewRow;
  mode: Mode;
  doc: string;
  threadsByAnchor: Map<string, CommentThreadView[]>;
  onDelete: (id: string) => void;
  onReply: (rootId: string, body: string) => Promise<void>;
  onResolve: (rootId: string, resolved: boolean) => void;
}): ReactNode {
  const threads: CommentThreadView[] = [];
  for (const side of ['old', 'new'] as DiffSide[]) {
    const line = side === 'old' ? row.oldLine : row.newLine;
    if (line == null) continue;
    threads.push(...(threadsByAnchor.get(indexKey(doc, side, line)) ?? []));
  }
  if (threads.length === 0) return null;
  return (
    <tr className="diff-thread">
      <td colSpan={mode === 'split' ? 4 : 3}>
        <div className="flex flex-col">
          {threads.map((thread) => (
            <CommentThread
              key={thread.root.id}
              thread={thread}
              onDelete={onDelete}
              onReply={onReply}
              onResolve={onResolve}
              label={thread.root.side === 'old' ? `removed in v${thread.root.baseVersion ?? '?'}` : undefined}
            />
          ))}
        </div>
      </td>
    </tr>
  );
}

function GapRow({
  segment,
  rows,
  doc,
  mode,
  commentIndex,
  open,
  onToggle,
}: {
  segment: Extract<DiffSegment, { kind: 'gap' }>;
  rows: ViewRow[];
  doc: string;
  mode: Mode;
  commentIndex: Map<string, Comment[]>;
  open: boolean;
  onToggle: (currentlyOpen: boolean) => void;
}) {
  const hidden = useMemo(
    () => hiddenComments(rows.slice(segment.start, segment.start + segment.count), doc, commentIndex).length,
    [segment.start, segment.count, rows, doc, commentIndex],
  );

  return (
    <tr className="diff-gap">
      <td colSpan={mode === 'split' ? 4 : 3}>
        <button onClick={() => onToggle(open)} className="diff-gap-btn">
          {open ? '⌃ hide unchanged' : `⋯ ${segment.count} unchanged line${segment.count === 1 ? '' : 's'}`}
          {hidden > 0 && (
            <span className="text-accent">
              {' '}
              · {hidden} comment{hidden === 1 ? '' : 's'}
            </span>
          )}
        </button>
      </td>
    </tr>
  );
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** Nearest selectable diff content cell (`[data-side]`) around a DOM node. */
function findCell(node: Node | null): HTMLElement | null {
  let cur: Node | null = node;
  while (cur) {
    if (cur instanceof HTMLElement && cur.dataset.side != null) return cur;
    cur = cur.parentNode;
  }
  return null;
}

function commentSide(c: Comment): DiffSide {
  return c.side === 'old' ? 'old' : 'new';
}

function indexKey(doc: string, side: DiffSide, line: number): string {
  return `${doc}:${side}:${line}`;
}

function gapKey(doc: string, start: number): string {
  return `${doc}:${start}`;
}

/** Comments anchored anywhere inside a hidden run of rows. */
function hiddenComments(rows: ViewRow[], doc: string, commentIndex: Map<string, Comment[]>): Comment[] {
  const found = new Map<string, Comment>();
  for (const row of rows) {
    for (const side of ['old', 'new'] as DiffSide[]) {
      const line = side === 'old' ? row.oldLine : row.newLine;
      if (line == null) continue;
      for (const c of commentIndex.get(indexKey(doc, side, line)) ?? []) found.set(c.id, c);
    }
  }
  return [...found.values()];
}

function countFor(index: Map<string, Comment[]>, doc: string, side: DiffSide, line: number | undefined): number {
  if (line == null) return 0;
  return index.get(indexKey(doc, side, line))?.length ?? 0;
}
