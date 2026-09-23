/**
 * Poll cadence for a pending review, as a function of how long it has been open.
 *
 * Responsive while someone is actively watching (a decision or an agent reply
 * should appear within ~2.5s), then backing off: a review left open on a second
 * monitor for an hour should not keep asking 24 times a minute. Exported and pure
 * so the schedule is testable without timers.
 */
export function reviewPollDelay(elapsedMs: number): number {
  if (elapsedMs < 30_000) return 2_500;
  if (elapsedMs < 2 * 60_000) return 5_000;
  if (elapsedMs < 10 * 60_000) return 15_000;
  return 30_000;
}
