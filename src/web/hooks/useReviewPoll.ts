import { useEffect } from 'react';
import type { Review } from '../../shared/types.js';
import { apiCache, useApi } from '../api/cache.js';
import { endpoints, keys } from '../api/endpoints.js';
import { reviewPollDelay } from './reviewPollDelay.js';

export interface ReviewPollResult {
  review: Review | undefined;
  loading: boolean;
  error: string | undefined;
  reload: () => void;
}

/**
 * Review status poller — isolated behind this hook.
 *
 * Polls while the review is pending and the tab is visible, with the backoff from
 * `reviewPollDelay`; goes quiet once resolved. A hidden tab does no polling at all
 * and refreshes immediately on return, so a backgrounded tab costs nothing and is
 * never stale when you look at it again.
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
    let timer: number | undefined;
    let cancelled = false;
    // Resets whenever the tab becomes visible again: a human who just came back
    // gets fresh data now and a responsive cadence, not a 30s wait.
    let startedAt = Date.now();

    const schedule = (): void => {
      if (cancelled || document.hidden) return; // visibilitychange will resume us
      timer = window.setTimeout(tick, reviewPollDelay(Date.now() - startedAt));
    };
    const tick = (): void => {
      if (cancelled) return;
      // A timer scheduled before the tab was hidden would otherwise fire once.
      if (document.hidden) {
        schedule();
        return;
      }
      reload();
      schedule();
    };
    const onVisibility = (): void => {
      if (cancelled || document.hidden) return;
      startedAt = Date.now();
      if (timer) window.clearTimeout(timer);
      reload();
      schedule();
    };

    document.addEventListener('visibilitychange', onVisibility);
    schedule();
    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [reviewId, pending, reload]);

  // When a review resolves, project badges elsewhere need refreshing.
  useEffect(() => {
    if (status != null && status !== 'pending') {
      void apiCache.refetch(keys.projects, endpoints.listProjects);
    }
  }, [status]);

  return { review: data, loading, error, reload };
}
