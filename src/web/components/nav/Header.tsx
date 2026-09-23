import type { ProjectSummary } from '../../../shared/types.js';
import { useTheme } from '../../state/theme.js';
import { Pill, Select } from '../primitives.js';
import { IconGist, IconMoon, IconSettings, IconSun } from '../icons.js';

export interface HeaderProps {
  projects: ProjectSummary[] | undefined;
  activeProject: string | null;
  onProjectChange: (key: string) => void;
  gistBinding: { savedVersion: number; htmlUrl: string } | null | undefined;
  onOpenGist: () => void;
  onOpenManage: () => void;
}

export function Header({ projects, activeProject, onProjectChange, gistBinding, onOpenGist, onOpenManage }: HeaderProps) {
  const { theme, toggle } = useTheme();
  const active = projects?.find((p) => p.key === activeProject);

  return (
    <header className="flex min-h-14 shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b border-border bg-surface-1 px-4 py-1.5 max-md:px-2.5">
      {/* mark */}
      <div className="flex items-center gap-2.5">
        <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-gradient-to-br from-accent to-[#8b5cf6] text-[13px] font-black text-accent-ink shadow-sm">
          P
        </div>
        <h1 className="hidden font-serif text-[16px] font-semibold tracking-tight sm:block">Plan Review</h1>
      </div>

      <div className="mx-1 hidden h-6 w-px bg-border sm:block" />

      {/* project switcher */}
      <div className="flex min-w-0 flex-1 items-center gap-2 sm:flex-none">
        <Select
          value={activeProject ?? ''}
          onChange={(e) => onProjectChange(e.target.value)}
          aria-label="Project"
          className="w-full min-w-0 max-w-[16rem] font-medium"
        >
          {(projects ?? []).map((p) => (
            <option key={p.key} value={p.key}>
              {p.name}
            </option>
          ))}
          {!projects && <option>Loading…</option>}
        </Select>
        {active != null && active.pending > 0 && <Pill tone="pending">{active.pending} pending</Pill>}
      </div>

      <span className="hidden flex-1 sm:block" />

      {/* actions — kept together so they wrap as a group, never one by one */}
      <div className="ml-auto flex shrink-0 items-center gap-2 sm:ml-0">
        <button
          onClick={onOpenGist}
          title={gistBinding ? `Gist holds v${gistBinding.savedVersion}` : 'Save to GitHub Gist'}
          className="flex shrink-0 items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-[12.5px] font-medium text-ink-muted transition-colors hover:border-border-strong hover:text-ink"
        >
          <IconGist className="h-4 w-4" />
          <span className="hidden md:inline">{gistBinding ? `v${gistBinding.savedVersion} → gist` : 'Save → gist'}</span>
          {gistBinding && <span className="h-1.5 w-1.5 rounded-full bg-ok" />}
        </button>

        <button
          onClick={onOpenManage}
          title="Manage plans"
          aria-label="Manage plans"
          className="shrink-0 rounded-lg p-2 text-ink-muted transition-colors hover:bg-surface-2 hover:text-ink"
        >
          <IconSettings className="h-4 w-4" />
        </button>

        <button
          onClick={toggle}
          title={theme === 'dark' ? 'Switch to light' : 'Switch to dark'}
          aria-label="Toggle theme"
          className="shrink-0 rounded-lg p-2 text-ink-muted transition-colors hover:bg-surface-2 hover:text-ink"
        >
          {theme === 'dark' ? <IconSun className="h-4 w-4" /> : <IconMoon className="h-4 w-4" />}
        </button>
      </div>
    </header>
  );
}
