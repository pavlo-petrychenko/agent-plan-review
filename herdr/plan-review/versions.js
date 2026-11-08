// Versions of a plan: the switcher's list with each version's review state, which version is
// shown, which one a diff compares against, and the per-page change markers. Pure.

/** A version's state, from its review: what the switcher shows. */
export const VERSION_STATES = {
  pending: { label: "Waiting for review", icon: "clock", color: "ansi3" },
  rejected: { label: "Changes requested", icon: "pencil", color: "ansi1" },
  approved: { label: "Approved", icon: "check", color: "ansi2" },
  none: { label: "No review", icon: "file", color: "dim" },
};

const time = (iso) => { const t = Date.parse(iso); return Number.isFinite(t) ? t : 0; };

/**
 * `versions` (GET /api/projects/:key → versions: [{ n, createdAt, kind, docCount }]) and the
 * project's `reviews` (GET /api/reviews?project=…) → [{ n, createdAt, docCount, status, reviewId }],
 * oldest first. A version with several reviews takes the newest one's state.
 */
export function versionList(versions, reviews) {
  const byVersion = new Map();
  for (const r of reviews ?? []) {
    if (!r || !Number.isInteger(r.version)) continue;
    const cur = byVersion.get(r.version);
    if (!cur || time(r.createdAt) >= time(cur.createdAt)) byVersion.set(r.version, r);
  }
  return [...(versions ?? [])]
    .filter((v) => v && Number.isInteger(v.n))
    .sort((a, b) => a.n - b.n)
    .map((v) => {
      const r = byVersion.get(v.n);
      const status = r && r.status in VERSION_STATES && r.status !== "none" ? r.status : "none";
      return { n: v.n, createdAt: v.createdAt ?? null, docCount: v.docCount ?? 1, status, reviewId: r?.id ?? "" };
    });
}

/** The version to show: the user's pick while the pointer still names the version it was made on, else the pointer's. */
export function shownVersion(pointerVersion, pick, list) {
  if (!pick || pick.follow !== pointerVersion) return pointerVersion;
  return list.some((v) => v.n === pick.n) || pick.n === pointerVersion ? pick.n : pointerVersion;
}

/** The pointer for another version of the same plan: its review (if any) and state. */
export function pointerFor(pointer, n, list) {
  if (n === pointer.version) return pointer;
  const v = list.find((x) => x.n === n);
  return { ...pointer, version: n, reviewId: v?.reviewId ?? "", status: v && v.status !== "none" ? v.status : "pending" };
}

/** The version a diff of `shown` compares against: the chosen one if it is older and exists, else the previous one; null for the first. */
export function diffBase(shown, chosen, list) {
  const older = list.filter((v) => v.n < shown).map((v) => v.n);
  if (!older.length) return null;
  return chosen != null && older.includes(chosen) ? chosen : older[older.length - 1];
}

/** The base one step older (-1) or newer (+1) than `base`, still older than `shown`; `base` when there is none. */
export function stepBase(shown, base, step, list) {
  const older = list.filter((v) => v.n < shown).map((v) => v.n);
  const at = older.indexOf(base);
  const to = older[at + step];
  return at >= 0 && to != null ? to : base;
}

/**
 * The versions the switcher draws: all of them up to `max`; more are cut to a window of `max`
 * that is centred on the shown version (clamped to the ends).
 * → { items: [version], before: older ones left out, after: newer ones left out }.
 */
export function switcherWindow(list, shown, max = 6) {
  if (list.length <= max) return { items: list, before: 0, after: 0 };
  const at = Math.max(0, list.findIndex((v) => v.n === shown));
  const from = Math.min(list.length - max, Math.max(0, at - Math.floor(max / 2)));
  return { items: list.slice(from, from + max), before: from, after: list.length - from - max };
}

/** The version `step` places from `shown` (-1 older, +1 newer), or null at the end. */
export function neighbourVersion(list, shown, step) {
  const i = list.findIndex((v) => v.n === shown);
  const v = i < 0 ? null : list[i + step];
  return v ? v.n : null;
}

/**
 * The server's diff (GET /api/projects/:key/diff) → what the view needs:
 * { status: Map(slug → "added" | "removed" | "modified" | "unchanged"), removed: [{ slug, title, parent }], from: Map(slug → old text), changed: count of changed pages }.
 */
export function diffIndex(payload) {
  const status = new Map(), from = new Map(), removed = [];
  let changed = 0;
  for (const d of payload?.docs ?? []) {
    status.set(d.slug, d.status);
    if (d.status !== "unchanged") changed++;
    if (typeof d.from === "string") from.set(d.slug, d.from);
    if (d.status === "removed") removed.push({ slug: d.slug, title: d.title ?? d.slug, parent: d.parent ?? null });
  }
  return { status, removed, from, changed };
}

/** The marker a page shows in the tree in diff mode, or null. */
export const PAGE_MARKS = {
  added: { icon: "plus", color: "ansi2", label: "Added in this version" },
  removed: { icon: "minus", color: "ansi1", label: "Removed in this version" },
  modified: { icon: "pencil", color: "ansi3", label: "Changed in this version" },
};
