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

/** New opaque id for reviews/comments. */
export function newId(): string {
  return globalThis.crypto.randomUUID();
}
