import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Comment, CreateCommentInput, GistBinding, Review } from '../shared/types.js';
import { actionableComments } from '../shared/compile.js';
import { refresh, useApi } from './api/cache.js';
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
import { IconDiff, IconEye, IconList, IconPlus, IconX } from './components/icons.js';

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

  const detail = useApi(projectKey ? keys.project(projectKey) : null, () =>
    endpoints.getProject(projectKey!),
  );
  const versions = detail.data?.versions;
  const storage = useApi(projectKey ? keys.storage(projectKey) : null, () =>
    endpoints.getStorage(projectKey!),
  );

  // Active version: URL param → latest.
  const version = params.version ?? versions?.[versions.length - 1]?.n ?? null;

  useEffect(() => {
    if (versions && versions.length > 0 && !params.version) {
      setParams({ version: versions[versions.length - 1].n });
    }
  }, [versions, params.version, setParams]);

  // --- review context ------------------------------------------------------
  const pendingReviews = useApi(keys.reviewsPending, async () =>
    endpoints.listReviews({ status: 'pending' }),
  );
  const explicitReview = useApi<Review>(params.review ? keys.review(params.review) : null, () =>
    endpoints.getReview(params.review!),
  );
  const explicitReviewMatches =
    explicitReview.data?.projectKey === projectKey && explicitReview.data?.version === version;
  const contextualReviewId =
    (explicitReviewMatches ? explicitReview.data?.id : undefined) ??
    pendingReviews.data?.find((r) => r.projectKey === projectKey && r.version === version)?.id ??
    null;
  // A pending review's comments are live data too: an agent reply arrives there,
  // not in the review record. Ride the review poll so the thread updates in step.
  const pollComments = useCallback(() => {
    if (projectKey && version) refresh(keys.comments(projectKey, version));
  }, [projectKey, version]);
  const { review } = useReviewPoll(contextualReviewId, pollComments);
  useEffect(() => {
    if (params.review && explicitReview.data && !explicitReviewMatches) setParams({ review: null });
  }, [explicitReview.data, explicitReviewMatches, params.review, setParams]);
  const reviewOnVersion =
    review?.status === 'pending' && review.projectKey === projectKey && review.version === version;
  // Two origins can carry an Ask back to the agent: an mcp review is read by
  // plan_review_check, a hook review by the blocking ExitPlanMode hook. An api
  // review has no consumer, so the store refuses an Ask there too.
  const askableReview =
    reviewOnVersion && (review.origin === 'mcp' || review.origin === 'hook') ? review : undefined;
  const deliveryUI = useMemo(
    () => ({
      canAsk: askableReview != null,
      reviewId: askableReview?.id,
      decisionLabel: reviewOnVersion ? 'Add to decision' : 'Add note',
      deliveryNote: askableReview
        ? askableReview.origin === 'hook'
          ? 'Ask agent holds your plan-mode reviewer open so it can answer you. The question is delivered the next time it presents the plan.'
          : 'Ask agent wakes the connected reviewer. If disconnected, it waits for the next check.'
        : reviewOnVersion
          ? 'This review has no connected agent to answer questions. Comments reach it when you decide.'
          : 'This version is no longer under review.',
    }),
    [askableReview, reviewOnVersion],
  );

  // EVERY version with an open review, not just the contextual one: the header pill
  // counts them all, while the rail used to mark only the review in the URL.
  const pendingVersions = useMemo(
    () =>
      new Set(
        (pendingReviews.data ?? [])
          .filter((r) => r.projectKey === projectKey && r.status === 'pending')
          .map((r) => r.version),
      ),
    [pendingReviews.data, projectKey],
  );

  // --- version payload / docs ----------------------------------------------
  const versionPayload = useApi(projectKey && version ? keys.version(projectKey, version) : null, () =>
    endpoints.getVersion(projectKey!, version!),
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
    // Only normalise the URL once we know this version's real document list:
    // before the payload arrives `docSlug` falls back to the root, and writing
    // that back would throw away a `?doc=` deep link on every cold load.
    if (!versionPayload.data) return;
    if (docSlug && params.doc !== docSlug) setParams({ doc: docSlug });
  }, [versionPayload.data, docSlug, params.doc, setParams]);

  const docPayload = useApi(
    isTree && projectKey && version && docSlug ? keys.doc(projectKey, version, docSlug) : null,
    () => endpoints.getDoc(projectKey!, version!, docSlug!),
  );

  const commentsState = useApi(projectKey && version ? keys.comments(projectKey, version) : null, () =>
    endpoints.getComments(projectKey!, version!),
  );
  const allComments: Comment[] = commentsState.data?.comments ?? [];
  const feedbackComments = allComments.filter(
    (comment) => comment.decisionReviewId == null || comment.decisionReviewId === review?.id,
  );
  const actionable = actionableComments(feedbackComments);
  const docComments = isTree ? allComments.filter((c) => c.doc === docSlug) : allComments;

  useEffect(() => {
    if (review?.status === 'pending') refresh(keys.comments(review.projectKey, review.version));
  }, [review]);

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
    async (input: CreateCommentInput) => {
      if (!projectKey || !version) return;
      const delivery = input.delivery ?? 'decision';
      await endpoints.addComment(projectKey, version, {
        ...input,
        delivery,
        reviewId: reviewOnVersion ? review?.id : delivery === 'ask' ? askableReview?.id : undefined,
        doc: input.doc ?? docSlug ?? undefined,
      });
      refresh(keys.comments(projectKey, version));
      toast(
        delivery === 'ask' ? 'Asked agent' : reviewOnVersion ? 'Added to decision batch' : 'Note added',
        'success',
      );
    },
    [projectKey, version, docSlug, askableReview?.id, review?.id, reviewOnVersion, toast],
  );

  const addDiffComment = useCallback((input: DiffCommentInput) => addComment(input), [addComment]);

  const deleteComment = useCallback(
    (id: string) => {
      if (!projectKey || !version) return;
      void endpoints
        .deleteComment(projectKey, version, id)
        .then(() => {
          refresh(keys.comments(projectKey, version));
          toast('Comment deleted');
        })
        .catch((err) => toast(err instanceof Error ? err.message : 'Delete failed', 'error'));
    },
    [projectKey, version, toast],
  );

  const replyComment = useCallback(
    async (rootId: string, body: string, delivery: CreateCommentInput['delivery'] = 'decision') => {
      if (!projectKey || !version) return;
      try {
        await endpoints.replyToComment(projectKey, version, rootId, {
          body,
          delivery,
          reviewId: reviewOnVersion ? review?.id : delivery === 'ask' ? askableReview?.id : undefined,
        });
        refresh(keys.comments(projectKey, version));
        toast(
          delivery === 'ask' ? 'Asked agent' : reviewOnVersion ? 'Added to decision batch' : 'Note added',
          'success',
        );
      } catch (err) {
        toast(err instanceof Error ? err.message : 'Reply failed', 'error');
        throw err;
      }
    },
    [projectKey, version, askableReview?.id, review?.id, reviewOnVersion, toast],
  );

  const resolveComment = useCallback(
    (id: string, resolved: boolean) => {
      if (!projectKey || !version) return;
      void endpoints
        .resolveComment(projectKey, version, id, resolved)
        .then(() => refresh(keys.comments(projectKey, version)))
        .catch((err) => toast(err instanceof Error ? err.message : 'Update failed', 'error'));
    },
    [projectKey, version, toast],
  );

  const decide = useCallback(
    async (decision: 'approve' | 'reject', summary?: string) => {
      if (!contextualReviewId) return;
      try {
        const res = await endpoints.decide(contextualReviewId, decision, summary);
        refresh(keys.projects, keys.review(contextualReviewId), keys.reviewsPending);
        if (projectKey && version) refresh(keys.comments(projectKey, version));
        if (decision === 'approve') {
          toast(
            res.commentCount > 0
              ? `Approved with ${res.commentCount} comment${res.commentCount === 1 ? '' : 's'} — the agent will proceed and incorporate them`
              : 'Approved — the agent will proceed',
            'success',
          );
        } else {
          toast('Changes requested — feedback sent to the agent', 'success');
        }
      } catch (err) {
        toast(err instanceof Error ? err.message : 'Decision failed', 'error');
      }
    },
    [contextualReviewId, projectKey, version, toast],
  );

  // --- dialogs ---------------------------------------------------------------
  const [gistOpen, setGistOpen] = useState(false);
  const [manageOpen, setManageOpen] = useState(false);
  // The rail is hidden below `lg`; this drives the drawer that replaces it.
  const [railOpen, setRailOpen] = useState(false);

  useEffect(() => {
    if (!railOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setRailOpen(false);
    };
    window.addEventListener('keydown', onKey);
    // A drawer left open while the window grows past `lg` would sit on top of the
    // real rail.
    const wide = window.matchMedia('(min-width: 1024px)');
    const onWide = (): void => {
      if (wide.matches) setRailOpen(false);
    };
    wide.addEventListener('change', onWide);
    return () => {
      window.removeEventListener('keydown', onKey);
      wide.removeEventListener('change', onWide);
    };
  }, [railOpen]);
  const onGistSaved = useCallback(
    (_binding: GistBinding) => {
      if (projectKey) refresh(keys.storage(projectKey));
    },
    [projectKey],
  );

  const resyncAfterChange = useCallback(() => {
    refresh(keys.projects);
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
        onProjectChange={(key) =>
          setParams({ project: key, version: null, doc: null, review: null }, { push: true })
        }
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
            body="When the agent finishes a plan in plan mode, it lands here for your review — rendered like a README, annotatable line by line, with your decision flowing straight back to the agent."
          />
        )
      ) : (
        <div className="flex min-h-0 flex-1">
          <Sidebar
            versions={versions}
            activeVersion={version}
            onVersionChange={(n) => setParams({ version: n, review: null })}
            manifest={manifest}
            activeDoc={docSlug}
            onDocChange={(slug) => setParams({ doc: slug })}
            threads={actionable}
            pendingVersions={pendingVersions}
            review={review}
            markdown={markdown}
            outlineSelection={section}
            onOutlineSelect={(sel) =>
              setSection(sel ? { start: sel.start, end: sel.end, label: sel.label } : null)
            }
          />

          <main className="flex min-w-0 flex-1 flex-col">
            <ReviewBar
              review={review}
              projectKey={projectKey}
              viewingVersion={version ?? -1}
              threadCount={actionable.length}
              onApprove={() => decide('approve')}
              onReject={(summary) => decide('reject', summary)}
            />

            {/* toolbar */}
            <div className="flex flex-wrap items-center gap-2 border-b border-border bg-surface-0 px-5 py-2 max-md:px-3">
              {/* Below `lg` the rail is hidden, so this is the only way to change
                  version, page or outline section. */}
              <button
                onClick={() => setRailOpen(true)}
                aria-label="Versions and pages"
                className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1 text-[12px] font-medium text-ink-muted transition-colors hover:bg-surface-2 hover:text-ink lg:hidden"
              >
                <IconList className="h-3.5 w-3.5" />
                Versions &amp; pages
              </button>

              <ViewToggle diff={showDiff} onChange={(d) => setParams({ view: d ? 'diff' : null })} />

              {section && <OutlineBanner section={section} onClear={() => setSection(null)} />}

              <span className="flex-1" />

              {version != null && (
                <span className="font-mono text-[11.5px] text-ink-faint">
                  v{version}
                  {isTree && docSlug
                    ? ` · ${manifest?.docs.find((d) => d.slug === docSlug)?.title ?? docSlug}`
                    : ''}
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
                deliveryUI={deliveryUI}
                onAddComment={addDiffComment}
                onDeleteComment={deleteComment}
                onReply={replyComment}
                onResolve={resolveComment}
              />
            ) : (
              <PreviewPane
                html={html}
                loading={versionPayload.loading || docPayload.loading}
                comments={docComments}
                deliveryUI={deliveryUI}
                section={section}
                generalNoteTick={generalNoteTick}
                onAddComment={addComment}
                onDeleteComment={deleteComment}
                onReply={replyComment}
                onResolve={resolveComment}
                onNavigateDoc={(slug) => setParams({ doc: slug })}
              />
            )}
          </main>
        </div>
      )}

      {projectKey && railOpen && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div
            className="absolute inset-0 animate-fade-in bg-black/45 backdrop-blur-[2px]"
            onClick={() => setRailOpen(false)}
          />
          <div
            role="dialog"
            aria-modal
            aria-label="Versions and pages"
            className="absolute inset-y-0 left-0 flex w-72 max-w-[85vw] flex-col border-r border-border bg-surface-0 shadow-pop"
          >
            <div className="flex shrink-0 items-center justify-between border-b border-border px-3 py-2.5">
              <h2 className="text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-faint">
                Versions &amp; pages
              </h2>
              <button
                onClick={() => setRailOpen(false)}
                aria-label="Close versions and pages"
                className="rounded-lg p-1 text-ink-faint transition-colors hover:bg-surface-2 hover:text-ink"
              >
                <IconX className="h-4 w-4" />
              </button>
            </div>
            <Sidebar
              versions={versions}
              activeVersion={version}
              onVersionChange={(n) => setParams({ version: n, review: null })}
              manifest={manifest}
              activeDoc={docSlug}
              onDocChange={(slug) => setParams({ doc: slug })}
              threads={actionable}
              pendingVersions={pendingVersions}
              review={review}
              markdown={markdown}
              outlineSelection={section}
              onOutlineSelect={(sel) =>
                setSection(sel ? { start: sel.start, end: sel.end, label: sel.label } : null)
              }
              className="min-h-0 flex-1 overflow-y-auto"
              onNavigate={() => setRailOpen(false)}
            />
          </div>
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
