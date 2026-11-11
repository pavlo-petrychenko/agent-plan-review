/**
 * Reading and joining the plans of one worktree. A worktree holds one plan per
 * agent (see record.ts); these helpers let an agent look at the others and
 * continue one of them.
 */

import type { Comment, Manifest, ProjectMeta, ReviewStatus } from '../../shared/types.js';
import { groupThreads } from '../../shared/threads.js';
import { badRequest, notFound } from '../util/errors.js';
import type { CommentStore } from './comments.js';
import { extractRootTitle, findNamedPlan, markAgentActive, resolveWorktreeCwd } from './record.js';
import type { ProjectStore } from './projects.js';
import type { ReviewStore } from './reviews.js';
import type { VersionStore } from './versions.js';

export interface PlanListEntry {
  /** `p-xxxxxx`; the full project key for a legacy (pre-plans) worktree project. */
  planId: string;
  /** True for the worktree's legacy project, addressed by its full key. */
  worktreePlan: boolean;
  title: string;
  currentVersion: number;
  /** Status of the newest review of the current version. */
  status: ReviewStatus | 'none';
  updatedAt: string;
  /** The asking agent wrote to or joined this plan. */
  mine: boolean;
  /** Terminal of the agent that submitted the newest review, when known. */
  lastAgentTerminal?: string;
}

export interface OpenThread {
  threadId: string;
  doc: string;
  line: number | null;
  lineEnd: number | null;
  quote: string | null;
  author: Comment['author'];
  body: string;
  replies: { author: Comment['author']; body: string }[];
}

export interface PlanSnapshot {
  planId: string;
  worktreePlan: boolean;
  projectKey: string;
  title: string;
  version: number;
  currentVersion: number;
  /** Single document, or the pages of a tree joined with `<!--doc ...-->` markers. */
  markdown: string;
  openThreads: OpenThread[];
}

export interface SharingStores {
  projects: ProjectStore;
  versions: VersionStore;
  reviews: ReviewStore;
  comments: CommentStore;
}

const planIdOf = (meta: ProjectMeta): string => meta.plan?.id ?? meta.key;

/** The plans of the worktree containing `rawCwd`, newest first. */
export async function listWorktreePlans(
  s: SharingStores,
  rawCwd: string,
  agentId: string,
): Promise<PlanListEntry[]> {
  const cwd = await resolveWorktreeCwd(s.projects, rawCwd);
  const entries: PlanListEntry[] = [];
  for (const meta of await s.projects.listByWorktree(cwd)) {
    if (meta.currentVersion < 1) continue;
    const newest = (await s.reviews.list({ projectKey: meta.key, version: meta.currentVersion }))[0];
    entries.push({
      planId: planIdOf(meta),
      worktreePlan: !meta.plan,
      title: meta.plan?.title ?? (await legacyTitle(s.versions, meta)),
      currentVersion: meta.currentVersion,
      status: newest?.status ?? 'none',
      updatedAt: meta.updatedAt,
      mine: meta.agents?.includes(agentId) ?? false,
      ...(newest?.agent?.terminal ? { lastAgentTerminal: newest.agent.terminal } : {}),
    });
  }
  return entries; // listByWorktree is newest first
}

/** Read one plan of this worktree (default: its current version). Changes nothing. */
export async function readWorktreePlan(
  s: SharingStores,
  rawCwd: string,
  planId: string,
  version?: number,
): Promise<PlanSnapshot> {
  const cwd = await resolveWorktreeCwd(s.projects, rawCwd);
  const meta = await findNamedPlan(s.projects, cwd, planId);
  const n = version ?? meta.currentVersion;
  if (!Number.isInteger(n) || n < 1) throw badRequest('version must be a positive integer');
  const info = await s.versions.readMeta(meta.key, n);
  if (!info) throw notFound(`Version ${n} of plan ${planIdOf(meta)}`);

  let markdown: string;
  if (info.kind === 'single') {
    markdown = (await s.versions.readMarkdown(meta.key, n)) ?? '';
  } else {
    const manifest = await s.versions.readManifest(meta.key, n);
    markdown = manifest ? await joinTree(s.versions, meta.key, n, manifest) : '';
  }

  const threads = groupThreads(await s.comments.list(meta.key, n))
    .filter((t) => !t.root.resolved)
    .map((t): OpenThread => ({
      threadId: t.root.id,
      doc: t.root.doc,
      line: t.root.line,
      lineEnd: t.root.lineEnd,
      quote: t.root.quote,
      author: t.root.author,
      body: t.root.body,
      replies: t.replies.map((r) => ({ author: r.author, body: r.body })),
    }));

  return {
    planId: planIdOf(meta),
    worktreePlan: !meta.plan,
    projectKey: meta.key,
    title: meta.plan?.title ?? (await legacyTitle(s.versions, meta)),
    version: n,
    currentVersion: meta.currentVersion,
    markdown,
    openThreads: threads,
  };
}

/**
 * Make `agentId` a participant of the plan and its preferred one: a later
 * submit without `planId` (the ExitPlanMode hook cannot pass one) lands there.
 * Touches nothing else — versions and `updatedAt` stay as they were.
 */
export async function joinWorktreePlan(
  s: SharingStores,
  rawCwd: string,
  planId: string,
  agentId: string,
): Promise<ProjectMeta> {
  const cwd = await resolveWorktreeCwd(s.projects, rawCwd);
  const meta = await findNamedPlan(s.projects, cwd, planId);
  await markAgentActive(s.projects, cwd, meta, agentId);
  return meta;
}

async function legacyTitle(versions: VersionStore, meta: ProjectMeta): Promise<string> {
  const n = meta.currentVersion;
  const manifest = await versions.readManifest(meta.key, n);
  if (manifest) {
    return (manifest.docs.find((d) => d.slug === manifest.root) ?? manifest.docs[0])?.title ?? meta.name;
  }
  const md = await versions.readMarkdown(meta.key, n);
  return md ? extractRootTitle(md) : meta.name;
}

/**
 * Tree → one string `plan_review_submit` accepts back: the root page first with
 * no marker, then every other page under a marker. A root whose slug is not
 * `root` (structured submissions) is renamed so `parent=` stays valid.
 */
async function joinTree(versions: VersionStore, key: string, n: number, manifest: Manifest): Promise<string> {
  const rootSlug = manifest.root;
  const parts: string[] = [];
  const root = manifest.docs.find((d) => d.slug === rootSlug) ?? manifest.docs[0];
  parts.push(((await versions.readDoc(key, n, root.slug)) ?? '').trimEnd());
  for (const doc of manifest.docs) {
    if (doc === root) continue;
    const parent = !doc.parent || doc.parent === root.slug ? 'root' : doc.parent;
    const title = doc.title.replace(/"/g, "'");
    parts.push(
      `<!--doc slug=${doc.slug} title="${title}" parent=${parent}-->\n` +
        ((await versions.readDoc(key, n, doc.slug)) ?? '').trimEnd(),
    );
  }
  return parts.join('\n\n') + '\n';
}
