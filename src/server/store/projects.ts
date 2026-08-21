import type { GistBinding, ProjectMeta } from '../../shared/types.js';
import { sanitizeProjectKey } from '../../shared/keys.js';
import type { Layout } from './paths.js';
import { ensureDir, listDirs, readJson, removePath, writeJson } from '../util/fs.js';

/** Project-level persistence: meta.json lifecycle + discovery. */
export class ProjectStore {
  constructor(private readonly layout: Layout) {}

  async getOrCreate(cwd: string, name?: string): Promise<{ meta: ProjectMeta; created: boolean }> {
    const key = sanitizeProjectKey(cwd);
    const existing = await this.get(key);
    if (existing) return { meta: existing, created: false };
    const now = new Date().toISOString();
    const meta: ProjectMeta = {
      key,
      name: name?.trim() || cwd.split('/').filter(Boolean).pop() || cwd,
      cwd,
      createdAt: now,
      updatedAt: now,
      currentVersion: 0,
      storage: {},
    };
    await ensureDir(this.layout.projectDir(key));
    await writeJson(this.layout.metaFile(key), meta);
    return { meta, created: true };
  }

  async get(key: string): Promise<ProjectMeta | null> {
    return readJson<ProjectMeta>(this.layout.metaFile(key));
  }

  async save(meta: ProjectMeta): Promise<void> {
    await writeJson(this.layout.metaFile(meta.key), meta);
  }

  /** All projects, most recently active first. */
  async list(): Promise<ProjectMeta[]> {
    const keys = await listDirs(this.layout.projectsDir);
    const metas: ProjectMeta[] = [];
    for (const key of keys) {
      const meta = await readJson<ProjectMeta>(this.layout.metaFile(key));
      if (meta) metas.push(meta);
    }
    return metas.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async setGistBinding(key: string, binding: GistBinding): Promise<void> {
    const meta = await this.get(key);
    if (!meta) return;
    meta.storage = { ...meta.storage, gist: binding };
    await this.save(meta);
  }

  async remove(key: string): Promise<void> {
    await removePath(this.layout.projectDir(key));
  }
}
