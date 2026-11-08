import { spawn } from 'node:child_process';
import { shouldOpenBrowser } from './herdr.js';

/** Open a URL in the default browser. Failures are silently ignored. */
export function openBrowser(url: string): void {
  // Test/CI escape hatch — never pop a browser from an automated run.
  if (process.env.AGENT_PLAN_REVIEW_NO_OPEN?.trim()) return;
  try {
    switch (process.platform) {
      case 'darwin':
        spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
        break;
      case 'win32':
        spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
        break;
      default:
        spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
    }
  } catch {
    // Never fail a review flow because the browser couldn't open.
  }
}

/**
 * Open a review from the hook or MCP server. Identical to `openBrowser` unless
 * the Herdr integration is enabled and the agent runs in a Herdr terminal —
 * then the Herdr mod shows the plan, and the browser opens only when
 * `integrations.herdr.openBrowser` is true.
 */
export function openReview(url: string, opts: { home: string; terminal?: string }): void {
  if (!shouldOpenBrowser(opts.home, opts.terminal)) return;
  openBrowser(url);
}
