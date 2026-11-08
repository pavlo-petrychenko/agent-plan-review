/**
 * Integration settings in <home>/config.json: safe defaults, the env override,
 * the atomic write that keeps unrelated keys, and the `herdr` CLI command.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { appConfigPath, herdrSettings, readAppConfig, setHerdrSettings, writeAppConfig } from './config.js';
import { runHerdrCommand } from './integrations/herdr.js';

const OFF = { enabled: false, openBrowser: false };

function makeHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'apr-config-'));
}

test('a missing config file means every integration is off', () => {
  const home = makeHome();
  assert.deepEqual(readAppConfig(home), {});
  assert.deepEqual(herdrSettings(home, {}), OFF);
});

test('a malformed or non-object config file is ignored, never thrown', () => {
  const home = makeHome();
  for (const raw of ['{not json', '[1,2]', '"text"', 'null', '{"integrations":{"herdr":"yes"}}']) {
    fs.writeFileSync(appConfigPath(home), raw);
    assert.deepEqual(herdrSettings(home, {}), OFF, raw);
  }
});

test('only literal true turns a switch on', () => {
  const home = makeHome();
  fs.writeFileSync(
    appConfigPath(home),
    JSON.stringify({ integrations: { herdr: { enabled: 'true', openBrowser: 1 } } }),
  );
  assert.deepEqual(herdrSettings(home, {}), OFF);
  writeAppConfig(home, { integrations: { herdr: { enabled: true, openBrowser: true } } });
  assert.deepEqual(herdrSettings(home, {}), { enabled: true, openBrowser: true });
});

test('AGENT_PLAN_REVIEW_HERDR=0|1 overrides enabled; other values are ignored', () => {
  const home = makeHome();
  assert.equal(herdrSettings(home, { AGENT_PLAN_REVIEW_HERDR: '1' }).enabled, true);
  setHerdrSettings(home, { enabled: true, openBrowser: false });
  assert.equal(herdrSettings(home, { AGENT_PLAN_REVIEW_HERDR: '0' }).enabled, false);
  assert.equal(herdrSettings(home, { AGENT_PLAN_REVIEW_HERDR: 'yes' }).enabled, true);
  assert.equal(herdrSettings(home, { AGENT_PLAN_REVIEW_HERDR: '' }).enabled, true);
});

test('setHerdrSettings writes atomically and keeps every other key', () => {
  const home = makeHome();
  writeAppConfig(home, { theme: 'dark', integrations: { other: { x: 1 } } });
  setHerdrSettings(home, { enabled: true, openBrowser: false });
  assert.deepEqual(readAppConfig(home), {
    theme: 'dark',
    integrations: { other: { x: 1 }, herdr: { enabled: true, openBrowser: false } },
  });
  assert.deepEqual(
    fs.readdirSync(home).filter((f) => f.endsWith('.tmp')),
    [],
    'no temp file is left behind',
  );
});

test('herdr enable / enable --browser / disable / status', () => {
  const home = makeHome();
  const herdrHome = makeHome();
  const env = { HERDR_APP_HOME: herdrHome };
  const lines: string[] = [];
  const out = (line: string): void => {
    lines.push(line);
  };

  assert.equal(runHerdrCommand(['status'], home, out, env), 0);
  assert.match(lines.join('\n'), /disabled/);
  assert.equal(fs.existsSync(appConfigPath(home)), false, 'status never writes the config');

  assert.equal(runHerdrCommand(['enable'], home, out, env), 0);
  assert.deepEqual(herdrSettings(home, {}), { enabled: true, openBrowser: false });

  lines.length = 0;
  assert.equal(runHerdrCommand(['enable', '--browser'], home, out, env), 0);
  assert.deepEqual(herdrSettings(home, {}), { enabled: true, openBrowser: true });
  assert.ok(lines.some((l) => l.includes(path.join(herdrHome, 'data', 'plan-review'))));

  assert.equal(runHerdrCommand(['disable'], home, out, env), 0);
  assert.deepEqual(herdrSettings(home, {}), OFF);

  assert.equal(runHerdrCommand(['bogus'], home, out, env), 1);
  assert.equal(runHerdrCommand([], home, out, env), 1);
});
