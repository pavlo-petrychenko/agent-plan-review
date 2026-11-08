import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePointer, terminalOfFile, touchesPointers, planFor, sameDoc, stackActive, harnessName } from "../pointer.js";
import { parseInstall, serverUrl, reviewPageUrl, startScript, pollDelay } from "../server.js";

const P = { reviewId: "r1", projectKey: "repo-abc", version: 2, status: "pending", title: "Plan", cwd: "/w/repo", updatedAt: "2026-01-01T00:00:00Z" };

test("pointer: parse keeps the fields the server writes; junk is no pointer", () => {
  assert.deepEqual(parsePointer(JSON.stringify({ ...P, server: "http://127.0.0.1:4621/" })), { ...P, server: "http://127.0.0.1:4621" });
  assert.equal(parsePointer(JSON.stringify(P)).server, null);
  assert.equal(parsePointer(JSON.stringify({ ...P, status: "weird" })).status, "pending");
  assert.equal(parsePointer(JSON.stringify({ ...P, server: "file:///etc" })).server, null);
  assert.equal(parsePointer("not json"), null);
  assert.equal(parsePointer(JSON.stringify({ ...P, version: 0 })), null);
  assert.equal(parsePointer(JSON.stringify({ ...P, reviewId: "" })), null);
  assert.equal(parsePointer("null"), null);
});

test("pointer files: terminal names and which changed paths matter", () => {
  const dir = "/h/data/plan-review";
  assert.equal(terminalOfFile(`${dir}/t3w.json`), "t3w");
  assert.equal(terminalOfFile(`${dir}/.t3.json.123.tmp`), null);
  assert.equal(terminalOfFile(`${dir}/.hidden.json`), null);
  assert.equal(touchesPointers(`${dir}/t3.json`, dir), true);
  assert.equal(touchesPointers(dir, dir), true);
  assert.equal(touchesPointers(`${dir}/images/a.png`, dir), false);
  assert.equal(touchesPointers(`${dir}/t3.json.1.tmp`, dir), false);
  assert.equal(touchesPointers("/elsewhere/t3.json", dir), false);
});

test("planFor: the focused terminal's plan, else another agent in the focused tab, else none", () => {
  const pointers = new Map([["t1", P], ["t3", { ...P, reviewId: "r3" }]]);
  const panes = [{ tab: "A", terminal: "t2" }, { tab: "A", terminal: "t1" }, { tab: "B", terminal: "t3" }, { tab: "A", terminal: null }];
  assert.deepEqual(planFor(pointers, { tab: "A", terminal: "t1" }, panes), { terminal: "t1", pointer: P });
  assert.equal(planFor(pointers, { tab: "A", terminal: "t2" }, panes).terminal, "t1");
  assert.equal(planFor(pointers, { tab: "A", terminal: null }, panes).terminal, "t1"); // a mod pane is focused
  assert.equal(planFor(pointers, { tab: "C", terminal: "t9" }, panes), null);
  assert.equal(planFor(pointers, null, panes), null);
  assert.equal(sameDoc(P, { ...P, status: "approved" }), true);
  assert.equal(sameDoc(P, { ...P, version: 3 }), false);
});

test("stackActive and harness names", () => {
  const tree = { id: "root", children: [{ id: "work", children: [{ id: "main-stack", type: "stack", active: "plan", children: [] }] }] };
  assert.equal(stackActive(tree), "plan");
  assert.equal(stackActive({ id: "root", children: [] }), null);
  assert.equal(stackActive(null), null);
  assert.equal(harnessName("claude-code"), "Claude Code");
  assert.equal(harnessName("my_mcp-client"), "My Mcp Client");
  assert.equal(harnessName(undefined), null);
});

test("server: URL from the pointer, else the running server's port, else the installed port", () => {
  const install = parseInstall(JSON.stringify({ home: "/apr", port: 4621, start: { command: "/n/node", args: ["/r/cli.js", "serve"], cwd: "/r" } }));
  assert.deepEqual(install, { home: "/apr", port: 4621, start: { command: "/n/node", args: ["/r/cli.js", "serve"], cwd: "/r" } });
  assert.deepEqual(parseInstall("junk"), { home: null, port: 4620, start: null });
  assert.equal(serverUrl({ pointer: { server: "http://localhost:4700" }, install }), "http://127.0.0.1:4700");
  assert.equal(serverUrl({ install, serverJson: '{"port":4800,"pid":1}' }), "http://127.0.0.1:4800");
  assert.equal(serverUrl({ install, serverJson: null }), "http://127.0.0.1:4621");
  assert.equal(serverUrl({ install, serverJson: "{broken" }), "http://127.0.0.1:4621");
  assert.equal(serverUrl(), "http://127.0.0.1:4620");
  assert.equal(reviewPageUrl("http://127.0.0.1:4621", { projectKey: "a b", version: 2, reviewId: "r1" }), "http://localhost:4621/?project=a%20b&version=2&review=r1");
});

test("server: the start script runs serve detached with the store, port and Herdr home", () => {
  const install = parseInstall(JSON.stringify({ home: "/apr home", port: 4621, start: { command: "/n/node", args: ["/r/it's/cli.js", "serve"], cwd: "/r" } }));
  assert.equal(startScript(install, "/h/app"),
    "cd '/r' && AGENT_PLAN_REVIEW_HOME='/apr home' AGENT_PLAN_REVIEW_PORT='4621' HERDR_APP_HOME='/h/app' nohup '/n/node' '/r/it'\\''s/cli.js' 'serve' >/dev/null 2>&1 </dev/null &");
  assert.equal(startScript(parseInstall(null), "/h"), null);
});

test("pollDelay: 2.5 s, then 5 s after 30 s, 15 s after 2 min, 30 s after 10 min", () => {
  assert.deepEqual([0, 29_999, 30_000, 119_999, 120_000, 599_999, 600_000, 3_600_000].map(pollDelay),
    [2_500, 2_500, 5_000, 5_000, 15_000, 15_000, 30_000, 30_000]);
});
