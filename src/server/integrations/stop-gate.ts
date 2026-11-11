/**
 * Stop-hook gate (v2 — one-reminder semantics).
 *
 * When a turn would end while a recent (<5h) mcp/api-origin review in this
 * cwd is still pending:
 *   - stand down entirely when a live plan-review-wake extension exists on
 *     this machine (fresh heartbeat in wake-active.json) — it will inject the
 *     decision and wake the agent itself;
 *   - otherwise remind the agent AT MOST ONCE per review (sentinel under
 *     <home>/gate/) to make ONE long plan_review_check call. The old "block on
 *     every stop" behavior would fight the new one-shot strategy: after Claude
 *     Code auto-backgrounds the long call the agent SHOULD be allowed to stop.
 * Never double-block (stop_hook_active); fail open on any error; never gate
 * hook-origin reviews (those block synchronously already).
 */

import fs from 'node:fs';
import path from 'node:path';

import { loadConfig } from '../config.js';
import { PlanReviewStore } from '../store/store.js';
import { sameProjectCwd } from '../util/project-cwd.js';
import { agentIdFrom } from '../agent-id.js';
import { readStdinJson, finish } from './hook-io.js';

const RECENT_WINDOW_MS = 5 * 3600 * 1000;
/** Heartbeat entries older than this are considered dead. */
const WAKE_MARKER_TTL_MS = 90 * 1000;

interface StopInput {
  session_id?: string;
  cwd?: string;
  stop_hook_active?: boolean;
}

interface WakeEntry {
  pid?: number;
  cwd?: string;
  ts?: string;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** True when a pi plan-review-wake extension on this machine is alive. */
function hasLiveWaker(home: string): boolean {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(home, 'wake-active.json'), 'utf8')) as {
      sessions?: WakeEntry[];
    };
    const now = Date.now();
    return (parsed.sessions ?? []).some(
      (s) =>
        typeof s.pid === 'number' &&
        typeof s.ts === 'string' &&
        now - Date.parse(s.ts) < WAKE_MARKER_TTL_MS &&
        pidAlive(s.pid),
    );
  } catch {
    return false;
  }
}

function sentinelFile(home: string, reviewId: string): string {
  return path.join(home, 'gate', `${reviewId}.reminded`);
}

export async function runStopGate(): Promise<void> {
  const input = (await readStdinJson()) as StopInput;
  try {
    if (input?.stop_hook_active) return finish({});

    const cfg = loadConfig();
    const store = new PlanReviewStore(cfg);
    const pending = await store.listReviews({ status: 'pending' });
    const now = Date.now();
    const sessionCwd = input.cwd ?? process.cwd();
    // A review that names its agent belongs to that agent alone: another
    // agent's pending review in this cwd must not hold this session's turn.
    // Reviews from before agent ids keep the plain cwd match.
    const me = agentIdFrom({ sessionId: input.session_id, env: process.env, harness: 'claude-code' });
    const match = pending.find(
      (r) =>
        (r.origin === 'mcp' || r.origin === 'api') &&
        (r.agentId
          ? r.agentId === me
          : sameProjectCwd(r.cwd, sessionCwd) ||
            (r.agentCwd != null && sameProjectCwd(r.agentCwd, sessionCwd))) &&
        now - Date.parse(r.createdAt) < RECENT_WINDOW_MS,
    );
    if (!match) return finish({});
    if (hasLiveWaker(cfg.home)) return finish({});

    // One reminder per review: after the agent re-enters with a single long
    // call (or the call gets backgrounded), further stops must pass.
    const sentinel = sentinelFile(cfg.home, match.id);
    if (fs.existsSync(sentinel)) return finish({});
    fs.mkdirSync(path.dirname(sentinel), { recursive: true });
    fs.writeFileSync(sentinel, new Date().toISOString());

    return finish({
      decision: 'block',
      reason:
        `Plan review ${match.id} (v${match.version}) is still awaiting a human decision.\n` +
        `Call plan_review_check ONCE with wait_seconds=3600 — it long-polls and returns the moment ` +
        `the human decides. If your harness moves that call to the background, continue (or end your ` +
        `turn): the result will arrive automatically. Never short-poll; never resubmit.`,
    });
  } catch {
    // Fail open: never prevent a turn from ending because of this hook.
    return finish({});
  }
}
