/**
 * EnterPlanMode context hook.
 *
 * Injects multi-document format guidance as additionalContext ONLY — no
 * permissionDecision, so the human's consent to enter plan mode is untouched.
 */

import { loadConfig } from '../config.js';
import { agentIdFrom } from '../agent-id.js';
import { PlanReviewStore } from '../store/store.js';
import { resolveProjectCwd } from '../util/project-cwd.js';
import type { ProjectMeta } from '../../shared/types.js';
import { readStdinJson, finish } from './hook-io.js';

const GUIDANCE = `When the plan spans multiple documents (overview + sections), present it in the multi-document format:

# Overview / main plan
...root content...

<!--doc slug=implementation title="Implementation" parent=root-->
...
<!--doc slug=risks title="Risks" parent=root-->
...

Rules:
- Markers sit ALONE on their own line: <!--doc slug=<kebab-slug> title="Title" parent=<slug>-->
- Content before the first marker becomes the root document (titled from its H1).
- Exactly one root; parents must reference existing slugs; slugs are lowercase-kebab and unique.
- Cross-link documents with [[slug]] or [[slug|label]] or [label](doc:slug).
- Zero markers is fine — a single-document plan needs no markers.

The human reviews plans in a browser UI and can approve or request changes per section.`;

interface PreToolUseInput {
  tool_name?: string;
  session_id?: string;
  cwd?: string;
}

/** Most other plans listed in the hint. */
const MAX_OTHER_PLANS = 5;

function oneLine(text: string, max = 80): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** What a plan project is called to the agent: plan id and title, or the legacy key. */
function planLabel(p: ProjectMeta): string {
  return p.plan ? `${p.plan.id} "${oneLine(p.plan.title)}"` : `${p.key} (worktree plan)`;
}

/**
 * Hint about the plans already in this worktree, so an agent entering plan mode
 * knows it is not alone. Empty when the agent has no id or nothing is to report.
 */
export async function worktreePlansHint(
  store: PlanReviewStore,
  rawCwd: string,
  agentId: string | undefined,
): Promise<string> {
  if (!agentId) return '';
  const known = [...new Set((await store.projects.list()).map((p) => p.cwd))];
  const cwd = resolveProjectCwd(rawCwd, known);
  // Newest first. A project nothing was ever recorded in has nothing to show.
  const inWorktree = (await store.projects.listByWorktree(cwd)).filter((p) => p.currentVersion > 0);
  const mine = inWorktree.find((p) => p.agents?.includes(agentId));
  const others = inWorktree.filter((p) => !p.agents?.includes(agentId));

  const lines: string[] = [];
  if (mine) {
    lines.push(
      `Your plan here: ${planLabel(mine)}, v${mine.currentVersion} — your next ExitPlanMode continues it.`,
    );
  }
  if (others.length > 0) {
    const reviews = await store.listReviews();
    const statusOf = (p: ProjectMeta): string =>
      // listReviews is newest first.
      reviews.find((r) => r.projectKey === p.key && r.version === p.currentVersion)?.status ?? 'no review';
    lines.push(
      'Other plans in this worktree (written by other agents; you do not need them):',
      ...others
        .slice(0, MAX_OTHER_PLANS)
        .map(
          (p) =>
            `- ${planLabel(p)} — v${p.currentVersion}, ${statusOf(p)}, updated ${p.updatedAt.slice(0, 10)}`,
        ),
      'To read one: plan_review_get { planId }. To continue one instead of starting your own: ' +
        'plan_review_join { planId } before ExitPlanMode.',
    );
  }
  return lines.join('\n');
}

export async function runEnterPlanModeHook(): Promise<void> {
  const input = (await readStdinJson()) as PreToolUseInput;
  try {
    if (input?.tool_name !== 'EnterPlanMode') return finish({});
    // Fail open: any trouble reading the store leaves the plain guidance.
    let hint = '';
    try {
      hint = await worktreePlansHint(
        new PlanReviewStore(loadConfig()),
        input.cwd ?? process.cwd(),
        agentIdFrom({ sessionId: input.session_id, env: process.env, harness: 'claude-code' }),
      );
    } catch {
      hint = '';
    }
    return finish({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        additionalContext: hint ? `${GUIDANCE}\n\n${hint}` : GUIDANCE,
      },
    });
  } catch {
    return finish({});
  }
}
