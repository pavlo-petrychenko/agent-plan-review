/**
 * Shared domain model + API contracts.
 *
 * This module is the single source of truth for every shape that crosses the
 * wire between the Express server and the React client. Both sides import from
 * here — never hand-duplicate a DTO.
 */

// ---------------------------------------------------------------------------
// Domain
// ---------------------------------------------------------------------------

export type VersionKind = 'single' | 'tree';

export type ReviewOrigin = 'hook' | 'mcp' | 'api';

export type ReviewStatus = 'pending' | 'approved' | 'rejected';

/** A comment anchored either to source lines or to a document as a whole. */
export interface Comment {
  id: string;
  /** Document slug this comment belongs to ('root' for single-doc versions). */
  doc: string;
  /** First source line of the anchor; null for general comments. */
  line: number | null;
  /** Last source line of the anchor; null for general comments. */
  lineEnd: number | null;
  /**
   * Which side of a version diff the anchor points at. Absent means 'new' (the
   * reviewed version); 'old' means a line of `baseVersion` that the diff showed
   * as removed — the anchor cannot be resolved against the reviewed version.
   */
  side?: 'old' | 'new';
  /** Base version an 'old'-side anchor refers to. */
  baseVersion?: number;
  /** Verbatim selected text, whitespace-normalized, capped at MAX_QUOTE_LEN. */
  quote: string | null;
  body: string;
  author: 'me';
  createdAt: string;
}

export const MAX_QUOTE_LEN = 2000;

export interface DocMeta {
  slug: string;
  title: string;
  parent: string | null;
}

export interface Manifest {
  root: string;
  docs: DocMeta[];
}

export interface VersionInfo {
  n: number;
  createdAt: string;
  kind: VersionKind;
  docCount: number;
  hash: string;
}

export interface GistBinding {
  id: string;
  htmlUrl: string;
  filename: string;
  description?: string;
  savedVersion: number;
  savedAt: string;
}

export interface ProjectMeta {
  key: string;
  name: string;
  cwd: string;
  createdAt: string;
  updatedAt: string;
  currentVersion: number;
  latestHash?: string;
  storage?: {
    gist?: GistBinding;
  };
}

export interface Review {
  id: string;
  projectKey: string;
  version: number;
  status: ReviewStatus;
  origin: ReviewOrigin;
  cwd: string;
  /** Raw cwd the agent submitted, kept for diagnostics when it was folded. */
  agentCwd?: string;
  createdAt: string;
  resolvedAt?: string;
  /** Compiled feedback attached when rejected. */
  reason?: string;
  /** Compiled guidance attached when approved with comments. */
  notes?: string;
  toolUseId?: string;
}

export interface PlanIssue {
  message: string;
  /** The offending `<!--doc ...-->` marker, when applicable. */
  marker?: string;
}

// ---------------------------------------------------------------------------
// API DTOs
// ---------------------------------------------------------------------------

export interface ChannelInfo {
  id: 'gist';
  label: string;
  ready: boolean;
  installed?: boolean;
  authed?: boolean;
  hasGistScope?: boolean;
  reason?: string;
  fixCommand?: string;
  fixUrl?: string;
}

export interface ProjectSummary extends ProjectMeta {
  pending: number;
  versionCount: number;
}

export interface ProjectDetail {
  meta: ProjectMeta;
  versions: VersionInfo[];
}

/** GET /api/projects/:key/versions/:n */
export interface VersionPayload {
  n: number;
  kind: VersionKind;
  meta: VersionInfo & { manifest?: Manifest };
  manifest?: Manifest;
  markdown?: string;
  html?: string;
}

/** GET /api/projects/:key/versions/:n/docs/:slug */
export interface DocPayload {
  slug: string;
  title: string;
  parent: string | null;
  markdown: string;
  html: string;
}

export interface CommentsPayload {
  comments: Comment[];
}

export interface CreateCommentInput {
  doc?: string;
  line?: number | null;
  lineEnd?: number | null;
  quote?: string | null;
  body: string;
  side?: 'old' | 'new';
  baseVersion?: number;
}

export type DiffDocStatus = 'added' | 'removed' | 'modified' | 'unchanged';

/** One document's slice of a version-to-version diff. */
export interface DiffDocEntry {
  slug: string;
  /** Title on the new side; falls back to the base title for removed docs. */
  title: string;
  parent: string | null;
  status: DiffDocStatus;
  /** Base-side source text ('' when the document did not exist yet). */
  from?: string;
  /** New-side source text ('' when the document was removed). */
  to?: string;
}

export interface DiffResponse {
  from: { n: number; manifest?: Manifest };
  to: { n: number; manifest?: Manifest };
  /** Every document of the union, in new-side order then removed docs. */
  docs: DiffDocEntry[];
}

export interface MoveVersionsResponse {
  /** Target project key. */
  to: string;
  moved: { from: number; to: number }[];
  /** True when the source project had no versions left and was removed. */
  sourceRemoved: boolean;
}

export interface SaveRequest {
  channel: 'gist';
  description: string;
  filename: string;
}

export interface RecordPlanResult {
  projectKey: string;
  version: number;
  reviewId: string;
  reviewUrl: string;
  deduped: boolean;
  /** True when a duplicate tool_use_id lost the create race and must not open a tab. */
  isLoser?: boolean;
}

export interface DecisionResponse {
  review: Review;
  commentCount: number;
}

export interface BulkDeleteResponse {
  deleted: number[];
  blocked: { n: number; pendingReviews: number }[];
  meta: ProjectMeta | null;
}
