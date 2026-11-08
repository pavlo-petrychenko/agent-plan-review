/**
 * `herdr install | uninstall`: the plan-review mod is copied into Herdr (not
 * symlinked — Herdr loads no icons through a symlinked mod folder), updated in
 * place on a re-install, and never written over a folder that is not ours.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { installHerdrMod, modSourceDir, modTarget, serveCommand, uninstallHerdrMod } from './herdr-install.js';
import { runHerdrCommand } from './herdr.js';

function tmp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

const START = { command: '/usr/bin/node', args: ['/apr/dist/server/cli.js', 'serve'], cwd: '/apr' };

function fakeSource(): string {
  const dir = tmp('apr-mod-src-');
  fs.writeFileSync(path.join(dir, 'main.js'), 'export default 1;\n');
  fs.writeFileSync(path.join(dir, 'mod.json'), '{ "place": "none", "title": "Plan review" }\n');
  fs.mkdirSync(path.join(dir, 'icons'));
  fs.writeFileSync(path.join(dir, 'icons', 'a.svg'), '<svg/>');
  fs.mkdirSync(path.join(dir, 'test'));
  fs.writeFileSync(path.join(dir, 'test', 'x.test.mjs'), '');
  fs.writeFileSync(path.join(dir, 'README.md'), '# dev notes');
  return dir;
}

test('install copies the real mod (no tests, no dev files) and writes install.json', () => {
  const herdrHome = tmp('apr-herdr-');
  const r = installHerdrMod({ herdrHome, home: '/apr-home', port: 4621, start: START });
  const target = modTarget(herdrHome);
  assert.equal(r.mode, 'copy');
  assert.equal(r.target, target);
  assert.equal(fs.lstatSync(target).isSymbolicLink(), false);
  for (const f of ['main.js', 'api.js', 'threads.js', 'pointer.js', 'server.js', 'mod.json', 'icons/globe.svg']) {
    assert.ok(fs.existsSync(path.join(target, f)), f);
  }
  assert.equal(fs.existsSync(path.join(target, 'test')), false);
  const info = JSON.parse(fs.readFileSync(path.join(target, 'install.json'), 'utf8'));
  assert.deepEqual({ ...info, installedAt: undefined }, { home: '/apr-home', port: 4621, start: START, installedAt: undefined });
  assert.ok(fs.existsSync(path.join(modSourceDir(), 'main.js')));
});

test('re-install updates in place, removes stale files, keeps what Herdr wrote', () => {
  const herdrHome = tmp('apr-herdr-');
  const source = fakeSource();
  installHerdrMod({ herdrHome, source, home: '/h', port: 4620, start: START });
  const target = modTarget(herdrHome);
  fs.writeFileSync(path.join(target, 'jsconfig.json'), '{}');
  fs.writeFileSync(path.join(target, 'old.js'), 'gone soon');
  fs.writeFileSync(path.join(source, 'main.js'), 'export default 2;\n');

  const r = installHerdrMod({ herdrHome, source, home: '/h', port: 4620, start: START });
  assert.deepEqual([r.copied, r.removed], [1, 1]);
  assert.equal(fs.readFileSync(path.join(target, 'main.js'), 'utf8'), 'export default 2;\n');
  assert.equal(fs.existsSync(path.join(target, 'old.js')), false);
  assert.equal(fs.existsSync(path.join(target, 'jsconfig.json')), true);
  assert.equal(fs.existsSync(path.join(target, 'README.md')), false);
  assert.deepEqual(fs.readdirSync(target).filter((f) => f.startsWith('.')), [], 'no temp files left');
});

test('install replaces an earlier symlink with a copy; --link makes a symlink', () => {
  const herdrHome = tmp('apr-herdr-');
  const source = fakeSource();
  const linked = installHerdrMod({ herdrHome, source, home: '/h', port: 4620, start: START, link: true });
  assert.equal(linked.mode, 'link');
  assert.equal(fs.lstatSync(modTarget(herdrHome)).isSymbolicLink(), true);
  assert.ok(fs.existsSync(path.join(source, 'install.json')));
  installHerdrMod({ herdrHome, source, home: '/h', port: 4620, start: START });
  assert.equal(fs.lstatSync(modTarget(herdrHome)).isSymbolicLink(), false);
  assert.ok(fs.existsSync(path.join(modTarget(herdrHome), 'icons', 'a.svg')));
});

test('a folder that is not the plan-review mod is never overwritten or removed', () => {
  const herdrHome = tmp('apr-herdr-');
  const target = modTarget(herdrHome);
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(target, 'main.js'), 'someone else');
  assert.throws(() => installHerdrMod({ herdrHome, source: fakeSource(), home: '/h', port: 1, start: START }), /not the plan-review mod/);
  assert.throws(() => uninstallHerdrMod(herdrHome), /not the plan-review mod/);
  assert.equal(fs.readFileSync(path.join(target, 'main.js'), 'utf8'), 'someone else');
});

test('uninstall removes a copy or a link; nothing installed is not an error', () => {
  const herdrHome = tmp('apr-herdr-');
  assert.equal(uninstallHerdrMod(herdrHome), false);
  installHerdrMod({ herdrHome, source: fakeSource(), home: '/h', port: 1, start: START });
  assert.equal(uninstallHerdrMod(herdrHome), true);
  assert.equal(fs.existsSync(modTarget(herdrHome)), false);
});

test('herdr install / uninstall through the CLI command; the default start command runs serve', () => {
  const herdrHome = tmp('apr-herdr-');
  const home = tmp('apr-home-');
  const lines: string[] = [];
  const env = { HERDR_APP_HOME: herdrHome };
  assert.equal(runHerdrCommand(['install'], home, (l) => lines.push(l), env, { port: 4633, source: fakeSource() }), 0);
  assert.match(lines[0], /Installed the plan-review mod/);
  assert.match(lines[1], /herdr enable/);
  const info = JSON.parse(fs.readFileSync(path.join(modTarget(herdrHome), 'install.json'), 'utf8'));
  assert.equal(info.port, 4633);
  assert.equal(info.home, home);
  assert.equal(info.start.args.at(-1), 'serve');
  assert.equal(runHerdrCommand(['uninstall'], home, (l) => lines.push(l), env), 0);
  assert.equal(fs.existsSync(modTarget(herdrHome)), false);
  assert.equal(runHerdrCommand(['bogus'], home, (l) => lines.push(l), env), 1);
  assert.deepEqual(serveCommand().args.at(-1), 'serve');
});
