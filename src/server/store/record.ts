import { createHash } from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { Manifest, ProjectMeta, PlanIssue, RecordPlanResult, ReviewOrigin } from '../../shared/types.js';
import { parsePlan, type ParsedDoc } from '../../shared/parser.js';
import { validateDocs, type ValidatableDoc } from '../../shared/validate.js';
import { sanitizeProjectKey } from '../../shared/keys.js';
import type { Layout } from './paths.js';
import { ensureDir } from '../util/fs.js';
import { PlanValidationError } from '../util/errors.js';
import { VersionStore } from './versions.js';
import type { ProjectStore } from './projects.js';
import type { ReviewStore } from './reviews.js';

export interface StructuredDoc {
  slug: string;
  title: string;
  parent?: string | null;
  markdown: string;
}

export interface RecordInput {
  cwd: string;
  name?: string;
  origin: ReviewOrigin;
  toolUseId?: string;
  /** Exactly one of: raw plan markdown (markers allowed) or structured docs. */
  markdown?: string;
  docs?: StructuredDoc[];
}

export interface RecordOutput extends RecordPlanResult {
  manifest?: Manifest;
}

function hashContent(kind: 'single' | 'tree', payload: unknown): string {
  return createHash('sha256').update(JSON.stringify({ kind, payload })).digest('hex');
}

/**
 * recordPlan — the single entry point every integration (hook, MCP, HTTP)
 * funnels through. Handles parsing, validation, content-hash dedup,
 * double-fire locking and review creation.
 */
export async function recordPlan(
  layout: Layout,
  projects: ProjectStore,
  reviews: ReviewStore,
  port: number,
  input: RecordInput,
): Promise<RecordOutput> {
  // --- normalize source ----------------------------------------------------
  let kind: 'single' | 'tree';
  let canonicalMarkdown: string | undefined;
  let docs: ValidatableDoc[];
  let bodies: Map<string, string>;

  if (input.docs && input.docs.length > 0) {
    kind = 'tree';
    docs = input.docs.map((d) => ({
      slug: d.slug,
      title: d.title,
      parent: d.parent ?? null,
    }));
    bodies = new Map(input.docs.map((d) => [d.slug, d.markdown]));
  } else if (typeof input.markdown === 'string' && input.markdown.trim()) {
    const parsed = parsePlan(input.markdown);
    if (parsed.malformedMarkers.length > 0) {
      throw new PlanValidationError(
        parsed.malformedMarkers.map((marker) => ({
          message: `Invalid document marker — expected <!--doc slug=<kebab-slug> title="Title" parent=<slug>--> alone on its line.`,
          marker,
        })),
      );
    }
    if (parsed.kind === 'single') {
      kind = 'single';
      canonicalMarkdown = parsed.markdown;
      docs = [{ slug: 'root', title: extractRootTitle(parsed.markdown), parent: null }];
      bodies = new Map([['root', parsed.markdown]]);
    } else {
      kind = 'tree';
      docs = parsed.docs.map((d) => ({ slug: d.slug, title: d.title, parent: d.parent, marker: d.marker }));
      bodies = new Map(parsed.docs.map((d) => [d.slug, d.markdown]));
    }
  } else {
    throw new PlanValidationError([{ message: 'The plan is empty — nothing to record.' }]);
  }

  // --- validate -------------------------------------------------------------
  const issues = validateDocs(docs as ValidatableDoc[], bodies);
  if (issues.length > 0) throw new PlanValidationError(issues);

  // --- project ----------------------------------------------------------------
  const cwd = input.cwd.trim();
  const key = sanitizeProjectKey(cwd);
  const { meta } = await projects.getOrCreate(cwd, input.name);

  // --- double-fire dedup lock -------------------------------------------------
  let isLoser = false;
  if (input.toolUseId) {
    const lockFile = path.join(layout.locksDir(key), `${sanitizeLockId(input.toolUseId)}.lock`);
    try {
      await ensureDir(layout.locksDir(key));
      // Exclusive create: a second hook scope firing for the same tool_use_id
      // loses the race and must not open another tab.
      await fsp.writeFile(lockFile, '', { flag: 'wx' });
    } catch {
      isLoser = true;
    }
  }

  // --- content-hash dedup -------------------------------------------------------
  const versionStore = new VersionStore(layout);
  const hash =
    kind === 'single'
      ? hashContent('single', canonicalMarkdown)
      : hashContent('tree', input.docs ?? [...bodies.entries()].map(([slug, markdown]) => ({ slug, markdown })));

  let version: number;
  let deduped = false;
  let manifest: Manifest | undefined;

  if (meta.latestHash && meta.latestHash === hash && meta.currentVersion > 0) {
    // Byte-identical re-presentation: reuse version + comments, still create a
    // fresh review request.
    version = meta.currentVersion;
    deduped = true;
    if (kind === 'tree') manifest = await versionStore.readManifest(key, version) ?? undefined;
  } else {
    version = meta.currentVersion + 1;
    if (kind === 'single') {
      await versionStore.write(key, { n: version, kind: 'single', hash, markdown: canonicalMarkdown! });
    } else {
      const treeDocs: ParsedDoc[] = input.docs
        ? input.docs.map((d) => ({ slug: d.slug, title: d.title, parent: d.parent ?? null, markdown: d.markdown }))
        : [...bodies.entries()].map(([slug, md]) => ({
            slug,
            markdown: md,
            title: docs.find((d) => d.slug === slug)!.title,
            parent: docs.find((d) => d.slug === slug)!.parent,
          }));
      const rootDoc = treeDocs.find((d) => d.parent === null);
      manifest = {
        root: rootDoc?.slug ?? treeDocs[0].slug,
        docs: treeDocs.map(({ slug, title, parent }) => ({ slug, title, parent })),
      };
      await versionStore.write(key, {
        n: version,
        kind: 'tree',
        hash,
        manifest,
        docBodies: new Map(treeDocs.map((d) => [d.slug, d.markdown])),
      });
    }
    meta.currentVersion = version;
    meta.latestHash = hash;
    meta.updatedAt = new Date().toISOString();
    await projects.save(meta);
  }

  // --- review request ------------------------------------------------------------
  const review = await reviews.create({
    projectKey: key,
    version,
    origin: input.origin,
    cwd,
    toolUseId: input.toolUseId,
  });

  const reviewUrl = `http://localhost:${port}/?project=${encodeURIComponent(key)}&version=${version}&review=${review.id}`;
  return { projectKey: key, version, reviewId: review.id, reviewUrl, deduped, isLoser, manifest };
}

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

function extractRootTitle(markdown: string): string {
  for (const line of markdown.split('\n')) {
    const m = /^ {0,3}#\s+(.+?)\s*#*\s*$/.exec(line);
    if (m) return m[1].trim();
  }
  return 'Plan';
}

/** Extract raw marker lines so validation issues can quote them back. */
export function collectMarkers(markdown: string): string[] {
  return markdown
    .split('\n')
    .filter((l) => /^\s*<!--\s*doc\s+.*-->\s*$/.test(l))
    .map((l) => l.trim());
}

function sanitizeLockId(id: string): string {
  return id.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 120);
}

export type { ProjectMeta, PlanIssue };
