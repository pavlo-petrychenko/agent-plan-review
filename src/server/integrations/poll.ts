import type { Review } from '../../shared/types.js';
import type { PlanReviewStore } from '../store/store.js';

/**
 * Poll the store until a review is decided (or the timeout elapses).
 * Returns the resolved review, or undefined on timeout / missing review.
 */
export async function waitForDecision(
  store: PlanReviewStore,
  reviewId: string,
  timeoutSeconds: number,
): Promise<Review | undefined> {
  const deadline = Date.now() + timeoutSeconds * 1000;
  for (;;) {
    const review = await store.getReview(reviewId);
    if (!review) return undefined;
    if (review.status !== 'pending') return review;
    if (Date.now() >= deadline) return undefined;
    await sleep(500);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
