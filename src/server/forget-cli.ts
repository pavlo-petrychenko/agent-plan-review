/**
 * `agent-plan-review forget --worktree <path> [--dry-run] [--json]`
 *
 * Deletes everything the store holds for one worktree: its projects — every
 * plan plus the legacy worktree project — (versions, comments, reviews), plan images no other project uses, and Herdr pointer
 * files. Works when the folder is already gone (the key comes from the path).
 * Exit code 0 also when nothing matched.
 */

import path from 'node:path';
import type { ServerConfig } from './config.js';
import { removePointerFiles, worktreeProjectKeys } from './integrations/herdr-worktrees.js';
import { PlanReviewStore } from './store/store.js';
import { parsePlanProjectKey } from '../shared/keys.js';

export interface ForgetArgs {
  worktree: string;
  dryRun: boolean;
  json: boolean;
}

export const FORGET_USAGE = 'Usage: agent-plan-review forget --worktree <path> [--dry-run] [--json]\n';

/** Parse argv after `forget`. Returns an error string on bad input. */
export function parseForgetArgs(argv: string[]): ForgetArgs | string {
  let worktree: string | undefined;
  let dryRun = false;
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dry-run') dryRun = true;
    else if (arg === '--json') json = true;
    else if (arg === '--worktree') {
      worktree = argv[++i];
      if (!worktree) return '--worktree needs a path';
    } else if (arg.startsWith('--worktree=')) worktree = arg.slice('--worktree='.length);
    else return `unknown argument: ${arg}`;
  }
  if (!worktree?.trim()) return '--worktree <path> is required';
  return { worktree, dryRun, json };
}

export interface ForgetReport {
  worktree: string;
  dryRun: boolean;
  matched: boolean;
  projects: { key: string; name: string; cwd: string; versions: number; reviews: number }[];
  images: { deleted: string[]; kept: string[] };
  pointers: string[];
}

export async function forgetWorktree(
  store: PlanReviewStore,
  worktree: string,
  dryRun: boolean,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ForgetReport> {
  const abs = path.resolve(worktree);
  // Plan projects are found by key prefix, not by cwd: the folder may be gone,
  // and their key names the worktree key they live in.
  const worktreeKeys = new Set(worktreeProjectKeys(abs));
  const planKeys = (await store.projects.list())
    .map((p) => p.key)
    .filter((k) => worktreeKeys.has(parsePlanProjectKey(k)?.worktreeKey ?? ''));
  const keys = [...worktreeKeys, ...planKeys];
  const result = await store.forgetProjects(keys, dryRun);
  // Pointers go even when no project matched: a stale pointer is still garbage.
  const pointers = await removePointerFiles(keys, dryRun, env);
  return {
    worktree: abs,
    dryRun,
    matched: result.projects.length > 0 || pointers.length > 0,
    projects: result.projects,
    images: { deleted: result.imagesDeleted, kept: result.imagesKept },
    pointers,
  };
}

export function formatForgetReport(r: ForgetReport): string {
  if (!r.matched) return `no plans for ${r.worktree}\n`;
  const verb = r.dryRun ? 'would delete' : 'deleted';
  const lines = [`${r.dryRun ? 'dry run — ' : ''}${r.worktree}`];
  for (const p of r.projects) {
    lines.push(`  ${verb} project ${p.name} (${p.key}): ${p.versions} versions, ${p.reviews} reviews`);
  }
  lines.push(`  ${verb} ${r.images.deleted.length} images (${r.images.kept.length} kept: shared with other projects)`);
  lines.push(`  ${verb} ${r.pointers.length} herdr pointer files`);
  return lines.join('\n') + '\n';
}

/** Run the command; returns the process exit code. */
export async function runForget(
  argv: string[],
  cfg: ServerConfig,
  out: { write(s: string): unknown } = process.stdout,
  err: { write(s: string): unknown } = process.stderr,
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  const args = parseForgetArgs(argv);
  if (typeof args === 'string') {
    err.write(`forget: ${args}\n${FORGET_USAGE}`);
    return 2;
  }
  try {
    const report = await forgetWorktree(new PlanReviewStore(cfg), args.worktree, args.dryRun, env);
    out.write(args.json ? JSON.stringify(report, null, 2) + '\n' : formatForgetReport(report));
    return 0;
  } catch (e) {
    err.write(`forget: ${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  }
}
