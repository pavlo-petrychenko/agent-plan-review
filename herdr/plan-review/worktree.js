// The other plans of the agent's worktree. Several agents in one worktree each keep their own
// plan (a project of its own, key "<worktree key>.p-<6 hex>"), and a pane shows only its agent's,
// so the header says how many others there are and links to the web UI's project list.
// Pure: no Herdr imports, so node tests load it.

/** How long a count stays fresh. A count is asked for when a plan loads; a repeat load (another
 *  version of the same plan) inside this window reuses it, so browsing versions costs no requests. */
export const COUNT_TTL = 30_000;

/**
 * How many projects of the worktree are not the shown one. `list` is the server's
 * `GET /api/projects?cwd=…`: every plan of the worktree plus its old worktree-wide project.
 * Project keys are opaque strings here (plan keys contain a "."), compared whole.
 */
export function countOthers(list, projectKey) {
  if (!Array.isArray(list)) return 0;
  return list.filter((p) => p && typeof p.key === "string" && p.key !== projectKey && (p.versionCount ?? 1) > 0).length;
}

/** "1 other plan" / "3 other plans"; compact: just the number. */
export function otherPlansLabel(n, compact = false) {
  return compact ? String(n) : `${n} other plan${n === 1 ? "" : "s"}`;
}

export function otherPlansTip(n) {
  return `${n} other plan${n === 1 ? "" : "s"} in this worktree · open the list in the browser`;
}

/** The web page that opens with the project picker showing this worktree's plans. */
export function plansPageUrl(base, pointer) {
  const b = String(base).replace(/\/+$/, "").replace("//127.0.0.1:", "//localhost:");
  return `${b}/?project=${encodeURIComponent(pointer.projectKey)}&picker=1`;
}

/** Whether a worktree's count (`{ n, at }` or undefined) is old enough to ask again. */
export function countStale(entry, now) {
  return !entry || now - entry.at >= COUNT_TTL;
}
