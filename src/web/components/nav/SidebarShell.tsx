import type { Comment, Manifest, Review, VersionInfo } from '../../../shared/types.js';
import { DocNavigator, OutlinePanel, VersionList, type OutlineSelection } from './Sidebar.js';
import { EmptyState } from '../primitives.js';
import { IconFolder } from '../icons.js';

export interface SidebarProps {
  versions: VersionInfo[] | undefined;
  activeVersion: number | null;
  onVersionChange: (n: number) => void;
  manifest: Manifest | undefined;
  activeDoc: string | null;
  onDocChange: (slug: string) => void;
  comments: Comment[];
  review: Review | undefined;
  markdown: string | undefined;
  outlineSelection: OutlineSelection | null;
  onOutlineSelect: (sel: OutlineSelection | null) => void;
}

/** Left rail: versions on top; documents (trees) or outline (any doc) below. */
export function Sidebar({
  versions,
  activeVersion,
  onVersionChange,
  manifest,
  activeDoc,
  onDocChange,
  comments,
  review,
  markdown,
  outlineSelection,
  onOutlineSelect,
}: SidebarProps) {
  const pendingVersions = new Set(
    review && review.status === 'pending' ? [review.version] : [],
  );
  const isTree = manifest != null && manifest.docs.length > 1;

  return (
    <aside className="flex w-72 shrink-0 flex-col overflow-y-auto border-r border-border bg-surface-0 max-lg:hidden">
      <Section title="Versions">
        {versions == null ? null : versions.length === 0 ? (
          <p className="px-2.5 py-2 text-[12.5px] leading-relaxed text-ink-faint">No versions yet.</p>
        ) : (
          <VersionList
            versions={versions}
            active={activeVersion}
            onSelect={onVersionChange}
            pendingVersions={pendingVersions}
          />
        )}
      </Section>

      {isTree && manifest && (
        <Section title="Documents" hint={comments.length > 0 ? `${comments.length} comment${comments.length === 1 ? '' : 's'}` : undefined}>
          <DocNavigator
            manifest={manifest}
            activeDoc={activeDoc}
            comments={comments}
            reviewPending={review?.status === 'pending'}
            onSelect={onDocChange}
          />
        </Section>
      )}

      {!isTree && markdown && (
        <Section title="Outline">
          <OutlinePanel markdown={markdown} selection={outlineSelection} onSelect={onOutlineSelect} />
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
