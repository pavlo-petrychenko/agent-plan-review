# Plan review inside Herdr: can we build it?

**Short answer: yes.** Herdr supports the whole core flow today. Herdr's markdown view hides what you selected, so **the mod draws the text itself, word by word, and handles selection on its own.** Press, drag, release over any words, even across paragraphs; selection snaps to whole words.

**Recommendation:** a **second screen for the existing agent-plan-review**, not a new tool. Agents, hooks, MCP tools and the store stay; inside Herdr the plan opens in a pane instead of Chrome.

## Your requirements, one by one

| Requirement | Verdict | How |
|---|---|---|
| Agent submits through plan mode or MCP | Yes | Existing hook and MCP tools, unchanged |
| Plan opens in Herdr, beside the agent | Yes | Same trick as `herdr-show`: `pane.split` with a mod |
| Scrollable, many pages, many versions | Yes | Text drawn by the mod, page sidebar, version switcher |
| Diff between versions | Workaround | No diff widget; draw coloured rows, as the `changes` mod does |
| Comment on selected text | Yes, word-exact | The mod draws its own text and tracks press, drag, release |
| Comment on the whole page | Yes | Plain composer |
| Approve / request changes | Yes | Buttons; the blocked agent gets the decision |
| Ask before deciding, chat in a thread | Yes | Existing "Ask agent" flow; the agent answers in the thread |
| Plans deleted with the worktree | Yes | Your `repo-worktree` mod gets a "plans" step in its remove job |

## What I need from you

1. Selection that snaps to whole words: good enough? See [[text-anchoring]].
2. "Second screen on the existing store": agreed? See [[how-it-would-work]].
3. Go-ahead for a probe mod before the implementation plan? See [[next-step]].

Herdr-only ideas are on [[ideas]].

## What changed since v5

- **Block anchors, quote-by-copy, source mode: removed.** Real drag selection replaces them: [[text-anchoring]].
- **Your `repo-worktree` mod deletes the plans**, as a step of its remove job: [[worktree-lifecycle]].

<!--doc slug=can-herdr-do-it title="Can Herdr do it? Feature by feature" parent=root-->
# Can Herdr do it? Feature by feature

Three investigations ran in parallel:

- **Mod UI:** what a Herdr mod can draw and react to. Sources: the Herdr authoring guide, the typings (`herdr.d.ts`, `gpui-kit.d.ts`), the reference mods, and a probe mod checked with `herdr-app check`.
- **Process control:** how outside processes and the mod talk to agents. Sources: `herdr-app`, `hc`, the `agent-queue` and `repo-worktree` mods, and the `herdr-status` hook.
- **Reuse:** which parts of agent-plan-review a Herdr view can use as they are.

The detail is split into three pages:

- [[text-anchoring]]: the one gap (selection), and the fix.
- [[rendering]]: markdown, pages, versions, diff, images, long documents.
- [[agent-channel]]: how the decision and the thread chat reach the agent.

**How a mod works, in one paragraph.** A mod is JavaScript that Herdr runs inside the app. It draws with ready-made components (markdown view, text area, buttons, virtual lists, popups). It can read and write files, watch a folder, run programs, and make network calls as a client. It cannot run a server. Outside programs open a mod with `herdr-app do pane.split --mod <name> --props '{...}'`. After that, they pass data through files that the mod watches, or through a server the mod calls.

<!--doc slug=text-anchoring title="Comments on selected text: real selection, drawn by the mod" parent=can-herdr-do-it-->
# Comments on selected text: real selection, drawn by the mod

**The problem.** Herdr's markdown view lets you select text, but it does not tell the mod what you selected or where. The component inside Herdr can do this (`selected_text`, `selected_source_range`), but Herdr does not pass it on to mods. The read-only code editor does not report its selection either.

**The fix: do not use Herdr's markdown view for the plan body.** Every Herdr element can report press, pointer movement, hover and release, and a row of elements can wrap like text. So the mod draws the text itself:

![How word-level selection works](image:select)

1. The server splits each page into words. Every word carries its position in the markdown source and its style (heading, bold, code, link).
2. The mod draws each word as a small element. They wrap like a normal paragraph.
3. You press on a word, drag, and release. The mod tints the words between the start and the pointer while you drag, across paragraphs, lists and table cells.
4. On release, the composer opens. The comment gets the exact quote and its source lines, the same anchor agent-plan-review stores today.

**What this also gives us:**

- Commented text stays tinted word by word, not as a whole block.
- Cmd-C copies the selection (the mod writes the clipboard itself).

**What it costs:**

- Selection snaps to whole words, not single letters.
- We draw markdown ourselves (headings, lists, tables, code, images). The server does the parsing in tested TypeScript, so the mod only draws.
- Code colours come from the server's highlighter, not from Herdr.

**Second track (optional):** ask the Herdr authors (`herdr-app feedback`) to pass `selected_source_range` on to mods. If they ship it, the mod can switch to Herdr's own markdown view with letter-exact selection.

<!--doc slug=rendering title="Rendering: markdown, pages, versions, diff, images" parent=can-herdr-do-it-->
# Rendering: markdown, pages, versions, diff, images

- **Markdown: drawn by the mod.** For selection, the plan body is drawn word by word (see [[text-anchoring]]): headings, lists, tables, quotes, inline code and links. Herdr's own markdown view stays for comment bodies.
- **Code colours: from the server.** The server colours code blocks and sends the colour with each word.
- **Pages and `[[slug]]` links: yes.** The page tree is plain clickable rows. A link is a word element with a click handler, so `[[slug]]` opens the page directly.
- **Versions: yes.** A version switcher, the same as in the browser.
- **Diff: workaround.** There is no diff widget. The server already computes the diff, so the mod only draws tinted rows in a virtual list, like the `changes` mod. Start with unified; side by side can come later.
- **Images: workaround.** The mod draws images only from the Herdr home folder. Copy the PNG to `~/.config/herdr-app/data/<mod>/` and draw it as its own block. Embedding the image inside the markdown text is unconfirmed.
- **Mermaid: shown as PNG.** Herdr cannot draw Mermaid. Plans already ship a rendered PNG beside each `.mmd` file, so the mod shows that PNG.
- **Long documents: likely fine, not measured.** The mod shows one page at a time, and your plan pages are short (300 words or less), so a page is a few hundred word elements. Every redraw repaints the whole window, so the mod redraws only on real changes.
- **Composer, buttons, keys, popups, toasts: yes.** Multi-line text area, buttons, key bindings, dialogs, hover cards and toast notifications all exist.

<!--doc slug=agent-channel title="Talking to the agent: decision and thread chat" parent=can-herdr-do-it-->
# Talking to the agent: decision and thread chat

An agent that waits for review is **blocked inside a tool call**. You cannot type to it, because Herdr's `hc send` refuses to type into a blocked agent. So the answer travels back through the call the agent is already waiting on. agent-plan-review already works this way.

![Ask-agent loop while the agent is blocked](image:ask)

**Per situation:**

- **Blocked on MCP (any harness):** `plan_review_check` returns early with your question. The agent answers with `plan_review_reply` and calls check again.
- **Blocked in Claude Code plan mode (hook):** the hook returns "deny" with your question. The agent answers and calls ExitPlanMode again. This path exists, but nobody has tested it end to end in Claude Code yet.
- **Agent is idle** (for example, after approval): this is new and Herdr-only. The mod types into the agent with `hc send --if idle`, and your comment arrives as a new turn. The `--if idle` flag stops it from typing over a busy agent.

**Harnesses:**

- **Claude Code:** hook plus MCP. Herdr's agent status detection is built for Claude Code.
- **pi:** MCP plus the existing wake extension.
- **OpenCode and Codex:** MCP only. How long they let an MCP call block is unknown. Codex must run with `--no-daemon` under `hc`.

<!--doc slug=how-it-would-work title="How it would work" parent=root-->
# How it would work

![Data flow: agent, store, Herdr mod, you](image:flow)

1. The agent submits as today, through the hook or the MCP tools.
2. Inside Herdr (`HC_TERMINAL_ID` is set), agent-plan-review opens the plan mod beside the agent's pane instead of Chrome. It also tells the queue that a plan waits for review.
3. The mod reads and writes through the existing HTTP server, exactly as the web page does. Locks, threads and the text sent to the agent stay in tested code.
4. When you decide, the blocked call returns the decision to the agent.

**Options compared:**

| Option | What it is | Good | Bad |
|---|---|---|---|
| A. Mod on the existing server (recommended) | New Herdr screen, same server and store | Agents unchanged; tested core; browser stays as a fallback | Needs the server running (the hook already starts it) |
| B. Mod reads files, a Node command writes | No HTTP; the mod runs a helper command for writes | Works without the server | Duplicates the server's API logic |
| C. New Herdr-native tool | New store in the worktree, new MCP tools, new hooks | Free to redesign everything | Rewrites the hard-won hook and MCP behaviour |

Option A still lets us rethink the review experience, because the screen is new. If a later idea needs a different plan model, the store can change underneath.

- [[reuse]]: what stays and what is new.
- [[worktree-lifecycle]]: how plans go away with the worktree.

<!--doc slug=reuse title="What we reuse from agent-plan-review" parent=how-it-would-work-->
# What we reuse from agent-plan-review

**Unchanged:**

- The Claude Code ExitPlanMode hook, the MCP tools, the stop-gate and the pi extension. They read and write the store files directly, not through HTTP.
- The store (`~/.agent-plan-review`): versions that never change, comments per version, reviews, images, one project per worktree.
- The tested shared code: plan parser, threads, diff, and the "compile" step that builds the text the agent receives.

**Small additions to agent-plan-review:**

- **Herdr opener.** When `HC_TERMINAL_ID` is set, open the plan mod beside the agent, like `herdr-show` does. Otherwise open Chrome as today.
- **Word endpoint.** The server returns each page as blocks of words, each word with its source position, style and code colour, plus diff rows. The mod then needs no markdown parser of its own, and this logic stays in tested TypeScript.
- **Queue signal.** Put the review id into the agent's Herdr status, so the queue row can open the plan.

**New:**

- The Herdr mod: page tree, word-drawn page view, composer, threads, version switch, diff rows, and the Approve, Request changes and Ask buttons.
- A small change in the `agent-queue` mod: a "Review plan" button on the row.

**Behaviour the new screen must keep:**

- Open threads carry over to the next version.
- "Ask agent" questions only go to agents that wait through the hook or MCP.
- On approval, the hook still sends the plan back unchanged (`updatedInput`), or Claude Code shows its own prompt as well.

<!--doc slug=worktree-lifecycle title="Plans are deleted with the worktree" parent=how-it-would-work-->
# Plans are deleted with the worktree

**Yes, your `repo-worktree` mod can delete the plans.** Its remove job is a shell script built in `mods/repo-worktree/remover.js`. It already has optional steps per checkout: remove Docker containers, delete the folder, delete the branch. Plans become one more step of the same kind.

**How:**

1. agent-plan-review gets a command `agent-plan-review forget --worktree <path>`. It deletes that worktree's project: versions, comments, reviews, and images that no other plan uses. The project key comes from the path alone, so it works even after the folder is gone.
2. `remover.js` gets an option `"plans": true` next to `deleteBranch` and `docker` (on by default). Stage 2 runs `forget` for each checkout, next to the Docker step. If agent-plan-review is not installed, the step skips quietly, like the Docker step does.
3. A pending review in that worktree is closed first, so a waiting agent gets "worktree removed" instead of hanging.

**Herdr's own `worktree` mod** (its built-in Remove) has no such step. As a safety net, the server also deletes projects whose folder is gone when it starts.

**Closed plans stay easy to reach until then:** the mod lists every review of the current worktree, decided and pending, so an old plan is one click away.

<!--doc slug=ideas title="Ideas that only Herdr makes possible" parent=root-->
# Ideas that only Herdr makes possible

Ordered by usefulness. All of them are possible with the APIs found.

1. **"Review plan" button in the queue, plus a toast.** The queue already marks a waiting plan as a "review" row. One click opens the plan, so you never miss one.
2. **Plan pane beside its agent.** It opens in the right space and tab automatically. The header has "Jump to agent" and a small live view of the agent's screen, so you can see what it is doing.
3. **File links open the code.** Click `src/x.ts:40` in a plan and the file viewer opens it at that line. You review the plan against the real code.
4. **Comment after approval.** While the agent implements, a comment on the approved plan reaches it as a new turn once it is idle (`hc send --if idle`). The plan stays the place where you talk about the work.
5. **Living plan.** After approval the plan pane turns into a progress view. The agent marks steps done with a new MCP tool, and the queue row shows "3 of 7 steps".
6. **Second opinion.** A button starts a critic agent in the same worktree (`hc run`). It posts its findings as threads on the plan before you read it.
7. **Key to open the newest pending plan.** Small, but quick.

**Not worth it now:** labels for agents on remote machines (only matters if you use remote agents), badges on spaces (no badge API), and the ACP protocol channel (Herdr does not speak it to agents; `acp-probe` is a benchmark).

<!--doc slug=next-step title="Next step: a probe before building" parent=root-->
# Next step: a probe before building

Some answers need a real pane, not reading code. I propose one small probe mod, run in the second test window (`~/.hrt/start.sh`) so your main window is not touched.

**The probe tests these things:**

1. **Drag selection over word elements:** do hover and move events keep arriving while the mouse button is held, also across paragraphs?
2. **Speed:** about 1500 word elements on one page, tinted live while dragging. Does it stay smooth?
3. **Looks:** do wrapped word elements read like normal text (spacing, line height, bold and code inside a sentence)?
4. **Tables and lists** drawn from rows of word elements.
5. **Images:** a PNG copied under the Herdr home.

**Agent side, also unverified:**

- The Claude Code hook "Ask agent" path end to end.
- How long OpenCode and Codex let an MCP call block.

**After the probe:** I write an implementation plan for option A with PR-sized steps: the opener, word endpoint and `forget` command in agent-plan-review, the mod, the remove step in `repo-worktree`, then the queue button. If drag selection fails in the probe, I come back to you before planning anything else.
