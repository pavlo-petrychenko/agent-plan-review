import { test } from "node:test";
import assert from "node:assert/strict";
import {
  fitScale, limits, clampScale, fitView, actualView, scaleOf, isFit, clampView, zoomAt, zoomStep, stepView,
  wheelFactor, panView, toggleView, imageRect, onImage, pageImages, neighbourImage, percent, MAX_ZOOM, KEEP, MARGIN,
} from "../viewer.js";

const pane = { w: 1000, h: 600 };
const big = { w: 2000, h: 1200 }; // fit = (600 - 64) / 1200
const small = { w: 300, h: 200 };
const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} is not near ${b}`);

test("fit: with a margin, never above 100 %", () => {
  near(fitScale(pane, big), (600 - 2 * MARGIN) / 1200);
  assert.equal(fitScale(pane, small), 1);
  near(fitScale({ w: 400, h: 2000 }, { w: 800, h: 100 }), (400 - 2 * MARGIN) / 800);
  assert.ok(fitScale({ w: 10, h: 10 }, big) > 0);
});

test("limits: from min(fit, 10 %) to 800 %", () => {
  assert.deepEqual(limits(0.5), { min: 0.1, max: MAX_ZOOM });
  assert.deepEqual(limits(0.04), { min: 0.04, max: MAX_ZOOM });
  assert.equal(clampScale(20, 0.5), 8);
  assert.equal(clampScale(0.01, 0.5), 0.1);
  assert.equal(clampScale(0.01, 0.04), 0.04);
});

test("zoomAt keeps the image point under the pointer fixed", () => {
  const at = { x: 120, y: -50 };
  const v = zoomAt(actualView(), 2, at, pane, big);
  near(v.scale, 2);
  near((at.x - v.ox) / v.scale, at.x / 1);
  near((at.y - v.oy) / v.scale, at.y / 1);
  // and again from a panned view
  const u = { fit: false, scale: 1, ox: -300, oy: 100 };
  const p = { x: -40, y: 20 };
  const w = zoomAt(u, 3, p, pane, big);
  near((p.x - w.ox) / w.scale, (p.x - u.ox) / u.scale);
  near((p.y - w.oy) / w.scale, (p.y - u.oy) / u.scale);
});

test("zoomAt from fit starts at the fitted zoom; reaching the fit zoom goes back to fit", () => {
  const fit = fitScale(pane, big);
  const v = zoomAt(fitView(), 1, { x: 0, y: 0 }, pane, big);
  assert.equal(v.fit, false);
  assert.equal(v.scale, 1);
  assert.deepEqual(zoomAt(v, fit, { x: 30, y: 30 }, pane, big), fitView());
  // a pointer-zoom out of fit: the pointer point stays put
  const at = { x: 200, y: 100 };
  const out = zoomAt(fitView(), fit * 2, at, pane, big);
  near((at.x - out.ox) / out.scale, at.x / fit);
});

test("zoomAt clamps the zoom to the limits", () => {
  assert.equal(zoomAt(actualView(), 100, { x: 0, y: 0 }, pane, big).scale, MAX_ZOOM);
  assert.equal(zoomAt(actualView(), 0.0001, { x: 0, y: 0 }, pane, big).scale, 0.1);
});

test("zoom steps walk the stops and include the fit zoom", () => {
  const fit = fitScale(pane, big); // 0.446
  assert.equal(zoomStep(1, 1, fit), 1.5);
  assert.equal(zoomStep(1, -1, fit), 0.75);
  assert.equal(zoomStep(fit, 1, fit), 0.5);
  assert.equal(zoomStep(0.5, -1, fit), +fit.toFixed(4));
  assert.equal(zoomStep(8, 1, fit), 8);
  assert.equal(zoomStep(0.1, -1, fit), 0.1);
  assert.equal(zoomStep(0.04, 1, 0.04), 0.1);
  // a step from an in-between zoom goes to the next stop
  assert.equal(zoomStep(1.2, 1, fit), 1.5);
  assert.equal(zoomStep(1.2, -1, fit), 1);
});

test("stepView zooms at the centre", () => {
  const v = stepView(actualView(), 1, pane, big);
  near(v.scale, 1.5);
  assert.equal(v.ox, 0);
  assert.equal(v.oy, 0);
  const w = stepView(fitView(), -1, pane, big);
  assert.ok(w.scale < fitScale(pane, big));
});

test("wheelFactor: wheel up zooms in, bounded", () => {
  assert.ok(wheelFactor(10) > 1);
  assert.ok(wheelFactor(-10) < 1);
  assert.equal(wheelFactor(0), 1);
  near(wheelFactor(1000), wheelFactor(120));
  near(wheelFactor(5) * wheelFactor(-5), 1);
});

test("pan: clamped so the image stays in the pane; a fitting axis stays centred", () => {
  // 2000 x 1200 at 100 % in 1000 x 600: may be pulled (2000-1000)/2 + KEEP
  const v = panView(actualView(), 5000, -5000, pane, big);
  assert.equal(v.ox, 500 + KEEP);
  assert.equal(v.oy, -(300 + KEEP));
  // the image edge is at most KEEP px past the pane edge: most of it is still in the pane
  const r = imageRect(v, pane, big);
  assert.equal(r.x, KEEP);
  assert.ok(r.x + r.w > pane.w);
  // small image: stays centred
  const s = panView(actualView(), 400, 400, pane, small);
  assert.deepEqual([s.ox, s.oy], [0, 0]);
  // wide image, short in the other axis
  const wide = { w: 3000, h: 100 };
  const t = panView(actualView(), 100, 100, pane, wide);
  assert.equal(t.ox, 100);
  assert.equal(t.oy, 0);
});

test("pan from fit becomes a zoomed view at the fitted zoom", () => {
  const v = panView(fitView(), 10, 10, pane, big);
  // the fitted image fits the pane, so it stays centred
  assert.equal(v.fit, false);
  near(v.scale, fitScale(pane, big));
  assert.deepEqual([v.ox, v.oy], [0, 0]);
});

test("clampView clamps a view after the pane shrinks", () => {
  const v = clampView({ fit: false, scale: 2, ox: 3000, oy: 0 }, { w: 500, h: 500 }, big);
  assert.equal(v.ox, (4000 - 500) / 2 + KEEP);
  assert.deepEqual(clampView(fitView(), pane, big), fitView());
});

test("double click toggles fit and 100 % (at the pointer)", () => {
  const at = { x: 100, y: 40 };
  const k = fitScale(pane, big);
  const z = toggleView(fitView(), at, pane, big);
  assert.equal(z.scale, 1);
  // the image point under the pointer stays: it was at.x / k from the centre of the image
  near((at.x - z.ox) / z.scale, at.x / k);
  assert.deepEqual(toggleView(z, at, pane, big), fitView());
  // an image that fits at 100 % has no other zoom to toggle to
  assert.deepEqual(toggleView(fitView(), at, pane, small), fitView());
  assert.equal(isFit(actualView(), pane, small), true);
  assert.equal(isFit(actualView(), pane, big), false);
});

test("imageRect and onImage", () => {
  const r = imageRect(fitView(), pane, big);
  const k = fitScale(pane, big);
  near(r.w, 2000 * k);
  near(r.x + r.w / 2, 500);
  near(r.y + r.h / 2, 300);
  assert.equal(onImage(r, 500, 300), true);
  assert.equal(onImage(r, 1, 1), false);
  const z = imageRect({ fit: false, scale: 2, ox: 10, oy: -20 }, pane, small);
  near(z.x, 500 + 10 - 300);
  near(z.y, 300 - 20 - 200);
  assert.equal(scaleOf(fitView(), pane, small), 1);
});

test("pageImages: reading order, inside quotes, loaded ones only", () => {
  const blocks = [
    { type: "heading" },
    { type: "image", src: "a", alt: "A" },
    { type: "quote", blocks: [{ type: "image", src: "b", alt: "" }, { type: "para" }] },
    { type: "list", items: [] },
    { type: "image", src: "c", alt: "C" },
  ];
  assert.deepEqual(pageImages(blocks).map((x) => x.src), ["a", "b", "c"]);
  assert.deepEqual(pageImages(blocks, (s) => s !== "b").map((x) => x.src), ["a", "c"]);
  assert.deepEqual(pageImages(null), []);
});

test("neighbourImage stops at the ends", () => {
  assert.equal(neighbourImage(0, -1, 3), 0);
  assert.equal(neighbourImage(0, 1, 3), 1);
  assert.equal(neighbourImage(2, 1, 3), 2);
  assert.equal(neighbourImage(0, 1, 1), 0);
});

test("percent", () => {
  assert.equal(percent(1), "100 %");
  assert.equal(percent(0.333), "33 %");
  assert.equal(percent(8), "800 %");
});
