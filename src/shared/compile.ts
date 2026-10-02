/**
 * Feedback compiler — the pure logic that turns stored comments into the
 * text an agent actually receives. This drives agent behavior; treat as spec.
 *
 *  - reject: per-document sections in reading order, line comments sorted by
 *    line with `[lines X-Y] "snippet" → body` formatting, then general
 *    comments. Always ends with an instruction to re-present.
 *  - ask: targeted human questions on a still-pending review, grouped into
 *    threads so the agent can answer each one by id. Ends by handing the plan
 *    back for a decision.
 *  - approve: notes only when comments exist ("approved with comments").
 *  - issues: compiled validation failures for deny reasons.
 */

import type { Comment, PlanIssue } from './types.js';
import type { Manifest } from './types.js';
import { actionableMessage, groupThreads, isOpenThread } from './threads.js';

export interface LineSliceResolver {
  /**
   * Return the raw text of lines [line, lineEnd] (1-based, inclusive) or null.
   * `baseVersion` selects the base-version text for old-side (removed-line)
   * anchors; absent means the reviewed version.
   */
  (doc: string, line: number, lineEnd: number, baseVersion?: number): string | null;
}

function docTitle(manifest: Manifest | undefined, slug: string): string {
  const doc = manifest?.docs.find((d) => d.slug === slug);
  return doc?.title || slug;
}

/** Single-doc plans (no manifest) get a plain header; trees get doc titles. */
function sectionHeader(manifest: Manifest | undefined, slug: string, fallback = 'Comments'): string {
  if (!manifest) return `## ${fallback}`;
  return `## Document: ${docTitle(manifest, slug)}`;
}

function orderedDocs(comments: Comment[], manifest: Manifest | undefined): string[] {
  const order = manifest?.docs.map((d) => d.slug) ?? [];
  const present = [...new Set(comments.map((c) => c.doc))];
  return present.sort((a, b) => {
    const ia = order.indexOf(a);
    const ib = order.indexOf(b);
    if (ia === -1 && ib === -1) return a.localeCompare(b);
    if (ia === -1) return 1;
    if (ib === -1) return -1;
    return ia - ib;
  });
}

const SNIPPET_MAX = 160;

function snippet(text: string): string {
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length > SNIPPET_MAX ? `${one.slice(0, SNIPPET_MAX - 1)}…` : one;
}

function lineLabel(comment: Comment): string {
  const { line, lineEnd, side, baseVersion } = comment;
  if (line == null) return '';
  const range = lineEnd == null || lineEnd <= line ? `line ${line}` : `lines ${line}-${lineEnd}`;
  if (side === 'old') return `[removed${baseVersion ? ` in v${baseVersion}` : ''}, ${range}]`;
  return `[${range}]`;
}

function formatLineComment(c: Comment, resolve: LineSliceResolver): string {
  const label = lineLabel(c);
  const quoteSource =
    c.quote?.trim() ||
    (c.line != null
      ? snippet(
          resolve(c.doc, c.line, c.lineEnd ?? c.line, c.side === 'old' ? c.baseVersion : undefined) ?? '',
        )
      : '');
  const quoted = quoteSource ? ` "${quoteSource}"` : '';
  return `- ${label}${quoted} → ${c.body.trim()}`;
}

/** New-side comments first, then removed-line comments — two line spaces. */
function bySideThenLine(a: Comment, b: Comment): number {
  const side = (c: Comment) => (c.side === 'old' ? 1 : 0);
  return side(a) - side(b) || a.line! - b.line! || (a.lineEnd ?? a.line)! - (b.lineEnd ?? b.line)!;
}

/**
 * Compile targeted human questions into the denial reason that returns control
 * to a plan-mode agent (the ExitPlanMode hook blocks the tool call, so an Ask
 * has to be delivered by giving the agent a turn).
 *
 * Every question is printed with its THREAD id — that is the handle
 * plan_review_reply takes — and the closing instruction is to present the plan
 * again, not to re-submit a revision. A discussion is not a change request.
 */
export function compileAsk(
  comments: Comment[],
  manifest: Manifest | undefined,
  reviewId: string,
  version: number,
): string {
  const threads = groupThreads(comments).filter(isOpenThread);
  const sections: string[] = [
    `The human chose Ask agent on your plan review (v${version}). This is a DISCUSSION, ` +
      `not a change request.`,
  ];

  // Threads inherit the root's anchor, so the ROOT is what orders the sections.
  for (const slug of orderedDocs(
    threads.map((t) => t.root),
    manifest,
  )) {
    const inDoc = threads.filter((t) => t.root.doc === slug);
    if (inDoc.length === 0) continue;
    sections.push(sectionHeader(manifest, slug));
    for (const thread of inDoc) {
      // Newest message wins: a follow-up supersedes the original question.
      const latest = actionableMessage(thread);
      const label = lineLabel(latest);
      const quoted = latest.quote?.trim() ? ` "${snippet(latest.quote)}"` : '';
      // A general comment has no anchor, so there is nothing for an arrow to
      // introduce — emitting "-  → body" reads like a formatting bug.
      const where = `${label}${quoted}`;
      sections.push(
        `- ${where ? `${where} → ` : ''}${latest.body.trim()}\n` + `  threadId: ${thread.root.id}`,
      );
    }
  }

  sections.push(
    `Answer every thread above with\n` +
      `  plan_review_reply { "reviewId": "${reviewId}", "commentId": "<threadId>", "body": "..." }\n` +
      `then present the plan again with ExitPlanMode so the human can decide. Not every thread ` +
      `needs a plan change — answer, explain the trade-off, or push back. Revise and re-present ` +
      `only if the discussion actually calls for one.`,
  );
  return sections.join('\n\n');
}

export type ResubmitChannel = 'ExitPlanMode' | 'plan_review_submit';

/**
 * Comments that should reach the agent: one entry per OPEN thread, carrying the
 * newest human message (a follow-up supersedes the original ask). Agent replies
 * are conversation, never feedback, and resolved threads drop out entirely.
 */
export function actionableComments(comments: Comment[]): Comment[] {
  return groupThreads(comments).filter(isOpenThread).map(actionableMessage);
}

/**
 * Compile the denial reason sent back to the agent on "Request changes".
 * `resubmitVia` names the channel the agent should use to re-present.
 */
export function compileRejection(
  comments: Comment[],
  manifest: Manifest | undefined,
  resolve: LineSliceResolver,
  version?: number,
  resubmitVia: ResubmitChannel = 'ExitPlanMode',
): string {
  const where = version ? `version ${version} ` : '';
  const again = `re-present the revised plan via ${resubmitVia}.`;
  const actionable = actionableComments(comments);
  if (actionable.length === 0) {
    return (
      `The human reviewed plan ${where}and requested changes without leaving specific comments.\n` +
      `Reconsider the plan critically — look for gaps, risks, and unstated assumptions — improve it, ` +
      `then ${again}`
    );
  }

  const sections: string[] = [
    `The human reviewed plan ${where}and requested changes. Address EVERY comment below, then ${again}`,
  ];
  for (const slug of orderedDocs(actionable, manifest)) {
    const docComments = actionable.filter((c) => c.doc === slug);
    const line = docComments.filter((c) => c.line != null).sort(bySideThenLine);
    const general = docComments.filter((c) => c.line == null);
    sections.push(sectionHeader(manifest, slug));
    for (const c of line) sections.push(formatLineComment(c, resolve));
    for (const c of general) sections.push(`- ${c.body.trim()}`);
  }
  sections.push(`Address each comment above, then ${again}`);
  return sections.join('\n');
}

/**
 * Compile implementation guidance delivered alongside an approval.
 * Returns "" when there are no comments.
 */
export function compileApproval(
  comments: Comment[],
  manifest: Manifest | undefined,
  resolve: LineSliceResolver,
): string {
  const actionable = actionableComments(comments);
  if (actionable.length === 0) return '';
  const count = actionable.length;
  const s = count === 1 ? '' : 's';
  const sections: string[] = [
    `The human APPROVED the plan with ${count} comment${s}. Proceed with implementation and incorporate these note${s}:`,
  ];
  for (const slug of orderedDocs(actionable, manifest)) {
    const docComments = actionable.filter((c) => c.doc === slug);
    const line = docComments.filter((c) => c.line != null).sort(bySideThenLine);
    const general = docComments.filter((c) => c.line == null);
    sections.push(sectionHeader(manifest, slug, 'Notes'));
    for (const c of line) sections.push(formatLineComment(c, resolve));
    for (const c of general) sections.push(`- ${c.body.trim()}`);
  }
  return sections.join('\n');
}

/** Compile validation issues into a deny reason the agent can act on alone. */
export function compileIssues(issues: PlanIssue[], resubmitVia: ResubmitChannel = 'ExitPlanMode'): string {
  const lines = issues.map((i) => `- ${i.message}${i.marker ? `\n  (marker: ${i.marker})` : ''}`);
  return [
    'The plan failed multi-document validation:',
    ...lines,
    '',
    `Fix every issue above and re-present the corrected plan via ${resubmitVia}.`,
  ].join('\n');
}
