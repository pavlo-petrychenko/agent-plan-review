/**
 * Herdr integration helpers: where Herdr lives, whether the integration is on,
 * which folders hold its git worktrees, the "pointer files" it leaves behind,
 * and the startup sweep that forgets plans of worktrees that no longer exist.
 *
 * Everything here reads foreign files defensively: a missing or malformed file
 * means "nothing configured", never an exception.
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { herdrSettings } from '../config.js';
import type { PlanReviewStore } from '../store/store.js';
import { sanitizeProjectKey } from '../../shared/keys.js';
import { herdrHome, herdrPointerDir, type HerdrPointer } from './herdr.js';

/**
 * Where to look for Herdr's files. `env` carries `HERDR_APP_HOME` (same
 * resolution as the pointer writer in ./herdr.ts); `userHome` is for `~` and
 * `{home}` expansion. Both default to the real process, tests inject temp dirs.
 */
export interface HerdrPaths {
  env?: NodeJS.ProcessEnv;
  userHome?: string;
}

function readJsonSync(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// ---------------------------------------------------------------------------
// worktree roots
// ---------------------------------------------------------------------------

/**
 * A place Herdr creates worktrees: `prefix` is a literal path prefix. A project
 * is inside when its path starts with it and is longer. The prefix usually ends
 * in `/` (`~/.herdr/worktrees/`) but may stop mid-name (`/code/website-`, from
 * the template `{repo.parent}/website-{name:slug}`).
 */
export interface WorktreeRoot {
  prefix: string;
  /** Main checkout folders that must never be forgotten (the repos themselves). */
  mainCheckouts: string[];
}

const norm = (p: string): string => p.replace(/\\/g, '/').replace(/\/+$/, '');

function expandHome(p: string, userHome: string): string {
  return p === '~' ? userHome : p.startsWith('~/') ? userHome + p.slice(1) : p;
}

/**
 * Turn a `path` template from repo-worktree.json into a literal prefix: fill in
 * `{home}`, `{repo.main}`, `{repo.parent}`, `{repo.name}` and cut at the first
 * placeholder that is left (`{name:slug}`, a field, `{repo.top}`). Returns null
 * when nothing variable is left (a fixed path is not a place worktrees pile up)
 * or the literal part is too shallow to trust.
 */
export function templatePrefix(template: string, repoMain: string, userHome: string): string | null {
  const parent = repoMain.split('/').slice(0, -1).join('/') || '/';
  const filled = template
    .replace(/\{home\}/g, userHome)
    .replace(/\{repo\.main\}/g, repoMain)
    .replace(/\{repo\.parent\}/g, parent)
    .replace(/\{repo\.name\}/g, repoMain.split('/').pop() ?? '');
  const cut = filled.indexOf('{');
  if (cut < 0) return null;
  const prefix = norm(expandHome(filled.slice(0, cut), userHome)) + (filled.slice(0, cut).endsWith('/') ? '/' : '');
  if (!path.isAbsolute(prefix)) return null;
  // Need at least three path segments of literal ("/Users/me/code"), so a
  // sloppy template like "{x}" or "/{name}" can never cover the disk.
  if (prefix.split('/').filter(Boolean).length < 3) return null;
  return prefix;
}

/**
 * Herdr's default `~/.herdr/worktrees/` plus every `path` template configured in
 * `<herdrHome>/repo-worktree.json` (`defaults.path` and each `repos.<main>.path`).
 */
export function worktreeRoots(paths: HerdrPaths = {}): WorktreeRoot[] {
  const userHome = paths.userHome ?? os.homedir();
  const roots: WorktreeRoot[] = [
    { prefix: norm(path.join(userHome, '.herdr', 'worktrees')) + '/', mainCheckouts: [] },
  ];
  const raw = readJsonSync(path.join(herdrHome(paths.env), 'repo-worktree.json'));
  if (!isObject(raw) || !isObject(raw.repos)) return roots;
  const defaults = isObject(raw.defaults) ? raw.defaults : {};
  for (const [key, entry] of Object.entries(raw.repos)) {
    if (!isObject(entry)) continue;
    const tpl = entry.path ?? defaults.path;
    if (typeof tpl !== 'string') continue;
    const main = norm(expandHome(key, userHome));
    const prefix = templatePrefix(tpl, main, userHome);
    if (prefix) roots.push({ prefix, mainCheckouts: [main] });
  }
  return roots;
}

/** True when `cwd` lies inside one of the roots (and is not a main checkout). */
export function insideWorktreeRoot(cwd: string, roots: WorktreeRoot[]): boolean {
  const p = norm(cwd);
  return roots.some(
    (r) => p.startsWith(r.prefix) && p.length > r.prefix.length && !r.mainCheckouts.includes(p),
  );
}

// ---------------------------------------------------------------------------
// project keys from a path
// ---------------------------------------------------------------------------

/**
 * Project keys a worktree path can be stored under. The key comes from the
 * literal absolute path (the folder may be gone, so git cannot resolve it); when
 * the folder still exists its realpath is tried too, because the store keys
 * `git rev-parse --show-toplevel`, which is symlink-resolved. Subdirectories are
 * deliberately not folded onto a parent: a command that deletes plans must only
 * hit the path it was given.
 */
export function worktreeProjectKeys(worktree: string): string[] {
  const abs = path.resolve(worktree);
  const keys = new Set([sanitizeProjectKey(abs)]);
  try {
    keys.add(sanitizeProjectKey(fs.realpathSync(abs)));
  } catch {
    // folder is gone — the literal path is all there is
  }
  return [...keys];
}

// ---------------------------------------------------------------------------
// pointer files
// ---------------------------------------------------------------------------

/**
 * Delete (or, with `dryRun`, list) the pointer files whose `projectKey` is one
 * of `keys`. Pointers are the `HerdrPointer` JSON that `syncHerdrPointers`
 * writes to `<herdrHome>/data/plan-review/<terminal>.json`; anything that does
 * not parse, or has no matching `projectKey`, is left alone.
 */
export async function removePointerFiles(
  keys: string[],
  dryRun: boolean,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string[]> {
  const dir = herdrPointerDir(env);
  let names: string[];
  try {
    names = await fsp.readdir(dir);
  } catch {
    return [];
  }
  const wanted = new Set(keys);
  const removed: string[] = [];
  for (const name of names.filter((n) => n.endsWith('.json')).sort()) {
    const file = path.join(dir, name);
    let projectKey: unknown;
    try {
      projectKey = (JSON.parse(await fsp.readFile(file, 'utf8')) as Partial<HerdrPointer>).projectKey;
    } catch {
      continue;
    }
    if (typeof projectKey !== 'string' || !wanted.has(projectKey)) continue;
    if (!dryRun) await fsp.rm(file, { force: true });
    removed.push(file);
  }
  return removed;
}

// ---------------------------------------------------------------------------
// startup sweep
// ---------------------------------------------------------------------------

export interface StartupGcOptions extends HerdrPaths {
  log?: (line: string) => void;
}

/**
 * Safety net for worktrees removed without `forget` (git by hand, a crashed
 * job). Only when the Herdr integration is on (`herdrSettings`: config.json plus the
 * `AGENT_PLAN_REVIEW_HERDR=0|1` override, exactly as the pointer writer sees it): forget every project whose
 * recorded folder is gone AND whose path is inside a Herdr worktree root.
 * Projects anywhere else are never touched. A root whose parent folder is
 * missing too (unmounted disk) is skipped. Returns the forgotten project keys.
 */
export async function forgetMissingWorktrees(
  store: PlanReviewStore,
  opts: StartupGcOptions = {},
): Promise<string[]> {
  const env = opts.env ?? process.env;
  if (!herdrSettings(store.config.home, env).enabled) return [];
  const log = opts.log ?? ((line: string) => console.log(line));
  // The folder that holds the worktrees must exist; if it does not (unmounted
  // disk, wiped home) a missing worktree proves nothing.
  const roots = worktreeRoots({ env, userHome: opts.userHome }).filter((r) => fs.existsSync(r.prefix.endsWith('/') ? r.prefix : path.dirname(r.prefix)));
  const doomed: string[] = [];
  for (const meta of await store.projects.list()) {
    if (!path.isAbsolute(meta.cwd) || fs.existsSync(meta.cwd)) continue;
    if (!insideWorktreeRoot(meta.cwd, roots)) continue;
    doomed.push(meta.key);
  }
  if (doomed.length === 0) return [];
  const result = await store.forgetProjects(doomed);
  const pointers = await removePointerFiles(doomed, false, env);
  for (const p of result.projects) {
    log(`plan-review: forgot plans of missing worktree ${p.cwd} (${p.versions} versions, ${p.reviews} reviews)`);
  }
  if (result.imagesDeleted.length > 0) log(`plan-review: removed ${result.imagesDeleted.length} unused images`);
  if (pointers.length > 0) log(`plan-review: removed ${pointers.length} herdr pointer files`);
  return result.projects.map((p) => p.key);
}
