import type { GistBinding, ProjectMeta } from '../../shared/types.js';
import { sanitizeProjectKey } from '../../shared/keys.js';
import type { Layout } from './paths.js';
import { ensureDir, listDirs, readJson, removePath, writeJson } from '../util/fs.js';
import { sameProjectCwd } from '../util/project-cwd.js';

/** Display name of a project: the given name, else the worktree folder name. */
function displayName(cwd: string, name?: string): string {
  return name?.trim() || cwd.split('/').filter(Boolean).pop() || cwd;
}

/** Project-level persistence: meta.json lifecycle + discovery. */
export class ProjectStore {
  constructor(private readonly layout: Layout) {}

  async getOrCreate(cwd: string, name?: string): Promise<{ meta: ProjectMeta; created: boolean }> {
    const key = sanitizeProjectKey(cwd);
    const existing = await this.get(key);
    if (existing) return { meta: existing, created: false };
    return { meta: await this.write(key, cwd, name), created: true };
  }

  /**
   * Create a plan project: one of several plans in the worktree `cwd`, stored
   * under `key` (`<worktree key>.p-<id>`, chosen by the caller). Its display
   * name stays the worktree folder name; the plan title tells plans apart.
   */
  async createPlan(
    key: string,
    cwd: string,
    plan: { id: string; title: string },
    name?: string,
  ): Promise<ProjectMeta> {
    return this.write(key, cwd, name, plan);
  }

  private async write(
    key: string,
    cwd: string,
    name?: string,
    plan?: { id: string; title: string },
  ): Promise<ProjectMeta> {
    const now = new Date().toISOString();
    const meta: ProjectMeta = {
      key,
      name: displayName(cwd, name),
      cwd,
      createdAt: now,
      updatedAt: now,
      currentVersion: 0,
      storage: {},
      ...(plan ? { plan } : {}),
    };
    await ensureDir(this.layout.projectDir(key));
    await writeJson(this.layout.metaFile(key), meta);
    return meta;
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

  /**
   * Every project of one worktree — its plans and its legacy project — most
   * recently active first. Many projects share a cwd now, so this is how a
   * worktree's plans are found.
   */
  async listByWorktree(cwd: string): Promise<ProjectMeta[]> {
    return (await this.list()).filter((p) => sameProjectCwd(p.cwd, cwd));
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
