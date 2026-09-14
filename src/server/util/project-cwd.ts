/**
 * Project cwd resolution.
 *
 * Projects are keyed by path, so an agent that happens to run inside a
 * subdirectory of a repo would otherwise mint a brand-new project for the same
 * work. Resolution folds such paths onto their repo/worktree root:
 *
 *  1. inside a git repo → `git rev-parse --show-toplevel` (the worktree root,
 *     so intentional worktrees stay separate projects),
 *  2. otherwise → the nearest ancestor that is already a registered project,
 *  3. otherwise → the path itself.
 */

import { execFileSync } from 'node:child_process';
import path from 'node:path';

/** cwd → git toplevel (or null). Cached: submitted paths repeat constantly. */
const toplevelCache = new Map<string, string | null>();

/** Repo/worktree root containing `cwd`, or null when not inside a git repo. */
export function gitToplevel(cwd: string): string | null {
  const dir = path.resolve(cwd);
  const cached = toplevelCache.get(dir);
  if (cached !== undefined) return cached;
  let top: string | null = null;
  try {
    const out = execFileSync('git', ['-C', dir, 'rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
    }).trim();
    top = out ? path.resolve(out) : null;
  } catch {
    top = null;
  }
  toplevelCache.set(dir, top);
  return top;
}

/** Sync, dependency-free resolution used by hooks, gates and extensions. */
export function resolveProjectCwdSync(cwd: string): string {
  return gitToplevel(cwd) ?? path.resolve(cwd);
}

/** True when two paths denote the same project root. */
export function sameProjectCwd(a: string, b: string): boolean {
  return resolveProjectCwdSync(a) === resolveProjectCwdSync(b);
}

/** Widest ancestor of `cwd` among `knownCwds` (including `cwd` itself). */
export function nearestKnownAncestor(cwd: string, knownCwds: string[]): string | null {
  const dir = path.resolve(cwd);
  let best: string | null = null;
  for (const known of knownCwds) {
    const candidate = path.resolve(known);
    if (dir !== candidate && !dir.startsWith(candidate + path.sep)) continue;
    if (!best || candidate.length > best.length) best = candidate;
  }
  return best;
}

/**
 * Resolve the project root for a submitted cwd. `knownCwds` are the cwds of
 * already-registered projects, used as the non-git fallback.
 */
export function resolveProjectCwd(cwd: string, knownCwds: string[] = []): string {
  return gitToplevel(cwd) ?? nearestKnownAncestor(cwd, knownCwds) ?? path.resolve(cwd);
}
