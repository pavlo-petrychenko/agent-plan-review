/**
 * Typed endpoint layer — the only place that knows URL shapes.
 * Keys mirror endpoints so cache invalidation stays predictable.
 */

import { api } from './client.js';
import type {
  BulkDeleteResponse,
  ChannelInfo,
  Comment,
  CommentsPayload,
  CreateCommentInput,
  DecisionResponse,
  DiffResponse,
  DocPayload,
  GistBinding,
  MoveVersionsResponse,
  ProjectDetail,
  ProjectSummary,
  Review,
  ReviewStatus,
  VersionPayload,
} from '../../shared/types.js';

export const keys = {
  projects: 'projects',
  project: (key: string) => `project:${key}`,
  version: (key: string, n: number) => `version:${key}:${n}`,
  doc: (key: string, n: number, slug: string) => `doc:${key}:${n}:${slug}`,
  comments: (key: string, n: number) => `comments:${key}:${n}`,
  review: (id: string) => `review:${id}`,
  reviewsPending: 'reviews:pending',
  channels: 'channels',
  storage: (key: string) => `storage:${key}`,
  diff: (key: string, from: number, to: number) => `diff:${key}:${from}:${to}`,
};

export const endpoints = {
  listProjects: () => api.get<ProjectSummary[]>('/api/projects'),

  getProject: (key: string) => api.get<ProjectDetail>(`/api/projects/${encodeURIComponent(key)}`),

  getVersion: (key: string, n: number) =>
    api.get<VersionPayload>(`/api/projects/${encodeURIComponent(key)}/versions/${n}`),

  getDoc: (key: string, n: number, slug: string) =>
    api.get<DocPayload>(
      `/api/projects/${encodeURIComponent(key)}/versions/${n}/docs/${encodeURIComponent(slug)}`,
    ),

  getComments: (key: string, n: number) =>
    api.get<CommentsPayload>(`/api/projects/${encodeURIComponent(key)}/versions/${n}/comments`),

  addComment: (key: string, n: number, input: CreateCommentInput) =>
    api.post<Comment>(`/api/projects/${encodeURIComponent(key)}/versions/${n}/comments`, input),

  deleteComment: (key: string, n: number, id: string) =>
    api.del<{ ok: true }>(`/api/projects/${encodeURIComponent(key)}/versions/${n}/comments/${id}`),

  getDiff: (key: string, from: number, to: number) =>
    api.get<DiffResponse>(`/api/projects/${encodeURIComponent(key)}/diff?from=${from}&to=${to}`),

  moveVersions: (key: string, to: string, versions?: number[]) =>
    api.post<MoveVersionsResponse>(`/api/projects/${encodeURIComponent(key)}/move`, { to, versions }),

  getReview: (id: string) => api.get<Review>(`/api/reviews/${encodeURIComponent(id)}`),

  listReviews: (filter?: { status?: ReviewStatus; projectKey?: string; version?: number }) => {
    const q = new URLSearchParams();
    if (filter?.status) q.set('status', filter.status);
    if (filter?.projectKey) q.set('project', filter.projectKey);
    if (filter?.version != null) q.set('version', String(filter.version));
    const qs = q.toString();
    return api.get<Review[]>(`/api/reviews${qs ? `?${qs}` : ''}`);
  },

  decide: (id: string, decision: 'approve' | 'reject', summary?: string) =>
    api.post<DecisionResponse>(`/api/reviews/${encodeURIComponent(id)}/decision`, {
      decision,
      summary,
    }),

  deleteVersion: (key: string, n: number, force: boolean) =>
    api.del<{ ok: true }>(`/api/projects/${encodeURIComponent(key)}/versions/${n}${force ? '?force=1' : ''}`),

  bulkDeleteVersions: (key: string, versions: number[], force: boolean) =>
    api.post<BulkDeleteResponse>(`/api/projects/${encodeURIComponent(key)}/bulk-delete`, {
      versions,
      force,
    }),

  deleteProject: (key: string, force: boolean) =>
    api.del<{ ok: true }>(`/api/projects/${encodeURIComponent(key)}${force ? '?force=1' : ''}`),

  getChannels: () => api.get<ChannelInfo[]>('/api/channels'),

  getStorage: (key: string) =>
    api.get<{ gist: GistBinding | null }>(`/api/projects/${encodeURIComponent(key)}/storage`),

  saveToGist: (key: string, n: number, description: string, filename: string) =>
    api.post<GistBinding & { created: boolean }>(
      `/api/projects/${encodeURIComponent(key)}/versions/${n}/save`,
      { channel: 'gist', description, filename },
    ),
};

export function findLatestPendingReview(
  reviews: Review[] | undefined,
  projectKey: string | null,
  version: number | null,
): Review | undefined {
  if (!reviews) return undefined;
  return reviews.find(
    (r) =>
      r.status === ('pending' satisfies ReviewStatus) &&
      (!projectKey || r.projectKey === projectKey) &&
      (version == null || r.version === version),
  );
}
