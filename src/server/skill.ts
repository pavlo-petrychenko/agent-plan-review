/**
 * The bundled agent skill — teaches any coding agent (pi, Claude Code, …)
 * how to submit plans for human review and wait for the decision.
 *
 * Single source of truth: `install-skill` writes this exact content to the
 * user's global skills directory; the repo carries a copy under
 * skills/agent-plan-review/SKILL.md.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const SKILL_NAME = 'agent-plan-review';

export const SKILL_CONTENT = `---
name: agent-plan-review
description: Submit implementation plans to the human for review in a browser UI and wait for their approve/request-changes decision. Use whenever you have a plan ready before starting a substantial implementation task — plan mode, feature work, refactors, migrations. Works in Claude Code via ExitPlanMode hooks (preferred) and everywhere via MCP tools.
---

# Plan Review

Give the human a real review surface for your plans instead of a terminal yes/no.

## Choose your integration

- **Claude Code**: PREFER plan mode. Presenting the plan via ExitPlanMode blocks
  until decided — the hook does the waiting, zero polling, zero wasted turns.
  Use the MCP flow below only outside plan mode or when no hooks are installed.
- **pi & any other MCP client**: use the MCP flow below.

## When to use

- You are about to implement something substantial and have (or can write) a plan.
- Plan mode: present the plan through plan-review instead of dumping text.
- The human asks to "review", "approve", or "sign off" on a plan.

## Workflow (MCP — pi and other MCP clients)

1. **Submit** the plan:

   \`plan_review_submit\` with \`{ cwd: <absolute project path>, markdown: <plan> }\`
   → returns \`{ reviewId, reviewUrl, projectKey, version }\` and opens the browser.

2. **Wait with ONE long call** — never poll in a loop:

   \`plan_review_check\` with \`{ reviewId, wait_seconds: 3600 }\`.

   - It is a TRUE LONG-POLL: it returns the moment the human decides, so one
     long call is enough. A pending result after the full wait just means the
     human needs more time: call ONCE more with the same arguments.
   - **If your harness moves the call to the background** (Claude Code does this
     after ~2 min): do NOT call again and do NOT re-submit. Keep working or end
     your turn — the result arrives automatically as a notification that starts
     a new turn.
   - **If the plan-review-wake pi extension is installed**, you may instead end
     your turn right after submitting: it watches the store and injects the
     decision (it writes ~/.agent-plan-review/wake-active.json).
   - \`status: "approved"\` → proceed with implementation. If notes are returned,
     incorporate them as part of the work.
   - \`status: "rejected"\` → the result contains compiled feedback (per document,
     with line references and quotes). Address EVERY comment, then re-submit the
     revised plan with \`plan_review_submit\`. It becomes the next version and the
     human can diff the two.

NEVER short-poll (short waits in a loop) and NEVER re-submit while a review is
pending — both waste tokens for zero information.

## Multi-document plans

For larger efforts, split the plan into pages inside one submission:

\`\`\`markdown
# Overview
Root content…

<!--doc slug=implementation title="Implementation" parent=root-->
…
<!--doc slug=risks title="Risks" parent=root-->
…
\`\`\`

- Markers sit ALONE on their own line:
  \`<!--doc slug=<kebab-slug> title="Title" parent=<slug>-->\`
- Content before the first marker is the root document (titled from its H1).
- Exactly one root (the doc without \`parent\`); parents must reference existing slugs;
  slugs are lowercase-kebab and unique.
- Cross-link with \`[[slug]]\`, \`[[slug|Label]]\`, or \`[Label](doc:slug)\`.
- A single-document plan needs no markers at all.

Invalid plans are rejected with an issue list — fix every issue and re-submit.

## Claude Code

If hooks are installed (\`hook-exit-plan-mode\`), presenting a plan via ExitPlanMode is
all you need: the tool blocks while the human reviews and returns allow/deny with the
decision. Outside plan mode, use the MCP flow above — a long \`plan_review_check\`
call auto-backgrounds after ~2 min and delivers the result later by itself.

## Setup

- Server starts automatically on first submit (\`http://localhost:4620\`).
- MCP registration with a request timeout that covers one long call:
  \`"agent-plan-review": { "command": "<path-to>/bin/agent-plan-review.js", "args": ["mcp"], "requestTimeoutMs": 3900000 }\`
- Optional pi wake extension: \`agent-plan-review install-pi-extension\`.
- Env: \`AGENT_PLAN_REVIEW_HOME\` (default \`~/.agent-plan-review\`),
  \`AGENT_PLAN_REVIEW_PORT\`, \`AGENT_PLAN_REVIEW_TIMEOUT\`,
  \`AGENT_PLAN_REVIEW_MAX_WAIT\` (check ceiling, default 3600 s).
`;

/** Install the skill into the pi global skills directory (idempotent). */
export function installSkill(): void {
  const dir = path.join(os.homedir(), '.pi', 'agent', 'skills', SKILL_NAME);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'SKILL.md');
  fs.writeFileSync(file, SKILL_CONTENT);
  console.log(`Skill installed: ${file}`);
  console.log('It loads in every pi session. MCP registration (once):');
  console.log(
    `  add "agent-plan-review": { "command": "<path-to>/bin/${SKILL_NAME}.js", "args": ["mcp"], "requestTimeoutMs": 3900000 }`,
  );
  console.log('  to ~/.config/mcp/mcp.json (or run /mcp setup inside pi).');
}
