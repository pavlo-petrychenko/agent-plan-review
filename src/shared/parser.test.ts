import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePlan, extractTitle } from './parser.js';

test('zero markers ⇒ flat single-doc', () => {
  const r = parsePlan('# Hello\n\nWorld.\n');
  assert.equal(r.kind, 'single');
  assert.equal((r as { markdown: string }).markdown, '# Hello\n\nWorld.');
});

test('preamble becomes root doc titled from H1', () => {
  const md = [
    '# Main Plan',
    '',
    'Intro text.',
    '',
    '<!--doc slug="details" title="Details" parent=root-->', // lenient quoting
    'Details body.',
  ].join('\n');
  const r = parsePlan(md);
  assert.equal(r.kind, 'tree');
  const docs = (r as { docs: { slug: string; title: string; parent: string | null; markdown: string }[] }).docs;
  assert.equal(docs.length, 2);
  assert.deepEqual([docs[0].slug, docs[0].title, docs[0].parent], ['root', 'Main Plan', null]);
  assert.equal(docs[0].markdown, '# Main Plan\n\nIntro text.');
  assert.deepEqual([docs[1].slug, docs[1].title, docs[1].parent], ['details', 'Details', 'root']);
  assert.equal(docs[1].markdown, 'Details body.');
});

test('marker inside fence ignored', () => {
  const md = ['# T', '', '```md', '<!--doc slug=fake title="Fake" parent=root-->', '```', ''].join('\n');
  const r = parsePlan(md);
  assert.equal(r.kind, 'single');
});

test('plan starting with marker has no implicit root', () => {
  const md = '<!--doc slug=overview title="Overview" parent=plan-->\nA\n<!--doc slug=plan title="Plan" parent=-->\nB';
  // note second marker's empty parent → parent '' treated as null? we treat '' as ''
  const r = parsePlan(md);
  assert.equal(r.kind, 'tree');
  const docs = (r as { docs: { slug: string; parent: string | null }[] }).docs;
  assert.equal(docs.length, 2);
  assert.equal(docs[0].slug, 'overview');
});

test('attribute order is flexible', () => {
  const md = '# R\n<!--doc title="Child" slug=child parent=root-->';
  const r = parsePlan(md);
  const docs = (r as { docs: { slug: string; title: string; parent: string | null; markdown: string }[] }).docs;
  assert.equal(docs[1].slug, 'child');
  assert.equal(docs[1].title, 'Child');
  assert.equal(docs[1].parent, 'root');
  assert.equal(docs[1].markdown, '');
});

test('extractTitle finds first H1', () => {
  assert.equal(extractTitle('text\n# The Title\ncode'), 'The Title');
  assert.equal(extractTitle('no heading here'), undefined);
});
