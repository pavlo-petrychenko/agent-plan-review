# agent-plan-review

A local, agent-agnostic review surface for coding-agent plans. Instead of reading a plan
as a wall of text in a terminal and answering a yes/no prompt, the human reads it
rendered like a GitHub README, annotates any line in the browser, compares iterations
side by side, and records a decision — **Approve** or **Request changes** — which flows
straight back to the agent.

```
agent proposes → human reviews in the browser → decision returns to the agent
      ↑                                                    │
      └──────────── revised plan = new version ←───────────┘
```

Works with **Claude Code** via hooks (blocking) and with **pi** (or any MCP client) via
MCP tools. Everything runs on your machine; plans, comments, versions and decisions live
under one home-directory root keyed by project path — nothing leaks into git and multiple
worktrees never collide.

---

## Quick start

```bash
npm install
npm run build        # server → dist/ , web UI → dist/web
npm run start        # serves http://localhost:4620  (AGENT_PLAN_REVIEW_PORT to change)
```

Development mode:

```bash
npm run dev          # Express API with watch on :4620
npm run dev:web      # Vite dev server on :5188 proxying /api
npm test             # unit tests for parser / validator / differ / compiler
npm run lint         # eslint
```

## Integration — Claude Code (hooks, blocking)

Add to `~/.claude/settings.json`:

```json
{
  "hooks": {
    "PreToolUse": [
      { "matcher": "ExitPlanMode",  "hooks": [{ "type": "command", "command": "agent-plan-review hook-exit-plan-mode" }] },
      { "matcher": "EnterPlanMode", "hooks": [{ "type": "command", "command": "agent-plan-review enter-plan-mode" }] }
    ],
    "Stop": [
      { "hooks": [{ "type": "command", "command": "agent-plan-review stop-gate" }] }
    ]
  }
}
```

| Hook | Behavior |
| --- | --- |
| `hook-exit-plan-mode` | Blocks while you review. Approve → emits `allow` with echoed `updatedInput` (suppresses Claude Code's native confirmation) plus approve-notes as guidance. Request changes → emits `deny` carrying every comment compiled per document with line references and quotes. **Ask agent** → also emits `deny`, carrying the questions with their `threadId`s, which returns control to Claude for a reply; it then calls `ExitPlanMode` again onto the same review. Validation failures deny with actionable issue lists. Hard timeout (`AGENT_PLAN_REVIEW_TIMEOUT`, default 1800 s) fails open to the native prompt. Every failure path fails open. |
| `enter-plan-mode` | Injects multi-document format guidance as context only; consent to enter plan mode is untouched. |
| `stop-gate` | If a turn would end while an MCP/API-origin review in this cwd is still pending (<5 h), reminds the agent AT MOST ONCE per review to make a single long `plan_review_check` call. Stands down entirely while a live plan-review-wake heartbeat exists. Never double-blocks; fails open. |

## Integration — pi & other MCP clients

1. Register the server once (pi-mcp-adapter reads standard MCP config):

   ```jsonc
   // ~/.config/mcp/mcp.json  (or .mcp.json per-project)
   {
     "mcpServers": {
       "agent-plan-review": {
         "command": "node",
         "args": ["/absolute/path/to/agent-plan-review/bin/agent-plan-review.js", "mcp"],
         "requestTimeoutMs": 180000000
       }
     }
   }
   ```

   `requestTimeoutMs` must cover one full long-poll (default ceiling 172800 s = 48 h + margin);
   without it, clients fall back to shorter SDK defaults and kill the single-call strategy.

2. Install the global skill so every session knows the workflow:

   ```bash
   agent-plan-review install-skill   # → ~/.pi/agent/skills/agent-plan-review/SKILL.md
   ```

3. Agents use five tools:

   - **`plan_review_submit`** `{ cwd, markdown | plan | docs[] , images[] }` → validates and records
     through the same store, opens the browser, returns `{ reviewId, reviewUrl,
     projectKey, version }`. `images[]` (`{ name, path | dataBase64 }`) are stored and
     `image:<name>` references in the text are rewritten to served URLs.
   - **`plan_review_check`** `{ reviewId?, wait_seconds? }` → TRUE LONG-POLL: returns the
     moment the decision lands, the human chooses **Ask agent** on a comment, or `wait_seconds`
     elapses (ceiling `AGENT_PLAN_REVIEW_MAX_WAIT`, default 172800 s = 48 h). Comments added to
     the **decision batch** stay silent until approval or requested changes. Returns `pending` /
     `approved (+notes)` / `rejected (+reason)`. The intended strategy is ONE long call per review —
     never a short-poll loop. Emits
     periodic progress notifications so silent calls survive client idle-timeouts.
     Clients that auto-background long calls (Claude Code after ~2 min) deliver the result
     on their own; the steering text tells agents not to re-call or re-submit then.
   - **`plan_review_reply`** `{ reviewId, commentId, body }` → answer a human's thread while a
     review is still pending, without re-submitting the plan.
   - **`plan_review_resolve`** `{ reviewId?, commentId, resolved? }` → mark a thread resolved
     (or reopen it) once it is genuinely dealt with. Accepts a review in **any** status and needs
     no waiting agent, so it also works on the blocking plan-mode `ExitPlanMode` path — clear the
     threads you fixed as you work through "request changes". Resolving stops the thread being
     delivered again and keeps it from carrying into the next version. `commentId` is the thread
     root id, never a reply id.
   - **`plan_review_attach_image`** `{ path | dataBase64, name? }` → store one image and get
     back the URL/markdown to embed.

4. Optional zero-poll wake for pi sessions:

   ```bash
   agent-plan-review install-pi-extension   # → ~/.pi/agent/extensions/plan-review-wake.ts
   ```

   The extension watches `~/.agent-plan-review/reviews/*.json`; when a review from this
   cwd resolves it injects the decision into the idle session and triggers a turn — so
   the agent can end its turn right after submitting. It also writes a heartbeat to
   `~/.agent-plan-review/wake-active.json`, which makes the Claude Code stop-gate stand
   down (no waker ⇒ the gate still reminds once per review).

The server starts itself on first use (`EADDRINUSE` from a second instance exits 0
quietly). Rejection reasons compiled for MCP/API reviews instruct re-submission via
`plan_review_submit`; hook-origin reviews say `ExitPlanMode`.

Immediate **Ask agent** delivery works on any review that has something reading
it: an `mcp` review is read by `plan_review_check`, a plan-mode `hook` review by
the blocking `ExitPlanMode` hook. An `api` review has no consumer — the browser is
the only reader — so it may join a decision batch but never take an Ask.

The plan-mode case needed the hook to stop being a pure block. `ExitPlanMode`
**blocks** the tool call until you decide, so there was no agent turn in which a
reply could exist; the hook now waits for a decision **or** a question, and on a
question returns `deny` — the same channel "request changes" already uses, which
leaves Claude in plan mode and hands it a turn. Three consequences worth knowing:

- **One live review per Claude Code session.** Reviews are keyed on `session_id`,
  so re-presenting a plan adopts the pending review instead of minting a second
  one. Without that, every question/answer round would strand its threads on a
  version nobody is looking at. A revised plan still makes a new version; the
  review is retargeted onto it, and open threads carry forward under their
  original ids.
- **Questions are delivered once.** `waitForDecisionOrAsk` marks the
  conversation cursor when it hands a question over, so an ignored question is
  not asked again. The thread stays visibly open in the UI, so the reviewer can
  re-ask or resolve it — that is the loop-breaker.
- **Delivery is pull-based.** A question is picked up the next time the hook
  runs, i.e. when Claude next presents the plan. There is no process left polling
  between calls, so the UI says so on the button.

If Claude Code refuses `plan_review_reply` in plan mode ("Cannot call … while in
plan mode"), allow it — it is the only write the review needs there:

```json
{ "permissions": { "allow": ["mcp__agent-plan-review__plan_review_reply"] } }
```

## Herdr integration (optional)

Herdr runs agents in its own terminals and sets `HC_TERMINAL_ID`
in each one. This integration is **off by default**: the browser stays the review
surface, and nothing below happens until you enable it.

```bash
agent-plan-review herdr enable            # Herdr mod shows plans; no browser tab for Herdr terminals
agent-plan-review herdr enable --browser  # pointer files AND the browser tab
agent-plan-review herdr disable           # back to the default
agent-plan-review herdr status
```

The setting lives in `<storage root>/config.json`
(`{ "integrations": { "herdr": { "enabled": true, "openBrowser": false } } }`);
`AGENT_PLAN_REVIEW_HERDR=0|1` overrides `enabled` for one process. A missing or broken
file means "off".

- **Always (harmless metadata):** a review submitted from a Herdr terminal records
  `agent: { terminal, harness }` (`claude-code` for the hook, the MCP client name for
  `plan_review_submit`). `GET /api/reviews?terminal=<id>` lists that terminal's reviews,
  newest first.
- **Only when enabled:** each submit, Ask, agent reply, thread resolve and decision
  rewrites `<HERDR_APP_HOME or ~/.config/herdr-app>/data/plan-review/<terminal>.json`
  atomically with `{ reviewId, projectKey, version, status, title, cwd, updatedAt }` for
  the terminal's newest review. A failed write is logged and never fails the review.
- **Only when enabled, for agents in a Herdr terminal:** the hook and MCP server skip the
  browser tab unless `openBrowser` is true. The review server still starts as usual, and
  agents outside Herdr are unaffected.

Comments may also carry `range: { start, end }` — character offsets into the page's
markdown — for word-exact anchors. It is optional; it is dropped when a carried thread's
line anchor moves, and clients fall back to the quote.

## Multi-document plans

A single markdown blob can carry multiple pages via markers (alone on their own line):

```markdown
# Overview
Root content…

<!--doc slug=implementation title="Implementation" parent=root-->
…
<!--doc slug=risks title="Risks" parent=root-->
…
```

- Content before the first marker becomes the root document (titled from its H1).
- Zero markers ⇒ flat single-doc plan.
- Slugs are lowercase kebab-case and unique; exactly one root; parents must exist.
- Cross-link with `[[slug]]`, `[[slug|Label]]` or `[Label](doc:slug)` — they navigate
  inside the app, never away.
- Markers inside code fences are ignored; validation reports *all* problems at once so
  the agent can self-correct from the deny reason alone.

## Feature map

- **Reading** — GFM rendered server-side with a bidirectional block↔source-line map;
  scripts stripped; outline navigation with display-only section filtering; document
  navigator with per-doc comment counts for tree plans.
- **Annotating** — select any text → thread anchored to those source lines (quotes
  captured verbatim); general notes; every human message chooses **Ask agent** for
  an immediate MCP conversation or **Add to decision** to stay silent until the
  review is decided. Cmd/Ctrl+Enter always uses the safe decision action.
- **Imaging** — attach screenshots to a plan (`images[]` on submit, `plan_review_attach_image`,
  or `POST /api/images`). They are content-addressed under the storage root, referenced from the
  markdown as `image:<name>` (rewritten to a served URL), and open at full size in a viewer with
  the alt text as its caption. A reference to an image nobody attached fails validation by name
  instead of rendering a broken link.
- **Threading** — every comment is a conversation: **Ask agent** wakes a pending
  MCP review for an immediate answer, while **decision batch** comments remain
  silent until Approve or Request changes. You can reply with either delivery
  choice and resolve a thread when it is done. Agent replies are never compiled
  into final feedback; unresolved threads carry forward to the next version,
  re-anchored through the diff.
- **Deciding** — pending/approved/rejected surfaced at all times; buttons only enabled
  when viewing the exact version under review; ~2.5 s polling while pending.
- **Comparing** — GitHub-style all-pages diff against any base version: every page in
  one scroll with per-page headers and +/- counts, hunks of ±3 context lines with
  expandable unchanged runs, split or unified, and comments on either side of the diff
  (removed-line anchors are compiled back to the agent as `[removed in vN, lines X-Y]`).
  Missing sides diff against empty content.
- **Exporting** — push the current version's markdown to a secret GitHub Gist through
  your installed `gh` CLI (no tokens stored). One destination per channel per project.
- **Housekeeping** — manage modal listing all projects/versions; immediate deletes;
  move versions/projects into another project (renumbered in place, comments and
  pending reviews travel); pending reviews protected behind explicit Force (“This plan
  was deleted in the review UI…”); bulk delete is partial-success aware; deep links
  restore project/version/doc/review.
- **Project keying** — a project is keyed by its cwd, resolved to the git toplevel, so a
  plan submitted from a subdirectory joins its repo/worktree project (worktrees stay
  separate; outside a repo the nearest registered ancestor wins).

## Forgetting a worktree

```
agent-plan-review forget --worktree <path> [--dry-run] [--json]
```

Deletes everything stored for one git worktree, under the store lock:

- its project: versions, comments and reviews (pending reviews are removed, not rejected);
- plan images that no other project references (images are shared by content, so an image
  a second project still uses stays);
- Herdr pointer files (`<herdrHome>/data/plan-review/*.json`, `herdrHome` = `HERDR_APP_HOME`
  or `~/.config/herdr-app`) whose `projectKey` is that project. Unreadable files are skipped.

It prints what it deleted, or with `--dry-run` what it would delete; `--json` prints the same
as one JSON object. A path with no plans prints `no plans for <path>` and exits 0, so it is
safe to call from a worktree-remove job. Exit 2 means bad arguments, 1 an I/O failure.

The project key is computed from the **literal absolute path** (trailing slashes ignored), so
it works after the folder is deleted. Unlike submission, it does not fold a subdirectory onto
its git root: a delete command must only hit the path it was given. If the folder still exists,
its symlink-resolved path is tried as well, because the store keys git's resolved toplevel.

### Startup safety net (Herdr)

When the server starts and the Herdr integration is enabled, it forgets projects whose
recorded folder **no longer exists** and whose path is **inside a Herdr worktree root**, and
logs each one. This catches worktrees removed outside the `forget` hook. It follows the same
switch as the rest of the integration (`agent-plan-review herdr enable`, or
`AGENT_PLAN_REVIEW_HERDR=1`; `=0` forces it off); when the integration is off, nothing is
ever removed automatically.

Worktree roots are `~/.herdr/worktrees/` plus the literal start of each `path` template in
`<herdrHome>/repo-worktree.json` (`repos.<main checkout>.path`, or `defaults.path`), with
`{home}`, `{repo.main}`, `{repo.parent}` and `{repo.name}` filled in and everything from the
first remaining placeholder cut off: `{repo.parent}/website-{name:slug}` for a repo at
`~/code/website` gives the root `~/code/website-`. Main checkouts, projects anywhere else,
and roots whose folder is itself missing (unmounted disk) are never touched.

## Configuration

| Env var | Default | Purpose |
| --- | --- | --- |
| `AGENT_PLAN_REVIEW_HOME` | `~/.agent-plan-review` | Storage root |
| `AGENT_PLAN_REVIEW_PORT` | `4620` | Server port |
| `AGENT_PLAN_REVIEW_TIMEOUT` | `1800` | Hook blocking timeout (seconds) |
| `AGENT_PLAN_REVIEW_HERDR` | unset | `0`/`1` overrides the Herdr integration switch |
| `HERDR_APP_HOME` | `~/.config/herdr-app` | Where Herdr pointer files are written; `repo-worktree.json` is read from here |

Legacy `PLAN_REVIEW_*` spellings are still honored.

## Architecture

```
src/
├── shared/       types + pure logic (parser, validator, differ, compiler, links)
├── server/
│   ├── store/    fs persistence: projects · versions · comments · reviews · recordPlan
│   ├── render/   remark→hast pipeline w/ line mapping, doc-link rewrite, sanitize
│   ├── channels/ gist via gh CLI
│   ├── api/      express routes
│   ├── integrations/  hook-exit-plan-mode · mcp-server · stop-gate · enter-plan-mode
│   ├── skill.ts  bundled global skill + installer
│   └── cli.ts    serve | mcp | install-skill | hook-* | stop-gate
├── skills/agent-plan-review/SKILL.md   repo copy of the global skill
└── web/          React + Tailwind SPA (query-param routing, cached API layer)
```

Pure logic lives in `shared/` and is unit-tested; the store is the only writer of disk
state; every agent-facing integration funnels through `recordPlan` and the same feedback
compiler, so hook, MCP and HTTP paths behave identically.

> Greenfield rebuild note: this shares no code with any previous implementation of the
> idea — only the storage layout concept and external behavior contracts.
