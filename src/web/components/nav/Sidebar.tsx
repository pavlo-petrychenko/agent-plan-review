import { useMemo } from 'react';
import type { Comment, Manifest, VersionInfo } from '../../../shared/types.js';
import { parseHeadings, sectionRange } from '../../../shared/headings.js';
import { Pill, cx } from '../primitives.js';
import { IconFile, IconList } from '../icons.js';

// ---------------------------------------------------------------------------
// Versions section
// ---------------------------------------------------------------------------

export function VersionList({
  versions,
  active,
  onSelect,
  pendingVersions,
}: {
  versions: VersionInfo[];
  active: number | null;
  onSelect: (n: number) => void;
  /** Version numbers with a pending review. */
  pendingVersions: Set<number>;
}) {
  const max = versions.length > 0 ? Math.max(...versions.map((v) => v.n)) : 0;
  return (
    <div className="flex flex-col gap-0.5">
      {[...versions].reverse().map((v) => {
        const isActive = v.n === active;
        return (
          <button
            key={v.n}
            onClick={() => onSelect(v.n)}
            className={cx(
              'group flex items-center gap-2 rounded-lg px-2.5 py-2 text-left transition-colors',
              isActive ? 'bg-accent-soft' : 'hover:bg-surface-2',
            )}
          >
            <span
              className={cx(
                'font-mono text-[12.5px] font-semibold',
                isActive ? 'text-accent' : 'text-ink-muted group-hover:text-ink',
              )}
            >
              v{v.n}
            </span>
            <span className="flex-1 truncate text-[11.5px] text-ink-faint">{formatDate(v.createdAt)}</span>
            {pendingVersions.has(v.n) && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-pending" title="Review pending" />}
            {v.n === max && <Pill tone="accent" className="shrink-0">latest</Pill>}
          </button>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Document navigator (tree versions)
// ---------------------------------------------------------------------------

export interface DocRow {
  slug: string;
  title: string;
  depth: number;
}

export function DocNavigator({
  manifest,
  activeDoc,
  comments,
  reviewPending,
  onSelect,
}: {
  manifest: Manifest;
  activeDoc: string | null;
  comments: Comment[];
  reviewPending: boolean;
  onSelect: (slug: string) => void;
}) {
  const rows = useMemo(() => orderDocs(manifest), [manifest]);
  const total = comments.length;

  return (
    <div className="flex flex-col gap-0.5">
      {rows.map((row) => {
        const docComments = comments.filter((c) => c.doc === row.slug);
        const isActive = row.slug === activeDoc;
        return (
          <button
            key={row.slug}
            onClick={() => onSelect(row.slug)}
            style={{ paddingLeft: `${0.625 + row.depth * 0.875}rem` }}
            className={cx(
              'group flex items-center gap-2 rounded-lg py-1.5 pr-2 text-left transition-colors',
              isActive ? 'bg-accent-soft' : 'hover:bg-surface-2',
            )}
          >
            <IconFile
              className={cx('h-3.5 w-3.5 shrink-0', isActive ? 'text-accent' : 'text-ink-faint')}
            />
            <span className={cx('flex-1 truncate text-[13px]', isActive ? 'font-medium text-ink' : 'text-ink-muted')}>
              {row.title}
            </span>
            {reviewPending && docComments.length > 0 && (
              <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-pending" title="Has unfinished feedback" />
            )}
            {docComments.length > 0 && (
              <span className="rounded-full bg-surface-3 px-1.5 py-px font-mono text-[10px] text-ink-muted">
                {docComments.length}
              </span>
            )}
          </button>
        );
      })}
      {total === 0 && null}
    </div>
  );
}

/** Depth-first ordering: root first, children indented; orphans at top level. */
function orderDocs(manifest: Manifest): DocRow[] {
  const bySlug = new Map(manifest.docs.map((d) => [d.slug, d]));
  const childrenOf = new Map<string | null, typeof manifest.docs>();
  for (const d of manifest.docs) {
    const parentKey = d.parent != null && bySlug.has(d.parent) ? d.parent : null;
    const list = childrenOf.get(parentKey) ?? [];
    list.push(d);
    childrenOf.set(parentKey, list);
  }
  const rows: DocRow[] = [];
  const walk = (slug: string | null, depth: number): void => {
    for (const d of childrenOf.get(slug) ?? []) {
      rows.push({ slug: d.slug, title: d.title || d.slug, depth });
      if (depth < 8) walk(d.slug, depth + 1);
    }
  };
  const rootSlug = manifest.root != null && bySlug.has(manifest.root) ? manifest.root : null;
  // Root first…
  const root = rootSlug != null ? bySlug.get(rootSlug) : undefined;
  if (root) {
    rows.push({ slug: root.slug, title: root.title || root.slug, depth: 0 });
  }
  walk(rootSlug, root ? 1 : 0);
  return rows;
}

// ---------------------------------------------------------------------------
// Outline panel (single-doc "view as tree")
// ---------------------------------------------------------------------------

export interface OutlineSelection {
  start: number;
  end: number;
  label: string;
}

export function OutlinePanel({
  markdown,
  selection,
  onSelect,
}: {
  markdown: string | undefined;
  selection: OutlineSelection | null;
  onSelect: (sel: OutlineSelection | null) => void;
}) {
  const headings = useMemo(() => (markdown ? parseHeadings(markdown) : []), [markdown]);
  const totalLines = useMemo(() => (markdown ? markdown.split('\n').length : 0), [markdown]);

  if (!markdown) return null;

  const entries: { label: string; depth: number; sel: OutlineSelection }[] = [];
  const firstHeadingLine = headings[0]?.line ?? totalLines + 1;

  // Synthetic top section — covers plans that start with bold text (OpenCode habit).
  if (firstHeadingLine > 1) {
    entries.push({
      label: '(top)',
      depth: 0,
      sel: { start: 1, end: firstHeadingLine, label: '(top)' },
    });
  }
  headings.forEach((h, i) => {
    const range_ = sectionRange(headings, i, totalLines);
    entries.push({
      label: h.text,
      depth: h.level - 1,
      sel: { start: range_.start, end: range_.end, label: h.text },
    });
  });

  return (
    <div className="flex flex-col gap-0.5">
      {entries.map((entry, i) => {
        const isActive =
          selection != null && selection.start === entry.sel.start && selection.end === entry.sel.end;
        return (
          <button
            key={`${entry.label}-${i}`}
            onClick={() => onSelect(isActive ? null : entry.sel)}
            style={{ paddingLeft: `${0.625 + entry.depth * 0.75}rem` }}
            className={cx(
              'truncate rounded-lg py-1 pr-2 text-left text-[12.5px] transition-colors',
              isActive ? 'bg-accent-soft font-medium text-accent' : 'text-ink-muted hover:bg-surface-2 hover:text-ink',
            )}
            title={entry.label}
          >
            {entry.label}
          </button>
        );
      })}
    </div>
  );
}

export function OutlineBanner({ section, onClear }: { section: SectionFilterLike; onClear: () => void }) {
  return (
    <button
      onClick={onClear}
      className="inline-flex items-center gap-1.5 rounded-full border border-accent/30 bg-accent-soft px-2.5 py-1 text-[12px] font-medium text-accent transition-colors hover:border-accent"
      title="Show all sections"
    >
      <IconList className="h-3 w-3" />
      Section: {section.label}
      <span className="ml-0.5 text-[14px] leading-none">×</span>
    </button>
  );
}

interface SectionFilterLike {
  label: string;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}
