/**
 * Source of truth for the `plan-review-wake` pi extension.
 *
 * Stored as a plain string so it ships inside dist/ and can be installed to
 * any machine via `agent-plan-review install-pi-extension`. It is NEVER
 * imported or typechecked by this package — pi loads it as a standalone
 * extension file. Keep it dependency-free (node builtins only).
 */
export const PI_WAKE_EXTENSION_FILENAME = 'plan-review-wake.ts';

export const PI_WAKE_EXTENSION_SOURCE = `/**
 * plan-review-wake — pi companion for agent-plan-review.
 *
 * Watches ~/.agent-plan-review/reviews/*.json. When a review submitted from
 * this cwd resolves, injects the decision into THIS session and triggers a
 * turn, so the agent may end its turn right after plan_review_submit instead
 * of blocking on a long plan_review_check call.
 *
 * Also maintains a heartbeat (~/.agent-plan-review/wake-active.json) so the
 * Claude Code stop-gate stands down on machines where a waker exists.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';

const HEARTBEAT_TTL_MS = 90000;
const SCAN_DEBOUNCE_MS = 100;
const HEARTBEAT_MS = Math.max(Number((process.env.AGENT_PLAN_REVIEW_WAKE_HEARTBEAT_MS || '').trim()) || 30000, 200);

function homeDir() {
  return process.env.AGENT_PLAN_REVIEW_HOME?.trim() || path.join(os.homedir(), '.agent-plan-review');
}

function readReview(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

function scanReviews(reviewsDir) {
  let entries;
  try {
    entries = fs.readdirSync(reviewsDir);
  } catch {
    return [];
  }
  const reviews = [];
  for (const name of entries) {
    if (!name.endsWith('.json')) continue;
    const review = readReview(path.join(reviewsDir, name));
    if (!review || typeof review.id !== 'string') continue;
    reviews.push({ id: review.id, review });
  }
  return reviews;
}

function writeHeartbeat(markerFile, cwd) {
  let sessions = [];
  try {
    const parsed = JSON.parse(fs.readFileSync(markerFile, 'utf8'));
    if (Array.isArray(parsed.sessions)) sessions = parsed.sessions;
  } catch {
    // First heartbeat on this machine.
  }
  const now = Date.now();
  sessions = sessions.filter(
    (s) => s && typeof s.ts === 'string' && now - Date.parse(s.ts) < HEARTBEAT_TTL_MS && s.pid !== process.pid,
  );
  sessions.push({ pid: process.pid, cwd, ts: new Date().toISOString() });
  try {
    fs.mkdirSync(path.dirname(markerFile), { recursive: true });
    fs.writeFileSync(markerFile, JSON.stringify({ sessions }, null, 2));
  } catch {
    // Never break the session over a hint file.
  }
}

export default function (pi) {
  let watcher;
  let heartbeat;
  let scanTimer;
  // reviewId -> status at last sight; lets us fire only on pending->resolved.
  const seen = new Map();
  const woke = new Set();
  let markerFile = '';
  let reviewsDir = '';

  function dispose() {
    if (watcher) watcher.close();
    watcher = undefined;
    if (heartbeat) clearInterval(heartbeat);
    heartbeat = undefined;
    if (scanTimer) clearTimeout(scanTimer);
    scanTimer = undefined;
    // Drop our own heartbeat entry so the Claude Code stop-gate resumes
    // reminding on machines where this was the only waker.
    try {
      const parsed = JSON.parse(fs.readFileSync(markerFile, 'utf8'));
      if (Array.isArray(parsed.sessions)) {
        const sessions = parsed.sessions.filter((s) => s && s.pid !== process.pid);
        fs.writeFileSync(markerFile, JSON.stringify({ sessions }, null, 2));
      }
    } catch {
      // Nothing to clean up.
    }
  }

  function decide(review) {
    if (woke.has(review.id)) return;
    woke.add(review.id);
    const vLabel = typeof review.version === 'number' ? ' (v' + review.version + ')' : '';
    let head;
    if (review.status === 'approved') {
      head = 'Plan review APPROVED' + vLabel + '. Proceed with implementation.';
    } else {
      head =
        'Plan review REQUESTED CHANGES' + vLabel +
        '. Address EVERY comment below, then re-submit the revised plan via plan_review_submit.';
    }
    const body = review.status === 'approved' ? (review.notes || '') : (review.reason || '');
    const content = (head + (body ? '\\n\\n' + body : '')).trim();
    void pi.sendMessage(
      { customType: 'plan-review-wake', content, display: true },
      { triggerTurn: true },
    );
  }

  /** Repo/worktree root for a path (null when not inside a git repo). */
function gitToplevel(cwd) {
  try {
    const out = execFileSync('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
    }).trim();
    return out || null;
  } catch {
    return null;
  }
}

/**
 * Same project? Plans recorded through a subdirectory resolve to the repo root,
 * so compare resolved roots rather than raw paths.
 */
function sameProject(a, b) {
  return (gitToplevel(a) || path.resolve(a)) === (gitToplevel(b) || path.resolve(b));
}

function scan(initial) {
    for (const entry of scanReviews(reviewsDir)) {
      const prev = seen.get(entry.id);
      seen.set(entry.id, entry.review.status || 'pending');
      if (initial || prev === undefined) continue; // never wake for history
      if (prev !== 'pending') continue; // only pending -> resolved wakes
      const status = entry.review.status;
      if (!status || status === 'pending' || status === prev) continue;
      if (entry.review.origin === 'hook') continue; // hook flow blocks natively
      if (entry.review.cwd && !sameProject(entry.review.cwd, process.cwd())) continue;
      decide(entry.review);
    }
  }

  function scheduleScan() {
    if (scanTimer) clearTimeout(scanTimer);
    scanTimer = setTimeout(() => {
      scanTimer = undefined;
      scan(false);
    }, SCAN_DEBOUNCE_MS);
  }

  pi.on('session_start', async (_event, ctx) => {
    const home = homeDir();
    reviewsDir = path.join(home, 'reviews');
    markerFile = path.join(home, 'wake-active.json');
    try {
      fs.mkdirSync(reviewsDir, { recursive: true });
    } catch {
      // Store dir will be created by submit too.
    }

    scan(true); // seed without waking

    try {
      watcher = fs.watch(reviewsDir, () => scheduleScan());
    } catch {
      watcher = undefined;
    }

    const cwd = ctx?.cwd || process.cwd();
    writeHeartbeat(markerFile, cwd);
    heartbeat = setInterval(() => writeHeartbeat(markerFile, cwd), HEARTBEAT_MS);
    heartbeat.unref?.();

    if (ctx?.hasUI) {
      ctx.ui.notify('plan-review-wake: watching ' + reviewsDir, 'info');
    }
  });

  pi.on('session_shutdown', async () => {
    dispose();
  });

  // Test/programmatic escape hatch.
  return { dispose };
}
`;
