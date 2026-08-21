import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeWikiLinks, extractDocLinks } from './markdownLinks.js';

test('wiki links normalize with and without labels', () => {
  assert.equal(normalizeWikiLinks('see [[alpha]]'), 'see [alpha](doc:alpha)');
  assert.equal(normalizeWikiLinks('see [[alpha|the alpha doc]]'), 'see [the alpha doc](doc:alpha)');
});

test('multi-word targets slugify', () => {
  assert.equal(normalizeWikiLinks('[[Risk Register]]'), '[Risk Register](doc:risk-register)');
});

test('inline code untouched', () => {
  assert.equal(normalizeWikiLinks('use `[[x]]` literally'), 'use `[[x]]` literally');
});

test('fenced code untouched, fences preserved', () => {
  const md = ['```md', '[[inside]]', '```', '', '[[outside]]'].join('\n');
  assert.equal(normalizeWikiLinks(md), ['```md', '[[inside]]', '```', '', '[outside](doc:outside)'].join('\n'));
});

test('extractDocLinks collects wiki and doc: targets', () => {
  const found = extractDocLinks('[a](doc:x) [[Y]] `[[z]]`\n```\n(doc:w)\n```');
  assert.deepEqual(found.sort(), ['x', 'y']);
});
