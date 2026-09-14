import { useCallback, useEffect, useState } from 'react';
import type { Comment, GistBinding } from '../shared/types.js';
import { invalidate, useApi } from './api/cache.js';
import { endpoints, keys } from './api/endpoints.js';
import { useParams, useSetParams } from './state/url.js';
import { ThemeProvider } from './state/theme.js';
import { ToastProvider, useToast } from './state/toasts.js';
import { useReviewPoll } from './hooks/useReviewPoll.js';
import { Header } from './components/nav/Header.js';
import { Sidebar } from './components/nav/SidebarShell.js';
import { PreviewPane, type SectionFilter } from './components/preview/PreviewPane.js';
import { DiffView, type DiffCommentInput } from './components/diff/DiffView.js';
import { ReviewBar } from './components/review/ReviewBar.js';
import { GistDialog } from './components/gist/GistDialog.js';
import { ManageModal } from './components/manage/ManageModal.js';
import { OutlineBanner } from './components/nav/Sidebar.js';
import { Button, EmptyState, ErrorNote, Spinner, cx } from './components/primitives.js';
import { IconDiff, IconEye, IconPlus } from './components/icons.js';

export function App() {
  return (
    <ThemeProvider>
      <ToastProvider>
        <ReviewWorkspace />
      </ToastProvider>
    </ThemeProvider>
  );
}

function ReviewWorkspace() {
  const params = useParams();
  const setParams = useSetParams();
  const { toast } = useToast();

  // --- projects ------------------------------------------------------------
  const projects = useApi(keys.projects, endpoints.listProjects);

  // Resolve active project: URL param → most recent.
  const projectKey = params.project ?? projects.data?.[0]?.key ?? null;

  useEffect(() => {
    if (!params.project && projects.data && projects.data.length > 0) {
      setParams({ project: projects.data[0].key });
    }
  }, [params.project, projects.data, setParams]);

  const detail = useApi(projectKey ? keys.project(projectKey) : null, () => endpoints.getProject(projectKey!));
  const versions = detail.data?.versions;
  const storage = useApi(projectKey ? keys.storage(projectKey) : null, () => endpoints.getStorage(projectKey!));

  // Active version: URL param → latest.
  const version = params.version ?? versions?.[versions.length - 1]?.n ?? null;

  useEffect(() => {
    if (versions && versions.length > 0 && !params.version) {
      setParams({ version: versions[versions.length - 1].n });
    }
  }, [versions, params.version, setParams]);

  // --- review context ------------------------------------------------------
  const pendingReviews = useApi(keys.reviewsPending, async () => endpoints.listReviews({ status: 'pending' }));
  const contextualReviewId =
    params.review ??
    pendingReviews.data?.find((r) => r.projectKey === projectKey && r.version === version)?.id ??
    null;
  const { review } = useReviewPoll(contextualReviewId);

  // --- version payload / docs ----------------------------------------------
  const versionPayload = useApi(
    projectKey && version ? keys.version(projectKey, version) : null,
    () => endpoints.getVersion(projectKey!, version!),
  );
  const manifest = versionPayload.data?.manifest;
  const isTree = manifest != null && manifest.docs.length > 1;

  const docSlug =
    params.doc && manifest?.docs.some((d) => d.slug === params.doc)
      ? params.doc
      : isTree
        ? (manifest?.root ?? null)
        : 'root';

  useEffect(() => {
    if (docSlug && params.doc !== docSlug) setParams({ doc: docSlug });
  }, [docSlug, params.doc, setParams]);

  const docPayload = useApi(
    isTree && projectKey && version && docSlug ? keys.doc(projectKey, version, docSlug) : null,
    () => endpoints.getDoc(projectKey!, version!, docSlug!),
  );

  const commentsState = useApi(
    projectKey && version ? keys.comments(projectKey, version) : null,
    () => endpoints.getComments(projectKey!, version!),
  );
  const allComments: Comment[] = commentsState.data?.comments ?? [];
  const docComments = isTree ? allComments.filter((c) => c.doc === docSlug) : allComments;

  // --- outline section filter ----------------------------------------------
  const [section, setSection] = useState<SectionFilter | null>(null);
  const [generalNoteTick, setGeneralNoteTick] = useState(0);
  useEffect(() => {
    setSection(null);
  }, [versionPayload.data, docSlug]);

  const markdown = isTree ? docPayload.data?.markdown : versionPayload.data?.markdown;
  const html = isTree ? docPayload.data?.html : versionPayload.data?.html;

  // --- mutations -----------------------------------------------------------
  const addComment = useCallback(
    async (input: {
      body: string;
      quote: string | null;
      line: number | null;
      lineEnd: number | null;
      doc?: string;
      side?: 'old' | 'new';
      baseVersion?: number;
    }) => {
      if (!projectKey || !version) return;
      await endpoints.addComment(projectKey, version, { ...input, doc: input.doc ?? docSlug ?? undefined });
      invalidate(`comments:${projectKey}:${version}`);
      toast('Comment added', 'success');
    },
    [projectKey, version, docSlug, toast],
  );

  const addDiffComment = useCallback(
    (input: DiffCommentInput) => addComment(input),
    [addComment],
  );

  const deleteComment = useCallback(
    (id: string) => {
      if (!projectKey || !version) return;
      void endpoints
        .deleteComment(projectKey, version, id)
        .then(() => {
          invalidate(`comments:${projectKey}:${version}`);
          toast('Comment deleted');
        })
        .catch((err) => toast(err instanceof Error ? err.message : 'Delete failed', 'error'));
    },
    [projectKey, version, toast],
  );

  const decide = useCallback(
    async (decision: 'approve' | 'reject', summary?: string) => {
      if (!contextualReviewId) return;
      try {
        const res = await endpoints.decide(contextualReviewId, decision, summary);
        invalidate(keys.projects, `review:${contextualReviewId}`, keys.reviewsPending);
        if (decision === 'approve') {
          toast(
            res.commentCount > 0
              ? `Approved with ${res.commentCount} comment${res.commentCount === 1 ? '' : 's'} — Claude will proceed and incorporate them`
              : 'Approved — Claude will proceed',
            'success',
          );
        } else {
          toast('Changes requested — feedback sent to Claude', 'success');
        }
      } catch (err) {
        toast(err instanceof Error ? err.message : 'Decision failed', 'error');
      }
    },
    [contextualReviewId, toast],
  );

  // --- dialogs ---------------------------------------------------------------
  const [gistOpen, setGistOpen] = useState(false);
  const [manageOpen, setManageOpen] = useState(false);
  const onGistSaved = useCallback(
    (_binding: GistBinding) => {
      if (projectKey) invalidate(`storage:${projectKey}`);
    },
    [projectKey],
  );

  const resyncAfterChange = useCallback(() => {
    invalidate(keys.projects);
  }, []);

  // If the active project vanished (deleted), fall back to first remaining.
  useEffect(() => {
    if (projects.data && params.project && !projects.data.some((p) => p.key === params.project)) {
      setParams({ project: projects.data[0]?.key ?? null, version: null, doc: null, review: null });
    }
  }, [projects.data, params.project, setParams]);

  const showDiff = params.view === 'diff';

  return (
    <div className="flex h-full flex-col bg-surface-0 text-ink">
      <Header
        projects={projects.data}
        activeProject={projectKey}
        onProjectChange={(key) => setParams({ project: key, version: null, doc: null, review: null }, { push: true })}
        gistBinding={storage.data?.gist ?? null}
        onOpenGist={() => setGistOpen(true)}
        onOpenManage={() => setManageOpen(true)}
      />

      {!projectKey ? (
        projects.loading ? (
          <Spinner label="Loading projects…" />
        ) : (
          <EmptyState
            icon={<span className="text-4xl">📋</span>}
            title="No plans yet"
            body="When Claude finishes a plan in plan mode, it lands here for your review — rendered like a README, annotatable line by line, with your decision flowing straight back to the agent."
          />
        )
      ) : (
        <div className="flex min-h-0 flex-1">
          <Sidebar
            versions={versions}
            activeVersion={version}
            onVersionChange={(n) => setParams({ version: n })}
            manifest={manifest}
            activeDoc={docSlug}
            onDocChange={(slug) => setParams({ doc: slug })}
            comments={allComments}
            review={review}
            markdown={markdown}
            outlineSelection={section}
            onOutlineSelect={(sel) => setSection(sel ? { start: sel.start, end: sel.end, label: sel.label } : null)}
          />

          <main className="flex min-w-0 flex-1 flex-col">
            <ReviewBar
              review={review}
              viewingVersion={version ?? -1}
              commentCount={allComments.length}
              onApprove={() => decide('approve')}
              onReject={(summary) => decide('reject', summary)}
            />

            {/* toolbar */}
            <div className="flex flex-wrap items-center gap-2 border-b border-border bg-surface-0 px-5 py-2 max-md:px-3">
              <ViewToggle diff={showDiff} onChange={(d) => setParams({ view: d ? 'diff' : null })} />

              {section && <OutlineBanner section={section} onClear={() => setSection(null)} />}

              <span className="flex-1" />

              {version != null && (
                <span className="font-mono text-[11.5px] text-ink-faint">
                  v{version}
                  {isTree && docSlug ? ` · ${manifest?.docs.find((d) => d.slug === docSlug)?.title ?? docSlug}` : ''}
                </span>
              )}

              {!showDiff && (
                <Button size="sm" variant="ghost" onClick={() => setGeneralNoteTick((t) => t + 1)}>
                  <IconPlus className="h-3.5 w-3.5" />
                  General note
                </Button>
              )}
            </div>

            {/* content */}
            {detail.error ? (
              <ErrorNote message={detail.error} onRetry={detail.reload} />
            ) : showDiff ? (
              <DiffView
                projectKey={projectKey}
                versions={versions ?? []}
                activeVersion={version ?? 0}
                activeDoc={docSlug}
                comments={allComments}
                onAddComment={addDiffComment}
                onDeleteComment={deleteComment}
              />
            ) : (
              <PreviewPane
                html={html}
                loading={versionPayload.loading || docPayload.loading}
                comments={docComments}
                section={section}
                generalNoteTick={generalNoteTick}
                onAddComment={addComment}
                onDeleteComment={deleteComment}
                onNavigateDoc={(slug) => setParams({ doc: slug })}
              />
            )}
          </main>
        </div>
      )}

      {projectKey && version != null && (
        <GistDialog
          open={gistOpen}
          onClose={() => setGistOpen(false)}
          projectKey={projectKey}
          projectName={detail.data?.meta.name ?? 'plan'}
          version={version}
          onSaved={onGistSaved}
        />
      )}
      <ManageModal open={manageOpen} onClose={() => setManageOpen(false)} onChanged={resyncAfterChange} />
    </div>
  );
}

function ViewToggle({ diff, onChange }: { diff: boolean; onChange: (diff: boolean) => void }) {
  return (
    <div className="flex overflow-hidden rounded-lg border border-border">
      <button
        onClick={() => onChange(false)}
        className={cx(
          'flex items-center gap-1.5 px-2.5 py-1 text-[12px] font-medium transition-colors',
          !diff ? 'bg-accent-soft text-accent' : 'bg-surface-1 text-ink-muted hover:bg-surface-2',
        )}
      >
        <IconEye className="h-3.5 w-3.5" />
        Preview
      </button>
      <button
        onClick={() => onChange(true)}
        className={cx(
          'flex items-center gap-1.5 px-2.5 py-1 text-[12px] font-medium transition-colors',
          diff ? 'bg-accent-soft text-accent' : 'bg-surface-1 text-ink-muted hover:bg-surface-2',
        )}
      >
        <IconDiff className="h-3.5 w-3.5" />
        Diff
      </button>
    </div>
  );
}
