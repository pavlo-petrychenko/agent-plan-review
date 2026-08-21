/**
 * Server-side markdown rendering — the contract the whole comment system
 * rests on:
 *
 *  1. Every top-level markdown block is wrapped in a container carrying
 *     `data-line-start` / `data-line-end` source-line numbers (1-based,
 *     inclusive). Trailing blank lines never extend a range.
 *  2. Cross-document links (`doc:slug`, wiki-normalized) are rewritten to
 *     in-app anchors tagged `data-doc-slug`, but ONLY for slugs present in
 *     the version's manifest.
 *  3. `<script>` blocks are stripped post-render (light sanitization; content
 *     is locally authored).
 */

import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkRehype from 'remark-rehype';
import rehypeStringify from 'rehype-stringify';
import { visit } from 'unist-util-visit';
import { h } from 'hastscript';
import type { Root, RootContent, Element } from 'hast';
import { normalizeWikiLinks } from '../../shared/markdownLinks.js';

export interface RenderOptions {
  /** Slugs defined in this version's manifest ('root' for single docs). */
  slugs: Set<string>;
}

interface Ctx {
  slugs: Set<string>;
  /** Source lines of the normalized markdown (for trailing-blank trimming). */
  lines: string[];
}

function rehypePlanReview(ctx: Ctx) {
  return (tree: Root) => {
    const nextChildren: RootContent[] = [];

    for (const child of tree.children) {
      const position = child.position;
      if (!position) {
        nextChildren.push(child);
        continue;
      }
      let endLine = position.end.line;
      // Trailing blank lines within a token don't extend the range.
      while (
        endLine > position.start.line &&
        endLine - 1 < ctx.lines.length &&
        ctx.lines[endLine - 1].trim() === ''
      ) {
        endLine--;
      }
      const wrapper = h(
        'div',
        {
          class: 'md-block',
          dataLineStart: String(position.start.line),
          dataLineEnd: String(endLine),
        },
        [child as never],
      );
      nextChildren.push(wrapper);
    }
    tree.children = nextChildren;

    // Rewrite cross-document links.
    visit(tree, 'element', (el: Element) => {
      if (el.tagName !== 'a') return;
      const href = el.properties.href;
      if (typeof href !== 'string' || !href.startsWith('doc:')) return;
      const slug = href.slice(4);
      if (!ctx.slugs.has(slug)) return;
      el.properties.href = `#${slug}`;
      el.properties['dataDocSlug'] = slug;
    });
  };
}

function makeProcessor(ctx: Ctx) {
  return unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkRehype, { allowDangerousHtml: true })
    .use(() => rehypePlanReview(ctx))
    .use(rehypeStringify, { allowDangerousHtml: true });
}

const SCRIPT_RE = /<script\b[^>]*>[\s\S]*?<\/script\s*>/gi;
const SCRIPT_OPEN_RE = /<script\b[^>]*\/?>/gi;

/** Render markdown to HTML per the block↔line contract above. */
export function renderMarkdown(markdown: string, slugs: Set<string>): string {
  const normalized = normalizeWikiLinks(markdown);
  const ctx: Ctx = { slugs, lines: normalized.split('\n') };
  const html = String(makeProcessor(ctx).processSync(normalized));
  // Light sanitization: strip executable content post-render.
  return html.replace(SCRIPT_RE, '').replace(SCRIPT_OPEN_RE, '');
}
