import { test } from "node:test";
import assert from "node:assert/strict";
import { versionList, shownVersion, pointerFor, diffBase, stepBase, switcherWindow, neighbourVersion, diffIndex, VERSION_STATES, PAGE_MARKS } from "../versions.js";
import { planFromDocs, planWithRemoved, pageOr, treeRows, neighbour } from "../plan.js";
import { createApi } from "../api.js";

const VERSIONS = [{ n: 3, createdAt: "2026-01-03T00:00:00Z", docCount: 2 }, { n: 1, createdAt: "2026-01-01T00:00:00Z", docCount: 1 }, { n: 2, createdAt: "2026-01-02T00:00:00Z", docCount: 2 }];
const REVIEWS = [
  { id: "r1", version: 1, status: "rejected", createdAt: "2026-01-01T01:00:00Z" },
  { id: "r2", version: 2, status: "approved", createdAt: "2026-01-02T01:00:00Z" },
  { id: "r2b", version: 2, status: "rejected", createdAt: "2026-01-02T05:00:00Z" },
  { id: "r3", version: 3, status: "pending", createdAt: "2026-01-03T01:00:00Z" },
];

test("versionList: oldest first, each with the state of its newest review", () => {
  const list = versionList(VERSIONS, REVIEWS);
  assert.deepEqual(list.map((v) => [v.n, v.status, v.reviewId]), [[1, "rejected", "r1"], [2, "rejected", "r2b"], [3, "pending", "r3"]]);
  assert.equal(list[2].docCount, 2);
  for (const v of list) assert.ok(v.status in VERSION_STATES);
});

test("versionList: a version with no review is 'none'; junk is ignored", () => {
  const list = versionList([{ n: 1 }, { n: 2 }, null, { n: "x" }], [{ id: "a", version: 2, status: "approved" }, { id: "b", version: 9, status: "approved" }, null]);
  assert.deepEqual(list.map((v) => [v.n, v.status, v.reviewId]), [[1, "none", ""], [2, "approved", "a"]]);
  assert.deepEqual(versionList(undefined, undefined), []);
  assert.equal(versionList([{ n: 1 }], [{ id: "a", version: 1, status: "bogus" }])[0].status, "none");
});

test("shownVersion: a pick holds while the pointer is on the version it was made on; a newer plan brings the newest back", () => {
  const list = versionList(VERSIONS, REVIEWS);
  assert.equal(shownVersion(3, null, list), 3);
  assert.equal(shownVersion(3, { n: 1, follow: 3 }, list), 1);
  assert.equal(shownVersion(4, { n: 1, follow: 3 }, list), 4, "the agent submitted v4: show it");
  assert.equal(shownVersion(3, { n: 7, follow: 3 }, list), 3, "a version that does not exist is ignored");
  assert.equal(shownVersion(3, { n: 3, follow: 3 }, []), 3);
});

test("pointerFor: another version takes its review; the newest keeps the pointer's own", () => {
  const list = versionList(VERSIONS, REVIEWS);
  const ptr = { reviewId: "r3", projectKey: "p", version: 3, status: "pending", title: "T", cwd: "/x", updatedAt: "u" };
  assert.equal(pointerFor(ptr, 3, list), ptr);
  assert.deepEqual(pointerFor(ptr, 1, list), { ...ptr, version: 1, reviewId: "r1", status: "rejected" });
  const none = versionList([{ n: 1 }, { n: 2 }], []);
  assert.deepEqual([pointerFor(ptr, 1, none).reviewId, pointerFor(ptr, 1, none).version], ["", 1]);
});

test("diffBase: the previous version by default, a chosen older one, none for the first", () => {
  const list = versionList([{ n: 1 }, { n: 2 }, { n: 4 }, { n: 5 }], []);
  assert.equal(diffBase(5, null, list), 4);
  assert.equal(diffBase(5, 2, list), 2);
  assert.equal(diffBase(5, 5, list), 4, "not older than the shown one");
  assert.equal(diffBase(5, 3, list), 4, "a version that does not exist (deleted)");
  assert.equal(diffBase(2, null, list), 1);
  assert.equal(diffBase(1, null, list), null);
});

test("stepBase: moves between the versions older than the shown one and stops at the ends", () => {
  const list = versionList([{ n: 1 }, { n: 2 }, { n: 3 }, { n: 4 }], []);
  assert.equal(stepBase(4, 3, -1, list), 2);
  assert.equal(stepBase(4, 2, -1, list), 1);
  assert.equal(stepBase(4, 1, -1, list), 1);
  assert.equal(stepBase(4, 3, 1, list), 3, "not past the shown version");
  assert.equal(stepBase(4, 1, 1, list), 2);
});

test("switcherWindow: all versions when they fit; else a window around the shown one, clamped to the ends", () => {
  const list = versionList(Array.from({ length: 10 }, (_, i) => ({ n: i + 1 })), []);
  const ns = (w) => w.items.map((v) => v.n);
  assert.deepEqual(switcherWindow(list.slice(0, 4), 2), { items: list.slice(0, 4), before: 0, after: 0 });
  let w = switcherWindow(list, 10, 6);
  assert.deepEqual([ns(w), w.before, w.after], [[5, 6, 7, 8, 9, 10], 4, 0]);
  w = switcherWindow(list, 1, 6);
  assert.deepEqual([ns(w), w.before, w.after], [[1, 2, 3, 4, 5, 6], 0, 4]);
  w = switcherWindow(list, 5, 6);
  assert.ok(ns(w).includes(5));
  assert.equal(w.before + w.items.length + w.after, 10);
  assert.equal(neighbourVersion(list, 5, -1), 4);
  assert.equal(neighbourVersion(list, 10, 1), null);
  assert.equal(neighbourVersion(list, 99, 1), null);
});

const DIFF = {
  from: { n: 1 }, to: { n: 2 },
  docs: [
    { slug: "root", title: "Plan", parent: null, status: "modified", from: "# Plan\nold", to: "# Plan\nnew" },
    { slug: "impl", title: "Implementation", parent: "root", status: "unchanged" },
    { slug: "notes", title: "Notes", parent: "root", status: "added", from: "", to: "n" },
    { slug: "risks", title: "Risks", parent: "root", status: "removed", from: "# Risks\nr", to: "" },
  ],
};

test("diffIndex: statuses, old texts, removed pages and the changed count from the server's diff", () => {
  const x = diffIndex(DIFF);
  assert.deepEqual([...x.status], [["root", "modified"], ["impl", "unchanged"], ["notes", "added"], ["risks", "removed"]]);
  assert.equal(x.from.get("root"), "# Plan\nold");
  assert.equal(x.from.get("notes"), "");
  assert.equal(x.from.has("impl"), false, "unchanged pages carry no text");
  assert.deepEqual(x.removed, [{ slug: "risks", title: "Risks", parent: "root" }]);
  assert.equal(x.changed, 3);
  assert.deepEqual(diffIndex(null).removed, []);
  for (const k of ["added", "removed", "modified"]) assert.ok(PAGE_MARKS[k].icon && PAGE_MARKS[k].label);
});

test("planWithRemoved: pages only the base had join the tree (empty, marked removed); the plan itself is not touched", () => {
  const plan = planFromDocs([
    { slug: "root", title: "Plan", parent: null, markdown: "# Plan" },
    { slug: "impl", title: "Implementation", parent: "root", markdown: "# Impl" },
    { slug: "notes", title: "Notes", parent: "root", markdown: "n" },
  ], "root");
  const union = planWithRemoved(plan, diffIndex(DIFF).removed);
  assert.deepEqual(union.pages.map((p) => p.slug), ["root", "impl", "notes", "risks"]);
  assert.equal(union.bySlug.get("risks").removed, true);
  assert.equal(union.bySlug.get("risks").parent, "root");
  assert.deepEqual(treeRows(union).map((r) => [r.slug, r.depth]), [["root", 0], ["impl", 1], ["notes", 1], ["risks", 1]]);
  assert.equal(neighbour(union, "notes", 1), "risks");
  assert.equal(plan.pages.length, 3);
  // Switching versions keeps the page when the other version has it, else the root.
  assert.equal(pageOr(plan, "notes"), "notes");
  assert.equal(pageOr(plan, "risks"), "root");
  assert.equal(pageOr(union, "risks"), "risks");
  assert.equal(pageOr(plan, null), "root");
  assert.equal(plan.bySlug.has("risks"), false);
  assert.equal(planWithRemoved(plan, []), plan);
  // A removed page whose parent was removed too hangs under it; a missing parent hangs under the root.
  const deep = planWithRemoved(plan, [{ slug: "a", title: "A", parent: "root" }, { slug: "b", title: "B", parent: "a" }, { slug: "c", title: "C", parent: "zzz" }]);
  assert.deepEqual(treeRows(deep).map((r) => [r.slug, r.depth]), [["root", 0], ["impl", 1], ["notes", 1], ["a", 1], ["b", 2], ["c", 1]]);
});

test("api: project, reviews of a project and the diff use the web UI's routes", async () => {
  const calls = [];
  const fn = async (url) => {
    const u = new URL(url);
    calls.push(u.pathname + u.search);
    const body = u.pathname.endsWith("/diff") ? DIFF : u.pathname === "/api/reviews" ? REVIEWS : { meta: {}, versions: VERSIONS };
    return { ok: true, status: 200, text: async () => JSON.stringify(body) };
  };
  const api = createApi("http://127.0.0.1:4621", fn);
  assert.equal((await api.project("my key")).versions.length, 3);
  assert.equal((await api.reviewsOf("my key")).length, 4);
  assert.equal((await api.diff("my key", 1, 2)).docs.length, 4);
  assert.deepEqual(calls, ["/api/projects/my%20key", "/api/reviews?project=my%20key", "/api/projects/my%20key/diff?from=1&to=2"]);
});
