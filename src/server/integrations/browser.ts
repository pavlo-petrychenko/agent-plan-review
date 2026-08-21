import { spawn } from 'node:child_process';

/** Open a URL in the default browser. Failures are silently ignored. */
export function openBrowser(url: string): void {
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
