/** Shared helpers for hook entry points: stdin parsing + JSON output. */

export function readStdinJson(): Promise<unknown> {
  return new Promise((resolve) => {
    let raw = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      raw += chunk;
    });
    process.stdin.on('end', () => {
      try {
        resolve(raw.trim() ? JSON.parse(raw) : {});
      } catch {
        resolve({});
      }
    });
    // A hook must never hang the session waiting for input that never comes.
    setTimeout(() => resolve({}), 5000).unref?.();
  });
}

/** Emit a hook payload and exit 0 — every path fails open. */
export function finish(payload: unknown): never {
  try {
    process.stdout.write(JSON.stringify(payload ?? {}));
  } catch {
    // ignore
  }
  process.exit(0);
}

export interface PreToolUseInput {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  hook_event_name?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_use_id?: string;
}
