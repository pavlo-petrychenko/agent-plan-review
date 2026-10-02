import { useState } from 'react';
import type { BulkDeleteResponse, ProjectDetail, ProjectSummary } from '../../../shared/types.js';
import { refresh as refreshCache, useApi } from '../../api/cache.js';
import { endpoints, keys } from '../../api/endpoints.js';
import { Button, EmptyState, ErrorNote, Modal, Pill, Select, Spinner } from '../primitives.js';
import { IconAlert, IconFolder, IconTrash } from '../icons.js';
import { useToast } from '../../state/toasts.js';

export interface ManageModalProps {
  open: boolean;
  onClose: () => void;
  /** Called after any deletion so the app can re-sync selectors. */
  onChanged: () => void;
}

interface BlockedReport {
  projectKey: string;
  deleted: number[];
  blocked: { n: number; pendingReviews: number }[];
}

/**
 * Housekeeping surface: every project with all its versions; tick-and-bulk
 * delete per project plus whole-project delete. Deletes are immediate;
 * pending reviews are protected behind an explicit Force that auto-rejects
 * with "This plan was deleted in the review UI — …".
 */
export function ManageModal({ open, onClose, onChanged }: ManageModalProps) {
  const { toast } = useToast();
  const projects = useApi(open ? keys.projects : null, endpoints.listProjects);
  const [ticked, setTicked] = useState<Set<string>>(new Set()); // `${key}:${n}`
  const [busy, setBusy] = useState(false);
  const [report, setReport] = useState<BlockedReport | null>(null);
  const [forceProjectKey, setForceProjectKey] = useState<string | null>(null);

  const refresh = (): void => {
    refreshCache('projects', 'project:', 'version:', 'doc:', 'comments:', 'storage:', 'review:', 'diff:');
    onChanged();
  };

  const tick = (projectKey: string, n: number): void => {
    const id = `${projectKey}:${n}`;
    setTicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const bulkDelete = async (projectKey: string, versions: number[], force: boolean): Promise<void> => {
    setBusy(true);
    try {
      const res = await endpoints.bulkDeleteVersions(projectKey, versions, force);
      announceBulk(res);
      if (res.blocked.length > 0) setReport({ projectKey, deleted: res.deleted, blocked: res.blocked });
      else setReport(null);
      setTicked((prev) => {
        const next = new Set(prev);
        for (const n of versions) next.delete(`${projectKey}:${n}`);
        return next;
      });
      refresh();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Delete failed', 'error');
    } finally {
      setBusy(false);
    }
  };

  const announceBulk = (res: BulkDeleteResponse): void => {
    const del = res.deleted.map((n) => `v${n}`).join(', ');
    const blocked = res.blocked.map((b) => `v${b.n} — ${b.pendingReviews} pending`).join('; ');
    if (del && blocked) toast(`Deleted ${del}. Blocked: ${blocked}. Force will auto-reject.`, 'info');
    else if (del) toast(`Deleted ${del}`, 'success');
    else if (blocked) toast(`Blocked: ${blocked}. Use Force to auto-reject and delete.`, 'error');
  };

  /** Move versions (or a whole project) into another project, renumbering in place. */
  const moveVersions = async (fromKey: string, versions: number[] | undefined, to: string): Promise<void> => {
    setBusy(true);
    try {
      const res = await endpoints.moveVersions(fromKey, to, versions);
      const names = res.moved.map((m) => `v${m.from}→v${m.to}`).join(', ');
      toast(`Moved ${names}${res.sourceRemoved ? ' — source project removed' : ''}`, 'success');
      setTicked((prev) => {
        const next = new Set(prev);
        for (const id of [...next]) if (id.startsWith(`${fromKey}:`)) next.delete(id);
        return next;
      });
      refresh();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Move failed', 'error');
    } finally {
      setBusy(false);
    }
  };

  const removeProject = async (summary: ProjectSummary, force: boolean): Promise<void> => {
    setBusy(true);
    try {
      await endpoints.deleteProject(summary.key, force);
      toast(
        force
          ? `Force-deleted “${summary.name}” — waiting agents were told the plan was removed`
          : `Deleted project “${summary.name}”`,
        'success',
      );
      setForceProjectKey(null);
      refresh();
    } catch (err) {
      const payload = (err as { payload?: { pendingReviews?: number } }).payload;
      if (!force && payload?.pendingReviews != null) {
        setForceProjectKey(summary.key);
        toast(
          `“${summary.name}” has ${payload.pendingReviews} pending review${payload.pendingReviews === 1 ? '' : 's'} — Force will auto-reject them`,
          'error',
        );
      } else {
        toast(err instanceof Error ? err.message : 'Delete failed', 'error');
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title="Manage plans" wide>
      <div className="max-h-[62vh] min-h-48 overflow-y-auto pr-1">
        {projects.loading && !projects.data ? (
          <Spinner label="Loading projects…" />
        ) : projects.error ? (
          <ErrorNote message={projects.error} onRetry={projects.reload} />
        ) : !projects.data || projects.data.length === 0 ? (
          <EmptyState
            icon={<IconFolder className="h-8 w-8" />}
            title="No projects yet"
            body="Finish a plan in plan mode and it will appear here."
          />
        ) : (
          <div className="flex flex-col gap-4">
            {projects.data.map((p) => (
              <ProjectSection
                key={p.key}
                summary={p}
                others={projects.data!.filter((o) => o.key !== p.key)}
                isTicked={(n) => ticked.has(`${p.key}:${n}`)}
                onTick={(n) => tick(p.key, n)}
                busy={busy}
                onBulkDelete={(versions, force) => void bulkDelete(p.key, versions, force)}
                onMove={(versions, to) => void moveVersions(p.key, versions, to)}
                onDeleteProject={() => void removeProject(p, false)}
                forceArmed={forceProjectKey === p.key}
                onForceProject={() => void removeProject(p, true)}
                onDisarmForce={() => setForceProjectKey(null)}
              />
            ))}
          </div>
        )}
      </div>

      {report && report.blocked.length > 0 && (
        <div className="mt-4 rounded-xl border border-pending/30 bg-pending-bg px-3.5 py-3">
          <p className="text-[12.5px] leading-relaxed text-pending">
            {report.deleted.length > 0 && <>Deleted {report.deleted.map((n) => `v${n}`).join(', ')}. </>}
            Blocked: {report.blocked.map((b) => `v${b.n}`).join(', ')} —{' '}
            {report.blocked.reduce((acc, b) => acc + b.pendingReviews, 0)} pending review(s). Force auto-rejects them
            (“This plan was deleted in the review UI — re-present or ask the user how to proceed”).
          </p>
          <Button
            variant="danger"
            size="sm"
            className="mt-2"
            disabled={busy}
            onClick={() => void bulkDelete(report.projectKey, report.blocked.map((b) => b.n), true)}
          >
            <IconAlert className="h-3.5 w-3.5" />
            Force delete blocked version{report.blocked.length === 1 ? '' : 's'}
          </Button>
        </div>
      )}
    </Modal>
  );
}

// ---------------------------------------------------------------------------

function ProjectSection({
  summary,
  others,
  isTicked,
  onTick,
  busy,
  onBulkDelete,
  onMove,
  onDeleteProject,
  forceArmed,
  onForceProject,
  onDisarmForce,
}: {
  summary: ProjectSummary;
  others: ProjectSummary[];
  isTicked: (n: number) => boolean;
  onTick: (n: number) => void;
  busy: boolean;
  onBulkDelete: (versions: number[], force: boolean) => void;
  onMove: (versions: number[] | undefined, to: string) => void;
  onDeleteProject: () => void;
  forceArmed: boolean;
  onForceProject: () => void;
  onDisarmForce: () => void;
}) {
  const [expanded, setExpanded] = useState(true);
  const detail = useApi<ProjectDetail>(keys.project(summary.key), () => endpoints.getProject(summary.key));
  const versions = detail.data?.versions ?? [];
  const selected = versions.filter((v) => isTicked(v.n)).map((v) => v.n);

  return (
    <section className="overflow-hidden rounded-xl border border-border">
      <header className="flex flex-wrap items-center gap-2 bg-surface-2 px-3.5 py-2.5">
        <button
          onClick={() => setExpanded((e) => !e)}
          className="text-ink-faint transition-colors hover:text-ink"
          aria-label="Toggle versions"
        >
          <span className={`inline-block text-[10px] transition-transform ${expanded ? 'rotate-90' : ''}`}>▶</span>
        </button>
        <IconFolder className="h-4 w-4 shrink-0 text-ink-muted" />
        <span className="text-[13.5px] font-semibold">{summary.name}</span>
        <span className="font-mono text-[11px] text-ink-faint">
          {versions.length} version{versions.length === 1 ? '' : 's'}
        </span>
        {summary.pending > 0 && <Pill tone="pending">{summary.pending} pending</Pill>}
        <span className="flex-1" />
        {selected.length > 0 ? (
          <div className="flex items-center gap-2">
            <span className="text-[12px] text-ink-muted">{selected.length} selected</span>
            <MoveControl label={`Move ${selected.length}`} others={others} busy={busy} onMove={(to) => onMove(selected, to)} />
            <Button size="sm" variant="danger" disabled={busy} onClick={() => onBulkDelete(selected, false)}>
              <IconTrash className="h-3.5 w-3.5" />
              Delete selected
            </Button>
          </div>
        ) : forceArmed ? (
          <div className="flex items-center gap-1.5">
            <Button size="sm" variant="ghost" disabled={busy} onClick={onDisarmForce}>
              Cancel
            </Button>
            <Button size="sm" variant="danger" disabled={busy} onClick={onForceProject}>
              <IconAlert className="h-3.5 w-3.5" />
              Force delete project
            </Button>
          </div>
        ) : (
          <div className="flex items-center gap-1.5">
            <MoveControl label="Move to…" others={others} busy={busy} onMove={(to) => onMove(undefined, to)} />
            <Button
              size="sm"
              variant="ghost"
              className="text-danger hover:bg-danger-bg hover:text-danger"
              disabled={busy}
              onClick={onDeleteProject}
            >
              <IconTrash className="h-3.5 w-3.5" />
              Delete project
            </Button>
          </div>
        )}
      </header>

      {expanded && (
        <div className="divide-y divide-border">
          {[...versions].reverse().map((v) => {
            const pendingOnVersion = v.n === summary.currentVersion && summary.pending > 0;
            return (
              <label
                key={v.n}
                className="flex cursor-pointer items-center gap-3 px-3.5 py-2 transition-colors hover:bg-surface-2/60"
              >
                <input
                  type="checkbox"
                  checked={isTicked(v.n)}
                  onChange={() => onTick(v.n)}
                  className="h-3.5 w-3.5 accent-[var(--accent)]"
                />
                <span className="w-9 font-mono text-[12px] font-semibold">v{v.n}</span>
                <span className="text-[12px] text-ink-muted">{formatDateTime(v.createdAt)}</span>
                <Pill tone="neutral">{v.kind}</Pill>
                {v.kind === 'tree' && <span className="text-[11.5px] text-ink-faint">{v.docCount} docs</span>}
                {pendingOnVersion && <Pill tone="pending">pending review</Pill>}
                <span className="flex-1" />
                <button
                  onClick={(e) => {
                    e.preventDefault();
                    onBulkDelete([v.n], false);
                  }}
                  disabled={busy}
                  className="rounded-md p-1 text-ink-faint transition-colors hover:bg-danger-bg hover:text-danger disabled:opacity-40"
                  title="Delete this version"
                >
                  <IconTrash className="h-3.5 w-3.5" />
                </button>
              </label>
            );
          })}
          {versions.length === 0 && <p className="px-3.5 py-3 text-[12.5px] text-ink-faint">No versions.</p>}
        </div>
      )}
    </section>
  );
}

function MoveControl({
  label,
  others,
  busy,
  onMove,
}: {
  label: string;
  others: ProjectSummary[];
  busy: boolean;
  onMove: (to: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [to, setTo] = useState('');

  if (others.length === 0) return null;

  if (!open) {
    return (
      <Button
        size="sm"
        variant="ghost"
        disabled={busy}
        onClick={() => {
          setTo(others[0].key);
          setOpen(true);
        }}
      >
        <IconFolder className="h-3.5 w-3.5" />
        {label}
      </Button>
    );
  }

  return (
    <div className="flex items-center gap-1.5">
      <Select size="sm" value={to} onChange={(e) => setTo(e.target.value)} aria-label="Target project">
        {others.map((p) => (
          <option key={p.key} value={p.key}>
            {p.name}
          </option>
        ))}
      </Select>
      <Button
        size="sm"
        variant="primary"
        disabled={busy || !to}
        onClick={() => {
          onMove(to);
          setOpen(false);
        }}
      >
        Move
      </Button>
      <Button size="sm" variant="ghost" disabled={busy} onClick={() => setOpen(false)}>
        Cancel
      </Button>
    </div>
  );
}

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString([], {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}
