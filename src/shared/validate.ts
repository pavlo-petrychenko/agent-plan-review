/**
 * Multi-document plan validation.
 *
 * Collects ALL issues (never just the first) so the agent can self-correct
 * from a single deny reason. Every message is written to be actionable
 * without any further context.
 */

import type { CommentRange, PlanIssue, DocMeta } from './types.js';
import { extractDocLinks } from './markdownLinks.js';

export const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export interface ValidatableDoc extends DocMeta {
  /** Raw `<!--doc ...-->` line this doc came from, when applicable. */
  marker?: string;
}

export function validateDocs(docs: ValidatableDoc[], bodies: Map<string, string>): PlanIssue[] {
  const issues: PlanIssue[] = [];

  // --- slugs -------------------------------------------------------------
  const known = new Set<string>();
  for (const doc of docs) {
    if (!doc.slug) {
      issues.push({
        message: 'A document marker is missing its slug attribute. Add slug=<kebab-slug>.',
        marker: doc.marker,
      });
      continue;
    }
    if (!SLUG_RE.test(doc.slug)) {
      issues.push({
        message: `Invalid document slug "${doc.slug}" — use lowercase kebab-case (letters, digits, single hyphens).`,
        marker: doc.marker,
      });
    }
    if (!doc.title || !doc.title.trim()) {
      issues.push({
        message: `Document "${doc.slug}" is missing a title. Add title="Document title".`,
        marker: doc.marker,
      });
    }
    if (known.has(doc.slug)) {
      issues.push({
        message: `Duplicate document slug "${doc.slug}" — every slug must be unique.`,
        marker: doc.marker,
      });
    }
    known.add(doc.slug);
  }

  // --- roots -------------------------------------------------------------
  const roots = docs.filter((d) => d.parent === null && d.slug && known.has(d.slug));
  if (roots.length === 0) {
    issues.push({
      message:
        'No root document — exactly one document must omit the parent attribute. Content before the first <!--doc ...--> marker automatically becomes the root.',
    });
  } else if (roots.length > 1) {
    issues.push({
      message: `Multiple root documents (${roots.map((r) => `"${r.slug}"`).join(', ')}) — exactly one document may omit the parent attribute.`,
    });
  }

  // --- parents -----------------------------------------------------------
  const bySlug = new Map(docs.filter((d) => d.slug).map((d) => [d.slug, d]));
  for (const doc of docs) {
    if (doc.parent !== null && !bySlug.has(doc.parent)) {
      issues.push({
        message: `Document "${doc.slug}" references parent "${doc.parent}", but no document with that slug exists.`,
        marker: doc.marker,
      });
    }
  }

  // --- cycles ------------------------------------------------------------
  for (const doc of bySlug.values()) {
    const path = new Set<string>([doc.slug]);
    let cursor: ValidatableDoc | undefined = doc;
    while (cursor?.parent != null) {
      if (path.has(cursor.parent)) {
        issues.push({
          message: `Parent cycle detected involving "${cursor.parent}" — restructure so every parent chain ends at the single root document.`,
          marker: cursor.marker,
        });
        break;
      }
      path.add(cursor.parent);
      cursor = bySlug.get(cursor.parent);
      if (!cursor) break; // unknown parent already reported above
    }
  }

  // --- cross-document links ----------------------------------------------
  for (const doc of docs) {
    const body = bodies.get(doc.slug);
    if (!body) continue;
    for (const target of extractDocLinks(body)) {
      if (!bySlug.has(target)) {
        issues.push({
          message: `Document "${doc.slug}" links to unknown document "${target}". Either add the document or fix the link.`,
        });
      }
    }
  }

  return issues;
}

/**
 * Validate an optional comment `range` (character offsets [start, end) into a
 * page's markdown source). Absent gives `{}`; malformed gives `{ error }` with
 * an actionable message. Offsets past the end of the page are not checked: the
 * range is advisory and clients fall back to the quote when it misses.
 */
export function parseCommentRange(raw: unknown): { range?: CommentRange; error?: string } {
  if (raw == null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { error: 'range must be an object { start, end } of character offsets' };
  }
  const { start, end } = raw as Record<string, unknown>;
  if (typeof start !== 'number' || !Number.isInteger(start) || start < 0) {
    return { error: 'range.start must be a non-negative integer' };
  }
  if (typeof end !== 'number' || !Number.isInteger(end) || end <= start) {
    return { error: 'range.end must be an integer greater than range.start' };
  }
  return { range: { start, end } };
}
