// Render units: a page is drawn as retained child views, one per unit, so a selection step redraws
// only the units whose words changed tint. A unit is a whole small block (heading, paragraph,
// quote, image, rule) or a chunk of a big one (list items, table rows, code lines). Pure.

export const CHUNK = 40; // items, rows or lines per unit

/**
 * blocks → { units: [{ id, block, kind, from, to }], wordUnit: Int32Array(word count) }.
 * `from`/`to` index the block's items / rows (0 = header) / lines, half-open.
 */
export function makeUnits(blocks, wordCount, chunk = CHUNK) {
  const units = [];
  const wordUnit = new Int32Array(wordCount).fill(-1);
  const mark = (flow, u) => { for (const w of flow.words) wordUnit[w.i] = u; };
  const marks = (b, u) => {
    if (b.flow) mark(b.flow, u);
    if (b.type === "quote") b.blocks.forEach((x) => marks(x, u));
    if (b.type === "list") b.items.forEach((it) => mark(it.flow, u));
    if (b.type === "table") [b.header, ...b.rows].forEach((r) => r.forEach((f) => mark(f, u)));
    if (b.type === "code") b.lines.forEach((l) => mark(l, u));
  };
  blocks.forEach((b, k) => {
    const parts = b.type === "list" ? b.items : b.type === "table" ? [b.header, ...b.rows] : b.type === "code" ? b.lines : null;
    if (!parts || parts.length <= chunk) {
      const u = units.length;
      units.push({ id: u, block: k, kind: "whole", from: 0, to: parts ? parts.length : 0 });
      marks(b, u);
      return;
    }
    for (let from = 0; from < parts.length; from += chunk) {
      const u = units.length;
      const to = Math.min(parts.length, from + chunk);
      units.push({ id: u, block: k, kind: "part", from, to });
      for (let n = from; n < to; n++) {
        if (b.type === "list") mark(parts[n].flow, u);
        else if (b.type === "table") parts[n].forEach((f) => mark(f, u));
        else mark(parts[n], u);
      }
    }
  });
  return { units, wordUnit };
}

/**
 * The units to redraw when the tinted range changes from `a` to `b` (inclusive word ranges or null):
 * the units of words whose tint changed, plus the word before each changed run (its trailing space
 * tint depends on the next word).
 */
export function changedUnits(a, b, wordUnit) {
  const out = new Set();
  const n = wordUnit.length;
  const inA = (i) => !!a && i >= a[0] && i <= a[1];
  const inB = (i) => !!b && i >= b[0] && i <= b[1];
  const lo = Math.max(0, Math.min(a ? a[0] : Infinity, b ? b[0] : Infinity) - 1);
  const hi = Math.min(n - 1, Math.max(a ? a[1] : -Infinity, b ? b[1] : -Infinity) + 1);
  for (let i = lo; i <= hi; i++) {
    if (inA(i) !== inB(i)) {
      out.add(wordUnit[i]);
      if (i > 0) out.add(wordUnit[i - 1]);
    }
  }
  out.delete(-1);
  return out;
}

/** Units grouped by block, in order: Map(block → [unit]). */
export function unitsByBlock(units) {
  const m = new Map();
  for (const u of units) { if (!m.has(u.block)) m.set(u.block, []); m.get(u.block).push(u); }
  return m;
}
