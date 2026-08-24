/**
 * CLI entrypoint — one binary, several subcommands:
 *
 *   agent-plan-review serve              start the review server
 *   agent-plan-review mcp                MCP stdio server (pi & friends)
 *   agent-plan-review hook-exit-plan-mode  Claude Code ExitPlanMode PreToolUse hook
 *   agent-plan-review stop-gate          Claude Code Stop hook gate (one-reminder semantics)
 *   agent-plan-review enter-plan-mode    Claude Code EnterPlanMode context hook
 *   agent-plan-review install-skill      install the global agent skill
 *   agent-plan-review install-pi-extension  install the plan-review-wake pi extension
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
import { installSkill } from './skill.js';
import { APP_NAME, loadConfig } from './config.js';

const cfg = loadConfig();

const HELP = `${APP_NAME} — a local review surface for AI coding-agent plans.

Usage:
  agent-plan-review <command>

Commands:
  serve                    Start the review server (http://localhost:${cfg.port})
  mcp                      Run the MCP stdio server (plan_review_submit / plan_review_check)
  install-skill            Install the "agent-plan-review" skill globally (~/.pi/agent/skills)
  install-pi-extension     Install the plan-review-wake extension (~/.pi/agent/extensions):
                           wakes idle sessions with the decision so agents can stop
                           polling; heartbeat makes the Claude Code stop-gate stand down
  hook-exit-plan-mode      ExitPlanMode PreToolUse hook (blocking review)
  stop-gate                Stop-hook gate for pending MCP/API reviews (reminds once per review)
  enter-plan-mode          EnterPlanMode context hook (multidoc guidance)

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
  calls (Claude Code) deliver the result on their own.

Environment:
  AGENT_PLAN_REVIEW_HOME        Storage root (default ~/.agent-plan-review)
  AGENT_PLAN_REVIEW_PORT        Server port (default ${cfg.port})
  AGENT_PLAN_REVIEW_TIMEOUT     Hook blocking timeout in seconds (default 1800)
  AGENT_PLAN_REVIEW_MAX_WAIT    plan_review_check ceiling in seconds (default 172800 = 48 h)
  AGENT_PLAN_REVIEW_PROGRESS_MS Keepalive progress interval during checks (default 20000)
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
    process.stdout.write('It watches ~/.agent-plan-review/reviews and injects decisions into idle sessions.\n');
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
  default:
    process.stdout.write(HELP);
    process.exit(command ? 1 : 0);
}
