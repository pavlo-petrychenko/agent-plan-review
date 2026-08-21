import { useMemo, useState } from 'react';
import type { DiffResponse, Manifest, VersionInfo } from '../../../shared/types.js';
import { diffTexts, type SbsRow, type UnifiedRow } from '../../../shared/differ.js';
import { useApi } from '../../api/cache.js';
import { endpoints, keys } from '../../api/endpoints.js';
import { EmptyState, ErrorNote, Pill, Select, Spinner, cx } from '../primitives.js';
import { IconDiff, IconEye } from '../icons.js';

export interface DiffViewProps {
  projectKey: string;
  versions: VersionInfo[];
  activeVersion: number;
  /** Active doc slug (used as default when either side is a tree). */
  activeDoc: string | null;
}

type Mode = 'split' | 'unified';

/**
 * Version diff: base selector (defaults to previous version), split/unified
 * modes, per-document scoping when either side is a tree.
 */
export function DiffView({ projectKey, versions, activeVersion, activeDoc }: DiffViewProps) {
  const others = versions.filter((v) => v.n !== activeVersion);
  const [base, setBase] = useState<number | null>(null);
  const [mode, setMode] = useState<Mode>('split');
  const [doc, setDoc] = useState<string | null>(null);

  const fromVersion = base ?? (others.find((v) => v.n === activeVersion - 1)?.n ?? others[others.length - 1]?.n ?? null);

  // Manifests of both sides drive the per-document selector.
  const toPayload = useApi(
    keys.version(projectKey, activeVersion),
    () => endpoints.getVersion(projectKey, activeVersion),
  );
  const fromPayload = useApi(
    fromVersion != null ? keys.version(projectKey, fromVersion) : null,
    () => endpoints.getVersion(projectKey, fromVersion!),
  );
  const fromManifest = fromPayload.data?.manifest;
  const toManifest = toPayload.data?.manifest;
  const needsDoc = Boolean(fromManifest || toManifest);
  const docOptions = useMemo(() => {
    if (!needsDoc) return ['root'];
    const union: string[] = [];
    for (const m of [toManifest, fromManifest]) {
      for (const d of m?.docs ?? []) {
        if (!union.includes(d.slug)) union.push(d.slug);
      }
    }
    return union.length > 0 ? union : ['root'];
  }, [needsDoc, fromManifest, toManifest]);

  const effectiveDoc =
    doc && docOptions.includes(doc)
      ? doc
      : activeDoc && docOptions.includes(activeDoc)
        ? activeDoc
        : docOptions.includes('root')
          ? 'root'
          : docOptions[0];

  const key = fromVersion != null ? keys.diff(projectKey, fromVersion, activeVersion, effectiveDoc) : null;
  const { data, loading, error, reload } = useApi<DiffResponse>(
    key,
    () => endpoints.getDiff(projectKey, fromVersion!, activeVersion, needsDoc ? effectiveDoc : undefined),
  );

  const diff = useMemo(() => (data ? diffTexts(data.from.markdown, data.to.markdown) : null), [data]);

  if (versions.length <= 1) {
    return (
      <EmptyState
        icon={<IconDiff className="h-8 w-8" />}
        title="Nothing to diff yet"
        body="This is the only version of the plan. When Claude re-presents a revised plan it becomes v2 and you can compare the two here."
      />
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* toolbar */}
      <div className="flex flex-wrap items-center gap-2 border-b border-border bg-surface-0 px-5 py-2.5 max-md:px-3">
        <span className="text-[12px] text-ink-faint">Comparing</span>
        <Select size="sm" value={fromVersion ?? ''} onChange={(e) => setBase(Number(e.target.value))} aria-label="Base version">
          {others.map((v) => (
            <option key={v.n} value={v.n}>
              v{v.n}
            </option>
          ))}
        </Select>
        <IconDiff className="h-3.5 w-3.5 text-ink-faint" />
        <Pill tone="accent">v{activeVersion}</Pill>

        {needsDoc && (
          <Select size="sm" value={effectiveDoc} onChange={(e) => setDoc(e.target.value)} aria-label="Document">
            {docOptions.map((slug) => (
              <option key={slug} value={slug}>
                {titleOf(slug, toManifest) ?? titleOf(slug, fromManifest) ?? slug}
              </option>
            ))}
          </Select>
        )}

        <span className="flex-1" />

        {diff && (
          <span className="flex items-center gap-1.5 font-mono text-[11.5px]">
            <span className="rounded-md bg-add-bg px-1.5 py-0.5 text-add-fg">+{diff.stats.added}</span>
            <span className="rounded-md bg-del-bg px-1.5 py-0.5 text-del-fg">−{diff.stats.removed}</span>
          </span>
        )}

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
        {loading && !diff && <Spinner label="Computing diff…" />}
        {error && <ErrorNote message={error} onRetry={reload} />}
        {diff && data && diff.stats.added === 0 && diff.stats.removed === 0 && (
          <EmptyState
            icon={<IconEye className="h-8 w-8" />}
            title={`No differences in “${data.doc}”`}
            body={`${labelFor(fromVersion)} and ${labelFor(activeVersion)} render identical content for this document.`}
          />
        )}
        {diff && !(diff.stats.added === 0 && diff.stats.removed === 0) && (
          <div className="mx-auto max-w-full overflow-hidden rounded-xl border border-border bg-surface-1 shadow-card">
            {mode === 'split' ? <SplitTable rows={diff.rows} /> : <UnifiedTable rows={diff.unified} />}
          </div>
        )}
      </div>
    </div>
  );
}

function labelFor(n: number | null): string {
  return n != null ? `v${n}` : 'empty';
}

function titleOf(slug: string, manifest: Manifest | undefined): string | undefined {
  return manifest?.docs.find((d) => d.slug === slug)?.title;
}

function SplitTable({ rows }: { rows: SbsRow[] }) {
  return (
    <table className="diff-table">
      <tbody>
        {rows.map((row, i) => {
          const leftCls = row.kind === 'del' || row.kind === 'mod' ? 'diff-del' : '';
          const rightCls = row.kind === 'add' || row.kind === 'mod' ? 'diff-add' : '';
          return (
            <tr key={i}>
              <td className={cx('diff-ln', leftCls)}>{row.left?.n ?? ''}</td>
              <td className={cx(leftCls, !row.left && 'opacity-40')}>
                {row.left ? <><span className="diff-sign">{row.kind !== 'eq' ? '−' : ' '}</span>{row.left.text}</> : ''}
              </td>
              <td className={cx('diff-ln', rightCls)}>{row.right?.n ?? ''}</td>
              <td className={cx(rightCls, !row.right && 'opacity-40')}>
                {row.right ? <><span className="diff-sign">{row.kind !== 'eq' ? '+' : ' '}</span>{row.right.text}</> : ''}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function UnifiedTable({ rows }: { rows: UnifiedRow[] }) {
  return (
    <table className="diff-table">
      <tbody>
        {rows.map((row, i) => {
          const cls = row.kind === 'add' ? 'diff-add' : row.kind === 'del' ? 'diff-del' : '';
          return (
            <tr key={i} className={cls}>
              <td className="diff-ln">{row.oldLine ?? ''}</td>
              <td className="diff-ln">{row.newLine ?? ''}</td>
              <td>
                <span className="diff-sign">{row.kind === 'add' ? '+' : row.kind === 'del' ? '−' : ' '}</span>
                {row.text}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
