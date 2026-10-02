---
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

## Plan mode: the human can ask you a question mid-review

The ExitPlanMode hook blocks the tool call, so if the reviewer presses **Ask
agent** on a comment the hook gives the wait back and the plan-mode denial reason
becomes the question. You are still in plan mode, with a turn:

1. Read the question in the denial reason. Each one carries its `threadId`, the
   document, the line range and the quoted text.
2. Answer every thread:
   `plan_review_reply { "reviewId": "<id>", "commentId": "<threadId>", "body": "..." }`
   — all thread ids for one round are in the same message, and one call per
   thread is fine.
3. **Call `ExitPlanMode` again.** This is what hands control back to the human —
   there is no background poller in plan mode, so a question you never re-present
   is a question the human waits on forever. Your re-presentation lands on the
   SAME review, so the thread and its answer stay together.

A question is a DISCUSSION, not a change request. Answer it, explain the
trade-off, or push back — and only revise the plan if the discussion actually
calls for one. Questions are delivered **once**: if you ignore one and
re-present, it will not be asked again, but the thread stays visibly open in the
review UI, so the human can re-ask or resolve it.

If Claude Code refuses `plan_review_reply` with "Cannot call … while in plan
mode", allow it once — `plan_review_reply` is the only write the review needs in
plan mode:

```json
{ "permissions": { "allow": ["mcp__agent-plan-review__plan_review_reply"] } }
```

## When to use

- You are about to implement something substantial and have (or can write) a plan.
- Plan mode: present the plan through plan-review instead of dumping text.
- The human asks to "review", "approve", or "sign off" on a plan.

## Workflow (MCP — pi and other MCP clients)

1. **Submit** the plan:

   `plan_review_submit` with `{ cwd: <absolute repo/worktree root>, markdown: <plan> }`
   → returns `{ reviewId, reviewUrl, projectKey, version }` and opens the browser.

   Pass the ROOT of the repo or worktree the plan belongs to (its git toplevel).
   Subdirectories are folded onto the containing project automatically, so a plan
   submitted from a nested folder still lands as a new version of the same project.

2. **Wait with ONE long call** — never poll in a loop:

   `plan_review_check` with `{ reviewId, wait_seconds: 172800 }`.

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
   - `status: "approved"` → proceed with implementation. If notes are returned,
     incorporate them as part of the work.
   - `status: "rejected"` → the result contains compiled feedback (per document,
     with line references and quotes). Address EVERY comment, then re-submit the
     revised plan with `plan_review_submit`. It becomes the next version and the
     human can diff the two — the diff shows every page at once, and comments may
     target removed lines too (they arrive as `[removed in vN, lines X-Y]`).
   - `status: "pending"` **with `newComments`** → the human chose Ask agent on a
     comment thread. This is a DISCUSSION, not a change request: answer each one
     with `plan_review_reply { "reviewId", "commentId": "<threadId>", "body" }`, then
     call `plan_review_check` again. The server tracks what you have seen, so you
     will not be handed the same message twice. Only revise and re-submit the plan
     if the discussion actually calls for a change.
   - Comments the human adds to the decision batch do not wake you. They arrive
     only in the final approved notes or requested-changes feedback.

NEVER short-poll (short waits in a loop) and NEVER re-submit while a review is
pending — both waste tokens for zero information.

## Threads (questions, not just change requests)

Comments are conversation threads. The human may choose Ask agent for a question
on a line, or reply to one of your comments; answer those with
`plan_review_reply`. Decision-batch comments stay silent until the human decides.
Threads are not always change requests — answer questions, explain trade-offs,
and ask for clarification. A thread is compiled into decision feedback until it
is resolved; a resolved one drops out. Threads carry forward to the next version,
re-anchored, so the conversation stays visible on the revised plan.

- Reply with `plan_review_reply { "reviewId": "<id>", "commentId": "<threadId>", "body": "..." }`.
- `threadId` comes from the `newComments` entries of `plan_review_check`.
- After replying, call `plan_review_check` again to wait for the next message or
  the decision — do not re-submit the plan to answer a question.
- Close a thread you have actually dealt with:
  `plan_review_resolve { "reviewId": "<id>", "commentId": "<threadId>" }`
  (`"resolved": false` reopens it). Do this once the question is answered or the
  change is in the plan — it stops the thread being delivered again and keeps it
  from carrying into your next version. Never resolve a thread just to silence
  feedback you have not addressed; the human can reopen it.
- `plan_review_resolve` works on any review of the project, decided or still
  pending, and needs no waiting agent. `commentId` is always the thread ROOT id,
  never a reply id.

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

## Images

Screenshots belong in the plan — a reviewer should see the before/after, not read about it.

Attach them with the submission and reference each one from the markdown:

```jsonc
plan_review_submit {
  "cwd": "/abs/repo",
  "markdown": "## Fixed\n\nBefore:\n\n![dark Approve button](image:before)\n\nAfter:\n\n![readable](image:after)",
  "images": [
    { "name": "before", "path": "/tmp/shot-before.png" },
    { "name": "after", "path": "shots/after.png" }    // relative paths resolve against cwd
  ]
}
```

- `image:<name>` is rewritten to a served URL before the version is stored, so a
  re-submission of the same plan can also just link the URL directly.
- Prefer one image per completed step, captioned with what changed, and keep the alt
  text meaningful — it is the caption in the full-screen viewer.
- PNG, JPEG, GIF, WebP, AVIF and SVG; 8 MB each, 60 per submission. The type is
  sniffed from the bytes, and identical bytes are stored once (content-addressed), so
  re-attaching the same screenshot across versions costs nothing.
- A reference to an image nobody attached fails validation by name — it never renders
  as a broken link.
- Already uploaded the file? `plan_review_attach_image { path }` returns the URL to
  paste, and `POST /api/images { dataBase64, name }` does the same over HTTP.
- Images are served by the local server, so they render in the review UI but NOT in a
  gist export (those URLs are local to your machine).

## Claude Code

If hooks are installed (`hook-exit-plan-mode`), presenting a plan via ExitPlanMode is
all you need: the tool blocks while the human reviews and returns allow/deny with the
decision. Outside plan mode, use the MCP flow above — a long `plan_review_check`
call auto-backgrounds after ~2 min and delivers the result later by itself.

## Setup

- Server starts automatically on first submit (`http://localhost:4620`).
- MCP registration with a request timeout that covers one long call:
  `"agent-plan-review": { "command": "<path-to>/bin/agent-plan-review.js", "args": ["mcp"], "requestTimeoutMs": 180000000 }`
- Optional pi wake extension: `agent-plan-review install-pi-extension`.
- Env: `AGENT_PLAN_REVIEW_HOME` (default `~/.agent-plan-review`),
  `AGENT_PLAN_REVIEW_PORT`, `AGENT_PLAN_REVIEW_TIMEOUT`,
  `AGENT_PLAN_REVIEW_MAX_WAIT` (check ceiling, default 172800 s = 48 h).
