import { test } from "node:test";
import assert from "node:assert/strict";
import { createApi, ApiError, loadErrorText } from "../api.js";
import { delivery, withDelivery, sentLabel, decisionState } from "../review.js";

// A fake fetch: records each call, answers from a table of "METHOD path" → [status, body].
function fakeFetch(routes) {
  const calls = [];
  const fn = async (url, init = {}) => {
    const u = new URL(url);
    const key = `${init.method ?? "GET"} ${u.pathname}${u.search}`;
    calls.push({ key, body: init.body ? JSON.parse(init.body) : undefined, headers: init.headers });
    if (!(key in routes)) return { ok: false, status: 404, text: async () => JSON.stringify({ error: `no route ${key}` }) };
    const [status, body] = routes[key];
    return { ok: status < 400, status, text: async () => (body == null ? "" : JSON.stringify(body)) };
  };
  return { fn, calls };
}

test("api: comment, reply, resolve, delete and decision use the web UI's routes and payloads", async () => {
  const { fn, calls } = fakeFetch({
    "POST /api/projects/my%20key/versions/2/comments": [201, { id: "c1" }],
    "POST /api/projects/my%20key/versions/2/comments/c1/replies": [201, { id: "c2" }],
    "POST /api/projects/my%20key/versions/2/comments/c1/resolve": [200, { id: "c1", resolved: false }],
    "DELETE /api/projects/my%20key/versions/2/comments/c1": [200, { ok: true }],
    "POST /api/reviews/r1/decision": [200, { review: { id: "r1", status: "rejected" }, commentCount: 1 }],
    "GET /api/projects/my%20key/versions/2/comments": [200, { comments: [{ id: "c1" }] }],
    "GET /api/reviews/r1": [200, { id: "r1" }],
  });
  const api = createApi("http://127.0.0.1:4621/", fn);
  assert.equal(api.base, "http://127.0.0.1:4621");
  const input = { doc: "root", line: 3, lineEnd: 3, quote: "q", range: { start: 4, end: 9 }, body: "why?", delivery: "ask", reviewId: "r1" };
  assert.deepEqual(await api.addComment("my key", 2, input), { id: "c1" });
  await api.reply("my key", 2, "c1", { body: "and?", delivery: "decision", reviewId: "r1" });
  await api.resolve("my key", 2, "c1", false);
  await api.remove("my key", 2, "c1");
  assert.equal((await api.decide("r1", "reject", "Split step 2")).commentCount, 1);
  await api.decide("r1", "approve");
  assert.deepEqual(await api.comments("my key", 2), [{ id: "c1" }]);
  assert.deepEqual(calls[0].body, input);
  assert.equal(calls[0].headers["content-type"], "application/json");
  assert.deepEqual(calls[1].body, { body: "and?", delivery: "decision", reviewId: "r1" });
  assert.deepEqual(calls[2].body, { resolved: false });
  assert.deepEqual(calls[4].body, { decision: "reject", summary: "Split step 2" });
  assert.deepEqual(calls[5].body, { decision: "approve" });
});

test("api: a single version is one root page; a tree version loads each document", async () => {
  const { fn } = fakeFetch({
    "GET /api/projects/k/versions/1": [200, { n: 1, kind: "single", markdown: "# One" }],
    "GET /api/projects/k/versions/2": [200, { n: 2, kind: "tree", manifest: { root: "top", docs: [{ slug: "top", title: "Top", parent: null }, { slug: "a b", title: "A", parent: "top" }] } }],
    "GET /api/projects/k/versions/2/docs/top": [200, { slug: "top", markdown: "# Top" }],
    "GET /api/projects/k/versions/2/docs/a%20b": [200, { slug: "a b", markdown: "# A" }],
  });
  const api = createApi("http://127.0.0.1:1", fn);
  assert.deepEqual(await api.plan("k", 1), { kind: "single", root: "root", docs: [{ slug: "root", title: null, parent: null, markdown: "# One" }] });
  const tree = await api.plan("k", 2);
  assert.equal(tree.root, "top");
  assert.deepEqual(tree.docs.map((d) => [d.slug, d.title, d.parent, d.markdown]), [["top", "Top", null, "# Top"], ["a b", "A", "top", "# A"]]);
});

test("api: errors carry the server's message; no answer at all means the server is down", async () => {
  const { fn } = fakeFetch({ "POST /api/reviews/r1/decision": [409, { error: "Review already resolved" }] });
  const api = createApi("http://127.0.0.1:1", fn);
  await assert.rejects(api.decide("r1", "approve"), (e) => e instanceof ApiError && e.status === 409 && e.message === "Review already resolved" && !e.down);
  await assert.rejects(api.review("nope"), (e) => e.status === 404 && !e.down);
  const down = createApi("http://127.0.0.1:1", async () => { throw new TypeError("fetch failed"); });
  await assert.rejects(down.health(), (e) => e instanceof ApiError && e.down && e.status === 0);
  const broken = createApi("http://127.0.0.1:1", async () => ({ ok: false, status: 500, text: async () => "<html>" }));
  await assert.rejects(broken.health(), (e) => e.status === 500 && e.message === "Request failed (500)");
});

test("delivery: Ask only on a pending mcp/hook review of this version; reviewId as the web UI sends it", () => {
  const mcp = { id: "r1", status: "pending", origin: "mcp", version: 2 };
  assert.deepEqual([delivery(mcp, 2).onVersion, delivery(mcp, 2).canAsk, delivery(mcp, 2).decisionLabel], [true, true, "Add to decision"]);
  assert.equal(delivery({ ...mcp, origin: "hook" }, 2).canAsk, true);
  assert.equal(delivery({ ...mcp, origin: "api" }, 2).canAsk, false);
  assert.deepEqual([delivery(mcp, 1).onVersion, delivery(mcp, 1).decisionLabel], [false, "Add note"]);
  assert.equal(delivery({ ...mcp, status: "approved" }, 2).decided, true);
  assert.equal(delivery(null, 2).onVersion, false);

  assert.deepEqual(withDelivery({ body: "x" }, mcp, 2, "ask"), { body: "x", delivery: "ask", reviewId: "r1" });
  assert.deepEqual(withDelivery({ body: "x" }, mcp, 2), { body: "x", delivery: "decision", reviewId: "r1" });
  // Not askable: an Ask falls back to the decision batch.
  assert.deepEqual(withDelivery({ body: "x" }, { ...mcp, origin: "api" }, 2, "ask"), { body: "x", delivery: "decision", reviewId: "r1" });
  // Decided or another version: a plain note with no review.
  assert.deepEqual(withDelivery({ body: "x" }, { ...mcp, status: "rejected" }, 2, "ask"), { body: "x", delivery: "decision" });
  assert.equal(sentLabel({ delivery: "ask" }, mcp, 2), "Asked the agent");
  assert.equal(sentLabel({ delivery: "decision" }, mcp, 2), "Added to the decision");
  assert.equal(sentLabel({ delivery: "decision" }, mcp, 1), "Note added");
});

test("decisionState: the bar's label per review status", () => {
  assert.equal(decisionState({ status: "pending" }).label, "Waiting for your review");
  assert.equal(decisionState({ status: "approved" }).label, "Approved");
  assert.equal(decisionState({ status: "approved", notes: "x" }).label, "Approved with comments");
  assert.equal(decisionState({ status: "rejected" }).tone, "blocked");
  assert.equal(decisionState(null).label, "No review");
});

test("loadErrorText names Herdr's task limit and keeps other messages", () => {
  assert.match(loadErrorText(new Error("cx.spawn(fn) exceeded the per-runtime outstanding host task limit of 1024")), /Restart Herdr/);
  assert.equal(loadErrorText(new Error("Request failed (500)")), "Request failed (500)");
  assert.equal(loadErrorText("boom"), "boom");
});
