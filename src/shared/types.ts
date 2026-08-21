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
}

export interface DiffResponse {
  doc: string;
  from: { markdown: string };
  to: { markdown: string };
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
