import type { Comment, Review } from '../../shared/types.js';
import type { PlanReviewStore } from '../store/store.js';

/**
 * What woke the waiter.
 *
 * `decided` is the normal end of a review. `ask` is the plan-mode escape
 * hatch: the ExitPlanMode hook BLOCKS the tool call until the human acts, so a
 * question has no way to reach the agent unless the hook gives up its wait and
 * returns control. `timedOut` is the fail-open case.
 */
export type WaitOutcome =
  | { kind: 'decided'; review: Review }
  | { kind: 'ask'; review: Review; comments: Comment[]; cursor: string | null }
  | { kind: 'timedOut' };

/**
 * Poll the store until a review is decided or the human asks the agent a
 * question (or the timeout elapses).
 *
 * Delivering an Ask marks the conversation cursor, so the same question is
 * never handed over twice — that is what stops a hook round-tripping with the
 * human forever. Marking is "delivered", not "answered": an Ask the agent
 * ignores simply stops being offered, and the thread stays visibly open in the
 * review UI for the human to re-ask or resolve.
 */
export async function waitForDecisionOrAsk(
  store: PlanReviewStore,
  reviewId: string,
  timeoutSeconds: number,
): Promise<WaitOutcome> {
  const deadline = Date.now() + timeoutSeconds * 1000;
  for (;;) {
    const review = await store.getReview(reviewId);
    if (!review) return { kind: 'timedOut' };
    if (review.status !== 'pending') return { kind: 'decided', review };

    const messages = await store.getReviewMessages(reviewId);
    if (messages.comments.length > 0) {
      await store.markAgentCursor(reviewId, messages.cursor);
      return {
        kind: 'ask',
        review,
        comments: messages.comments,
        cursor: messages.cursor,
      };
    }

    if (Date.now() >= deadline) return { kind: 'timedOut' };
    await sleep(500);
  }
}

/**
 * Poll the store until a review is decided (or the timeout elapses).
 * Returns the resolved review, or undefined on timeout / missing review.
 */
export async function waitForDecision(
  store: PlanReviewStore,
  reviewId: string,
  timeoutSeconds: number,
): Promise<Review | undefined> {
  const outcome = await waitForDecisionOrAsk(store, reviewId, timeoutSeconds);
  if (outcome.kind === 'decided') return outcome.review;
  if (outcome.kind === 'ask') return outcome.review;
  return undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
