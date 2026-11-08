// Delivery rules for comments and the decision, the same as the web UI's (src/web/App.tsx).
// Pure.

/**
 * What a comment on `version` of a review does.
 *   onVersion: the review is pending on exactly this version (comments join its decision);
 *   canAsk:    "Ask agent" can reach the agent now (an mcp or hook review — an api review has
 *              nobody reading it);
 *   decided:   the review has its decision.
 */
export function delivery(review, version) {
  const onVersion = !!review && review.status === "pending" && review.version === version;
  const canAsk = onVersion && (review.origin === "mcp" || review.origin === "hook");
  return {
    onVersion,
    canAsk,
    decided: !!review && review.status !== "pending",
    decisionLabel: onVersion ? "Add to decision" : "Add note",
    note: canAsk
      ? review.origin === "hook"
        ? "Ask agent: the agent answers the next time it presents the plan."
        : "Ask agent wakes the agent now. Other comments go with your decision."
      : onVersion
        ? "No agent is connected to answer questions. Comments reach it with your decision."
        : "This version is no longer under review.",
  };
}

/**
 * The body of a new comment or reply: the web UI's `delivery` + `reviewId` rule. A pending
 * review on this version gets every comment (Ask or decision batch); otherwise only an Ask is
 * addressed to the review, and only when one can be asked.
 */
export function withDelivery(input, review, version, kind = "decision") {
  const d = delivery(review, version);
  const ask = kind === "ask" && d.canAsk;
  const out = { ...input, delivery: ask ? "ask" : "decision" };
  const reviewId = d.onVersion ? review.id : undefined;
  if (reviewId) out.reviewId = reviewId;
  return out;
}

/** The toast after a comment was sent. */
export function sentLabel(body, review, version) {
  if (body.delivery === "ask") return "Asked the agent";
  return delivery(review, version).onVersion ? "Added to the decision" : "Note added";
}

/** The decision bar's state line. */
export function decisionState(review) {
  if (!review) return { label: "No review", tone: "dim" };
  if (review.status === "approved") return { label: review.notes ? "Approved with comments" : "Approved", tone: "done" };
  if (review.status === "rejected") return { label: "Changes requested", tone: "blocked" };
  return { label: "Waiting for your review", tone: "pending" };
}
