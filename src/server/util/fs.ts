import fsp from 'node:fs/promises';
import type fs from 'node:fs';
import path from 'node:path';

export async function ensureDir(dir: string): Promise<void> {
  await fsp.mkdir(dir, { recursive: true });
}

export async function exists(p: string): Promise<boolean> {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

export async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8')) as T;
  } catch {
    return null;
  }
}

/** Atomic-ish write: temp file + rename in the same directory. */
export async function writeJson(file: string, data: unknown): Promise<void> {
  await ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(data, null, 2));
  await fsp.rename(tmp, file);
}

export async function readText(file: string): Promise<string | null> {
  try {
    return await fsp.readFile(file, 'utf8');
  } catch {
    return null;
  }
}

export async function writeText(file: string, content: string): Promise<void> {
  await ensureDir(path.dirname(file));
  await fsp.writeFile(file, content);
}

export async function removePath(p: string): Promise<void> {
  await fsp.rm(p, { recursive: true, force: true });
}

/** List immediate child directories of `dir` (empty when missing). */
export async function listDirs(dir: string): Promise<string[]> {
  let entries: fs.Dirent[];
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();
}

export async function listFiles(dir: string): Promise<string[]> {
  let entries: fs.Dirent[];
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.filter((e) => e.isFile()).map((e) => e.name).sort();
}
