/**
 * Agent identity: which agent submitted a plan, so several agents working in
 * one worktree each keep their own plan (version line, dedup, carried threads)
 * instead of writing into one shared project.
 *
 * Sources, strongest first:
 *  - `claude:<session id>` — Claude Code's session id. The ExitPlanMode hook
 *    gets it as stdin `session_id`; an MCP server Claude Code spawned reads
 *    `CLAUDE_CODE_SESSION_ID`. Both carry the same value, so a hook submit and
 *    an MCP submit from one session map to the same agent.
 *  - `term:<HC_TERMINAL_ID>[:<harness>]` — the Herdr terminal the agent runs in.
 *    One terminal usually hosts one agent at a time; the harness segment keeps
 *    two different harnesses in one terminal apart.
 *  - none → undefined: the caller falls back to the worktree's legacy plan, or
 *    to `processAgentId()` when it lives exactly as long as the agent does.
 *
 * Pure apart from `processAgentId`: the environment is passed in, never read.
 */

export interface AgentIdSource {
  /** Session id the integration received directly (hook stdin `session_id`). */
  sessionId?: string;
  /** Environment to read `CLAUDE_CODE_SESSION_ID` / `HC_TERMINAL_ID` from. */
  env?: NodeJS.ProcessEnv;
  /** Agent harness, e.g. 'claude-code' or the MCP client name. */
  harness?: string;
}

export function agentIdFrom({ sessionId, env = {}, harness }: AgentIdSource): string | undefined {
  const session = sessionId?.trim() || env.CLAUDE_CODE_SESSION_ID?.trim();
  if (session) return `claude:${session}`;
  const terminal = env.HC_TERMINAL_ID?.trim();
  if (terminal) {
    const name = harness?.trim();
    return name ? `term:${terminal}:${name}` : `term:${terminal}`;
  }
  return undefined;
}

let processId: string | undefined;

/**
 * `proc:<uuid>`, minted once per process. For a long-lived integration (the
 * MCP server runs as long as its agent) with no stronger identity: its
 * submissions still form one plan, while a second agent's server gets another.
 */
export function processAgentId(): string {
  processId ??= `proc:${globalThis.crypto.randomUUID()}`;
  return processId;
}
