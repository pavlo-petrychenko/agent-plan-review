---
name: agent-plan-review
description: Submit implementation plans to the human for review in a browser UI and wait for their approve/request-changes decision. Use whenever you have a plan ready before starting a substantial implementation task — plan mode, feature work, refactors, migrations. Works in pi via MCP tools and in Claude Code via ExitPlanMode hooks.
---

# Plan Review

Give the human a real review surface for your plans instead of a terminal yes/no.

## When to use

- You are about to implement something substantial and have (or can write) a plan.
- Plan mode: present the plan through plan-review instead of dumping text.
- The human asks to "review", "approve", or "sign off" on a plan.

## Workflow (MCP — pi and other MCP clients)

1. **Submit** the plan:

   `plan_review_submit` with `{ cwd: <absolute project path>, markdown: <plan> }`
   → returns `{ reviewId, reviewUrl, projectKey, version }` and opens the browser.

2. **Poll** for the decision:

   `plan_review_check` with `{ reviewId, wait_seconds: 20 }`.

   - `status: "pending"` → call again. Keep polling; do NOT end your turn while a
     review is pending.
   - `status: "approved"` → proceed with implementation. If notes are returned,
     incorporate them as part of the work.
   - `status: "rejected"` → the result contains compiled feedback (per document,
     with line references and quotes). Address EVERY comment, then re-submit the
     revised plan with `plan_review_submit`. It becomes the next version and the
     human can diff the two.

## Multi-document plans

For larger efforts, split the plan into pages inside one submission:

```markdown
# Overview
Root content…

<!--doc slug=implementation title="Implementation" parent=root-->
…
<!--doc slug=risks title="Risks" parent=root-->
…
```

- Markers sit ALONE on their own line:
  `<!--doc slug=<kebab-slug> title="Title" parent=<slug>-->`
- Content before the first marker is the root document (titled from its H1).
- Exactly one root (the doc without `parent`); parents must reference existing slugs;
  slugs are lowercase-kebab and unique.
- Cross-link with `[[slug]]`, `[[slug|Label]]`, or `[Label](doc:slug)`.
- A single-document plan needs no markers at all.

Invalid plans are rejected with an issue list — fix every issue and re-submit.

## Claude Code

If hooks are installed (`hook-exit-plan-mode`), presenting a plan via ExitPlanMode is
all you need: the tool blocks while the human reviews and returns allow/deny with the
decision. Call `agent-plan-review install-skill` to make this skill available anyway.

## Setup

- Server starts automatically on first submit (`http://localhost:4620`).
- Env: `AGENT_PLAN_REVIEW_HOME` (default `~/.agent-plan-review`),
  `AGENT_PLAN_REVIEW_PORT`, `AGENT_PLAN_REVIEW_TIMEOUT`.
