// A multi-page plan: the text before the first marker is the root page; every other page starts
// with a marker alone on its line:  <!--doc slug=<kebab> title="Title" parent=<slug>-->
// Pure: no Herdr imports, so node tests can load it.

const MARKER = /^<!--doc\s+(.*?)\s*-->\s*$/;
const ATTR = /(\w+)=(?:"([^"]*)"|(\S+))/g;

/** Parses one marker line; null when the line is not a marker. */
export function parseMarker(line) {
  const m = MARKER.exec(line.trim());
  if (!m) return null;
  const attrs = {};
  for (const a of m[1].matchAll(ATTR)) attrs[a[1]] = a[2] ?? a[3];
  return attrs.slug ? attrs : null;
}

const firstHeading = (lines) => {
  for (const l of lines) {
    const m = /^#{1,6}\s+(.*?)\s*#*\s*$/.exec(l);
    if (m) return m[1];
  }
  return null;
};

/**
 * Splits a plan into pages. Each page: { slug, title, parent, depth, lines, startLine }.
 * `lines` are the page's own lines (marker excluded); `startLine` is the 1-based line in the
 * whole file of `lines[0]`, so a word's source line is startLine + its index in `lines`.
 * Parents that do not exist hang under the root; cycles are cut there too.
 */
export function parsePlan(text) {
  const all = String(text ?? "").replace(/\r\n?/g, "\n").split("\n");
  const pages = [];
  let cur = { slug: "root", title: null, parent: null, lines: [], startLine: 1 };
  pages.push(cur);
  all.forEach((line, i) => {
    const m = parseMarker(line);
    if (m) {
      cur = { slug: m.slug, title: m.title ?? null, parent: m.parent ?? "root", lines: [], startLine: i + 2 };
      pages.push(cur);
    } else cur.lines.push(line);
  });
  // A plan whose first line is a marker has an empty root: drop it if nothing is in it.
  if (pages.length > 1 && pages[0].lines.every((l) => !l.trim())) {
    pages.shift();
    for (const p of pages) if (p.parent === "root") p.parent = null;
  }
  return buildTree(pages);
}

/**
 * A plan from the server's documents: `docs` is [{ slug, title, parent, markdown }] in
 * manifest order, `root` the root slug. Every page is its own document, so its lines start at
 * line 1 — the line numbers comments use.
 */
export function planFromDocs(docs, root) {
  const list = docs.map((d) => ({
    slug: d.slug,
    title: d.title || null,
    parent: d.slug === root ? null : d.parent ?? root,
    lines: String(d.markdown ?? "").replace(/\r\n?/g, "\n").split("\n"),
    startLine: 1,
  }));
  const at = list.findIndex((p) => p.slug === root);
  if (at > 0) list.unshift(...list.splice(at, 1));
  if (!list.length) list.push({ slug: root || "root", title: null, parent: null, lines: [""], startLine: 1 });
  return buildTree(list);
}

/**
 * The plan of a diff: its pages plus those only the base version has (`removed`: [{ slug, title,
 * parent }]), which are empty pages marked `removed`. The plan itself is not changed.
 */
export function planWithRemoved(plan, removed) {
  if (!removed.length) return plan;
  const have = new Set(plan.pages.map((p) => p.slug));
  const pages = plan.pages.map((p) => ({ ...p }));
  for (const r of removed) {
    if (have.has(r.slug)) continue;
    pages.push({ slug: r.slug, title: r.title || null, parent: r.parent ?? plan.root, lines: [], startLine: 1, removed: true });
  }
  return buildTree(pages);
}

// Pages (the first is the root) → the tree: titles, parents, depth, reading order.
function buildTree(pages) {
  const bySlug = new Map();
  for (const p of pages) if (!bySlug.has(p.slug)) bySlug.set(p.slug, p);
  const rootSlug = pages[0].slug;
  for (const p of pages) {
    p.title = p.title || firstHeading(p.lines) || p.slug;
    if (p === pages[0]) { p.parent = null; continue; }
    if (!p.parent || !bySlug.has(p.parent) || p.parent === p.slug) p.parent = rootSlug;
  }
  // Cut cycles: walk up; if we come back, re-hang under the root.
  for (const p of pages) {
    const seen = new Set([p.slug]);
    let q = p.parent ? bySlug.get(p.parent) : null;
    while (q) {
      if (seen.has(q.slug)) { p.parent = rootSlug; break; }
      seen.add(q.slug);
      q = q.parent ? bySlug.get(q.parent) : null;
    }
  }
  const unique = [...bySlug.values()];
  const children = new Map(unique.map((p) => [p.slug, []]));
  for (const p of unique) if (p.parent) children.get(p.parent).push(p.slug);
  // Depth-first order = reading order of the tree (sidebar order, next/prev order).
  const order = [];
  const walk = (slug, depth) => {
    const p = bySlug.get(slug);
    p.depth = depth;
    order.push(slug);
    for (const c of children.get(slug)) walk(c, depth + 1);
  };
  walk(rootSlug, 0);
  return { pages: order.map((s) => bySlug.get(s)), bySlug, children, root: rootSlug, title: bySlug.get(rootSlug).title };
}

/** `slug` when the plan has that page (switching versions keeps the page), else the root. */
export function pageOr(plan, slug) {
  return slug && plan.bySlug.has(slug) ? slug : plan.root;
}

/** The page before or after `slug` in tree order (wraps: no). */
export function neighbour(plan, slug, step) {
  const i = plan.pages.findIndex((p) => p.slug === slug);
  const j = i + step;
  return j >= 0 && j < plan.pages.length ? plan.pages[j].slug : null;
}

/** Root-first chain of pages above `slug`, not including it. */
export function ancestors(plan, slug) {
  const out = [];
  let p = plan.bySlug.get(slug);
  while (p && p.parent) { p = plan.bySlug.get(p.parent); if (p) out.unshift(p); }
  return out;
}

/**
 * Sidebar rows: every page with its depth, and for each depth above it whether a vertical guide
 * continues (a later sibling exists at that level) — enough to draw a tidy tree.
 */
export function treeRows(plan) {
  const rows = [];
  const walk = (slug, guides) => {
    const kids = plan.children.get(slug) ?? [];
    rows.push({ slug, title: plan.bySlug.get(slug).title, depth: guides.length, guides, hasChildren: kids.length > 0 });
    kids.forEach((k, i) => walk(k, [...guides, i < kids.length - 1]));
  };
  walk(plan.root, []);
  return rows;
}
