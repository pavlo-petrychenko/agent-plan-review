/**
 * Comment-body rendering.
 *
 * Comment bodies are authored by humans (a plain textarea) and by agents (often
 * markdown), so both are rendered as markdown for display. Two deliberate
 * differences from the plan renderer:
 *
 *  - **No raw HTML.** `allowDangerousHtml` stays off, so a `<script>` or an
 *    `<img onerror=…>` in a body is dropped rather than injected. Plan content is
 *    trusted (locally authored); comment bodies include model output.
 *  - **No block wrappers.** The `md-block` / `data-line-start` contract exists to
 *    anchor comments to plan lines; a comment body has no line numbers.
 */

import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkRehype from 'remark-rehype';
import rehypeStringify from 'rehype-stringify';

const processor = unified().use(remarkParse).use(remarkGfm).use(remarkRehype).use(rehypeStringify);

/** Markdown → HTML for a comment body. Raw HTML is dropped, not escaped. */
export function renderCommentBody(markdown: string): string {
  if (!markdown.trim()) return '';
  return String(processor.processSync(markdown));
}
