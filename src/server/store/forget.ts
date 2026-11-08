/**
 * Whole-project removal for the "forget a worktree" flow.
 *
 * `ProjectStore.remove` only deletes `projects/<key>/`. Two things live outside
 * it: reviews (top-level `reviews/<id>.json`, tagged with `projectKey`) and
 * plan images (content-addressed in `<home>/images/`, shared across projects).
 * A project's images are found by scanning its files for `/api/images/<file>`
 * URLs; an image is only deleted when no *surviving* project references it.
 *
 * These helpers are lock-free; `PlanReviewStore.forgetProjects` calls them under
 * the store's global mutation lock.
 */

import fsp from 'node:fs/promises';
import path from 'node:path';
import type { Layout } from './paths.js';
import { listFiles, removePath } from '../util/fs.js';
import type { ProjectStore } from './projects.js';
import type { ReviewStore } from './reviews.js';

const IMAGE_URL_RE = /\/api\/images\/([a-f0-9]{16}\.(?:png|jpg|gif|webp|svg|avif))/g;

export interface ForgottenProject {
  key: string;
  name: string;
  cwd: string;
  versions: number;
  reviews: number;
}

export interface ForgetResult {
  projects: ForgottenProject[];
  /** Image files only the forgotten projects used (deleted, or would be). */
  imagesDeleted: string[];
  /** Image files the forgotten projects used that a surviving project still uses. */
  imagesKept: string[];
}

/** Collect every image file name referenced by any file under `dir`. */
async function imagesUnder(dir: string, into: Set<string>): Promise<void> {
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await imagesUnder(full, into);
    } else if (entry.isFile()) {
      let text: string;
      try {
        text = await fsp.readFile(full, 'utf8');
      } catch {
        continue;
      }
      for (const m of text.matchAll(IMAGE_URL_RE)) into.add(m[1]);
    }
  }
}

async function countVersions(layout: Layout, key: string): Promise<number> {
  const files = await listFiles(layout.versionsDir(key));
  return files.filter((f) => /^\d+\.json$/.test(f)).length;
}

export async function forgetProjectsUnlocked(
  layout: Layout,
  projects: ProjectStore,
  reviews: ReviewStore,
  keys: string[],
  dryRun: boolean,
): Promise<ForgetResult> {
  const doomed = new Set(keys);
  const result: ForgetResult = { projects: [], imagesDeleted: [], imagesKept: [] };

  const used = new Set<string>();
  const allReviews = await reviews.list();
  for (const key of keys) {
    const meta = await projects.get(key);
    if (!meta) continue;
    result.projects.push({
      key,
      name: meta.name,
      cwd: meta.cwd,
      versions: await countVersions(layout, key),
      reviews: allReviews.filter((r) => r.projectKey === key).length,
    });
    await imagesUnder(layout.projectDir(key), used);
  }
  if (result.projects.length === 0) return result;

  // Images that a project we keep still points at.
  const stillUsed = new Set<string>();
  for (const meta of await projects.list()) {
    if (doomed.has(meta.key)) continue;
    await imagesUnder(layout.projectDir(meta.key), stillUsed);
  }
  for (const file of [...used].sort()) {
    (stillUsed.has(file) ? result.imagesKept : result.imagesDeleted).push(file);
  }

  if (dryRun) return result;

  for (const project of result.projects) {
    for (const review of allReviews) {
      if (review.projectKey === project.key) await removePath(layout.reviewFile(review.id));
    }
    await projects.remove(project.key);
  }
  for (const file of result.imagesDeleted) await removePath(path.join(layout.imagesDir, file));
  return result;
}
