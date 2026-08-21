import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { accessSync } from 'node:fs';
import { loadConfig, serverJsonPath } from '../config.js';
import { readJson } from '../util/fs.js';

interface ServerJson {
  port: number;
  pid: number;
}

interface HealthInfo {
  ok: boolean;
  home?: string;
}

/** Healthy AND sharing our storage root (never reuse a foreign instance). */
async function isHealthy(port: number, expectedHome: string): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(700) });
    if (!res.ok) return false;
    const info = (await res.json()) as HealthInfo;
    return info.ok === true && info.home === expectedHome;
  } catch {
    return false;
  }
}

export class ServerStartError extends Error {}

/**
 * Ensure the review server is running; start it detached when necessary.
 * Returns the port to talk to. Throws only if the server never became
 * healthy — callers fail open in that case.
 */
export async function ensureServerRunning(): Promise<number> {
  const cfg = loadConfig();

  const recorded = await readJson<ServerJson>(serverJsonPath(cfg));
  if (recorded && (await isHealthy(recorded.port, cfg.home))) {
    return recorded.port;
  }

  spawnDetachedServe(cfg.port);
  for (let i = 0; i < 100; i++) {
    await sleep(100);
    if (await isHealthy(cfg.port, cfg.home)) return cfg.port;
  }

  // Distinguish "foreign instance owns the port" from "nothing started".
  try {
    const res = await fetch(`http://127.0.0.1:${cfg.port}/api/health`, { signal: AbortSignal.timeout(700) });
    if (res.ok) {
      const info = (await res.json()) as HealthInfo;
      if (info.ok === true && info.home !== cfg.home) {
        throw new ServerStartError(
          `Port ${cfg.port} is occupied by a different agent-plan-review instance ` +
            `(its storage root is ${info.home}, this process uses ${cfg.home}). ` +
            'Set AGENT_PLAN_REVIEW_PORT or stop the other instance.',
        );
      }
    }
  } catch (err) {
    if (err instanceof ServerStartError) throw err;
  }
  throw new ServerStartError(`agent-plan-review server did not become healthy on port ${cfg.port}`);
}

function cliEntryPath(): string {
  // Built: dist/server/integrations/spawn-server.js → dist/server/cli.js
  // Dev:   src/server/integrations/spawn-server.ts → src/server/cli.ts (tsx)
  const here = import.meta.url;
  const built = fileURLToPath(new URL('../cli.js', here));
  try {
    accessSync(built);
    return built;
  } catch {
    return fileURLToPath(new URL('../cli.ts', here));
  }
}

function spawnDetachedServe(port: number): void {
  const entry = cliEntryPath();
  const isTs = entry.endsWith('.ts');
  const command = isTs ? 'npx' : process.execPath;
  const args = isTs ? ['tsx', entry, 'serve'] : [entry, 'serve'];
  try {
    const child = spawn(command, args, {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, AGENT_PLAN_REVIEW_PORT: String(port) },
      cwd: path.dirname(entry),
    });
    child.unref();
  } catch {
    // The health probe below will surface the failure; hooks fail open.
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
