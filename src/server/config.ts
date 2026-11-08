import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const APP_NAME = 'agent-plan-review';
/** Keep in sync with package.json version. */
export const APP_VERSION = '1.0.0';
export const DEFAULT_PORT = 4620;
/** Reviews resolved longer than this are pruned. */
export const RESOLVED_TTL_MS = 7 * 24 * 3600 * 1000;

export interface ServerConfig {
  /** Storage root (~/.claude/plan-review unless PLAN_REVIEW_HOME is set). */
  home: string;
  port: number;
}

export function loadConfig(): ServerConfig {
  // AGENT_PLAN_REVIEW_* is canonical; legacy PLAN_REVIEW_* vars still honored.
  const env = (name: string): string | undefined =>
    process.env[`AGENT_PLAN_REVIEW_${name}`]?.trim() || process.env[`PLAN_REVIEW_${name}`]?.trim();
  const home = env('HOME') || path.join(os.homedir(), '.agent-plan-review');
  const port = Number.parseInt(env('PORT') ?? '', 10) || DEFAULT_PORT;
  return { home, port };
}

/** Hard timeout (seconds) for blocking hook waits. */
export function reviewTimeoutSeconds(): number {
  const raw = process.env.AGENT_PLAN_REVIEW_TIMEOUT?.trim() || process.env.PLAN_REVIEW_TIMEOUT?.trim();
  return Number.parseInt(raw ?? '', 10) || 1800;
}

/**
 * Upper bound (seconds) for plan_review_check long-polls. One long call is the
 * intended wait strategy — agents should request the full ceiling and let the
 * long-poll return early the moment the human decides.
 */
export function maxCheckWaitSeconds(): number {
  const raw = process.env.AGENT_PLAN_REVIEW_MAX_WAIT?.trim() || process.env.PLAN_REVIEW_MAX_WAIT?.trim();
  return Number.parseInt(raw ?? '', 10) || 172800;
}

/** Interval (ms) between keepalive progress notifications during a check poll. */
export function checkProgressIntervalMs(): number {
  const raw = process.env.AGENT_PLAN_REVIEW_PROGRESS_MS?.trim();
  return Math.max(Number.parseInt(raw ?? '', 10) || 20000, 250);
}

export function serverJsonPath(cfg: ServerConfig): string {
  return path.join(cfg.home, 'server.json');
}

// ---------------------------------------------------------------------------
// Integration settings (<home>/config.json)
// ---------------------------------------------------------------------------

/** Herdr integration switches. Off unless config.json (or the env) turns it on. */
export interface HerdrSettings {
  /** Write pointer files for the Herdr mod and skip the browser for Herdr terminals. */
  enabled: boolean;
  /** With Herdr enabled, still open the browser for reviews from a Herdr terminal. */
  openBrowser: boolean;
}

export interface AppConfigFile {
  integrations?: {
    herdr?: Partial<HerdrSettings>;
    [name: string]: unknown;
  };
  [key: string]: unknown;
}

export function appConfigPath(home: string): string {
  return path.join(home, 'config.json');
}

/**
 * Read <home>/config.json. A missing, unreadable or malformed file is an empty
 * config — fail open, every integration stays off.
 */
export function readAppConfig(home: string): AppConfigFile {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(appConfigPath(home), 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as AppConfigFile) : {};
  } catch {
    return {};
  }
}

/** Write <home>/config.json atomically (temp file + rename). */
export function writeAppConfig(home: string, config: AppConfigFile): void {
  const file = appConfigPath(home);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

/**
 * Effective Herdr settings: config.json, with AGENT_PLAN_REVIEW_HERDR=0|1
 * overriding `enabled`. Anything that is not literally `true` counts as off.
 */
export function herdrSettings(home: string, env: NodeJS.ProcessEnv = process.env): HerdrSettings {
  const raw = readAppConfig(home).integrations?.herdr;
  const herdr: Partial<HerdrSettings> = raw && typeof raw === 'object' ? raw : {};
  let enabled = herdr.enabled === true;
  const override = env.AGENT_PLAN_REVIEW_HERDR?.trim();
  if (override === '1') enabled = true;
  else if (override === '0') enabled = false;
  return { enabled, openBrowser: herdr.openBrowser === true };
}

/** Persist Herdr settings, keeping every other key of config.json. */
export function setHerdrSettings(home: string, settings: HerdrSettings): void {
  const config = readAppConfig(home);
  const integrations =
    config.integrations && typeof config.integrations === 'object' ? config.integrations : {};
  writeAppConfig(home, { ...config, integrations: { ...integrations, herdr: settings } });
}
