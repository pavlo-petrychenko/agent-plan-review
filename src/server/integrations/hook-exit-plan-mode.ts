/**
 * ExitPlanMode PreToolUse hook (blocking).
 *
 * Flow: parse stdin → ignore non-matching tools / empty plans → record the
 * plan (validation failures DENY with compiled issues) → ensure server up →
 * open the review URL (unless this invocation lost the dedup race) → wait for
 * EITHER a decision or a targeted question:
 *   approve → emit allow WITH echoed updatedInput (suppresses Claude Code's
 *             native confirmation) plus additionalContext carrying notes;
 *   reject  → emit deny with the compiled reason.
 *   ask     → emit deny carrying the questions. Claude stays in plan mode and
 *             gets a turn to answer them; it then calls ExitPlanMode again,
 *             which lands on the SAME review (one live review per session).
 *
 * The ask branch is what makes mid-review conversation possible at all: this
 * hook blocks the tool call, so without giving the wait back there is no agent
 * turn in which a reply could exist.
 *
 * Hard timeout (PLAN_REVIEW_TIMEOUT, default 1800s) exits 0 — fail-open to
 * the native prompt. EVERY failure path fails open.
 */

import { loadConfig, reviewTimeoutSeconds } from '../config.js';
import { PlanReviewStore } from '../store/store.js';
import { PlanValidationError } from '../util/errors.js';
import { compileAsk, compileIssues } from '../../shared/compile.js';
import type { Review } from '../../shared/types.js';
import { readStdinJson, finish, type PreToolUseInput } from './hook-io.js';
import { ensureServerRunning } from './spawn-server.js';
import { waitForDecisionOrAsk } from './poll.js';
import { openReview } from './browser.js';
import { agentFromEnv } from './herdr.js';
import { agentIdFrom } from '../agent-id.js';

export async function runExitPlanModeHook(): Promise<void> {
  const input = (await readStdinJson()) as PreToolUseInput;

  try {
    if (input?.tool_name !== 'ExitPlanMode') return finish({});
    const plan = input.tool_input?.plan;
    if (typeof plan !== 'string' || !plan.trim()) return finish({});

    await ensureServerRunning();
    const store = new PlanReviewStore(loadConfig());
    // Herdr terminal link (HC_TERMINAL_ID) — plain metadata, always recorded.
    const agent = agentFromEnv('claude-code');

    let recorded;
    try {
      recorded = await store.recordPlan({
        cwd: input.cwd ?? process.cwd(),
        origin: 'hook',
        toolUseId: input.tool_use_id,
        // Reuse this session's pending review so a question → answer →
        // re-present round stays one continuous thread.
        sessionId: input.session_id,
        agent,
        // The session's own plan: a second agent in this worktree gets its own.
        agentId: agentIdFrom({ sessionId: input.session_id, env: process.env, harness: 'claude-code' }),
        markdown: plan,
      });
    } catch (err) {
      if (err instanceof PlanValidationError) {
        return finish(deny(compileIssues(err.issues)));
      }
      throw err;
    }

    // The dedup loser must not open a second tab; it polls the winner's review.
    let review: Review | undefined;
    if (recorded.isLoser) {
      review = await findPendingFor(store, recorded.projectKey, recorded.version);
      if (!review) return finish({});
    } else {
      // Open the tab unless the reviewer is already looking at exactly this.
      // A reused review on an unchanged plan is the no-op round (the agent just
      // answered a question and re-presented): their tab is still correct.
      // A reused review on a REVISED plan is not — the review now points at a
      // new version they have not seen.
      if (!recorded.reusedReview || !recorded.deduped) {
        openReview(recorded.reviewUrl, { home: store.config.home, terminal: agent?.terminal });
      }
      review = (await store.getReview(recorded.reviewId)) ?? undefined;
    }
    if (!review) return finish({});

    const outcome = await waitForDecisionOrAsk(store, review.id, reviewTimeoutSeconds());
    if (outcome.kind === 'timedOut') return finish({}); // timeout ⇒ fail-open

    if (outcome.kind === 'ask') {
      const manifest =
        (await store.getManifest(outcome.review.projectKey, outcome.review.version)) ?? undefined;
      return finish(deny(compileAsk(outcome.comments, manifest, review.id, review.version)));
    }

    if (outcome.review.status === 'approved') {
      return finish(allow(input.tool_input ?? {}, outcome.review.notes || undefined));
    }

    const reason = outcome.review.reason ?? 'The human requested changes via the review UI.';
    return finish(deny(reason));
  } catch (err) {
    // Fail-open discipline: log and yield to the native prompt.
    console.error('[plan-review hook] failing open:', err);
    return finish({});
  }
}

/** Find the newest pending review for a project version (dedup-loser path). */
async function findPendingFor(
  store: PlanReviewStore,
  projectKey: string,
  version: number,
): Promise<Review | undefined> {
  const pending = await store.listReviews({ status: 'pending', projectKey });
  return pending.find((r) => r.version === version);
}

function allow(updatedInput: Record<string, unknown>, additionalContext?: string) {
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
      permissionDecisionReason: 'Plan approved via plan-review UI.',
      ...(additionalContext ? { additionalContext } : {}),
    },
    updatedInput,
    ...(additionalContext ? { additionalContext } : {}),
  };
}

function deny(reason: string) {
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  };
}
