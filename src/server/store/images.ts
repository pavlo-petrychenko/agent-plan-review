/**
 * Plan images — content-addressed files under `<home>/images/`.
 *
 * Why content-addressed: an agent can attach the same screenshot to several
 * versions and it is stored once; the URL is stable forever, so a plan's
 * markdown can keep pointing at it across re-submissions; and nothing an agent
 * sends can influence a path (the file name is derived from the bytes, never
 * from the client's filename).
 *
 * The type is sniffed from magic bytes rather than trusted from the request, so
 * a `.php` dressed up as a PNG is rejected instead of served.
 *
 * Markdown references them two ways:
 *   - inline, by final URL, once uploaded: `![before](/api/images/<sha>.png)`
 *   - symbolically at submit time: `![before](image:before)` + `images: [{name: 'before', path | dataBase64}]`
 *     (rewritten to the final URL before the version is stored and hashed).
 */

import { createHash } from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { Layout } from './paths.js';
import { ensureDir } from '../util/fs.js';
import { ApiError } from '../util/errors.js';

/** Hard cap per image. Base64 in a JSON body inflates ~4/3, and the API accepts 12mb. */
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

export const IMAGE_FILE_RE = /^[a-f0-9]{16}\.(png|jpg|gif|webp|svg|avif)$/;

/** Bad image payload — maps onto a 400 and a tool error alike. */
export class ImageError extends ApiError {
  constructor(message: string) {
    super(400, { error: message }, message);
    this.name = 'ImageError';
  }
}

export interface StoredImage {
  /** File name under `<home>/images/`, e.g. `3f2a…9c.png`. */
  file: string;
  /** Absolute-path URL that serves it. */
  url: string;
  bytes: number;
  sha: string;
  contentType: string;
  /** Ready-to-paste markdown for the agent's reply. */
  markdown: string;
}

/** An image supplied with a plan submission (MCP `images[]`, HTTP `images[]`). */
export interface PlanImageInput {
  /** Referenced from markdown as `image:<name>`. */
  name: string;
  /** Absolute or cwd-relative path to read (local agents). */
  path?: string;
  /** Or inline base64 (optionally a full `data:` URL). */
  dataBase64?: string;
}

// ---------------------------------------------------------------------------
// type sniffing
// ---------------------------------------------------------------------------

/** Sniff an image type from magic bytes. Returns null for anything unsupported. */
export function sniffImageType(data: Buffer): { ext: string; contentType: string } | null {
  if (data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { ext: 'png', contentType: 'image/png' };
  }
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) {
    return { ext: 'jpg', contentType: 'image/jpeg' };
  }
  if (data.length >= 6 && data.subarray(0, 4).toString('latin1') === 'GIF8') {
    return { ext: 'gif', contentType: 'image/gif' };
  }
  if (data.length >= 12 && data.subarray(0, 4).toString('latin1') === 'RIFF' && data.subarray(8, 12).toString('latin1') === 'WEBP') {
    return { ext: 'webp', contentType: 'image/webp' };
  }
  if (data.length >= 12 && data.subarray(4, 8).toString('latin1') === 'ftyp') {
    const brand = data.subarray(8, 12).toString('latin1');
    if (brand === 'avif' || brand === 'avis') return { ext: 'avif', contentType: 'image/avif' };
  }
  // SVG is text; keep the check strict and anchored at the start of the document.
  const head = data.subarray(0, 2048).toString('utf8').trimStart();
  const withoutProlog = head.replace(/^<\?xml[^>]*\?>\s*/i, '').replace(/^<!--[\s\S]*?-->\s*/, '');
  if (/^<svg[\s>]/i.test(withoutProlog)) return { ext: 'svg', contentType: 'image/svg+xml' };
  return null;
}

export function contentTypeFor(file: string): string {
  const ext = path.extname(file).slice(1).toLowerCase();
  switch (ext) {
    case 'png':
      return 'image/png';
    case 'jpg':
      return 'image/jpeg';
    case 'gif':
      return 'image/gif';
    case 'webp':
      return 'image/webp';
    case 'svg':
      return 'image/svg+xml';
    case 'avif':
      return 'image/avif';
    default:
      return 'application/octet-stream';
  }
}

// ---------------------------------------------------------------------------
// store
// ---------------------------------------------------------------------------

export function imageUrl(file: string): string {
  return `/api/images/${file}`;
}

/** Store bytes as a content-addressed image. Idempotent: same bytes, same file. */
export async function storeImage(layout: Layout, data: Buffer): Promise<StoredImage> {
  if (data.length === 0) throw new ImageError('Image is empty.');
  if (data.length > MAX_IMAGE_BYTES) {
    throw new ImageError(`Image is too large (${Math.round(data.length / 1024 / 1024)} MB); the limit is ${MAX_IMAGE_BYTES / 1024 / 1024} MB.`);
  }
  const kind = sniffImageType(data);
  if (!kind) {
    throw new ImageError('Unsupported image — expected PNG, JPEG, GIF, WebP, AVIF or SVG bytes.');
  }
  const sha = createHash('sha256').update(data).digest('hex');
  const file = `${sha.slice(0, 16)}.${kind.ext}`;
  await ensureDir(layout.imagesDir);
  const target = path.join(layout.imagesDir, file);
  try {
    await fsp.access(target);
    // Already stored; identical bytes.
  } catch {
    await fsp.writeFile(target, data);
  }
  const url = imageUrl(file);
  return {
    file,
    url,
    bytes: data.length,
    sha,
    contentType: kind.contentType,
    markdown: `![](${url})`,
  };
}

/** Resolve a base64 payload (raw, or a full `data:image/png;base64,…` URL). */
export function decodeBase64Image(input: string): Buffer {
  const comma = input.startsWith('data:') ? input.indexOf(',') : -1;
  const payload = comma >= 0 ? input.slice(comma + 1) : input;
  const cleaned = payload.replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(cleaned)) throw new ImageError('dataBase64 is not valid base64.');
  return Buffer.from(cleaned, 'base64');
}

/** Load one submission input from disk or base64 and store it. */
export async function storePlanImage(
  layout: Layout,
  input: PlanImageInput,
  cwd?: string,
): Promise<StoredImage> {
  const name = typeof input?.name === 'string' ? input.name.trim() : '';
  if (!name) throw new ImageError('Every entry in images[] needs a `name` (referenced as image:<name>).');
  if (input.path && input.dataBase64) {
    throw new ImageError(`images[${name}]: provide either path or dataBase64, not both.`);
  }
  if (input.path) {
    const resolved = path.isAbsolute(input.path) ? input.path : path.resolve(cwd ?? process.cwd(), input.path);
    let data: Buffer;
    try {
      data = await fsp.readFile(resolved);
    } catch {
      throw new ImageError(`images[${name}]: cannot read file at ${resolved}.`);
    }
    return storeImage(layout, data);
  }
  if (input.dataBase64) return storeImage(layout, decodeBase64Image(input.dataBase64));
  throw new ImageError(`images[${name}]: provide path or dataBase64.`);
}

/**
 * Store every attached image and return the `name → url` map used to rewrite
 * `image:<name>` references. Duplicate names keep the first occurrence.
 */
export async function resolvePlanImages(
  layout: Layout,
  images: PlanImageInput[] | undefined,
  cwd?: string,
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (!images || images.length === 0) return map;
  if (images.length > 60) throw new ImageError('Too many images in one submission (limit 60).');
  for (const input of images) {
    const name = typeof input?.name === 'string' ? input.name.trim() : '';
    if (map.has(name)) continue;
    const stored = await storePlanImage(layout, input, cwd);
    map.set(name, stored.url);
  }
  return map;
}

// ---------------------------------------------------------------------------
// markdown rewriting
// ---------------------------------------------------------------------------

const MD_REF_RE = /(!\[[^\]]*\]\()\s*image:([A-Za-z0-9._-]+)\s*(\))/g;
const HTML_REF_RE = /(<img\b[^>]*\bsrc=["'])\s*image:([A-Za-z0-9._-]+)\s*(["'])/gi;

/** Rewrite `image:<name>` references (markdown and raw `<img src>`) to final URLs. */
export function rewriteImageRefs(markdown: string, byName: Map<string, string>): string {
  if (byName.size === 0) return markdown;
  const swap = (_m: string, pre: string, name: string, post: string): string => {
    const url = byName.get(name);
    return url ? `${pre}${url}${post}` : `${pre}image:${name}${post}`;
  };
  return markdown.replace(MD_REF_RE, swap).replace(HTML_REF_RE, swap);
}

/** Names referenced as `image:<name>` that no attachment (or rewrite) resolved. */
export function unresolvedImageRefs(markdown: string): string[] {
  const names = new Set<string>();
  for (const re of [MD_REF_RE, HTML_REF_RE]) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(markdown)) !== null) names.add(m[2]);
  }
  return [...names];
}
