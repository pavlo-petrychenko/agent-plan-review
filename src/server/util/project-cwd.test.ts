import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gitToplevel, nearestKnownAncestor, resolveProjectCwd, resolveProjectCwdSync, sameProjectCwd } from './project-cwd.js';

function makeDir(prefix: string): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

test('a subdirectory resolves to its git toplevel', () => {
  const repo = makeDir('apr-cwd-repo-');
  execFileSync('git', ['init', '-q'], { cwd: repo });
  const sub = path.join(repo, 'a', 'b');
  fs.mkdirSync(sub, { recursive: true });

  assert.equal(gitToplevel(sub), repo);
  assert.equal(resolveProjectCwdSync(sub), repo);
  assert.equal(sameProjectCwd(repo, sub), true);
});

test('separate worktrees of one repo stay separate projects', () => {
  const repo = makeDir('apr-cwd-wt-');
  execFileSync('git', ['init', '-q'], { cwd: repo });
  execFileSync('git', ['config', 'user.email', 't@t'], { cwd: repo });
  execFileSync('git', ['config', 'user.name', 't'], { cwd: repo });
  fs.writeFileSync(path.join(repo, 'f.txt'), 'x');
  execFileSync('git', ['add', '.'], { cwd: repo });
  execFileSync('git', ['commit', '-qm', 'init'], { cwd: repo });

  const worktree = path.join(makeDir('apr-cwd-wtbase-'), 'feature');
  execFileSync('git', ['worktree', 'add', '-q', worktree], { cwd: repo });
  fs.mkdirSync(path.join(worktree, 'sub'), { recursive: true });

  // A worktree's toplevel is the worktree root — not the main checkout.
  assert.equal(resolveProjectCwdSync(path.join(worktree, 'sub')), fs.realpathSync(worktree));
  assert.equal(sameProjectCwd(repo, worktree), false);
});

test('outside a repo the nearest registered ancestor wins', () => {
  const parent = makeDir('apr-cwd-parent-');
  const child = path.join(parent, 'src', 'deep');
  fs.mkdirSync(child, { recursive: true });

  assert.equal(gitToplevel(child), null);
  assert.equal(nearestKnownAncestor(child, [parent]), parent);
  assert.equal(resolveProjectCwd(child, [parent]), parent);
  assert.equal(resolveProjectCwd(child), child);
});

test('nearestKnownAncestor picks the deepest match and ignores non-ancestors', () => {
  const outer = makeDir('apr-cwd-o-');
  const inner = path.join(outer, 'inner');
  fs.mkdirSync(inner, { recursive: true });
  const unrelated = makeDir('apr-cwd-u-');

  assert.equal(nearestKnownAncestor(inner, [outer, unrelated]), outer);
  assert.equal(nearestKnownAncestor(inner, [unrelated]), null);
  assert.equal(nearestKnownAncestor(outer, [outer]), outer);
});
