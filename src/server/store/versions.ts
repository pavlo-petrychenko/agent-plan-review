import type { Manifest, VersionInfo, VersionKind } from '../../shared/types.js';
import type { Layout } from './paths.js';
import { padVersion } from './paths.js';
import { ensureDir, exists, listDirs, listFiles, readJson, readText, removePath, writeJson, writeText } from '../util/fs.js';

export interface WriteVersionInput {
  n: number;
  kind: VersionKind;
  hash: string;
  /** For single versions. */
  markdown?: string;
  /** For tree versions (ordered). */
  manifest?: Manifest;
  docBodies?: Map<string, string>;
}

/**
 * Version persistence — immutable snapshots. Files are written once and never
 * mutated; deletion is the only lifecycle event.
 */
export class VersionStore {
  constructor(private readonly layout: Layout) {}

  async write(projectKey: string, input: WriteVersionInput): Promise<VersionInfo> {
    const { n, kind, hash } = input;
    await ensureDir(this.layout.versionsDir(projectKey));
    const info: VersionInfo = {
      n,
      createdAt: new Date().toISOString(),
      kind,
      docCount: kind === 'tree' ? (input.manifest?.docs.length ?? 0) : 1,
      hash,
    };
    await writeJson(this.layout.versionMetaFile(projectKey, n), info);
    if (kind === 'single') {
      await writeText(this.layout.versionMdFile(projectKey, n), input.markdown ?? '');
    } else {
      const dir = this.layout.versionDir(projectKey, n);
      await ensureDir(dir);
      await writeJson(this.layout.manifestFile(projectKey, n), input.manifest);
      for (const doc of input.manifest!.docs) {
        await writeText(this.layout.docFile(projectKey, n, doc.slug), input.docBodies?.get(doc.slug) ?? '');
      }
    }
    return info;
  }

  async readMeta(projectKey: string, n: number): Promise<VersionInfo | null> {
    return readJson<VersionInfo>(this.layout.versionMetaFile(projectKey, n));
  }

  async listMetas(projectKey: string): Promise<VersionInfo[]> {
    const names = await listFiles(this.layout.versionsDir(projectKey));
    const metas: VersionInfo[] = [];
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      const meta = await readJson<VersionInfo>(`${this.layout.versionsDir(projectKey)}/${name}`);
      if (meta) metas.push(meta);
    }
    return metas.sort((a, b) => a.n - b.n);
  }

  async readManifest(projectKey: string, n: number): Promise<Manifest | null> {
    return readJson<Manifest>(this.layout.manifestFile(projectKey, n));
  }

  async readMarkdown(projectKey: string, n: number): Promise<string | null> {
    return readText(this.layout.versionMdFile(projectKey, n));
  }

  async readDoc(projectKey: string, n: number, slug: string): Promise<string | null> {
    return readText(this.layout.docFile(projectKey, n, slug));
  }

  /**
   * Delete one version's files. Returns the surviving version metas so the
   * caller can recompute project meta.
   */
  async deleteFiles(projectKey: string, n: number): Promise<void> {
    await removePath(this.layout.versionMetaFile(projectKey, n));
    await removePath(this.layout.versionMdFile(projectKey, n));
    await removePath(this.layout.versionDir(projectKey, n));
  }

  /** True when any version files exist for this project. */
  async hasAny(projectKey: string): Promise<boolean> {
    return exists(this.layout.versionsDir(projectKey));
  }

  /** Highest surviving version number (0 when none). */
  async maxSurvivor(projectKey: string): Promise<number> {
    const metas = await this.listMetas(projectKey);
    return metas.length > 0 ? metas[metas.length - 1].n : 0;
  }

  /** All version directories (used by bulk cleanup sanity checks). */
  async listTreeDirs(projectKey: string): Promise<string[]> {
    return listDirs(this.layout.versionsDir(projectKey));
  }
}

export { padVersion };
