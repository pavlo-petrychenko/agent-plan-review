import type { ProjectSummary } from '../../../shared/types.js';

/**
 * Project picker model. One worktree can hold several plans (each its own
 * project) next to its old worktree-wide project, so the picker groups
 * projects by worktree (`cwd`). Pure: the component only draws it.
 */

export const LEGACY_TITLE = 'Worktree plan (old)';

export interface PickerEntry {
  key: string;
  /** Plan title; "Worktree plan (old)" for a project without a plan. */
  title: string;
  /** Short plan id (`p-3f9a1c`), null for the old worktree plan. */
  planId: string | null;
  /** Herdr terminal of the newest review, when known. */
  terminal: string | null;
  pending: number;
}

export interface PickerGroup {
  /** Normalized worktree path, the grouping key. */
  id: string;
  /** Worktree folder name. */
  name: string;
  /** Where the worktree is: the last folders above it (`…/Documents/personal`). */
  hint: string;
  entries: PickerEntry[];
}

const trimPath = (cwd: string): string => (cwd.length > 1 ? cwd.replace(/[\\/]+$/, '') : cwd);

export function worktreeName(cwd: string): string {
  const parts = trimPath(cwd).split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? cwd;
}

export function pathHint(cwd: string): string {
  const parts = trimPath(cwd).split(/[\\/]/).filter(Boolean);
  const parents = parts.slice(0, -1);
  if (parents.length === 0) return '';
  return (parents.length > 2 ? '…/' : '/') + parents.slice(-2).join('/');
}

/** Groups in order of first appearance (the list is newest first), entries likewise. */
export function groupProjects(projects: readonly ProjectSummary[]): PickerGroup[] {
  const groups = new Map<string, PickerGroup>();
  for (const p of projects) {
    const id = trimPath(p.cwd);
    let group = groups.get(id);
    if (!group) {
      group = { id, name: worktreeName(p.cwd) || p.name, hint: pathHint(p.cwd), entries: [] };
      groups.set(id, group);
    }
    group.entries.push({
      key: p.key,
      title: p.plan?.title || (p.plan ? 'Plan' : LEGACY_TITLE),
      planId: p.plan?.id ?? null,
      terminal: p.lastTerminal ?? null,
      pending: p.pending,
    });
  }
  return [...groups.values()];
}

/** The group and entry of a project key. */
export function findEntry(
  groups: readonly PickerGroup[],
  key: string | null,
): { group: PickerGroup; entry: PickerEntry } | null {
  for (const group of groups) {
    const entry = group.entries.find((e) => e.key === key);
    if (entry) return { group, entry };
  }
  return null;
}

/**
 * Text lines of an entry. A worktree with one project reads as before plans
 * existed: the worktree name, plus the plan title dimmed when it has one. In a
 * worktree with several, the title leads and the worktree is the group header.
 */
export function entryLabel(group: PickerGroup, entry: PickerEntry): { primary: string; secondary: string | null } {
  if (group.entries.length === 1) {
    return { primary: group.name, secondary: entry.planId ? entry.title : null };
  }
  return { primary: entry.title, secondary: null };
}
