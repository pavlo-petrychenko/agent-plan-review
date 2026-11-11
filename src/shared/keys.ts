import { createHash } from 'node:crypto';

/**
 * Convert an absolute project path into a stable storage key.
 *
 * The human-readable part comes from the basename (sanitized); a short hash of
 * the full path guarantees uniqueness across same-named directories and
 * worktrees while staying deterministic.
 */
export function sanitizeProjectKey(cwd: string): string {
  const normalized = cwd.replace(/\/+$/, '');
  const base = normalized.split(/[\\/]/).pop() ?? 'project';
  const safe =
    base
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '-')
      .replace(/^[-.]+|-+$/g, '')
      .slice(0, 48) || 'project';
  const hash = createHash('sha256').update(normalized).digest('hex').slice(0, 8);
  return `${safe}-${hash}`;
}

/**
 * Plan projects. One worktree can hold several plans (one per agent working
 * there), each its own project: `<worktree key>.p-<6 hex>`. The worktree key is
 * `sanitizeProjectKey(worktreeRoot)`, so a plan key still says which worktree it
 * lives in, and projects stored before plans existed (the bare worktree key)
 * stay valid as the worktree's "legacy" plan. A worktree key always ends in its
 * 8-hex path hash, so it can never itself match the plan suffix.
 */
const PLAN_KEY_RE = /^(.+)\.(p-[0-9a-f]{6})$/;
const PLAN_ID_RE = /^p-[0-9a-f]{6}$/;

/** Fresh plan id: `p-` plus 6 random hex digits. */
export function newPlanId(): string {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(3));
  return 'p-' + [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Project key of plan `planId` inside the worktree keyed `worktreeKey`. */
export function planProjectKey(worktreeKey: string, planId: string): string {
  return `${worktreeKey}.${planId}`;
}

/** Split a plan project key; null for a worktree (legacy) key. */
export function parsePlanProjectKey(key: string): { worktreeKey: string; planId: string } | null {
  const m = PLAN_KEY_RE.exec(key);
  return m ? { worktreeKey: m[1], planId: m[2] } : null;
}

/**
 * Normalize what an agent passes as a plan id: `p-3f9a1c`, bare `3f9a1c`
 * (agents drop prefixes), any case. Null when it is not plan-id shaped (it may
 * then still be a full project key).
 */
export function normalizePlanId(raw: string): string | null {
  const t = raw.trim().toLowerCase();
  const id = t.startsWith('p-') ? t : `p-${t}`;
  return PLAN_ID_RE.test(id) ? id : null;
}

/** New opaque id for reviews/comments. */
export function newId(): string {
  return globalThis.crypto.randomUUID();
}
