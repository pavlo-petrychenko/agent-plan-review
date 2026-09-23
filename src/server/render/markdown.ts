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
      // Raw HTML that spans sibling blocks is emitted bare so the surrounding
      // blocks nest inside it (see spansSiblingBlocks). Trade-off: those tag
      // lines lose their own comment anchor, which is strictly better than a
      // disclosure that renders empty with its body outside. —
      if (child.type === 'raw' && spansSiblingBlocks(String(child.value))) {
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
      // Wrap tables so they can both fill the column and scroll when they cannot:
      // `display: block` on the table itself (the old approach) made it a block box
      // whose inner table shrank to content, so columns never stretched and the
      // header cells wrapped while the data cells did not.
      const wrapper = h('div', { class: 'md-table-wrap' }, [child as never]);
      const wrapped = child.type === 'element' && child.tagName === 'table' ? wrapper : (child as never);
      const node = h(
        'div',
        {
          class: 'md-block',
          dataLineStart: String(position.start.line),
          dataLineEnd: String(endLine),
        },
        [wrapped],
      );
      nextChildren.push(node);
    }
    tree.children = nextChildren;

    // Rewrite cross-document links, and prepare images: defer offscreen ones and
    // tag them for the viewer (click to zoom), keeping any author classes.
    visit(tree, 'element', (el: Element) => {
      if (el.tagName === 'img') {
        const existing = el.properties.className;
        const classes = Array.isArray(existing) ? existing.map(String) : existing ? [String(existing)] : [];
        el.properties.className = [...classes.filter((c) => c !== 'md-img'), 'md-img'];
        el.properties.loading = 'lazy';
        el.properties.decoding = 'async';
        return;
      }
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
/** `<img>` tags authored as raw HTML bypass the hast pass above. */
const RAW_IMG_RE = /<img\b(?![^>]*\bloading=)/gi;

/** Block-level tags whose balance decides whether raw HTML can be wrapped. */
const BLOCK_TAG_RE = /<\/?(details|summary|div|section|article|aside|figure|figcaption|table|thead|tbody|tfoot|tr|td|th|ul|ol|li|dl|dt|dd|blockquote|pre|fieldset|form|main|nav|header|footer|video|audio|picture|iframe)\b[^>]*>/gi;

/**
 * Does this raw-HTML chunk leave a block-level element open (or close one the
 * chunk never opened)? Such a chunk spans sibling blocks and cannot be wrapped
 * in its own container: the wrapper would close the element early, the browser
 * would auto-close it, and its body would escape outside (a `<details>` whose
 * content renders unfoldable below it).
 */
export function spansSiblingBlocks(html: string): boolean {
  const open: string[] = [];
  for (const match of html.matchAll(BLOCK_TAG_RE)) {
    const tag = match[1].toLowerCase();
    if (match[0].startsWith('</')) {
      const at = open.lastIndexOf(tag);
      if (at === -1) return true; // a stray close tag
      open.length = at;
    } else if (!/\/>\s*$/.test(match[0])) {
      open.push(tag);
    }
  }
  return open.length > 0;
}

/** Render markdown to HTML per the block↔line contract above. */
export function renderMarkdown(markdown: string, slugs: Set<string>): string {
  const normalized = normalizeWikiLinks(markdown);
  const ctx: Ctx = { slugs, lines: normalized.split('\n') };
  const html = String(makeProcessor(ctx).processSync(normalized));
  // Light sanitization: strip executable content post-render. Raw HTML images
  // (plain `<img …>`) never reach the hast pass, so defer them here too.
  return html
    .replace(SCRIPT_RE, '')
    .replace(SCRIPT_OPEN_RE, '')
    .replace(RAW_IMG_RE, '<img loading="lazy" decoding="async"');
}
