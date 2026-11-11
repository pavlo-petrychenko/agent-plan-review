import { test } from "node:test";
import assert from "node:assert/strict";
import { COUNT_TTL, countOthers, otherPlansLabel, otherPlansTip, plansPageUrl, countStale } from "../worktree.js";
import { createApi } from "../api.js";
import { parsePointer, terminalOfFile } from "../pointer.js";
import { reviewPageUrl } from "../server.js";

const PLAN = "repo-1a2b3c4d.p-3f9a1c";

test("worktree: the others are the worktree's projects except the shown one", () => {
  const list = [
    { key: PLAN, versionCount: 2 },
    { key: "repo-1a2b3c4d.p-aaaaaa", versionCount: 1 },
    { key: "repo-1a2b3c4d", versionCount: 3 }, // the old worktree plan counts too
    { key: "repo-1a2b3c4d.p-bbbbbb", versionCount: 0 }, // nothing to open
  ];
  assert.equal(countOthers(list, PLAN), 2);
  assert.equal(countOthers([{ key: PLAN }], PLAN), 0);
  assert.equal(countOthers(list, "gone"), 3);
  assert.equal(countOthers(null, PLAN), 0);
  assert.equal(countOthers([null, {}], PLAN), 0);
});

test("worktree: labels", () => {
  assert.equal(otherPlansLabel(1), "1 other plan");
  assert.equal(otherPlansLabel(3), "3 other plans");
  assert.equal(otherPlansLabel(3, true), "3");
  assert.match(otherPlansTip(2), /^2 other plans in this worktree/);
});

test("worktree: the link opens the web UI on this project with the picker, key URL-encoded", () => {
  assert.equal(plansPageUrl("http://127.0.0.1:4621/", { projectKey: PLAN }), `http://localhost:4621/?project=${PLAN}&picker=1`);
  assert.equal(plansPageUrl("http://127.0.0.1:4621", { projectKey: "a b/c.p-111111" }), "http://localhost:4621/?project=a%20b%2Fc.p-111111&picker=1");
});

test("worktree: a count is stale after the ttl, or when never asked", () => {
  assert.equal(countStale(undefined, 1000), true);
  assert.equal(countStale({ n: 2, at: 1000 }, 1000 + COUNT_TTL - 1), false);
  assert.equal(countStale({ n: 2, at: 1000 }, 1000 + COUNT_TTL), true);
});

test("worktree: the api asks for the worktree's projects with the path encoded", async () => {
  const calls = [];
  const fn = async (url) => {
    calls.push(new URL(url).pathname + new URL(url).search);
    return { ok: true, status: 200, text: async () => JSON.stringify([{ key: PLAN }]) };
  };
  const api = createApi("http://127.0.0.1:4621", fn);
  assert.deepEqual(await api.projectsIn("/w/my repo"), [{ key: PLAN }]);
  assert.deepEqual(calls, ["/api/projects?cwd=%2Fw%2Fmy%20repo"]);
});

test("plan keys with a dot are opaque everywhere in the mod", async () => {
  const calls = [];
  const fn = async (url, init = {}) => {
    calls.push(`${init.method ?? "GET"} ${new URL(url).pathname}${new URL(url).search}`);
    return { ok: true, status: 200, text: async () => JSON.stringify({ comments: [], versions: [] }) };
  };
  const api = createApi("http://127.0.0.1:4621", fn);
  await api.project(PLAN);
  await api.reviewsOf(PLAN);
  await api.comments(PLAN, 2);
  await api.addComment(PLAN, 2, { body: "x" });
  await api.diff(PLAN, 1, 2);
  assert.deepEqual(calls, [
    `GET /api/projects/${PLAN}`,
    `GET /api/reviews?project=${PLAN}`,
    `GET /api/projects/${PLAN}/versions/2/comments`,
    `POST /api/projects/${PLAN}/versions/2/comments`,
    `GET /api/projects/${PLAN}/diff?from=1&to=2`,
  ]);
  const ptr = parsePointer(JSON.stringify({ reviewId: "r1", projectKey: PLAN, version: 2, status: "pending", title: "Plan", cwd: "/w/repo" }));
  assert.equal(ptr.projectKey, PLAN);
  assert.equal(reviewPageUrl("http://127.0.0.1:4621", ptr), `http://localhost:4621/?project=${PLAN}&version=2&review=r1`);
  // Pointer files are named by terminal, never by project key.
  assert.equal(terminalOfFile("/h/data/plan-review/t5d.json"), "t5d");
});
