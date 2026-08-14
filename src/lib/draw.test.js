// drawScene is the only thing that says what a pose LOOKS like, and every one of its signals is a
// promise to the user: red-shaded = you marked this wrong, dashed = a detector suspects it, white ring =
// this is what you have targeted. Those are easy to break silently — nothing throws when a fill colour
// stops being applied. So: run it against a recording context and read back what it actually painted.
import { describe, it, expect } from "vitest";
import { drawScene, shouldHoldPaint, hasKnownDims, frameDims } from "./draw.js";

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
    // Recorded, not discarded: the placeholder's caption is the only thing that tells the user whether
    // the frame is loading or the file simply has no pixels, and those are opposite diagnoses.
    fillText(text) { paints.push({ op: "text", text: String(text) }); }, strokeText() {},
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

// ---------------------------------------------------------------------------------------------
// A flag names a SHAPE, and the canvas has to draw that shape. Before this, every geometric check
// — max_edge, max_angle, curvature, visibility — landed on the same dashed ring around one node, so
// "the neck angle is wrong" and "the nose is misplaced" looked identical. These pin each mark.
const PINK = "#ff2d55";
const TRI = {
  video: { shape: [1, 300, 400, 1] }, frameIdx: 0,
  lf: { instances: [{ points: [
    { xy: [100, 100], visible: true }, { xy: [200, 100], visible: true }, { xy: [200, 200], visible: true },
  ] }] },
};
const SK3 = { edges: [], nodeNames: ["a", "b", "c"], index: (n) => SK3.nodeNames.indexOf(n) };

describe("an ANGLE flag draws the angle, not a node", () => {
  const { ctx, paints } = recorder();
  // vertex = node 1, arms to nodes 0 and 2 — the shape max_angle_zscore / max_curvature blame.
  drawScene(ctx, null, TRI, SK3, { ...OPTS, worstAngles: { 0: [1, 0, 2] } });

  it("arcs the bend at the VERTEX, at a radius clear of the joint's own dot", () => {
    const arc = paints.find((p) => p.kind === "arc" && p.op === "stroke" && p.color === PINK && p.r >= 10);
    expect(arc, "no angle arc drawn").toBeTruthy();
    expect([arc.x, arc.y], "the arc must sit on the vertex, not an arm").toEqual([200, 100]);
  });

  it("draws both arms, cased so they read over a same-coloured bone", () => {
    const arms = paints.filter((p) => p.kind === "line" && p.x === 100 && p.y === 100);
    expect(arms.map((a) => a.color).sort()).toEqual(["#0b0e13", PINK]); // casing pass + dashed pass
    expect(arms.find((a) => a.color === PINK).dashed, "the guess must stay dashed").toBe(true);
    expect(arms.find((a) => a.color === "#0b0e13").width)
      .toBeGreaterThan(arms.find((a) => a.color === PINK).width);
  });

  it("does not fall back to ringing a node", () => {
    expect(paints.some((p) => p.kind === "arc" && p.op === "stroke" && p.dashed)).toBe(false);
  });

  it("is skipped when any of the three points is unplaced, rather than drawing a wild arc", () => {
    const gap = { ...TRI, lf: { instances: [{ points: [
      { xy: [Number.NaN, Number.NaN], visible: true }, { xy: [200, 100], visible: true }, { xy: [200, 200], visible: true },
    ] }] } };
    const { ctx: c2, paints: p2 } = recorder();
    drawScene(c2, null, gap, SK3, { ...OPTS, worstAngles: { 0: [1, 0, 2] } });
    expect(p2.some((p) => p.kind === "arc" && p.op === "stroke" && p.color === PINK && p.r >= 10)).toBe(false);
  });
});

describe("the visibility flag says WHICH WAY the node is wrong", () => {
  const marksAt = (variant) => {
    const { ctx, paints } = recorder();
    drawScene(ctx, null, TRI, SK3, { ...OPTS, worstNodes: { 0: 0 }, worstNodeVariants: { 0: variant } });
    return paints;
  };

  it('"absent" — expected here, not labelled — gets a cross-hair', () => {
    const p = marksAt("absent");
    const bars = p.filter((q) => q.kind === "line" && q.color === PINK);
    expect(bars.length, "no cross-hair").toBeGreaterThan(0);
    expect(bars.every((b) => !b.dashed), "the cross-hair is solid; the ring carries the dashes").toBe(true);
  });

  it('"present" — labelled where it almost never co-occurs — gets a filled centre dot instead', () => {
    const p = marksAt("present");
    expect(p.some((q) => q.kind === "line" && q.color === PINK), "cross-hair on the wrong variant").toBe(false);
    expect(p.some((q) => q.op === "fill" && q.color === PINK && q.x === 100)).toBe(true);
  });

  it("with no variant it stays the plain dashed ring every other check uses", () => {
    const p = marksAt(null);
    expect(p.some((q) => q.op === "stroke" && q.kind === "arc" && q.color === PINK && q.dashed)).toBe(true);
    expect(p.some((q) => q.kind === "line" && q.color === PINK)).toBe(false);
    expect(p.some((q) => q.op === "fill" && q.color === PINK && q.x === 100)).toBe(false);
  });
});

// The proofreader "showed a black frame at first before updating". Nothing was drawing it black — the
// canvas simply had not been painted, so the stage's own background (#0b0e13) showed through for the
// ~50-100 ms of the first decode. The paint was being withheld by the rule that keeps the pose and the
// picture in step, which is right for a frame CHANGE and wrong for the first frame: there was no
// previous paint to hold, so it held nothing.
describe("shouldHoldPaint", () => {
  const EL = { id: "canvas-a" }, OTHER = { id: "canvas-b" };

  it("never holds once the picture and the pose are the same frame", () => {
    for (const paintedEl of [null, EL, OTHER]) {
      expect(shouldHoldPaint({ havePair: true, paintedEl, canvasEl: EL }), String(paintedEl?.id)).toBe(false);
    }
  });

  it("holds a mismatched pair, so the new pose never lands on the old photograph", () => {
    expect(shouldHoldPaint({ havePair: false, paintedEl: EL, canvasEl: EL })).toBe(true);
  });

  it("does NOT hold on a canvas that has never been painted — that is the black rectangle", () => {
    expect(shouldHoldPaint({ havePair: false, paintedEl: null, canvasEl: EL })).toBe(false);
  });

  it("treats a re-created canvas as never painted, because it is blank again", () => {
    // Closing the proofreader destroys the canvas; re-opening makes a new, empty one. Remembering
    // "we have painted" as a boolean would hold a paint that no longer exists — black again.
    expect(shouldHoldPaint({ havePair: false, paintedEl: OTHER, canvasEl: EL })).toBe(false);
  });

  it("holds rather than guess the frame size — a jump is worse than a brief wait", () => {
    // Without the file stating the shape, the early paint would scale the pose to a guessed 1024x768
    // and then snap when the real pixels arrive.
    expect(shouldHoldPaint({ havePair: false, paintedEl: null, canvasEl: EL, dimsKnown: false })).toBe(true);
    expect(shouldHoldPaint({ havePair: false, paintedEl: null, canvasEl: EL, dimsKnown: true })).toBe(false);
  });
});

describe("hasKnownDims", () => {
  it("reads the size off the file when it is there", () => {
    expect(hasKnownDims({ video: { shape: [10, 480, 640, 1] } })).toBe(true);
  });
  it("says no to a missing, short, or zeroed shape rather than throwing", () => {
    for (const v of [undefined, null, { video: {} }, { video: { shape: [10] } },
                     { video: { shape: [10, 0, 640] } }, { video: { shape: [10, 480, 0] } }]) {
      expect(hasKnownDims(v), JSON.stringify(v)).toBe(false);
    }
  });
  it("agrees with frameDims — one is the precondition of the other", () => {
    const known = { video: { shape: [10, 480, 640, 1] } };
    expect(frameDims(known, null)).toEqual({ w: 640, h: 480 });
    const unknown = { video: {} };
    expect(hasKnownDims(unknown)).toBe(false);
    expect(frameDims(unknown, null)).toEqual({ w: 1024, h: 768 }); // the guess this guards against
  });
});

describe("a decode in flight does not accuse the file of having no pixels", () => {
  const item = { ...ITEM, frameIdx: 42 };

  const said = (paints) => paints.filter((p) => p.op === "text").map((p) => p.text).join(" | ");

  it("says 'decoding…' while the picture is on its way", () => {
    const { ctx, paints } = recorder();
    drawScene(ctx, null, item, SK, { ...OPTS, decoding: true });
    expect(said(paints)).toContain("decoding");
    expect(said(paints), "told the user to upload a video that is already loading").not.toContain("upload the video");
  });

  it("still says what is wrong when the pixels genuinely are not there", () => {
    const { ctx, paints } = recorder();
    drawScene(ctx, null, item, SK, OPTS);
    expect(said(paints)).toContain("no image pixels");
  });

  it("draws the pose either way — the whole point is that something is there to look at", () => {
    const { ctx, paints } = recorder();
    drawScene(ctx, null, ITEM, SK, { ...OPTS, decoding: true });
    expect(paints.some((p) => p.kind === "arc"), "no keypoints drawn over the placeholder").toBe(true);
  });
});
