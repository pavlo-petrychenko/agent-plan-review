/**
 * GitHub Gist storage channel.
 *
 * Auth is delegated wholly to the installed `gh` CLI — no tokens are ever
 * stored or passed around by this app. Readiness = installed ∧ authed ∧
 * token carries the classic `gist` scope.
 */

import { execFile } from 'node:child_process';
import type { ChannelInfo, GistBinding } from '../../shared/types.js';

const GH_INSTALL_URL = 'https://cli.github.com/';

function gh(args: string[], input?: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = execFile('gh', args, { maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({
        code: err && typeof (err as { code?: number }).code === 'number' ? (err as { code: number }).code : err ? 1 : 0,
        stdout: String(stdout),
        stderr: String(stderr),
      });
    });
    if (input !== undefined) {
      child.stdin?.end(input);
    }
  });
}

/** Probe the gh CLI and report readiness with precise remediation info. */
export async function gistReadiness(): Promise<ChannelInfo> {
  const base: ChannelInfo = { id: 'gist', label: 'GitHub Gist', ready: false };

  const version = await gh(['--version']);
  if (!version.stdout) {
    return {
      ...base,
      installed: false,
      reason: 'The GitHub CLI (gh) is not installed.',
      fixUrl: GH_INSTALL_URL,
    };
  }

  const whoami = await gh(['api', '-i', '/user']);
  if (whoami.code !== 0) {
    const needsScopeRefresh = /auth.*refresh|token/i.test(whoami.stderr);
    return {
      ...base,
      installed: true,
      authed: false,
      reason: needsScopeRefresh
        ? 'gh authentication is missing or expired.'
        : 'gh is not authenticated with GitHub.',
      fixCommand: 'gh auth login',
    };
  }

  const scopesLine = whoami.stdout
    .split('\n')
    .find((l) => l.toLowerCase().startsWith('x-oauth-scopes:'));
  const scopes = scopesLine
    ?.slice(scopesLine.indexOf(':') + 1)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean) ?? [];

  if (!scopes.includes('gist')) {
    return {
      ...base,
      installed: true,
      authed: true,
      hasGistScope: false,
      reason: 'Your gh token is missing the "gist" scope.',
      fixCommand: 'gh auth refresh -s gist',
    };
  }

  return { ...base, installed: true, authed: true, hasGistScope: true, ready: true };
}

interface GistApiResponse {
  id: string;
  html_url: string;
  description?: string;
  files: Record<string, unknown>;
}

export class GistError extends Error {
  readonly fixCommand?: string;
  constructor(message: string, fixCommand?: string) {
    super(message);
    this.name = 'GistError';
    this.fixCommand = fixCommand;
  }
}

async function apiJson(args: string[], input?: string): Promise<GistApiResponse> {
  const res = await gh(['api', ...args], input);
  if (res.code !== 0) {
    const stderr = res.stderr.trim() || 'gh api failed';
    // Diagnose scope problems accurately — only blame scope when truly absent.
    if (/403/.test(stderr) || /Must have admin rights|Not Found.*scope/i.test(stderr)) {
      const readiness = await gistReadiness();
      if (readiness.hasGistScope === false) {
        throw new GistError('GitHub rejected the request: token lacks the gist scope.', readiness.fixCommand);
      }
    }
    throw new GistError(stderr);
  }
  return JSON.parse(res.stdout) as GistApiResponse;
}

function gistBody(description: string, filename: string, content: string): string {
  return JSON.stringify({
    description,
    public: false,
    files: { [filename]: { content } },
  });
}

/**
 * Save markdown to the project's single gist destination. Existing binding ⇒
 * update in place (renaming the file when it changed); a gist deleted
 * upstream (404) is transparently recreated and re-bound.
 */
export async function saveGist(
  binding: GistBinding | undefined,
  opts: { description: string; filename: string; content: string },
): Promise<{ binding: GistBinding; created: boolean }> {
  const { description, filename, content } = opts;

  if (binding) {
    try {
      // Rename + update content in one patch when the filename changed.
      const files =
        binding.filename && binding.filename !== filename
          ? { [binding.filename]: null, [filename]: { content } }
          : { [filename]: { content } };
      const updated = await apiJson(
        ['--method', 'PATCH', `/gists/${binding.id}`, '--input', '-'],
        JSON.stringify({ description, files }),
      );
      return { binding: toBinding(updated, filename, description, binding.savedVersion), created: false };
    } catch (err) {
      // Gist deleted upstream → transparently recreate below.
      if (!(err instanceof GistError && /\b404\b|Not Found/i.test(err.message))) throw err;
    }
  }

  const created = await apiJson(
    ['--method', 'POST', '/gists', '--input', '-'],
    gistBody(description, filename, content),
  );
  return { binding: toBinding(created, filename, description), created: true };
}

function toBinding(res: GistApiResponse, filename: string, description: string, savedVersion?: number): GistBinding {
  return {
    id: res.id,
    htmlUrl: res.html_url,
    filename,
    description,
    savedVersion: savedVersion ?? 0,
    savedAt: new Date().toISOString(),
  };
}
