import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { ApiError, PlanValidationError } from '../util/errors.js';

/** Wrap an async handler so rejections reach the error middleware. */
export function wrap(handler: (req: Request, res: Response) => Promise<void>): RequestHandler {
  return (req, res, next: NextFunction) => {
    handler(req, res).catch(next);
  };
}

export function parseVersionParam(raw: string): number {
  const n = Number.parseInt(raw, 10);
  if (!Number.isInteger(n) || n <= 0) {
    throw new ApiError(400, { error: 'Invalid version number' });
  }
  return n;
}

export function forceFlag(req: Request): boolean {
  return req.query.force === '1' || req.query.force === 'true';
}

export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction): void {
  if (err instanceof PlanValidationError) {
    res.status(400).json({ error: 'Invalid plan', issues: err.issues });
    return;
  }
  if (err instanceof ApiError) {
    res.status(err.status).json(err.payload);
    return;
  }
  const message = err instanceof Error ? err.message : String(err);
  console.error('[plan-review] unhandled error:', err);
  res.status(500).json({ error: message });
}
