import path from 'node:path';
import type { ServerConfig } from '../config.js';

/**
 * Storage layout (all under cfg.home):
 *
 *   server.json                     {port,pid}
 *   reviews/<reviewId>.json
 *   projects/<key>/meta.json
 *   projects/<key>/versions/NNNN.json          version meta
 *   projects/<key>/versions/NNNN.md            single-doc content
 *   projects/<key>/versions/NNNN/manifest.json tree manifest
 *   projects/<key>/versions/NNNN/<slug>.md     tree doc content
 *   projects/<key>/comments/NNNN.json
 *   projects/<key>/locks/<toolUseId>.lock      double-fire dedup markers
 */
export interface Layout {
  home: string;
  reviewsDir: string;
  projectsDir: string;
  projectDir: (key: string) => string;
  metaFile: (key: string) => string;
  versionsDir: (key: string) => string;
  commentsDir: (key: string) => string;
  locksDir: (key: string) => string;
  versionMetaFile: (key: string, n: number) => string;
  versionMdFile: (key: string, n: number) => string;
  versionDir: (key: string, n: number) => string;
  manifestFile: (key: string, n: number) => string;
  docFile: (key: string, n: number, slug: string) => string;
  commentsFile: (key: string, n: number) => string;
  reviewFile: (id: string) => string;
}

export function createLayout(cfg: ServerConfig): Layout {
  const home = cfg.home;
  const pad = (n: number) => String(n).padStart(4, '0');
  return {
    home,
    reviewsDir: path.join(home, 'reviews'),
    projectsDir: path.join(home, 'projects'),
    projectDir: (key) => path.join(home, 'projects', key),
    metaFile: (key) => path.join(home, 'projects', key, 'meta.json'),
    versionsDir: (key) => path.join(home, 'projects', key, 'versions'),
    commentsDir: (key) => path.join(home, 'projects', key, 'comments'),
    locksDir: (key) => path.join(home, 'projects', key, 'locks'),
    versionMetaFile: (key, n) => path.join(home, 'projects', key, 'versions', `${pad(n)}.json`),
    versionMdFile: (key, n) => path.join(home, 'projects', key, 'versions', `${pad(n)}.md`),
    versionDir: (key, n) => path.join(home, 'projects', key, 'versions', `${pad(n)}`),
    manifestFile: (key, n) => path.join(home, 'projects', key, 'versions', `${pad(n)}`, 'manifest.json'),
    docFile: (key, n, slug) => path.join(home, 'projects', key, 'versions', `${pad(n)}`, `${slug}.md`),
    commentsFile: (key, n) => path.join(home, 'projects', key, 'comments', `${pad(n)}.json`),
    reviewFile: (id) => path.join(home, 'reviews', `${id}.json`),
  };
}

export const padVersion = (n: number): string => String(n).padStart(4, '0');
