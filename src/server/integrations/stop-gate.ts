/**
 * Stop-hook gate.
 *
 * When a turn would end while a recent (<5h) mcp/api-origin review in this
 * cwd is still pending, block and tell the agent to resume plan_review_check.
 * Never double-block (stop_hook_active); fail open on any error; never gate
 * hook-origin reviews (those block synchronously already).
 */

import { loadConfig } from '../config.js';
import { PlanReviewStore } from '../store/store.js';
import { readStdinJson, finish } from './hook-io.js';

const RECENT_WINDOW_MS = 5 * 3600 * 1000;

interface StopInput {
  session_id?: string;
  cwd?: string;
  stop_hook_active?: boolean;
}

export async function runStopGate(): Promise<void> {
  const input = (await readStdinJson()) as StopInput;
  try {
    if (input?.stop_hook_active) return finish({});

    const store = new PlanReviewStore(loadConfig());
    const pending = await store.listReviews({ status: 'pending' });
    const now = Date.now();
    const match = pending.find(
      (r) =>
        (r.origin === 'mcp' || r.origin === 'api') &&
        r.cwd === (input.cwd ?? process.cwd()) &&
        now - Date.parse(r.createdAt) < RECENT_WINDOW_MS,
    );
    if (!match) return finish({});

    return finish({
      decision: 'block',
      reason:
        `Plan review ${match.id} (v${match.version}) is still awaiting a human decision. ` +
        `Call the plan_review_check tool with wait_seconds=20 to wait for it before ending your turn.`,
    });
  } catch {
    // Fail open: never prevent a turn from ending because of this hook.
    return finish({});
  }
}
