/**
 * Herdr integration (opt-in).
 *
 * Herdr is a terminal/agent desktop app; every process it starts carries
 * HC_TERMINAL_ID. This module does three small things:
 *
 *   - `agentFromEnv` captures that terminal id so a review knows which terminal
 *     submitted it (always recorded — it is harmless metadata);
 *   - `syncHerdrPointers` writes `<herdrHome>/data/plan-review/<terminal>.json`
 *     so a Herdr mod can find the terminal's current review without polling the
 *     HTTP API — ONLY when the integration is enabled;
 *   - `shouldOpenBrowser` lets the Herdr mod replace the browser tab for agents
 *     running inside Herdr — again only when enabled.
 *
 * With the integration disabled (the default) nothing here touches the disk
 * beyond reading <home>/config.json, and the browser opens exactly as before.
 * Every function fails open: a pointer that cannot be written is logged and
 * skipped, never a failed store operation.
 */

import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { DEFAULT_PORT, appConfigPath, herdrSettings, setHerdrSettings, type ServerConfig } from '../config.js';
import { installHerdrMod, modTarget, uninstallHerdrMod, type StartCommand } from './herdr-install.js';
import type { Review, ReviewAgent } from '../../shared/types.js';
import type { ReviewStore } from '../store/reviews.js';
import type { VersionStore } from '../store/versions.js';
import { extractRootTitle } from '../store/record.js';
import { writeJson } from '../util/fs.js';

/** What the Herdr mod reads for a terminal. */
export interface HerdrPointer {
  reviewId: string;
  projectKey: string;
  version: number;
  status: Review['status'];
  /** Root page title of the reviewed version. */
  title: string;
  cwd: string;
  updatedAt: string;
  /**
   * Base URL of the review server that owns this review (`http://127.0.0.1:<port>`),
   * so the mod talks to the right instance (an isolated store on another port too).
   */
  server: string;
}

/** Which reviews a store mutation may have changed. */
export type HerdrScope = { reviewId: string } | { projectKey: string; version: number };

interface PointerDeps {
  config: ServerConfig;
  reviews: ReviewStore;
  versions: VersionStore;
}

/** Terminal ids become file names, so only accept a conservative alphabet. */
const TERMINAL_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** The agent's terminal from HC_TERMINAL_ID, or undefined outside Herdr. */
export function agentFromEnv(
  harness?: string,
  env: NodeJS.ProcessEnv = process.env,
): ReviewAgent | undefined {
  const terminal = env.HC_TERMINAL_ID?.trim();
  if (!terminal) return undefined;
  const name = harness?.trim();
  return name ? { terminal, harness: name } : { terminal };
}

/** Herdr's data root: HERDR_APP_HOME or ~/.config/herdr-app. */
export function herdrHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.HERDR_APP_HOME?.trim() || path.join(os.homedir(), '.config', 'herdr-app');
}

/** Folder that holds the pointer files. */
export function herdrPointerDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(herdrHome(env), 'data', 'plan-review');
}

/** Pointer file for a terminal, or null when the id is not a safe file name. */
export function herdrPointerFile(terminal: string, env: NodeJS.ProcessEnv = process.env): string | null {
  if (!TERMINAL_RE.test(terminal)) return null;
  return path.join(herdrPointerDir(env), `${terminal}.json`);
}

/**
 * Browser decision for a review opened by the hook or MCP server. Unchanged
 * (open) unless Herdr is enabled AND the agent runs in a Herdr terminal; then
 * the Herdr mod shows the plan and the browser opens only with openBrowser.
 */
export function shouldOpenBrowser(
  home: string,
  terminal: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (!terminal) return true;
  const settings = herdrSettings(home, env);
  if (!settings.enabled) return true;
  return settings.openBrowser;
}

/**
 * Refresh the pointer file of every Herdr terminal linked to the reviews in
 * `scope`. Each terminal's pointer names its NEWEST review, so an event on an
 * older review never points the mod backwards. Never throws.
 */
export async function syncHerdrPointers(
  deps: PointerDeps,
  scope: HerdrScope,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  try {
    if (!herdrSettings(deps.config.home, env).enabled) return;

    const touched =
      'reviewId' in scope
        ? [await deps.reviews.get(scope.reviewId)].filter((r): r is Review => r != null)
        : await deps.reviews.list({ projectKey: scope.projectKey, version: scope.version });
    const terminals = new Set(touched.map((r) => r.agent?.terminal).filter((t): t is string => !!t));

    for (const terminal of terminals) {
      try {
        const file = herdrPointerFile(terminal, env);
        if (!file) continue;
        const [newest] = await deps.reviews.list({ terminal });
        if (!newest) continue;
        await writeJson(file, await buildPointer(deps.versions, newest, deps.config.port));
      } catch (err) {
        console.error(`[plan-review herdr] pointer write failed for terminal ${terminal}:`, err);
      }
    }
  } catch (err) {
    console.error('[plan-review herdr] pointer sync failed:', err);
  }
}

const HERDR_USAGE =
  'Usage: agent-plan-review herdr <enable [--browser] | disable | status | install [--link] | uninstall>';

/**
 * `agent-plan-review herdr <enable [--browser] | disable | status | install | uninstall>`.
 * Returns the process exit code; output goes through `out`.
 */
export function runHerdrCommand(
  args: string[],
  home: string,
  out: (line: string) => void,
  env: NodeJS.ProcessEnv = process.env,
  opts: { port?: number; source?: string; start?: StartCommand } = {},
): number {
  const [sub, ...flags] = args;
  if (sub === 'install') {
    try {
      const r = installHerdrMod({
        herdrHome: herdrHome(env),
        home,
        port: opts.port ?? DEFAULT_PORT,
        source: opts.source,
        start: opts.start,
        link: flags.includes('--link'),
      });
      out(
        r.mode === 'link'
          ? `Linked the plan-review mod: ${r.target} (Herdr shows no icons through a symlink; use a copy for real use)`
          : `Installed the plan-review mod: ${r.target} (${r.copied} file${r.copied === 1 ? '' : 's'} updated${r.removed ? `, ${r.removed} removed` : ''})`,
      );
      if (!herdrSettings(home, env).enabled) {
        out('The Herdr integration is off: run `agent-plan-review herdr enable` so plans reach the mod.');
      }
      return 0;
    } catch (err) {
      out(`Install failed: ${err instanceof Error ? err.message : String(err)}`);
      return 1;
    }
  }
  if (sub === 'uninstall') {
    try {
      out(uninstallHerdrMod(herdrHome(env)) ? `Removed ${modTarget(herdrHome(env))}` : 'The plan-review mod is not installed.');
      return 0;
    } catch (err) {
      out(`Uninstall failed: ${err instanceof Error ? err.message : String(err)}`);
      return 1;
    }
  }
  if (sub === 'enable') {
    setHerdrSettings(home, { enabled: true, openBrowser: flags.includes('--browser') });
  } else if (sub === 'disable') {
    setHerdrSettings(home, { enabled: false, openBrowser: false });
  } else if (sub !== 'status') {
    out(HERDR_USAGE);
    return 1;
  }
  const effective = herdrSettings(home, env);
  out(`Herdr integration: ${effective.enabled ? 'enabled' : 'disabled'}`);
  out(`  browser for Herdr terminals: ${effective.enabled && !effective.openBrowser ? 'skipped' : 'opened'}`);
  out(`  config: ${appConfigPath(home)}`);
  out(`  pointer files: ${herdrPointerDir(env)}`);
  const mod = modTarget(herdrHome(env));
  out(`  mod: ${fs.existsSync(mod) ? mod : 'not installed (agent-plan-review herdr install)'}`);
  const override = env.AGENT_PLAN_REVIEW_HERDR?.trim();
  if (override === '0' || override === '1')
    out(`  (AGENT_PLAN_REVIEW_HERDR=${override} overrides the config file)`);
  return 0;
}

async function buildPointer(versions: VersionStore, review: Review, port: number): Promise<HerdrPointer> {
  return {
    reviewId: review.id,
    projectKey: review.projectKey,
    version: review.version,
    status: review.status,
    title: await rootTitle(versions, review.projectKey, review.version),
    cwd: review.cwd,
    updatedAt: new Date().toISOString(),
    server: `http://127.0.0.1:${port}`,
  };
}

async function rootTitle(versions: VersionStore, key: string, n: number): Promise<string> {
  const manifest = await versions.readManifest(key, n);
  if (manifest) return manifest.docs.find((d) => d.slug === manifest.root)?.title ?? 'Plan';
  return extractRootTitle((await versions.readMarkdown(key, n)) ?? '');
}
