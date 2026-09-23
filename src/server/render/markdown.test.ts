/**
 * Plan-renderer contracts that are easy to regress:
 *  - the block↔line wrapper every comment anchor depends on;
 *  - raw HTML that spans sibling blocks must NOT be wrapped (or the browser
 *    auto-closes the element and its body escapes outside it);
 *  - images get a class + deferred loading, whether markdown or raw HTML.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderMarkdown, spansSiblingBlocks } from './markdown.js';

const SLUGS = new Set(['root', 'impl']);

test('spansSiblingBlocks detects container tags that cross block boundaries', () => {
  assert.equal(spansSiblingBlocks('<details><summary>Q</summary>'), true, 'open with no close');
  assert.equal(spansSiblingBlocks('</details>'), true, 'stray close tag');
  assert.equal(spansSiblingBlocks('<details><summary>Q</summary></details>'), false, 'balanced');
  assert.equal(spansSiblingBlocks('<div class="x">a</div>'), false, 'balanced inline block');
  assert.equal(spansSiblingBlocks('<img src="x.png">'), false, 'void tags are irrelevant');
  assert.equal(spansSiblingBlocks('<br>'), false);
  assert.equal(spansSiblingBlocks('<span>inline</span>'), false, 'inline tags do not wrap blocks');
  assert.equal(spansSiblingBlocks('<div/><div/>'), false, 'self-closing form');
});

test('a <details> that spans blocks is emitted unwrapped so it can nest them', () => {
  const md = [
    '<details><summary>Should raw HTML survive?</summary>',
    '',
    'Inside the disclosure.',
    '',
    '</details>',
  ].join('\n');
  const html = renderMarkdown(md, SLUGS);

  assert.ok(!/md-block[^>]*>\s*<details/.test(html), 'the opening tag is not locked inside a wrapper');
  assert.match(html, /^<details>/, 'it is emitted at the container level');
  assert.ok(!/md-block[^>]*>\s*<\/details>/.test(html), 'the closing tag is not locked inside a wrapper');
  // The body keeps its own anchor, and now sits between the two bare tags, so the
  // DOM nests it inside the disclosure.
  assert.match(html, /md-block[^>]*data-line-start="3"[^>]*>\s*<p>Inside the disclosure\.<\/p>/);
  assert.ok(html.indexOf('<details>') < html.indexOf('Inside the disclosure.'));
  assert.ok(html.indexOf('Inside the disclosure.') < html.indexOf('</details>'));
});

test('balanced raw html keeps its wrapper and line anchor', () => {
  const html = renderMarkdown('text\n\n<div class="box">one line</div>', SLUGS);
  assert.match(html, /<div class="md-block" data-line-start="3" data-line-end="3"><div class="box">one line<\/div><\/div>/);
});

test('every top-level block carries a line range', () => {
  const html = renderMarkdown('# Title\n\npara one\n\n- a\n- b', SLUGS);
  const starts = [...html.matchAll(/data-line-start="(\d+)"/g)].map((m) => m[1]);
  assert.deepEqual(starts, ['1', '3', '5']);
});

test('images get the viewer class and deferred loading, markdown or raw', () => {
  const md = '![shot](/api/images/ab.png)\n\n<img src="/api/images/cd.png" width="300">';
  const html = renderMarkdown(md, SLUGS);
  assert.match(html, /<img[^>]*class="md-img"[^>]*loading="lazy"[^>]*decoding="async"/);
  assert.equal((html.match(/loading="lazy"/g) || []).length, 2, 'raw-HTML images are deferred too');
  assert.match(html, /<img[^>]*loading="lazy"[^>]*decoding="async"[^>]*src="\/api\/images\/cd\.png"/);
});

test('cross-document links are rewritten only for slugs in the manifest', () => {
  const html = renderMarkdown('[impl](doc:impl) and [gone](doc:nope)', SLUGS);
  assert.match(html, /href="#impl"[^>]*data-doc-slug="impl"/);
  assert.match(html, /href="doc:nope"/, 'unknown slugs are left alone');
});

test('scripts are stripped from rendered plans', () => {
  const html = renderMarkdown('ok\n\n<script>alert(1)</script>', SLUGS);
  assert.ok(!html.includes('<script'), 'executable content never reaches the page');
});

test('tables are wrapped so they can fill the column and still scroll', () => {
  const md = '| a | b |\n| --- | --- |\n| wide cell value | other |';
  const html = renderMarkdown(md, SLUGS);
  // The wrapper makes the table stretch to the reading column (display:block on the
  // table itself would shrink columns to content) while keeping its own scrollbar.
  assert.match(html, /<div class="md-table-wrap"><table>/);
  // …and the block↔line contract is untouched: one md-block containing the wrapper.
  assert.match(html, /<div class="md-block" data-line-start="1" data-line-end="3"><div class="md-table-wrap">/);
});
