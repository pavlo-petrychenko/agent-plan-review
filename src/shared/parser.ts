/**
 * Multi-document plan parser.
 *
 * A plan string may embed multiple documents via markers:
 *
 *   <!--doc slug=<kebab-slug> title="Title" parent=<slug>-->
 *
 * Rules:
 *  - Markers must sit alone on their own line and are ignored inside fences.
 *  - Content before the first marker becomes the implicit root document,
 *    titled from its first H1 heading (or "Plan").
 *  - Zero markers ⇒ flat single-document plan.
 */

import type { DocMeta } from './types.js';

export interface ParsedDoc extends DocMeta {
  markdown: string;
  /** Raw marker line this doc came from (absent for the implicit root). */
  marker?: string;
}

export type ParseResult =
  | { kind: 'single'; markdown: string; malformedMarkers: string[] }
  | { kind: 'tree'; docs: ParsedDoc[]; malformedMarkers: string[] };

const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/;
const MARKER_RE = /^\s*<!--\s*doc\s+(.*?)\s*-->\s*$/;
const H1_RE = /^ {0,3}#\s+(.+?)\s*#*\s*$/;

interface MarkerAttrs {
  slug?: string;
  title?: string;
  parent?: string;
}

/** Parse `slug=x title="T" parent=y` style attribute strings (any order). */
function parseMarkerAttrs(raw: string): MarkerAttrs | null {
  const attrs: MarkerAttrs = {};
  const tokenRe = /(slug|title|parent)\s*=\s*("([^"]*)"|'([^']*)'|(\S*))/g;
  let matched = false;
  let m: RegExpExecArray | null;
  while ((m = tokenRe.exec(raw))) {
    matched = true;
    const key = m[1] as keyof MarkerAttrs;
    attrs[key] = m[3] ?? m[4] ?? m[5] ?? '';
  }
  if (!matched) return null;
  // Reject anything that is not a known attribute at top level.
  const residue = raw
    .replace(tokenRe, '')
    .replace(/["']/g, '')
    .trim();
  if (residue.length > 0) return null;
  return attrs;
}

function leadingRun(text: string, char: string): number {
  let i = 0;
  while (i < text.length && text[i] === char) i++;
  return i;
}

interface Segment {
  attrs: MarkerAttrs;
  marker: string;
  lines: string[];
}

/** Split content into [preamble, {marker, segment}...] segments, fence-aware. */
function splitSegments(markdown: string): { preamble: string; segments: Segment[]; malformed: string[] } {
  const lines = markdown.split('\n');
  let fence: string | null = null;

  const preambleLines: string[] = [];
  const segments: Segment[] = [];
  const malformed: string[] = [];

  for (const line of lines) {
    const fm = FENCE_RE.exec(line);
    const run = fm?.[1] ?? null;

    if (fence === null && run) {
      fence = run;
      if (segments.length > 0) segments[segments.length - 1].lines.push(line);
      else preambleLines.push(line);
      continue;
    }
    if (fence !== null) {
      if (run && run[0] === fence[0] && leadingRun(line.trimStart(), fence[0]) >= fence.length) {
        fence = null;
      }
      if (segments.length > 0) segments[segments.length - 1].lines.push(line);
      else preambleLines.push(line);
      continue;
    }

    const mm = MARKER_RE.exec(line);
    if (mm) {
      const attrs = parseMarkerAttrs(mm[1]);
      if (attrs) {
        segments.push({ attrs, marker: line.trim(), lines: [] });
        continue;
      }
      // Marker-shaped but unparseable — surface it for validation.
      malformed.push(line.trim());
      continue;
    }
    if (segments.length > 0) {
      segments[segments.length - 1].lines.push(line);
    } else {
      preambleLines.push(line);
    }
  }
  return {
    preamble: preambleLines.join('\n'),
    segments: segments.map((s) => ({ ...s, lines: s.lines })),
    malformed,
  };
}

/** First H1 heading text of a markdown fragment (fences respected implicitly by H1_RE shape). */
export function extractTitle(markdown: string): string | undefined {
  for (const line of markdown.split('\n')) {
    const m = H1_RE.exec(line);
    if (m) return m[1].trim();
  }
  return undefined;
}

function trimBlankEdges(text: string): string {
  return text.replace(/\n+$/, '').replace(/^\n+/, '');
}

export function parsePlan(markdown: string): ParseResult {
  const { preamble, segments, malformed } = splitSegments(markdown);

  if (segments.length === 0) {
    return { kind: 'single', markdown: trimBlankEdges(markdown), malformedMarkers: malformed };
  }

  const docs: ParsedDoc[] = [];
  const pre = trimBlankEdges(preamble);
  if (pre.length > 0) {
    docs.push({
      slug: 'root',
      title: extractTitle(pre) ?? 'Plan',
      parent: null,
      markdown: pre,
    });
  }
  for (const seg of segments) {
    docs.push({
      slug: seg.attrs.slug ?? '',
      title: seg.attrs.title ?? '',
      parent: seg.attrs.parent ? seg.attrs.parent : null,
      markdown: trimBlankEdges(seg.lines.join('\n')),
      marker: seg.marker,
    });
  }
  return { kind: 'tree', docs, malformedMarkers: malformed };
}
