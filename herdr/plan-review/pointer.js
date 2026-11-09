// Which plan belongs to which agent. Pure: no Herdr imports, so node tests load it.
//
// agent-plan-review (with `agent-plan-review herdr enable`) writes one pointer file per agent
// terminal, `<app home>/data/plan-review/<terminal>.json`, on every submit, agent reply,
// resolve and decision (src/server/integrations/herdr.ts `HerdrPointer`):
//   { reviewId, projectKey, version, status, title, cwd, updatedAt, server? }
// A terminal's pointer always names its newest review.

export const POINTER_DIR = "data/plan-review";
export const IMAGE_DIR = "data/plan-review/images";
export const STACK = "main-stack"; // the layout stack that holds the tab area and the plan
export const AGENT_VIEW = "main";
export const PLAN_VIEW = "plan";
export const VIEW_KEY = "plan-review.view"; // shared: the side last flipped to (set by the flip)

export const NOTIFIED_KEY = "plan-review.notified"; // shared: terminal → the last plan announced ("reviewId@version")

/** The identity of a submitted plan version, for announcing it once. */
export const noticeKey = (ptr) => `${ptr.reviewId}@${ptr.version}`;

/** Whether a pointer is a plan to announce: waiting for review, and not announced for its terminal yet. */
export function planNotice(ptr, announced) {
  return !!ptr && ptr.status === "pending" && announced !== noticeKey(ptr);
}

export const STATES = {
  pending: { label: "Waiting for review", color: "ansi3" },
  approved: { label: "Approved", color: "ansi2" },
  rejected: { label: "Changes requested", color: "ansi1" },
};

const TERMINAL_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** A pointer file's text → the pointer, or null when it is not one. */
export function parsePointer(text) {
  let v;
  try { v = JSON.parse(text); } catch { return null; }
  if (!v || typeof v !== "object") return null;
  if (typeof v.reviewId !== "string" || !v.reviewId || typeof v.projectKey !== "string" || !v.projectKey) return null;
  const version = Number(v.version);
  if (!Number.isInteger(version) || version < 1) return null;
  return {
    reviewId: v.reviewId,
    projectKey: v.projectKey,
    version,
    status: STATES[v.status] ? v.status : "pending",
    title: typeof v.title === "string" ? v.title : "Plan",
    cwd: typeof v.cwd === "string" ? v.cwd : "",
    updatedAt: typeof v.updatedAt === "string" ? v.updatedAt : "",
    server: typeof v.server === "string" && /^https?:\/\//.test(v.server) ? v.server.replace(/\/+$/, "") : null,
  };
}

/** The terminal a pointer file is for ("…/data/plan-review/t3.json" → "t3"), or null. */
export function terminalOfFile(path) {
  const m = /\/([^/]+)\.json$/.exec(String(path));
  return m && TERMINAL_RE.test(m[1]) ? m[1] : null;
}

/** Whether a changed path (from watchFolder) may change the pointers. */
export function touchesPointers(path, dir) {
  if (path === dir || path === `${dir}/`) return true;
  if (!String(path).startsWith(`${dir}/`)) return false;
  const rest = path.slice(dir.length + 1);
  return !rest.includes("/") && rest.endsWith(".json");
}

/**
 * The plan to show: the focused terminal's pointer, else the pointer of another terminal in the
 * focused tab (in pane order). `pointers`: Map(terminal → pointer). → { terminal, pointer } | null.
 */
export function planFor(pointers, focused, panes) {
  if (!focused) return null;
  const own = focused.terminal && pointers.get(focused.terminal);
  if (own) return { terminal: focused.terminal, pointer: own };
  for (const p of panes ?? []) {
    if (p.tab !== focused.tab || !p.terminal) continue;
    const e = pointers.get(p.terminal);
    if (e) return { terminal: p.terminal, pointer: e };
  }
  return null;
}

/** Two pointers name the same version of the same review. */
export const sameDoc = (a, b) => !!a && !!b && a.projectKey === b.projectKey && a.version === b.version;

/** The active child of the stack `id` in a layout tree, or null if the tree does not say. */
export function stackActive(tree, id = STACK) {
  if (!tree || typeof tree !== "object") return null;
  if (tree.id === id) return typeof tree.active === "string" ? tree.active : null;
  for (const c of tree.children ?? []) {
    const r = stackActive(c, id);
    if (r) return r;
  }
  return null;
}

/** "claude-code" → "Claude Code"; unknown harness names are title-cased. */
export function harnessName(harness) {
  if (!harness) return null;
  const known = { "claude-code": "Claude Code", pi: "pi", codex: "Codex" };
  if (known[harness]) return known[harness];
  return String(harness).split(/[-_\s]+/).filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join(" ");
}
