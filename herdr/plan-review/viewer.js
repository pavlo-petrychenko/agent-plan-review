// The image viewer's maths. Pure: no Herdr imports, so node tests load it.
//
// A view is { fit, scale, ox, oy } in a pane { w, h } for an image { w, h } (its size at 100 %):
//   fit      true: the image is fitted to the pane (scale and offset are then derived)
//   scale    the zoom, 1 = 100 %
//   ox, oy   where the image's centre is, from the pane's centre, in pane pixels
// Points ("at") are in the same space: pane pixels from the pane's centre.

export const MAX_ZOOM = 8; // 800 %
export const MIN_ZOOM = 0.1; // the lowest zoom limit; a "fit" below it lowers the limit
export const MARGIN = 32; // free space around a fitted image
export const KEEP = 48; // when the image is bigger than the pane: how far past its edge it may be pulled
const STOPS = [0.1, 0.125, 0.167, 0.25, 0.333, 0.5, 0.667, 0.75, 1, 1.5, 2, 3, 4, 6, 8];
const EPS = 1e-3;

/** The zoom at which the image fits the pane with a margin; never above 100 %. */
export function fitScale(pane, img, margin = MARGIN) {
  const aw = Math.max(1, pane.w - 2 * margin), ah = Math.max(1, pane.h - 2 * margin);
  return Math.min(1, aw / Math.max(1, img.w), ah / Math.max(1, img.h));
}

/** The zoom range: from min(fit, 10 %) to 800 %. */
export function limits(fit) {
  return { min: Math.min(fit, MIN_ZOOM), max: MAX_ZOOM };
}

export const clampScale = (s, fit) => {
  const { min, max } = limits(fit);
  return Math.min(max, Math.max(min, s));
};

export const fitView = () => ({ fit: true, scale: 1, ox: 0, oy: 0 });
export const actualView = () => ({ fit: false, scale: 1, ox: 0, oy: 0 });

/** The zoom a view shows right now. */
export const scaleOf = (v, pane, img) => (v.fit ? fitScale(pane, img) : v.scale);

/** Whether a view shows the image fitted (in fit mode, or zoomed to exactly the fit zoom). */
export const isFit = (v, pane, img) => v.fit || Math.abs(v.scale - fitScale(pane, img)) < EPS;

/** The offset of one axis, kept so part of the image stays in the pane. An image that fits the
 *  pane on this axis stays centred; a bigger one may be pulled KEEP pixels past its edges. */
function clampAxis(o, size, pane) {
  if (size <= pane) return 0;
  const lim = (size - pane) / 2 + KEEP;
  return Math.min(lim, Math.max(-lim, o));
}

/** The view with its offset clamped. */
export function clampView(v, pane, img) {
  if (v.fit) return fitView();
  return { ...v, ox: clampAxis(v.ox, img.w * v.scale, pane.w), oy: clampAxis(v.oy, img.h * v.scale, pane.h) };
}

/** Zoom to `scale`, keeping the image point under `at` where it is. */
export function zoomAt(v, scale, at, pane, img) {
  const fit = fitScale(pane, img);
  const from = scaleOf(v, pane, img);
  const to = clampScale(scale, fit);
  if (Math.abs(to - fit) < EPS) return fitView();
  const ox = v.fit ? 0 : v.ox, oy = v.fit ? 0 : v.oy;
  const k = to / from;
  return clampView({ fit: false, scale: to, ox: at.x - (at.x - ox) * k, oy: at.y - (at.y - oy) * k }, pane, img);
}

/** The next zoom stop above (dir > 0) or below (dir < 0) `scale`; the fit zoom is a stop too. */
export function zoomStep(scale, dir, fit) {
  const { min, max } = limits(fit);
  const stops = [...new Set([...STOPS, fit].filter((s) => s >= min - EPS && s <= max + EPS).map((s) => +s.toFixed(4)))].sort((a, b) => a - b);
  if (dir > 0) return stops.find((s) => s > scale * (1 + EPS)) ?? max;
  return [...stops].reverse().find((s) => s < scale * (1 - EPS)) ?? min;
}

/** A step of + / − : zoom at the pane's centre. */
export function stepView(v, dir, pane, img) {
  const fit = fitScale(pane, img);
  return zoomAt(v, zoomStep(scaleOf(v, pane, img), dir, fit), { x: 0, y: 0 }, pane, img);
}

/** The zoom factor of a scroll step: `dy` is the wheel delta in pixels (positive: wheel up, zoom in). */
export function wheelFactor(dy) {
  const d = Math.max(-120, Math.min(120, dy || 0));
  return Math.exp(d * 0.006);
}

/** Pan by (dx, dy) pane pixels. A fitted image becomes a plain zoomed one, then pans. */
export function panView(v, dx, dy, pane, img) {
  const scale = scaleOf(v, pane, img);
  const base = v.fit ? { fit: false, scale, ox: 0, oy: 0 } : v;
  return clampView({ ...base, ox: base.ox + dx, oy: base.oy + dy }, pane, img);
}

/** The double-click: fitted → 100 % at `at`; anything else → fit. */
export function toggleView(v, at, pane, img) {
  if (!isFit(v, pane, img)) return fitView();
  return zoomAt(v, 1, at, pane, img);
}

/** The image's rectangle in pane pixels from the pane's top-left corner. */
export function imageRect(v, pane, img) {
  const s = scaleOf(v, pane, img);
  const w = img.w * s, h = img.h * s;
  const o = v.fit ? { x: 0, y: 0 } : { x: v.ox, y: v.oy };
  return { x: pane.w / 2 + o.x - w / 2, y: pane.h / 2 + o.y - h / 2, w, h };
}

/** Whether a point (pane pixels from the top-left corner) is on the image. */
export function onImage(r, x, y) {
  return x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;
}

/** The images of a page in reading order: [{ src, alt }]. Looks inside quotes. `shown(src)`
 *  says whether the image is drawn (loaded). */
export function pageImages(blocks, shown = () => true) {
  const out = [];
  const walk = (list) => {
    for (const b of list ?? []) {
      if (b.type === "image") { if (shown(b.src)) out.push({ src: b.src, alt: b.alt || "" }); }
      else if (b.type === "quote") walk(b.blocks);
    }
  };
  walk(blocks);
  return out;
}

/** The index `step` away from `i` in a list of `n`, or `i` when there is nowhere to go. */
export function neighbourImage(i, step, n) {
  const j = i + step;
  return j < 0 || j >= n ? i : j;
}

/** The zoom as the bar shows it: "100 %", "33 %". */
export function percent(scale) {
  return `${Math.round(scale * 100)} %`;
}
