/**
 * CLI entrypoint — one binary, several subcommands:
 *
 *   agent-plan-review serve              start the review server
 *   agent-plan-review mcp                MCP stdio server (pi & friends)
 *   agent-plan-review hook-exit-plan-mode  Claude Code ExitPlanMode PreToolUse hook
 *   agent-plan-review stop-gate          Claude Code Stop hook gate (one-reminder semantics)
 *   agent-plan-review enter-plan-mode    Claude Code EnterPlanMode context hook
 *   agent-plan-review forget --worktree <path>  delete the plans of a removed worktree
 *   agent-plan-review install-skill      install the global agent skill
 *   agent-plan-review install-pi-extension  install the plan-review-wake pi extension
 *   agent-plan-review herdr enable|disable|status  optional Herdr integration
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { serve } from './index.js';
import { runMcpServer } from './integrations/mcp-server.js';
import { runExitPlanModeHook } from './integrations/hook-exit-plan-mode.js';
import { runStopGate } from './integrations/stop-gate.js';
import { runEnterPlanModeHook } from './integrations/enter-plan-mode.js';
import { PI_WAKE_EXTENSION_FILENAME, PI_WAKE_EXTENSION_SOURCE } from './integrations/pi-wake-source.js';
import { runHerdrCommand } from './integrations/herdr.js';
import { installSkill } from './skill.js';
import { runForget } from './forget-cli.js';
import { APP_NAME, loadConfig } from './config.js';

const cfg = loadConfig();

const HELP = `${APP_NAME} — a local review surface for AI coding-agent plans.

Usage:
  agent-plan-review <command>

Commands:
  serve                    Start the review server (http://localhost:${cfg.port})
  mcp                      Run the MCP stdio server (plan_review_submit / plan_review_check / plan_review_reply)
  install-skill            Install the "agent-plan-review" skill globally (~/.pi/agent/skills)
  install-pi-extension     Install the plan-review-wake extension (~/.pi/agent/extensions):
                           wakes idle sessions with the decision so agents can stop
                           polling; heartbeat makes the Claude Code stop-gate stand down
  hook-exit-plan-mode      ExitPlanMode PreToolUse hook (blocking review)
  stop-gate                Stop-hook gate for pending MCP/API reviews (reminds once per review)
  enter-plan-mode          EnterPlanMode context hook (multidoc guidance)
  herdr enable [--browser] Turn on the optional Herdr integration (pointer files for the
                           Herdr mod; --browser keeps opening the browser too)
  herdr disable            Turn the Herdr integration off (the default)
  herdr status             Show the effective Herdr settings
  forget --worktree <path> [--dry-run] [--json]
                           Delete a worktree's plans (versions, comments, reviews), images
                           no other project uses, and Herdr pointer files. Works after the
                           folder is gone; exits 0 when nothing matched.

Integration — Claude Code (hooks, blocking):
  ~/.claude/settings.json → hooks:
    PreToolUse / matcher "ExitPlanMode"  → ${APP_NAME} hook-exit-plan-mode
    PreToolUse / matcher "EnterPlanMode" → ${APP_NAME} enter-plan-mode
    Stop                                 → ${APP_NAME} stop-gate

Integration — pi & any MCP client (tools, one-shot long-poll):
  .mcp.json / ~/.config/mcp/mcp.json → mcpServers:
    "agent-plan-review": { "command": "${APP_NAME}", "args": ["mcp"], "requestTimeoutMs": 180000000 }
  Agents submit with plan_review_submit, then make ONE long plan_review_check call
  (wait_seconds up to AGENT_PLAN_REVIEW_MAX_WAIT). Clients that auto-background long
   calls (Claude Code) deliver the result on their own. plan_review_check also returns
   early when the human chooses Ask agent; answer with plan_review_reply.

Environment:
  AGENT_PLAN_REVIEW_HOME        Storage root (default ~/.agent-plan-review)
  AGENT_PLAN_REVIEW_PORT        Server port (default ${cfg.port})
  AGENT_PLAN_REVIEW_TIMEOUT     Hook blocking timeout in seconds (default 1800)
  AGENT_PLAN_REVIEW_MAX_WAIT    plan_review_check ceiling in seconds (default 172800 = 48 h)
  AGENT_PLAN_REVIEW_PROGRESS_MS Keepalive progress interval during checks (default 20000)
  AGENT_PLAN_REVIEW_HERDR       0|1 — override integrations.herdr.enabled from config.json
  HERDR_APP_HOME                Herdr data root for pointer files (default ~/.config/herdr-app)
  (legacy PLAN_REVIEW_* spellings are still honored)
`;

const command = process.argv[2];

switch (command) {
  case 'serve':
    serve();
    break;
  case 'mcp':
    void runMcpServer();
    break;
  case 'install-skill':
    installSkill();
    break;
  case 'install-pi-extension': {
    const dir = path.join(os.homedir(), '.pi', 'agent', 'extensions');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, PI_WAKE_EXTENSION_FILENAME);
    fs.writeFileSync(file, PI_WAKE_EXTENSION_SOURCE);
    process.stdout.write(`pi wake extension installed: ${file}\n`);
    process.stdout.write('Restart pi sessions or run /reload to activate it.\n');
    process.stdout.write('It watches ~/.agent-plan-review/reviews and injects decisions into idle sessions,\n');
    process.stdout.write('and wakes the session when the human chooses Ask agent on a thread.\n');
    break;
  }
  case 'hook-exit-plan-mode':
    void runExitPlanModeHook();
    break;
  case 'stop-gate':
    void runStopGate();
    break;
  case 'enter-plan-mode':
    void runEnterPlanModeHook();
    break;
  case 'herdr': {
    const code = runHerdrCommand(process.argv.slice(3), cfg.home, (line) =>
      process.stdout.write(`${line}\n`),
    );
    process.exit(code);
    break;
  }
  case 'forget':
    void runForget(process.argv.slice(3), cfg).then((code) => process.exit(code));
    break;
  default:
    process.stdout.write(HELP);
    process.exit(command ? 1 : 0);
}
