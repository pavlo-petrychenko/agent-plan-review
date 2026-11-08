/**
 * Tests for `forget` (delete one worktree's plans) and the startup sweep of
 * vanished Herdr worktrees. Every test runs against temp dirs: a temp store
 * home, a temp "user home" and a temp Herdr app folder. Nothing touches the
 * real ~/.agent-plan-review or ~/.config/herdr-app.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PlanReviewStore } from './store/store.js';
import { sanitizeProjectKey } from '../shared/keys.js';
import { herdrSettings, setHerdrSettings } from './config.js';
import { forgetWorktree, formatForgetReport, parseForgetArgs, runForget } from './forget-cli.js';
import {
  forgetMissingWorktrees,
  insideWorktreeRoot,
  templatePrefix,
  worktreeRoots,
} from './integrations/herdr-worktrees.js';
import { herdrPointerFile } from './integrations/herdr.js';

/** Temp "user home" and temp Herdr app folder. */
interface HerdrEnv {
  herdrHome: string;
  userHome: string;
}

/** The process env the Herdr helpers read, pointed at the temp Herdr folder. */
const procEnv = (e: HerdrEnv): NodeJS.ProcessEnv => ({ HERDR_APP_HOME: e.herdrHome });

const tmp = (prefix: string): string => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));

function png(tag: string): string {
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from(tag),
  ]).toString('base64');
}

interface Fixture {
  store: PlanReviewStore;
  home: string;
  env: HerdrEnv;
}

function fixture(): Fixture {
  const home = tmp('apr-forget-home-');
  const userHome = tmp('apr-forget-user-');
  const herdrHome = tmp('apr-forget-herdr-');
  return { store: new PlanReviewStore({ home, port: 4999 }), home, env: { herdrHome, userHome } };
}

/** Record a one-image-per-name plan for a (possibly non-existent) worktree path. */
async function plan(store: PlanReviewStore, cwd: string, imageTags: string[]): Promise<string> {
  const md = '# Plan\n\n' + imageTags.map((t) => `![${t}](image:${t})`).join('\n\n');
  const out = await store.recordPlan({
    cwd,
    origin: 'mcp',
    markdown: md,
    images: imageTags.map((t) => ({ name: t, dataBase64: png(t) })),
  });
  return out.projectKey;
}

function imageFiles(home: string): string[] {
  try {
    return fs.readdirSync(path.join(home, 'images')).sort();
  } catch {
    return [];
  }
}

function writePointer(env: HerdrEnv, terminal: string, projectKey: string): string {
  const file = herdrPointerFile(terminal, procEnv(env));
  assert.ok(file);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // The shape PR 1's HerdrPointer writer produces.
  fs.writeFileSync(
    file,
    JSON.stringify({
      reviewId: 'r',
      projectKey,
      version: 1,
      status: 'pending',
      title: 'Plan',
      cwd: '/x',
      updatedAt: new Date().toISOString(),
    }),
  );
  return file;
}

test('forget removes the worktree project and keeps the others', async () => {
  const { store, env } = fixture();
  const gone = path.join(env.userHome, 'wt', 'feature-a');
  const other = path.join(env.userHome, 'wt', 'feature-b');
  const keyGone = await plan(store, gone, ['one']);
  const keyOther = await plan(store, other, ['two']);
  const reviewsBefore = await store.reviews.list();
  assert.equal(reviewsBefore.length, 2);

  // Trailing slash is normalised; the folder never existed.
  const report = await forgetWorktree(store, gone + '/', false, procEnv(env));

  assert.equal(report.matched, true);
  assert.deepEqual(
    report.projects.map((p) => p.key),
    [keyGone],
  );
  assert.equal(await store.projects.get(keyGone), null);
  assert.ok(await store.projects.get(keyOther));
  assert.equal(fs.existsSync(store.layout.projectDir(keyGone)), false);
  const remaining = await store.reviews.list();
  assert.deepEqual(
    remaining.map((r) => r.projectKey),
    [keyOther],
  );
});

test('forget deletes exclusive images and keeps images another project uses', async () => {
  const { store, home, env } = fixture();
  const a = path.join(env.userHome, 'wt', 'a');
  const b = path.join(env.userHome, 'wt', 'b');
  await plan(store, a, ['shared', 'only-a']);
  await plan(store, b, ['shared', 'only-b']);
  assert.equal(imageFiles(home).length, 3);

  const report = await forgetWorktree(store, a, false, procEnv(env));

  assert.equal(report.images.deleted.length, 1);
  assert.equal(report.images.kept.length, 1);
  const left = imageFiles(home);
  assert.equal(left.length, 2);
  assert.ok(left.includes(report.images.kept[0]));
  assert.ok(!left.includes(report.images.deleted[0]));
});

test('--dry-run reports everything and deletes nothing', async () => {
  const { store, home, env } = fixture();
  const a = path.join(env.userHome, 'wt', 'a');
  const key = await plan(store, a, ['x']);
  const pointer = writePointer(env, 't1', key);

  const report = await forgetWorktree(store, a, true, procEnv(env));

  assert.equal(report.dryRun, true);
  assert.equal(report.projects.length, 1);
  assert.equal(report.images.deleted.length, 1);
  assert.deepEqual(report.pointers, [pointer]);
  assert.match(formatForgetReport(report), /would delete project/);
  assert.ok(await store.projects.get(key));
  assert.equal(imageFiles(home).length, 1);
  assert.equal((await store.reviews.list()).length, 1);
  assert.ok(fs.existsSync(pointer));
});

test('an unknown path says "no plans" and exits 0', async () => {
  const { store, home, env } = fixture();
  const stay = path.join(env.userHome, 'wt', 'stay');
  const key = await plan(store, stay, ['x']);

  const missing = path.join(env.userHome, 'wt', 'never-seen');
  const report = await forgetWorktree(store, missing, false, procEnv(env));
  assert.equal(report.matched, false);
  assert.equal(formatForgetReport(report), `no plans for ${missing}\n`);

  let out = '';
  const code = await runForget(['--worktree', missing], { home, port: 4999 }, { write: (s) => (out += s) }, process.stderr, procEnv(env));
  assert.equal(code, 0);
  assert.match(out, /^no plans for /);
  assert.ok(await store.projects.get(key));
});

test('--json prints machine output', async () => {
  const { store, home, env } = fixture();
  const a = path.join(env.userHome, 'wt', 'a');
  const key = await plan(store, a, ['x']);
  let out = '';
  const code = await runForget(['--worktree', a, '--json', '--dry-run'], { home, port: 4999 }, { write: (s) => (out += s) }, process.stderr, procEnv(env));
  assert.equal(code, 0);
  const parsed = JSON.parse(out) as { matched: boolean; dryRun: boolean; projects: { key: string }[] };
  assert.equal(parsed.matched, true);
  assert.equal(parsed.dryRun, true);
  assert.equal(parsed.projects[0].key, key);
});

test('bad arguments exit 2 with usage', async () => {
  const { home, env } = fixture();
  let err = '';
  const code = await runForget([], { home, port: 4999 }, process.stdout, { write: (s) => (err += s) }, procEnv(env));
  assert.equal(code, 2);
  assert.match(err, /--worktree <path> is required/);
  assert.equal(typeof parseForgetArgs(['--bogus']), 'string');
  assert.deepEqual(parseForgetArgs(['--worktree=/x', '--json']), { worktree: '/x', dryRun: false, json: true });
});

test('forget removes only the pointer files of that project and ignores bad ones', async () => {
  const { store, env } = fixture();
  const a = path.join(env.userHome, 'wt', 'a');
  const b = path.join(env.userHome, 'wt', 'b');
  const keyA = await plan(store, a, ['x']);
  const keyB = await plan(store, b, ['y']);
  const pa = writePointer(env, 't-a', keyA);
  const pb = writePointer(env, 't-b', keyB);
  const dir = path.dirname(pa);
  fs.writeFileSync(path.join(dir, 'broken.json'), '{not json');
  fs.writeFileSync(path.join(dir, 'note.txt'), keyA);

  const report = await forgetWorktree(store, a, false, procEnv(env));

  assert.deepEqual(report.pointers, [pa]);
  assert.equal(fs.existsSync(pa), false);
  assert.ok(fs.existsSync(pb));
  assert.ok(fs.existsSync(path.join(dir, 'broken.json')));
  assert.ok(fs.existsSync(path.join(dir, 'note.txt')));
});

test('a missing pointer folder is fine', async () => {
  const { store, env } = fixture();
  const report = await forgetWorktree(store, path.join(env.userHome, 'x'), false, env);
  assert.equal(report.matched, false);
});

test('key comes from the literal path even when the folder is gone', () => {
  const p = path.join(tmp('apr-forget-key-'), 'wt');
  assert.equal(sanitizeProjectKey(p), sanitizeProjectKey(p + '//'));
});

// ---------------------------------------------------------------------------
// integration switch + roots
// ---------------------------------------------------------------------------

test('the integration follows PR 1 semantics: config.json, with AGENT_PLAN_REVIEW_HERDR=0|1 overriding', () => {
  const home = tmp('apr-forget-cfg-');
  const on = (env: NodeJS.ProcessEnv = {}): boolean => herdrSettings(home, env).enabled;
  assert.equal(on(), false);
  fs.writeFileSync(path.join(home, 'config.json'), '{garbage');
  assert.equal(on(), false);
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ integrations: { herdr: { enabled: true } } }));
  assert.equal(on(), true);
  assert.equal(on({ AGENT_PLAN_REVIEW_HERDR: '0' }), false);
  fs.rmSync(path.join(home, 'config.json'));
  assert.equal(on({ AGENT_PLAN_REVIEW_HERDR: '1' }), true);
  // Not literally 0/1: ignored.
  assert.equal(on({ AGENT_PLAN_REVIEW_HERDR: 'true' }), false);
});

test('roots: default folder plus repo-worktree.json path templates', () => {
  const env: HerdrEnv = { herdrHome: tmp('apr-forget-h-'), userHome: '/Users/me' };
  fs.writeFileSync(
    path.join(env.herdrHome, 'repo-worktree.json'),
    JSON.stringify({
      repos: {
        '~/Desktop/project/website': { strategy: 'command', path: '{repo.parent}/website-{name:slug}' },
        '~/code/api': { path: '{home}/trees/{repo.name}/{name:slug}' },
        '~/code/fixed': { path: '/srv/fixed/place' },
        '~/code/shallow': { path: '/{name}' },
        '~/code/nopath': {},
      },
    }),
  );
  const prefixes = worktreeRoots({ env: procEnv(env), userHome: env.userHome }).map((r) => r.prefix);
  assert.deepEqual(prefixes, [
    '/Users/me/.herdr/worktrees/',
    '/Users/me/Desktop/project/website-',
    '/Users/me/trees/api/',
  ]);
  const roots = worktreeRoots({ env: procEnv(env), userHome: env.userHome });
  assert.equal(insideWorktreeRoot('/Users/me/.herdr/worktrees/repo/feat', roots), true);
  assert.equal(insideWorktreeRoot('/Users/me/Desktop/project/website-feat', roots), true);
  // The main checkout, a sibling that merely shares a name stem, and strangers are outside.
  assert.equal(insideWorktreeRoot('/Users/me/Desktop/project/website', roots), false);
  assert.equal(insideWorktreeRoot('/Users/me/Desktop/other/thing', roots), false);
  assert.equal(insideWorktreeRoot('/Users/me/.herdr/worktrees', roots), false);
  assert.equal(templatePrefix('{name}', '/a/b/c', '/Users/me'), null);
});

test('roots survive a missing or malformed repo-worktree.json', () => {
  const env: HerdrEnv = { herdrHome: tmp('apr-forget-h-'), userHome: '/Users/me' };
  assert.equal(worktreeRoots({ env: procEnv(env), userHome: env.userHome }).length, 1);
  fs.writeFileSync(path.join(env.herdrHome, 'repo-worktree.json'), '[[[');
  assert.equal(worktreeRoots({ env: procEnv(env), userHome: env.userHome }).length, 1);
  fs.writeFileSync(path.join(env.herdrHome, 'repo-worktree.json'), JSON.stringify({ repos: [] }));
  assert.equal(worktreeRoots({ env: procEnv(env), userHome: env.userHome }).length, 1);
});

// ---------------------------------------------------------------------------
// startup sweep
// ---------------------------------------------------------------------------

function enable(home: string): void {
  // what `agent-plan-review herdr enable` does
  setHerdrSettings(home, { enabled: true, openBrowser: false });
}

test('startup sweep removes a missing worktree under a root and keeps the rest', async () => {
  const { store, home, env } = fixture();
  enable(home);
  const root = path.join(env.userHome, '.herdr', 'worktrees');
  fs.mkdirSync(path.join(root, 'repo', 'alive'), { recursive: true });
  const missingInside = path.join(root, 'repo', 'gone');
  const aliveInside = path.join(root, 'repo', 'alive');
  const missingOutside = path.join(env.userHome, 'elsewhere', 'gone');

  const keyGone = await plan(store, missingInside, ['a']);
  const keyAlive = await plan(store, aliveInside, ['b']);
  const keyOutside = await plan(store, missingOutside, ['c']);
  const pointer = writePointer(env, 't', keyGone);

  const lines: string[] = [];
  const removed = await forgetMissingWorktrees(store, { env: procEnv(env), userHome: env.userHome, log: (l) => lines.push(l) });

  assert.deepEqual(removed, [keyGone]);
  assert.equal(await store.projects.get(keyGone), null);
  assert.ok(await store.projects.get(keyAlive));
  assert.ok(await store.projects.get(keyOutside));
  assert.equal(fs.existsSync(pointer), false);
  assert.ok(lines.some((l) => l.includes(missingInside)));
  assert.equal(imageFiles(home).length, 2);
});

test('startup sweep honours repo-worktree.json roots', async () => {
  const { store, home, env } = fixture();
  enable(home);
  const parent = path.join(env.userHome, 'code');
  fs.mkdirSync(path.join(parent, 'website'), { recursive: true });
  fs.writeFileSync(
    path.join(env.herdrHome, 'repo-worktree.json'),
    JSON.stringify({ repos: { [path.join(parent, 'website')]: { path: '{repo.parent}/website-{name:slug}' } } }),
  );
  const keyGone = await plan(store, path.join(parent, 'website-feat'), ['a']);
  const keyMainMissing = await plan(store, path.join(parent, 'website'), ['b']);
  fs.rmSync(path.join(parent, 'website'), { recursive: true });

  const removed = await forgetMissingWorktrees(store, { env: procEnv(env), userHome: env.userHome, log: () => {} });

  // The main checkout itself is never swept, even if its folder vanished.
  assert.deepEqual(removed, [keyGone]);
  assert.ok(await store.projects.get(keyMainMissing));
});

test('startup sweep does nothing when the integration is off', async () => {
  const { store, env } = fixture();
  const missing = path.join(env.userHome, '.herdr', 'worktrees', 'repo', 'gone');
  fs.mkdirSync(path.join(env.userHome, '.herdr', 'worktrees'), { recursive: true });
  const key = await plan(store, missing, ['a']);

  assert.deepEqual(await forgetMissingWorktrees(store, { env: procEnv(env), userHome: env.userHome, log: () => {} }), []);
  assert.ok(await store.projects.get(key));
});

test('startup sweep does nothing when the worktree root itself is missing', async () => {
  const { store, home, env } = fixture();
  enable(home);
  // ~/.herdr/worktrees was never created (or its disk is unmounted).
  const key = await plan(store, path.join(env.userHome, '.herdr', 'worktrees', 'repo', 'gone'), ['a']);
  assert.deepEqual(await forgetMissingWorktrees(store, { env: procEnv(env), userHome: env.userHome, log: () => {} }), []);
  assert.ok(await store.projects.get(key));
});

test('startup sweep: AGENT_PLAN_REVIEW_HERDR=1 enables it, =0 disables it despite config.json', async () => {
  const { store, home, env } = fixture();
  const missing = path.join(env.userHome, '.herdr', 'worktrees', 'repo', 'gone');
  fs.mkdirSync(path.join(env.userHome, '.herdr', 'worktrees'), { recursive: true });
  const key = await plan(store, missing, ['a']);
  const opts = { userHome: env.userHome, log: () => {} };

  // =0 beats an enabled config.json
  enable(home);
  assert.deepEqual(await forgetMissingWorktrees(store, { ...opts, env: { ...procEnv(env), AGENT_PLAN_REVIEW_HERDR: '0' } }), []);
  assert.ok(await store.projects.get(key));

  // =1 works without a config.json
  fs.rmSync(path.join(home, 'config.json'));
  assert.deepEqual(await forgetMissingWorktrees(store, { ...opts, env: { ...procEnv(env), AGENT_PLAN_REVIEW_HERDR: '1' } }), [key]);
});
