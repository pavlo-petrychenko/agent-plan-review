/**
 * Comment bodies are authored by humans and by agents, so they render as
 * markdown — but with raw HTML dropped (model output is not trusted markup) and
 * without the plan renderer's block wrappers (a body has no source lines).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderCommentBody } from './comments.js';

test('renders markdown that agents actually write', () => {
  const html = renderCommentBody('Came from the **v2 revision**; options:\n\n- keep slugs\n- renumber\n\n`plan_review_submit` carries it.');
  assert.match(html, /<strong>v2 revision<\/strong>/);
  assert.match(html, /<ul>\s*<li>keep slugs<\/li>\s*<li>renumber<\/li>\s*<\/ul>/);
  assert.match(html, /<code>plan_review_submit<\/code>/);
  assert.equal((html.match(/<p>/g) || []).length, 2, 'blank line separates paragraphs');
});

test('raw HTML in a body is dropped, not executed', () => {
  const html = renderCommentBody('<script>alert(1)</script>\n\n<img src=x onerror="alert(2)">\n\n<b>bold?</b>');
  assert.ok(!html.includes('<script'), 'no script tag');
  assert.ok(!html.includes('onerror'), 'no attribute-injection vector');
  assert.ok(!html.includes('<b>'), 'raw HTML tags do not survive');
  assert.match(html, /bold\?/, 'the text is still shown');
});

test('bodies carry no block wrappers or line anchors', () => {
  const html = renderCommentBody('hello\n\nworld');
  assert.ok(!html.includes('md-block'));
  assert.ok(!html.includes('data-line-start'));
});

test('links, quotes and code fences are rendered', () => {
  const html = renderCommentBody('see [docs](https://example.com)\n\n> quoted\n\n```ts\nconst a = 1;\n```');
  assert.match(html, /<a href="https:\/\/example.com">docs<\/a>/);
  assert.match(html, /<blockquote>/);
  assert.match(html, /<pre><code class="language-ts">/);
});

test('an empty or whitespace body renders nothing', () => {
  assert.equal(renderCommentBody(''), '');
  assert.equal(renderCommentBody('   \n  '), '');
});
