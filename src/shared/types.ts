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

/** Who wrote a comment. The agent replies through the reply tool/endpoint. */
export type CommentAuthor = 'me' | 'agent';

export type CommentDelivery = 'ask' | 'decision';

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
  /**
   * Word-exact anchor: character offsets [start, end) into this page's markdown
   * source. Optional and advisory — clients that lack it fall back to the line
   * anchor plus quote search. Dropped when a carried thread's line anchor moves.
   */
  range?: CommentRange;
  body: string;
  author: CommentAuthor;
  createdAt: string;
  delivery?: CommentDelivery;
  wakeReviewId?: string;
  decisionReviewId?: string;
  /**
   * Thread root this comment replies to; null/absent marks a thread root.
   * A reply inherits its anchor (doc/line/side/baseVersion) from the root.
   */
  parentId?: string | null;
  /** Set on a thread ROOT when the human marks the conversation resolved. */
  resolved?: boolean;
  /** When the thread was resolved. */
  resolvedAt?: string;
  /**
   * `body` rendered to HTML. Derived at read time for display (never persisted):
   * markdown, with raw HTML dropped so an agent cannot inject markup.
   */
  html?: string;
}

export const MAX_QUOTE_LEN = 2000;

/** Character offsets [start, end) into a page's markdown source. */
export interface CommentRange {
  start: number;
  end: number;
}

/** Which terminal (and harness) a review was submitted from. */
export interface ReviewAgent {
  /** Terminal id, e.g. Herdr's HC_TERMINAL_ID. */
  terminal: string;
  /** Agent harness, e.g. 'claude-code' or the MCP client name. */
  harness?: string;
}

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
  /**
   * Set on a plan project (key `<worktree key>.p-<id>`): one of possibly many
   * plans in the worktree `cwd`. Absent on the worktree's legacy project (the
   * bare worktree key, as stored before plans existed). `title` follows the
   * root title of the newest version.
   */
  plan?: { id: string; title: string };
  /** Agent ids that wrote to or joined this project, newest last, no repeats. */
  agents?: string[];
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
  /**
   * Claude Code session this review belongs to (hook origin only). One live
   * review per session: answering an Ask means calling ExitPlanMode again, and
   * every round must land on the SAME review or its threads and conversation
   * cursor are orphaned on the previous version.
   */
  sessionId?: string;
  /**
   * The terminal the submitting agent runs in (Herdr's HC_TERMINAL_ID), when
   * known. Plain metadata: recorded whether or not the Herdr integration is on.
   */
  agent?: ReviewAgent;
  /** Agent id (see server/agent-id.ts) that submitted this review, when known. */
  agentId?: string;
  /**
   * ISO timestamp of the newest targeted Ask already handed to the agent by
   * plan_review_check — the cursor that keeps the conversation from looping.
   */
  agentCursor?: string;
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
  range?: CommentRange;
  body: string;
  delivery?: CommentDelivery;
  reviewId?: string;
  side?: 'old' | 'new';
  baseVersion?: number;
  /** Thread root this comment replies to (anchor inherited from the root). */
  parentId?: string | null;
}

/** A thread root plus its replies, oldest first. */
export interface CommentThreadView {
  root: Comment;
  replies: Comment[];
}

/** GET /api/reviews/:id/messages — new human messages since a cursor. */
export interface ReviewMessagesPayload {
  /** Newest comment createdAt included (pass back as `since`). */
  cursor: string | null;
  /** Targeted human Ask roots/replies the agent has not seen yet. */
  comments: Comment[];
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
  /**
   * True when an existing pending review was adopted instead of a new one
   * (one live review per plan-mode session). The caller should treat this as
   * "the review you were already showing", not a fresh request.
   */
  reusedReview: boolean;
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
