import { useEffect } from 'react';
import type { Review } from '../../shared/types.js';
import { apiCache, useApi } from '../api/cache.js';
import { endpoints, keys } from '../api/endpoints.js';

export interface ReviewPollResult {
  review: Review | undefined;
  loading: boolean;
  error: string | undefined;
  reload: () => void;
}

/**
 * Review status poller — isolated behind this hook. Polls every ~2.5s while
 * the review is pending so decisions made elsewhere reflect automatically;
 * goes quiet once resolved.
 */
export function useReviewPoll(reviewId: string | null): ReviewPollResult {
  const { data, loading, error, reload } = useApi<Review>(
    reviewId ? keys.review(reviewId) : null,
    async () => {
      const r = await endpoints.getReview(reviewId!);
      return r;
    },
  );

  const pending = data?.status === 'pending';
  const status = data?.status;

  useEffect(() => {
    if (!reviewId || !pending) return;
    const timer = setInterval(reload, 2500);
    return () => clearInterval(timer);
  }, [reviewId, pending, reload]);

  // When a review resolves, project badges elsewhere need refreshing.
  useEffect(() => {
    if (status != null && status !== 'pending') {
      void apiCache.refetch(keys.projects, endpoints.listProjects);
    }
  }, [status]);

  return { review: data, loading, error, reload };
}
