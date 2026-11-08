/**
 * `agent-plan-review herdr install | uninstall`: put the plan-review Herdr mod
 * (`herdr/plan-review/` in this repo) into `<herdr home>/mods/plan-review`.
 *
 * The mod is COPIED, not symlinked: Herdr resolves no files through a symlinked
 * mod folder, so every icon disappears ("a path led outside of the filesystem";
 * checked in the test window). Running `install` again after an
 * upgrade re-copies it in place (Herdr hot-reloads the changed files) and drops
 * files the new version no longer has. `--link` makes a symlink anyway, for
 * working on the mod itself.
 *
 * `install.json` next to the mod tells it where this agent-plan-review lives:
 * the storage root (images, server.json), the port, and the command that starts
 * the server, for its "Start server" button.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cliEntryPath } from './spawn-server.js';

export const MOD_NAME = 'plan-review';
const INSTALL_FILE = 'install.json';
/** Files Herdr or the installer write into a mod folder: never copied, never pruned. */
const KEEP = new Set([INSTALL_FILE, 'jsconfig.json', 'tsconfig.json']);
/** Source entries that are for development only. */
const SKIP = new Set(['test', 'dev', 'node_modules']);

export interface StartCommand {
  command: string;
  args: string[];
  cwd: string;
}

export interface InstallOptions {
  herdrHome: string;
  /** The mod's source folder (default: herdr/plan-review in this package). */
  source?: string;
  /** agent-plan-review storage root and port, written to install.json. */
  home: string;
  port: number;
  /** How the mod starts the server (default: this CLI's `serve`). */
  start?: StartCommand;
  link?: boolean;
}

export interface InstallResult {
  target: string;
  mode: 'copy' | 'link';
  /** Files written (copy) — 0 for a link. */
  copied: number;
  /** Stale files removed from an earlier install. */
  removed: number;
}

/** herdr/plan-review in this package (src/server/integrations or dist/server/integrations). */
export function modSourceDir(): string {
  return fileURLToPath(new URL('../../../herdr/plan-review', import.meta.url));
}

/** The command that runs this CLI's `serve` in the foreground. */
export function serveCommand(): StartCommand {
  const entry = cliEntryPath();
  const root = fileURLToPath(new URL('../../../', import.meta.url));
  if (entry.endsWith('.ts')) {
    const tsx = path.join(root, 'node_modules', '.bin', 'tsx');
    return fs.existsSync(tsx)
      ? { command: tsx, args: [entry, 'serve'], cwd: root }
      : { command: 'npx', args: ['tsx', entry, 'serve'], cwd: root };
  }
  return { command: process.execPath, args: [entry, 'serve'], cwd: root };
}

export function modTarget(herdrHome: string): string {
  return path.join(herdrHome, 'mods', MOD_NAME);
}

/** Copy (or link) the mod into Herdr and write its install.json. */
export function installHerdrMod(opts: InstallOptions): InstallResult {
  const source = path.resolve(opts.source ?? modSourceDir());
  if (!fs.existsSync(path.join(source, 'main.js'))) throw new Error(`No Herdr mod at ${source}`);
  const target = modTarget(opts.herdrHome);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const existing = lstat(target);
  if (existing && !existing.isSymbolicLink() && !isOurMod(target)) {
    throw new Error(`${target} exists and is not the plan-review mod; move it away first.`);
  }
  const info = {
    home: opts.home,
    port: opts.port,
    start: opts.start ?? serveCommand(),
    installedAt: new Date().toISOString(),
  };

  if (opts.link) {
    if (existing?.isSymbolicLink()) fs.rmSync(target);
    else if (existing) fs.rmSync(target, { recursive: true, force: true });
    fs.symlinkSync(source, target, 'dir');
    writeAtomic(path.join(source, INSTALL_FILE), `${JSON.stringify(info, null, 2)}\n`);
    return { target, mode: 'link', copied: 0, removed: 0 };
  }

  // A symlink from an earlier `--link` (or an older install) goes; a real folder is
  // updated in place so Herdr reloads the copy instead of seeing a new mod.
  if (existing?.isSymbolicLink()) fs.rmSync(target);
  fs.mkdirSync(target, { recursive: true });
  const files = listFiles(source);
  let copied = 0;
  for (const rel of files) {
    const from = path.join(source, rel);
    const to = path.join(target, rel);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    const same = fs.existsSync(to) && fs.readFileSync(to).equals(fs.readFileSync(from));
    if (!same) {
      writeAtomic(to, fs.readFileSync(from));
      copied++;
    }
  }
  const wanted = new Set(files);
  let removed = 0;
  for (const rel of listFiles(target)) {
    if (!wanted.has(rel)) {
      fs.rmSync(path.join(target, rel), { force: true });
      removed++;
    }
  }
  removeEmptyDirs(target);
  writeAtomic(path.join(target, INSTALL_FILE), `${JSON.stringify(info, null, 2)}\n`);
  return { target, mode: 'copy', copied, removed };
}

/** Remove the installed mod. Returns false when there was none. */
export function uninstallHerdrMod(herdrHome: string): boolean {
  const target = modTarget(herdrHome);
  const st = lstat(target);
  if (!st) return false;
  if (st.isSymbolicLink()) {
    fs.rmSync(target);
    return true;
  }
  if (!isOurMod(target)) throw new Error(`${target} is not the plan-review mod; not removing it.`);
  fs.rmSync(target, { recursive: true, force: true });
  return true;
}

/** Every file of a mod folder to copy, relative, sorted — dev folders, dotfiles, docs and Herdr's own files left out. */
function listFiles(dir: string, rel = ''): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    const name = e.name;
    const r = rel ? path.join(rel, name) : name;
    if (name.startsWith('.')) continue;
    if (e.isDirectory()) {
      if (!rel && SKIP.has(name)) continue;
      out.push(...listFiles(dir, r));
    } else if (e.isFile()) {
      if (!rel && KEEP.has(name)) continue;
      if (name.endsWith('.d.ts') || name.endsWith('.md') || name.endsWith('.error')) continue;
      out.push(r);
    }
  }
  return out.sort();
}

function removeEmptyDirs(dir: string): void {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const p = path.join(dir, e.name);
    removeEmptyDirs(p);
    if (fs.readdirSync(p).length === 0) fs.rmdirSync(p);
  }
}

function isOurMod(dir: string): boolean {
  if (fs.existsSync(path.join(dir, INSTALL_FILE))) return true;
  try {
    const mod = JSON.parse(fs.readFileSync(path.join(dir, 'mod.json'), 'utf8')) as { title?: string };
    return mod.title === 'Plan review';
  } catch {
    return false;
  }
}

function lstat(p: string): fs.Stats | null {
  try {
    return fs.lstatSync(p);
  } catch {
    return null;
  }
}

function writeAtomic(file: string, data: string | Buffer): void {
  // A hidden temp name: Herdr ignores dotfiles, so it reloads once, on the rename.
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.tmp`);
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}
