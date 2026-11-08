import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, serverJsonPath } from './config.js';
import { createApiRouter } from './api/router.js';
import { errorHandler } from './api/helpers.js';
import { PlanReviewStore } from './store/store.js';
import { ensureDir } from './util/fs.js';
import { forgetMissingWorktrees } from './integrations/herdr-worktrees.js';

/**
 * Server entrypoint. Binds 127.0.0.1 only (localhost tool), records its
 * port/pid in server.json for the hook/MCP components, and removes the file
 * on SIGINT/SIGTERM.
 */
export function serve(): void {
  const cfg = loadConfig();
  const store = new PlanReviewStore(cfg);
  const app = express();

  app.disable('x-powered-by');
  app.use(express.json({ limit: '12mb' }));

  app.use('/api', createApiRouter(store));
  app.use(errorHandler);

  // Static web assets in production (dist/web built by `npm run build`).
  const webDist = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'web');
  if (fs.existsSync(webDist)) {
    app.use(express.static(webDist));
    // SPA fallback for any non-API GET.
    app.get(/^\/(?!api\/).*/, (_req, res) => {
      res.sendFile(path.join(webDist, 'index.html'));
    });
  }

  const server = app.listen(cfg.port, '127.0.0.1', () => {
    void ensureDir(cfg.home).then(() => {
      fs.writeFileSync(serverJsonPath(cfg), JSON.stringify({ port: cfg.port, pid: process.pid }, null, 2));
    });
    console.log(`plan-review listening on http://localhost:${cfg.port}`);
    // Only the instance that owns the port sweeps (a second one exits on EADDRINUSE).
    void forgetMissingWorktrees(store).catch((err: unknown) => {
      console.error('plan-review: worktree sweep failed:', err);
    });
  });

  // A second instance detecting an occupied port exits 0 quietly.
  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      process.exit(0);
    }
    throw err;
  });

  const cleanup = (): void => {
    try {
      const file = serverJsonPath(cfg);
      const recorded = JSON.parse(fs.readFileSync(file, 'utf8')) as { pid?: number };
      if (recorded.pid === process.pid) fs.rmSync(file, { force: true });
    } catch {
      // ignore
    }
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 500).unref();
  };
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
}
