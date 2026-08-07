// drawScene is the only thing that says what a pose LOOKS like, and every one of its signals is a
// promise to the user: red-shaded = you marked this wrong, dashed = a detector suspects it, white ring =
// this is what you have targeted. Those are easy to break silently — nothing throws when a fill colour
// stops being applied. So: run it against a recording context and read back what it actually painted.
import { describe, it, expect } from "vitest";
import { drawScene } from "./draw.js";

const RED = "#ff3b30"; // GT_FAULTY — what YOU labelled
const DASH = "#ff2d55"; // the detector's guess

/** A 2D context that records each paint with the style in force AT PAINT TIME (not at arc() time —
 *  canvas reads fillStyle when you fill, and getting that wrong is how you "verify" a bug into existence). */
function recorder() {
  const paints = [];
  let path = null;
  const state = { fillStyle: "", strokeStyle: "", lineWidth: 0, globalAlpha: 1, font: "", dash: [] };
  const stack = [];
  const ctx = {
    canvas: { width: 400, height: 300 },
    get fillStyle() { return state.fillStyle; }, set fillStyle(v) { state.fillStyle = v; },
    get strokeStyle() { return state.strokeStyle; }, set strokeStyle(v) { state.strokeStyle = v; },
    get lineWidth() { return state.lineWidth; }, set lineWidth(v) { state.lineWidth = v; },
    get globalAlpha() { return state.globalAlpha; }, set globalAlpha(v) { state.globalAlpha = v; },
    set font(v) { state.font = v; }, set textBaseline(_v) {}, set textAlign(_v) {}, set lineJoin(_v) {},
    set lineCap(_v) {}, set imageSmoothingEnabled(_v) {},
    save() { stack.push({ ...state }); },
    restore() { Object.assign(state, stack.pop() ?? state); },
    setTransform() {}, clearRect() {}, translate() {}, scale() {},
    getTransform: () => ({ a: 1, d: 1, e: 0, f: 0 }),
    measureText: () => ({ width: 10 }),
    setLineDash(d) { state.dash = d; },
    beginPath() { path = null; },
    arc(x, y, r) { path = { kind: "arc", x, y, r }; },
    moveTo(x, y) { path = { kind: "line", x, y }; },
    lineTo() {}, rect() {}, strokeRect() {}, fillRect() {}, drawImage() {},
    fill() { if (path) paints.push({ op: "fill", ...path, color: state.fillStyle, alpha: +state.globalAlpha.toFixed(2) }); },
    stroke() {
      if (path) paints.push({ op: "stroke", ...path, color: state.strokeStyle, width: state.lineWidth, dashed: state.dash.length > 0 });
    },
    fillText() {}, strokeText() {},
  };
  return { ctx, paints };
}

const SK = { edges: [], nodeNames: ["nose", "ear"], index: (n) => SK.nodeNames.indexOf(n) };
const ITEM = {
  video: { shape: [1, 300, 400, 1] }, frameIdx: 0,
  lf: { instances: [{ points: [{ xy: [100, 100], visible: true }, { xy: [200, 150], visible: true }] }] },
};
const OPTS = { transform: { s: 1, offX: 0, offY: 0 }, dims: { w: 400, h: 300 }, scale: 1 };

/** Everything painted at one node's coordinates. */
const at = (paints, x) => paints.filter((p) => p.kind === "arc" && p.x === x);

describe("a keypoint you labelled faulty", () => {
  const { ctx, paints } = recorder();
  drawScene(ctx, null, ITEM, SK, { ...OPTS, gtFaulty: new Set(["0:0"]) });
  const bad = at(paints, 100); // the faulty one
  const ok = at(paints, 200); // its clean neighbour

  it("is SHADED red, not merely outlined", () => {
    const fills = bad.filter((p) => p.op === "fill");
    expect(fills.some((f) => f.color === RED && f.alpha === 1), "no solid red dot").toBe(true);
  });

  it("carries a soft halo so it reads over a busy frame", () => {
    const halo = bad.find((p) => p.op === "fill" && p.color === RED && p.alpha < 1);
    expect(halo, "no halo").toBeTruthy();
    const dot = bad.find((p) => p.op === "fill" && p.alpha === 1);
    expect(halo.r).toBeGreaterThan(dot.r); // behind and bigger, or it isn't a halo
  });

  it("gets a solid red ring, and is drawn larger than a normal node", () => {
    const ring = bad.find((p) => p.op === "stroke" && p.color === RED);
    expect(ring, "no ring").toBeTruthy();
    expect(ring.dashed, "the ring must be SOLID — dashed is the detector's language").toBe(false);
    const badDot = bad.find((p) => p.op === "fill" && p.alpha === 1);
    const okDot = ok.find((p) => p.op === "fill");
    expect(badDot.r).toBeGreaterThan(okDot.r);
  });

  it("leaves every other keypoint alone", () => {
    expect(ok.length).toBe(1); // one plain dot: no halo, no ring
    expect(ok[0].color).not.toBe(RED); // and it keeps its track colour
  });
});

describe("a faulty mark outranks the hidden-node rule", () => {
  it("draws opaque even when the node is invisible and its instance is not selected", () => {
    // Hidden nodes are normally skipped entirely unless selected. A keypoint YOU marked faulty is the
    // one mark that must never be missable — it was being dropped, or drawn at 28%.
    const { ctx, paints } = recorder();
    const hidden = {
      video: { shape: [1, 300, 400, 1] }, frameIdx: 0,
      lf: { instances: [{ points: [{ xy: [100, 100], visible: false }, { xy: [200, 150], visible: true }] }] },
    };
    drawScene(ctx, null, hidden, SK, { ...OPTS, selInstance: -1, gtFaulty: new Set(["0:0"]) });
    const marks = at(paints, 100);
    expect(marks.length, "the invisible faulty node was not drawn at all").toBeGreaterThan(0);
    const dot = marks.find((p) => p.op === "fill" && p.color === RED && p.alpha === 1);
    expect(dot, "drawn, but faded — a recorded fact must be opaque").toBeTruthy();
    expect(marks.some((p) => p.op === "stroke" && p.color === RED)).toBe(true);
  });

  it("an ordinary hidden node is still skipped", () => {
    const { ctx, paints } = recorder();
    const hidden = {
      video: { shape: [1, 300, 400, 1] }, frameIdx: 0,
      lf: { instances: [{ points: [{ xy: [100, 100], visible: false }] }] },
    };
    drawScene(ctx, null, hidden, SK, { ...OPTS, selInstance: -1 });
    expect(at(paints, 100).length).toBe(0);
  });
});

describe("a detector's guess stays visibly a guess", () => {
  it("is a DASHED ring, never a shaded dot", () => {
    const { ctx, paints } = recorder();
    drawScene(ctx, null, ITEM, SK, { ...OPTS, worstNodes: { 0: 0 } });
    const marks = at(paints, 100);
    const ring = marks.find((p) => p.op === "stroke" && p.color === DASH);
    expect(ring, "no detector ring").toBeTruthy();
    expect(ring.dashed).toBe(true);
    expect(marks.some((p) => p.op === "fill" && p.color === DASH)).toBe(false); // never filled
  });

  it("can coexist with a user label without either disappearing", () => {
    const { ctx, paints } = recorder();
    drawScene(ctx, null, ITEM, SK, { ...OPTS, gtFaulty: new Set(["0:0"]), worstNodes: { 0: 0 } });
    const marks = at(paints, 100);
    expect(marks.some((p) => p.op === "fill" && p.color === RED && p.alpha === 1)).toBe(true);
    expect(marks.some((p) => p.op === "stroke" && p.color === DASH && p.dashed)).toBe(true);
  });
});

describe("nothing leaks between nodes", () => {
  it("the faulty style does not bleed onto the node drawn after it", () => {
    // save/restore discipline: a stray fillStyle would paint the next keypoint red too
    const { ctx, paints } = recorder();
    drawScene(ctx, null, ITEM, SK, { ...OPTS, gtFaulty: new Set(["0:0"]) });
    const reds = paints.filter((p) => p.op === "fill" && p.color === RED);
    expect(new Set(reds.map((p) => p.x))).toEqual(new Set([100])); // only at the labelled node
  });
});
