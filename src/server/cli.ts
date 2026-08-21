/**
 * CLI entrypoint — one binary, several subcommands:
 *
 *   agent-plan-review serve              start the review server
 *   agent-plan-review mcp                MCP stdio server (pi & friends)
 *   agent-plan-review hook-exit-plan-mode  Claude Code ExitPlanMode PreToolUse hook
 *   agent-plan-review stop-gate          Claude Code Stop hook gate
 *   agent-plan-review enter-plan-mode    Claude Code EnterPlanMode context hook
 *   agent-plan-review install-skill      install the global agent skill
 */

import { serve } from './index.js';
import { runMcpServer } from './integrations/mcp-server.js';
import { runExitPlanModeHook } from './integrations/hook-exit-plan-mode.js';
import { runStopGate } from './integrations/stop-gate.js';
import { runEnterPlanModeHook } from './integrations/enter-plan-mode.js';
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
  hook-exit-plan-mode      ExitPlanMode PreToolUse hook (blocking review)
  stop-gate                Stop-hook gate for pending MCP/API reviews
  enter-plan-mode          EnterPlanMode context hook (multidoc guidance)

Integration — Claude Code (hooks, blocking):
  ~/.claude/settings.json → hooks:
    PreToolUse / matcher "ExitPlanMode"  → ${APP_NAME} hook-exit-plan-mode
    PreToolUse / matcher "EnterPlanMode" → ${APP_NAME} enter-plan-mode
    Stop                                 → ${APP_NAME} stop-gate

Integration — pi & any MCP client (tools, non-blocking):
  .mcp.json / ~/.config/mcp/mcp.json → mcpServers:
    "agent-plan-review": { "command": "${APP_NAME}", "args": ["mcp"] }
  Agents submit with plan_review_submit, then poll plan_review_check.

Environment:
  AGENT_PLAN_REVIEW_HOME     Storage root (default ~/.agent-plan-review)
  AGENT_PLAN_REVIEW_PORT     Server port (default ${cfg.port})
  AGENT_PLAN_REVIEW_TIMEOUT  Hook blocking timeout in seconds (default 1800)
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
