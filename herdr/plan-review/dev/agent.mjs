#!/usr/bin/env node
// A pretend agent for trying the mod: it talks MCP to agent-plan-review exactly like pi or
// Claude Code would, from the terminal it runs in (HC_TERMINAL_ID is passed through).
//
//   node dev/agent.mjs submit <cwd> <plan.md> [name=image.png ...]   → { reviewId, ... }
//   node dev/agent.mjs check [reviewId] [wait_seconds]               → status / newComments
//   node dev/agent.mjs reply <reviewId> <commentId> <body...>
//   node dev/agent.mjs resolve <reviewId> <commentId>
//
// The MCP server is this repo's CLI (dist/ when built, else src/ through tsx). Environment
// (AGENT_PLAN_REVIEW_HOME, AGENT_PLAN_REVIEW_PORT, HERDR_APP_HOME, HC_TERMINAL_ID) is passed on.

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const built = path.join(root, "dist/server/cli.js");
const [cmd, ...rest] = process.argv.slice(2);

function call(name, args) {
  const child = existsSync(built)
    ? spawn(process.execPath, [built, "mcp"], { stdio: ["pipe", "pipe", "inherit"] })
    : spawn(path.join(root, "node_modules/.bin/tsx"), [path.join(root, "src/server/cli.ts"), "mcp"], { stdio: ["pipe", "pipe", "inherit"] });
  const send = (m) => child.stdin.write(`${JSON.stringify(m)}\n`);
  return new Promise((resolve, reject) => {
    let buf = "";
    child.stdout.on("data", (d) => {
      buf += d;
      for (let i; (i = buf.indexOf("\n")) >= 0;) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        const msg = JSON.parse(line);
        if (msg.id === 1) {
          send({ jsonrpc: "2.0", method: "notifications/initialized" });
          send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } });
        } else if (msg.id === 2) {
          child.kill();
          const text = msg.result?.content?.map((c) => c.text).join("\n") ?? "";
          if (msg.error || msg.result?.isError) reject(new Error(msg.error?.message ?? text));
          else resolve(text);
        }
      }
    });
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "fake-agent", version: "1" } } });
  });
}

let out;
if (cmd === "submit") {
  const [cwd, file, ...imgs] = rest;
  const images = imgs.map((s) => { const [name, p] = s.split("="); return { name, path: path.resolve(p) }; });
  out = await call("plan_review_submit", { cwd: path.resolve(cwd), plan: readFileSync(file, "utf8"), ...(images.length ? { images } : {}) });
} else if (cmd === "check") {
  const [reviewId, wait] = rest;
  out = await call("plan_review_check", { ...(reviewId ? { reviewId } : {}), wait_seconds: Number(wait ?? 0) });
} else if (cmd === "reply") {
  const [reviewId, commentId, ...body] = rest;
  out = await call("plan_review_reply", { reviewId, commentId, body: body.join(" ") });
} else if (cmd === "resolve") {
  out = await call("plan_review_resolve", { reviewId: rest[0], commentId: rest[1] });
} else {
  console.error("usage: agent.mjs submit <cwd> <plan.md> [name=img.png …] | check [reviewId] [wait] | reply <reviewId> <commentId> <body…> | resolve <reviewId> <commentId>");
  process.exit(1);
}
console.log(out);
