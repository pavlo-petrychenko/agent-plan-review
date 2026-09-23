import type { Comment, Manifest, Review, VersionInfo } from '../../../shared/types.js';
import { DocNavigator, OutlinePanel, VersionList, type OutlineSelection } from './Sidebar.js';
import { EmptyState, cx } from '../primitives.js';
import { IconFolder } from '../icons.js';

export interface SidebarProps {
  versions: VersionInfo[] | undefined;
  activeVersion: number | null;
  onVersionChange: (n: number) => void;
  manifest: Manifest | undefined;
  activeDoc: string | null;
  onDocChange: (slug: string) => void;
  /** Open threads only — what the feedback compiler would actually send. */
  threads: Comment[];
  /** Versions with an open review — every one of them, not just the contextual. */
  pendingVersions: Set<number>;
  review: Review | undefined;
  markdown: string | undefined;
  outlineSelection: OutlineSelection | null;
  onOutlineSelect: (sel: OutlineSelection | null) => void;
  /** Overrides the rail chrome (the narrow-viewport drawer passes its own). */
  className?: string;
  /** Called after any navigation, so a drawer can close itself. */
  onNavigate?: () => void;
}

/** Left rail: versions on top; documents (trees) or outline (any doc) below. */
export function Sidebar({
  versions,
  activeVersion,
  onVersionChange,
  manifest,
  activeDoc,
  onDocChange,
  threads,
  pendingVersions,
  review,
  markdown,
  outlineSelection,
  onOutlineSelect,
  className,
  onNavigate,
}: SidebarProps) {
  const isTree = manifest != null && manifest.docs.length > 1;
  const select = <T,>(fn: (v: T) => void) => (v: T) => {
    fn(v);
    onNavigate?.();
  };

  return (
    <aside
      className={cx(
        'flex flex-col overflow-y-auto bg-surface-0',
        className ?? 'w-72 shrink-0 border-r border-border max-lg:hidden',
      )}
    >
      <Section title="Versions">
        {versions == null ? null : versions.length === 0 ? (
          <p className="px-2.5 py-2 text-[12.5px] leading-relaxed text-ink-faint">No versions yet.</p>
        ) : (
          <VersionList
            versions={versions}
            active={activeVersion}
            onSelect={select(onVersionChange)}
            pendingVersions={pendingVersions}
          />
        )}
      </Section>

      {isTree && manifest && (
        <Section title="Documents" hint={threads.length > 0 ? `${threads.length} open thread${threads.length === 1 ? '' : 's'}` : undefined}>
          <DocNavigator
            manifest={manifest}
            activeDoc={activeDoc}
            comments={threads}
            reviewPending={review?.status === 'pending'}
            onSelect={select(onDocChange)}
          />
        </Section>
      )}

      {!isTree && markdown && (
        <Section title="Outline">
          <OutlinePanel markdown={markdown} selection={outlineSelection} onSelect={select(onOutlineSelect)} />
        </Section>
      )}

      {versions && versions.length === 0 && (
        <div className="mt-auto">
          <EmptyState
            icon={<IconFolder className="h-7 w-7" />}
            title="All versions deleted"
            body="New plans from Claude will start this project over at v1."
          />
        </div>
      )}
    </aside>
  );
}

function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section className="border-b border-border px-2 py-3 last:border-b-0">
      <div className="mb-1.5 flex items-center justify-between px-2.5">
        <h2 className="text-[10.5px] font-semibold uppercase tracking-[0.08em] text-ink-faint">{title}</h2>
        {hint && <span className="text-[11px] text-ink-faint">{hint}</span>}
      </div>
      {children}
    </section>
  );
}
