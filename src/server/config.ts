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
 * intended wait strategy — agents should request ~3600 and let the long-poll
 * return early the moment the human decides.
 */
export function maxCheckWaitSeconds(): number {
  const raw = process.env.AGENT_PLAN_REVIEW_MAX_WAIT?.trim() || process.env.PLAN_REVIEW_MAX_WAIT?.trim();
  return Number.parseInt(raw ?? '', 10) || 3600;
}

/** Interval (ms) between keepalive progress notifications during a check poll. */
export function checkProgressIntervalMs(): number {
  const raw = process.env.AGENT_PLAN_REVIEW_PROGRESS_MS?.trim();
  return Math.max(Number.parseInt(raw ?? '', 10) || 20000, 250);
}

export function serverJsonPath(cfg: ServerConfig): string {
  return path.join(cfg.home, 'server.json');
}
