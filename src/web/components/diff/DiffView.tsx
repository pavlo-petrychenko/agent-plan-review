import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Comment, DiffDocEntry, DiffDocStatus, DiffResponse, VersionInfo } from '../../../shared/types.js';
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
import { IconChat, IconDiff, IconEye } from '../icons.js';
import { CommentComposer, type ComposerState } from '../comments/CommentComposer.js';
import { CommentCard } from '../comments/CommentThread.js';

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
}

type Mode = 'split' | 'unified';

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
}: DiffViewProps) {
  const others = versions.filter((v) => v.n !== activeVersion);
  const [base, setBase] = useState<number | null>(null);
  const [mode, setMode] = useState<Mode>('split');
  const [docFilter, setDocFilter] = useState<'all' | string>('all');
  const [gapOverride, setGapOverride] = useState<Map<string, boolean>>(new Map());
  const [collapsedDocs, setCollapsedDocs] = useState<Set<string>>(new Set());
  const [composer, setComposer] = useState<{ state: ComposerState; doc: string; side: DiffSide } | null>(null);

  const fromVersion =
    base ?? others.find((v) => v.n === activeVersion - 1)?.n ?? others[others.length - 1]?.n ?? null;

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

  const toggleDoc = useCallback((slug: string) => {
    setCollapsedDocs((prev) => {
      const next = new Set(prev);
      if (next.has(slug)) next.delete(slug);
      else next.add(slug);
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

  if (versions.length <= 1) {
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

      {/* content */}
      <div className="min-h-0 flex-1 overflow-auto px-5 py-4 max-md:px-2">
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
                onToggleCollapse={() => toggleDoc(entry.slug)}
                onComment={openComposer}
                onDeleteComment={onDeleteComment}
              />
            ))}
          </div>
        )}
      </div>

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
  onToggleCollapse: () => void;
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
  onToggleCollapse,
  onComment,
  onDeleteComment,
}: DocSectionProps) {
  // Each mode hunks its own row list, so collapse offsets always index it.
  const rows = useMemo(() => (diff ? toViewRows(diff, mode) : []), [diff, mode]);
  const segments = useMemo(() => diffSegments(rows, computeHunks(rows)), [rows]);
  const general = comments.filter((c) => c.line == null);
  const unchanged = entry.status === 'unchanged';

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
    <section className="overflow-hidden rounded-xl border border-border bg-surface-1 shadow-card">
      <header className="diff-doc-header">
        <button
          onClick={onToggleCollapse}
          disabled={unchanged}
          className="text-ink-faint transition-colors hover:text-ink disabled:opacity-40"
          aria-label="Toggle page"
          aria-expanded={!collapsed}
        >
          <span className={cx('inline-block text-[10px] transition-transform', !collapsed && 'rotate-90')}>▶</span>
        </button>
        <span className="text-[13.5px] font-semibold text-ink">{entry.title}</span>
        <span className="font-mono text-[11px] text-ink-faint">{entry.slug}</span>
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
                            <SplitRow row={row} doc={entry.slug} commentIndex={commentIndex} onComment={onComment} />
                          ) : (
                            <UnifiedRow row={row} doc={entry.slug} commentIndex={commentIndex} onComment={onComment} />
                          )}
                          {threadRow({
                            row,
                            mode,
                            doc: entry.slug,
                            commentIndex,
                            onDelete: onDeleteComment,
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

      {!collapsed && general.length > 0 && (
        <div className="border-t border-border px-3.5 py-3">
          <h4 className="mb-2 text-[11.5px] font-semibold tracking-wide text-ink-faint uppercase">General notes</h4>
          <div className="flex flex-col gap-2">
            {general.map((c) => (
              <CommentCard key={c.id} comment={c} onDelete={() => onDeleteComment(c.id)} />
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
      <td className={cx(leftCls, !row.oldText && row.oldLine == null && 'opacity-40')}>
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
      <td className={cx(rightCls, !row.newText && row.newLine == null && 'opacity-40')}>
        <span className="diff-sign">{row.kind !== 'eq' ? '+' : ' '}</span>
        {row.newLine == null ? '' : row.newText}
      </td>
    </tr>
  );
}

function UnifiedRow({ row, doc, commentIndex, onComment }: RowProps) {
  const cls = row.kind === 'add' ? 'diff-add' : row.kind === 'del' ? 'diff-del' : '';
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
      <td>
        <span className="diff-sign">{row.kind === 'add' ? '+' : row.kind === 'del' ? '−' : ' '}</span>
        {row.kind === 'add' ? row.newText : row.oldText || row.newText}
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
  commentIndex,
  onDelete,
}: {
  row: ViewRow;
  mode: Mode;
  doc: string;
  commentIndex: Map<string, Comment[]>;
  onDelete: (id: string) => void;
}): ReactNode {
  const anchored = new Map<string, Comment>();
  for (const side of ['old', 'new'] as DiffSide[]) {
    const line = side === 'old' ? row.oldLine : row.newLine;
    if (line == null) continue;
    for (const c of commentIndex.get(indexKey(doc, side, line)) ?? []) anchored.set(c.id, c);
  }
  if (anchored.size === 0) return null;
  return (
    <tr className="diff-thread">
      <td colSpan={mode === 'split' ? 4 : 3}>
        <div className="flex flex-col gap-2 py-1">
          {[...anchored.values()].map((c) => (
            <CommentCard
              key={c.id}
              comment={c}
              onDelete={() => onDelete(c.id)}
              label={c.side === 'old' ? `removed in v${c.baseVersion ?? '?'}` : undefined}
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
