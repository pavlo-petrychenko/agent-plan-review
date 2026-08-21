/**
 * ExitPlanMode PreToolUse hook (blocking).
 *
 * Flow: parse stdin → ignore non-matching tools / empty plans → record the
 * plan (validation failures DENY with compiled issues) → ensure server up →
 * open the review URL (unless this invocation lost the dedup race) → poll
 * until decided:
 *   approve → emit allow WITH echoed updatedInput (suppresses Claude Code's
 *             native confirmation) plus additionalContext carrying notes;
 *   reject  → emit deny with the compiled reason.
 *
 * Hard timeout (PLAN_REVIEW_TIMEOUT, default 1800s) exits 0 — fail-open to
 * the native prompt. EVERY failure path fails open.
 */

import { loadConfig, reviewTimeoutSeconds } from '../config.js';
import { PlanReviewStore } from '../store/store.js';
import { PlanValidationError } from '../util/errors.js';
import { compileIssues } from '../../shared/compile.js';
import type { Manifest, Review } from '../../shared/types.js';
import { readStdinJson, finish, type PreToolUseInput } from './hook-io.js';
import { ensureServerRunning } from './spawn-server.js';
import { waitForDecision } from './poll.js';
import { openBrowser } from './browser.js';

export async function runExitPlanModeHook(): Promise<void> {
  const input = (await readStdinJson()) as PreToolUseInput;

  try {
    if (input?.tool_name !== 'ExitPlanMode') return finish({});
    const plan = input.tool_input?.plan;
    if (typeof plan !== 'string' || !plan.trim()) return finish({});

    await ensureServerRunning();
    const store = new PlanReviewStore(loadConfig());

    let recorded;
    try {
      recorded = await store.recordPlan({
        cwd: input.cwd ?? process.cwd(),
        origin: 'hook',
        toolUseId: input.tool_use_id,
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
      openBrowser(recorded.reviewUrl);
      review = await store.getReview(recorded.reviewId) ?? undefined;
    }
    if (!review) return finish({});

    const decided = await waitForDecision(store, review.id, reviewTimeoutSeconds());
    if (!decided || decided.status === 'pending') return finish({}); // timeout ⇒ fail-open

    if (decided.status === 'approved') {
      const comments = await store.listComments(decided.projectKey, decided.version);
      const manifest = (await store.getManifest(decided.projectKey, decided.version)) ?? undefined;
      const { compileApproval } = await import('../../shared/compile.js');
      const notes = compileApproval(comments, manifest as Manifest | undefined, () => null);
      return finish(allow(input.tool_input ?? {}, notes || undefined));
    }

    const reason = decided.reason ?? 'The human requested changes via the review UI.';
    return finish(deny(reason));
  } catch (err) {
    // Fail-open discipline: log and yield to the native prompt.
    console.error('[plan-review hook] failing open:', err);
    return finish({});
  }
}

/** Find the newest pending review for a project version (dedup-loser path). */
async function findPendingFor(store: PlanReviewStore, projectKey: string, version: number): Promise<Review | undefined> {
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
