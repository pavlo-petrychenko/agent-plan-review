import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ProjectSummary } from '../../../shared/types.js';
import { LEGACY_TITLE, entryLabel, findEntry, groupProjects, pathHint, worktreeName } from './projectGroups.js';

const project = (key: string, cwd: string, extra: Partial<ProjectSummary> = {}): ProjectSummary => ({
  key,
  name: worktreeName(cwd),
  cwd,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  currentVersion: 1,
  storage: {},
  pending: 0,
  versionCount: 1,
  ...extra,
});

test('worktree name and path hint come from the cwd', () => {
  assert.equal(worktreeName('/Users/me/Documents/personal/repo/'), 'repo');
  assert.equal(pathHint('/Users/me/Documents/personal/repo'), '…/Documents/personal');
  assert.equal(pathHint('/work/repo'), '/work');
  assert.equal(pathHint('/repo'), '');
});

test('projects of one worktree share a group, in first-seen order; plans keep id, title and terminal', () => {
  const groups = groupProjects([
    project('a.p-111111', '/w/a', { plan: { id: 'p-111111', title: 'Plan one' }, lastTerminal: 't5d', pending: 1 }),
    project('b-bbbbbbbb', '/w/b'),
    project('a-aaaaaaaa', '/w/a'),
    project('a.p-222222', '/w/a/', { plan: { id: 'p-222222', title: 'Plan two' } }),
  ]);
  assert.deepEqual(
    groups.map((g) => [g.name, g.entries.length]),
    [
      ['a', 3],
      ['b', 1],
    ],
  );
  const [first, legacy, second] = groups[0].entries;
  assert.deepEqual(first, { key: 'a.p-111111', title: 'Plan one', planId: 'p-111111', terminal: 't5d', pending: 1 });
  assert.equal(legacy.title, LEGACY_TITLE);
  assert.equal(legacy.planId, null);
  assert.equal(second.terminal, null);
});

test('a worktree with one project reads as before; with several, the title leads', () => {
  const [single, many] = groupProjects([
    project('s-11111111', '/w/solo'),
    project('m.p-111111', '/w/many', { plan: { id: 'p-111111', title: 'Plan one' } }),
    project('m.p-222222', '/w/many', { plan: { id: 'p-222222', title: 'Plan two' } }),
  ]);
  assert.deepEqual(entryLabel(single, single.entries[0]), { primary: 'solo', secondary: null });
  assert.deepEqual(entryLabel(many, many.entries[1]), { primary: 'Plan two', secondary: null });

  const [lone] = groupProjects([project('l.p-111111', '/w/lone', { plan: { id: 'p-111111', title: 'Only plan' } })]);
  assert.deepEqual(entryLabel(lone, lone.entries[0]), { primary: 'lone', secondary: 'Only plan' });
});

test('findEntry locates a key, or nothing', () => {
  const groups = groupProjects([project('x-11111111', '/w/x'), project('y-22222222', '/w/y')]);
  assert.equal(findEntry(groups, 'y-22222222')?.group.name, 'y');
  assert.equal(findEntry(groups, 'nope'), null);
  assert.equal(findEntry(groups, null), null);
});
