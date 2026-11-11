import { useEffect, useMemo, useRef, useState } from 'react';
import type { ProjectSummary } from '../../../shared/types.js';
import { cx } from '../primitives.js';
import { IconChevronDown } from '../icons.js';
import { entryLabel, findEntry, groupProjects, type PickerEntry, type PickerGroup } from './projectGroups.js';

/**
 * The project switcher. Projects are grouped by worktree: a worktree with one
 * project is a plain row, a worktree with several plans gets a header and one
 * row per plan (title, dimmed plan id, the Herdr terminal that last submitted).
 * A custom list instead of a native <select>, which cannot dim part of a label.
 */
export function ProjectPicker({
  projects,
  activeProject,
  onChange,
  defaultOpen = false,
}: {
  projects: ProjectSummary[] | undefined;
  activeProject: string | null;
  onChange: (key: string) => void;
  /** Open on first render (the Herdr mod links here to browse a worktree's plans). */
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const root = useRef<HTMLDivElement>(null);
  const groups = useMemo(() => groupProjects(projects ?? []), [projects]);
  const active = findEntry(groups, activeProject);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const options = (): HTMLElement[] =>
    Array.from(root.current?.querySelectorAll<HTMLElement>('[role="option"]') ?? []);

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Escape' && open) {
      setOpen(false);
      root.current?.querySelector<HTMLElement>('button[aria-haspopup]')?.focus();
    } else if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && open) {
      e.preventDefault();
      const all = options();
      const at = all.indexOf(document.activeElement as HTMLElement);
      const next = e.key === 'ArrowDown' ? at + 1 : at - 1;
      all[(next + all.length) % all.length]?.focus();
    }
  };

  return (
    <div ref={root} className="relative min-w-0 max-w-[18rem] flex-1 sm:flex-none" onKeyDown={onKeyDown}>
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label="Project"
        disabled={!projects}
        onClick={() => setOpen((o) => !o)}
        className={cx(
          'flex w-full min-w-0 items-center gap-2 rounded-lg border border-border bg-surface-1 py-1.5 pl-2.5 pr-2 text-left text-[13px] font-medium text-ink transition-colors',
          'cursor-pointer hover:border-border-strong focus-visible:outline-2 focus-visible:outline-accent',
        )}
      >
        {active ? <EntryText group={active.group} entry={active.entry} inline /> : <span>{projects ? 'No projects' : 'Loading…'}</span>}
        <IconChevronDown className="ml-auto h-3.5 w-3.5 shrink-0 text-ink-faint" />
      </button>

      {open && (
        <div
          role="listbox"
          aria-label="Projects"
          className="absolute left-0 top-full z-40 mt-1.5 max-h-[70vh] w-[22rem] max-w-[calc(100vw-1.25rem)] animate-pop overflow-y-auto rounded-xl border border-border bg-surface-1 p-1.5 shadow-pop"
        >
          {groups.map((group) => (
            <div key={group.id} className="py-0.5">
              {group.entries.length > 1 && (
                <div className="flex items-baseline gap-2 px-2.5 pb-1 pt-2" title={group.id}>
                  <span className="truncate text-[11.5px] font-semibold uppercase tracking-wide text-ink-muted">{group.name}</span>
                  {group.hint && <span className="truncate font-mono text-[10.5px] text-ink-faint">{group.hint}</span>}
                </div>
              )}
              {group.entries.map((entry) => (
                <button
                  key={entry.key}
                  type="button"
                  role="option"
                  aria-selected={entry.key === activeProject}
                  title={group.entries.length === 1 ? group.id : undefined}
                  onClick={() => {
                    setOpen(false);
                    if (entry.key !== activeProject) onChange(entry.key);
                  }}
                  className={cx(
                    'flex w-full items-center gap-2 rounded-lg py-1.5 text-left text-[13px] transition-colors focus-visible:outline-2 focus-visible:outline-accent',
                    group.entries.length > 1 ? 'pl-5 pr-2.5' : 'px-2.5',
                    entry.key === activeProject ? 'bg-accent-soft text-ink' : 'hover:bg-surface-2',
                  )}
                >
                  <EntryText group={group} entry={entry} />
                </button>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** Title, dimmed plan id, terminal chip and pending dot of one entry. */
function EntryText({ group, entry, inline = false }: { group: PickerGroup; entry: PickerEntry; inline?: boolean }) {
  const { primary, secondary } = entryLabel(group, entry);
  // The closed button has no group header, so a plan in a shared worktree names it.
  const lead = inline && group.entries.length > 1 ? group.name : null;
  return (
    <>
      <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
        {lead && <span className="shrink-0 text-ink-muted">{lead} /</span>}
        <span className="truncate">{primary}</span>
        {secondary && <span className="truncate text-[12px] font-normal text-ink-faint">{secondary}</span>}
        {entry.planId && !inline && <span className="shrink-0 font-mono text-[10.5px] font-normal text-ink-faint">{entry.planId}</span>}
      </span>
      {entry.terminal && (
        <span
          className="shrink-0 rounded-full bg-surface-2 px-1.5 py-0.5 font-mono text-[10.5px] font-normal text-ink-muted"
          title="Herdr terminal of the newest review"
        >
          {entry.terminal}
        </span>
      )}
      {entry.pending > 0 && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-pending" title={`${entry.pending} pending`} />}
    </>
  );
}
