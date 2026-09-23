/**
 * Unit tests for the plan-image store: the bytes are the identity (so the URL
 * is stable and dedupe is free), the type comes from the bytes and never from
 * the caller's filename, and `image:<name>` references resolve or fail loudly.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLayout } from './paths.js';
import {
  IMAGE_FILE_RE,
  decodeBase64Image,
  imageUrl,
  resolvePlanImages,
  rewriteImageRefs,
  sniffImageType,
  storeImage,
  unresolvedImageRefs,
} from './images.js';

function makeLayout() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'apr-images-'));
  return createLayout({ home, port: 4999 });
}

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('fake png body'),
]);
const GIF = Buffer.concat([Buffer.from('GIF89a'), Buffer.from('gif body')]);
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><rect /></svg>');

test('image type comes from the magic bytes, not the filename', () => {
  assert.equal(sniffImageType(PNG)?.ext, 'png');
  assert.equal(sniffImageType(GIF)?.contentType, 'image/gif');
  assert.equal(sniffImageType(SVG)?.contentType, 'image/svg+xml');
  assert.equal(sniffImageType(Buffer.from('<?xml version="1.0"?>\n<svg width="1" />'))?.ext, 'svg');
  // A script dressed up as an image is rejected outright.
  assert.equal(sniffImageType(Buffer.from('<?php echo 1; ?>')), null);
  assert.equal(sniffImageType(Buffer.from('not an image at all')), null);
  assert.equal(sniffImageType(Buffer.alloc(0)), null);
});

test('identical bytes collapse onto one immutable url', async () => {
  const layout = makeLayout();
  const first = await storeImage(layout, PNG);
  const second = await storeImage(layout, Buffer.from(PNG));
  assert.equal(first.file, second.file);
  assert.equal(first.url, imageUrl(first.file));
  assert.match(first.file, IMAGE_FILE_RE);
  assert.equal(fs.readdirSync(layout.imagesDir).length, 1, 'one file for identical bytes');
  // Two different images stay distinct.
  const other = await storeImage(layout, GIF);
  assert.notEqual(other.file, first.file);
  assert.equal(fs.readdirSync(layout.imagesDir).length, 2);
});

test('rejects empty, unsupported and oversized payloads', async () => {
  const layout = makeLayout();
  await assert.rejects(() => storeImage(layout, Buffer.alloc(0)), /empty/i);
  await assert.rejects(() => storeImage(layout, Buffer.from('hello')), /Unsupported image/i);
  const huge = Buffer.concat([PNG, Buffer.alloc(9 * 1024 * 1024)]);
  await assert.rejects(() => storeImage(layout, huge), /too large/i);
});

test('decodes raw and data: base64 payloads', () => {
  assert.deepEqual(decodeBase64Image(PNG.toString('base64')), PNG);
  assert.deepEqual(decodeBase64Image(`data:image/png;base64,${PNG.toString('base64')}`), PNG);
  assert.throws(() => decodeBase64Image('not base64 !!'), /not valid base64/i);
});

test('resolvePlanImages reads from disk or base64, keyed by name', async () => {
  const layout = makeLayout();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apr-img-src-'));
  fs.writeFileSync(path.join(dir, 'shot.png'), PNG);
  const map = await resolvePlanImages(
    layout,
    [
      { name: 'before', path: 'shot.png' },
      { name: 'after', dataBase64: GIF.toString('base64') },
    ],
    dir,
  );
  assert.equal(map.size, 2);
  assert.match(map.get('before')!, /^\/api\/images\/[a-f0-9]{16}\.png$/);
  assert.match(map.get('after')!, /^\/api\/images\/[a-f0-9]{16}\.gif$/);
  // Missing / ambiguous inputs fail with the offending name in the message.
  await assert.rejects(() => resolvePlanImages(layout, [{ name: 'x', path: 'nope.png' }], dir), /images\[x\].*cannot read/i);
  await assert.rejects(() => resolvePlanImages(layout, [{ name: 'x', path: 'a', dataBase64: 'b' }], dir), /not both/i);
  await assert.rejects(() => resolvePlanImages(layout, [{ name: '' } as never]), /needs a `name`/i);
});

test('image:<name> references are rewritten in markdown and raw html', async () => {
  const layout = makeLayout();
  const map = await resolvePlanImages(layout, [{ name: 'before', dataBase64: PNG.toString('base64') }]);
  const url = map.get('before')!;
  const md = [
    '# Before / after',
    '',
    '![before the fix](image:before)',
    '',
    '<img src="image:before" width="600">',
    '',
    '![already uploaded](' + url + ')',
  ].join('\n');
  const out = rewriteImageRefs(md, map);
  assert.equal(out.includes('image:before'), false, 'symbolic refs are gone');
  assert.equal(out.split(url).length - 1, 3, 'both refs plus the literal url');
  assert.deepEqual(unresolvedImageRefs(out), []);

  // An unattached name is reported rather than silently left broken.
  const broken = '![x](image:missing)\n\n<img src="image:also-missing">';
  assert.deepEqual(unresolvedImageRefs(broken).sort(), ['also-missing', 'missing']);
  assert.deepEqual(unresolvedImageRefs(rewriteImageRefs(broken, map)).sort(), ['also-missing', 'missing']);
  assert.deepEqual(unresolvedImageRefs('![ok](https://example.com/a.png)'), []);
});
