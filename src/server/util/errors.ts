/** Typed errors that map cleanly onto HTTP responses and hook outputs. */

import type { PlanIssue } from '../../shared/types.js';

export class PlanValidationError extends Error {
  readonly issues: PlanIssue[];
  constructor(issues: PlanIssue[]) {
    super(`Plan validation failed with ${issues.length} issue(s)`);
    this.name = 'PlanValidationError';
    this.issues = issues;
  }
}

/**
 * The submission named a plan (planId) that cannot be used from this worktree.
 * A PlanValidationError, so every integration reports it the way it reports a
 * malformed plan: "NOT recorded" plus the message, which lists the plans the
 * agent can pick instead.
 */
export class PlanSelectionError extends PlanValidationError {
  constructor(message: string) {
    super([{ message }]);
    this.name = 'PlanSelectionError';
    this.message = message;
  }
}

export class ApiError extends Error {
  readonly status: number;
  readonly payload: Record<string, unknown>;
  constructor(status: number, payload: Record<string, unknown>, message?: string) {
    super(message ?? String(payload.error ?? 'error'));
    this.name = 'ApiError';
    this.status = status;
    this.payload = payload;
  }
}

export function notFound(what: string): ApiError {
  return new ApiError(404, { error: `${what} not found` });
}

export function conflict(payload: Record<string, unknown>): ApiError {
  return new ApiError(409, payload);
}

export function badRequest(error: string): ApiError {
  return new ApiError(400, { error });
}
