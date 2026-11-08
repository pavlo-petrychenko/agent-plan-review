// Where the review server is, how to start it, and how often to ask it. Pure: no Herdr imports.
//
// `agent-plan-review herdr install` writes install.json next to this file:
//   { home, port, start: { command, args, cwd } }
// `home` is agent-plan-review's storage root (its server.json says the live port; its images/
// folder holds plan images), `start` runs `serve` in the foreground.

export const DEFAULT_PORT = 4620;

/** install.json's text → { home, port, start } with safe defaults (null fields when unknown). */
export function parseInstall(text) {
  let v = null;
  try { v = JSON.parse(text); } catch {}
  const port = Number(v?.port);
  const start = v?.start && typeof v.start.command === "string" && Array.isArray(v.start.args)
    ? { command: v.start.command, args: v.start.args.map(String), cwd: typeof v.start.cwd === "string" ? v.start.cwd : null }
    : null;
  return {
    home: typeof v?.home === "string" && v.home ? v.home : null,
    port: Number.isInteger(port) && port > 0 ? port : DEFAULT_PORT,
    start,
  };
}

/**
 * The server's base URL. The pointer names the server that wrote it; else the running server's
 * port (agent-plan-review's server.json); else the installed port. Always 127.0.0.1 (the server
 * listens there only; "localhost" may resolve to ::1 first).
 */
export function serverUrl({ pointer = null, install = null, serverJson = null } = {}) {
  if (pointer?.server) return pointer.server.replace("//localhost:", "//127.0.0.1:");
  let port = null;
  try { port = Number(JSON.parse(serverJson ?? "null")?.port); } catch {}
  if (!Number.isInteger(port) || port <= 0) port = install?.port ?? DEFAULT_PORT;
  return `http://127.0.0.1:${port}`;
}

/** The browser page of a review (what the hook would have opened). */
export function reviewPageUrl(base, pointer) {
  const b = String(base).replace("//127.0.0.1:", "//localhost:");
  return `${b}/?project=${encodeURIComponent(pointer.projectKey)}&version=${pointer.version}&review=${encodeURIComponent(pointer.reviewId)}`;
}

const sq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

/**
 * `sh -c` text that starts the server detached and returns at once (exec has a 30 s limit):
 * the storage root and port are passed explicitly, so it is the same server the hooks use, and
 * HERDR_APP_HOME so its pointer files land in this window's folder.
 */
export function startScript(install, appHome) {
  if (!install?.start) return null;
  const env = [];
  if (install.home) env.push(`AGENT_PLAN_REVIEW_HOME=${sq(install.home)}`);
  env.push(`AGENT_PLAN_REVIEW_PORT=${sq(install.port)}`);
  if (appHome) env.push(`HERDR_APP_HOME=${sq(appHome)}`);
  const cmd = [install.start.command, ...install.start.args].map(sq).join(" ");
  const cd = install.start.cwd ? `cd ${sq(install.start.cwd)} && ` : "";
  return `${cd}${env.join(" ")} nohup ${cmd} >/dev/null 2>&1 </dev/null &`;
}

/**
 * How long to wait before the next refresh of a pending review that has been on screen for
 * `elapsedMs` — the web page's schedule (src/web/hooks/reviewPollDelay.ts): responsive while
 * someone watches, then backing off.
 */
export function pollDelay(elapsedMs) {
  if (elapsedMs < 30_000) return 2_500;
  if (elapsedMs < 2 * 60_000) return 5_000;
  if (elapsedMs < 10 * 60_000) return 15_000;
  return 30_000;
}
