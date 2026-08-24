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
| `hook-exit-plan-mode` | Blocks while you review. Approve → emits `allow` with echoed `updatedInput` (suppresses Claude Code's native confirmation) plus approve-notes as guidance. Request changes → emits `deny` carrying every comment compiled per document with line references and quotes. Validation failures deny with actionable issue lists. Hard timeout (`AGENT_PLAN_REVIEW_TIMEOUT`, default 1800 s) fails open to the native prompt. Every failure path fails open. |
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

3. Agents use two tools:

   - **`plan_review_submit`** `{ cwd, markdown | plan | docs[] }` → validates and records
     through the same store, opens the browser, returns `{ reviewId, reviewUrl,
     projectKey, version }`.
   - **`plan_review_check`** `{ reviewId?, wait_seconds? }` → TRUE LONG-POLL: returns the
     moment the decision lands or `wait_seconds` elapses (ceiling `AGENT_PLAN_REVIEW_MAX_WAIT`,
     default 172800 s = 48 h). Returns `pending` / `approved (+notes)` / `rejected (+reason)`.
     The intended strategy is ONE long call per review — never a short-poll loop. Emits
     periodic progress notifications so silent calls survive client idle-timeouts.
     Clients that auto-background long calls (Claude Code after ~2 min) deliver the result
     on their own; the steering text tells agents not to re-call or re-submit then.

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
  captured verbatim); general notes; comments persist per version and survive
  byte-identical re-presentations (content-hash dedup).
- **Deciding** — pending/approved/rejected surfaced at all times; buttons only enabled
  when viewing the exact version under review; ~2.5 s polling while pending.
- **Comparing** — diff against any base version, split or unified, per-document scoping,
  +/- stats, missing sides diff against empty content.
- **Exporting** — push the current version's markdown to a secret GitHub Gist through
  your installed `gh` CLI (no tokens stored). One destination per channel per project.
- **Housekeeping** — manage modal listing all projects/versions; immediate deletes;
  pending reviews protected behind explicit Force (“This plan was deleted in the review
  UI…”); bulk delete is partial-success aware; deep links restore project/version/doc/
  review.

## Configuration

| Env var | Default | Purpose |
| --- | --- | --- |
| `AGENT_PLAN_REVIEW_HOME` | `~/.agent-plan-review` | Storage root |
| `AGENT_PLAN_REVIEW_PORT` | `4620` | Server port |
| `AGENT_PLAN_REVIEW_TIMEOUT` | `1800` | Hook blocking timeout (seconds) |

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
