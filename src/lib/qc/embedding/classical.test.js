import { describe, it, expect } from "vitest";
import { MODEL, toGray, downsample, tinyImage, histogram, hog, stats, featuresFromGray } from "./classical.js";

const SIDE = 64;
// Build a synthetic gray image via a per-pixel function f(x,y) -> 0..255.
const makeGray = (f) => { const g = new Float32Array(SIDE * SIDE); for (let y = 0; y < SIDE; y++) for (let x = 0; x < SIDE; x++) g[y * SIDE + x] = f(x, y); return g; };

describe("toGray", () => {
  it("computes luma from RGBA and is flat for a flat image", () => {
    const rgba = new Uint8ClampedArray(4 * 4 * 4).fill(120);
    const g = toGray(rgba, 4);
    expect(g.length).toBe(16);
    for (const v of g) expect(v).toBeCloseTo(120);
  });
});

describe("downsample", () => {
  it("averages blocks and preserves a uniform value", () => {
    const g = makeGray(() => 200);
    const d = downsample(g, SIDE, 16);
    expect(d.length).toBe(256);
    for (const v of d) expect(v).toBeCloseTo(200);
  });
});

describe("feature blocks are finite, fixed-length, unit-norm", () => {
  const g = makeGray((x, y) => (x + y) % 256); // a gradient so nothing is degenerate
  const norm = (v) => Math.hypot(...v);
  it("tinyImage", () => { const b = tinyImage(g, SIDE); expect(b.length).toBe(256); expect(norm(b)).toBeCloseTo(1); expect(b.every(Number.isFinite)).toBe(true); });
  it("hog", () => { const b = hog(g, SIDE); expect(b.length).toBe(128); expect(b.every(Number.isFinite)).toBe(true); });
  it("histogram", () => { const b = histogram(g); expect(b.length).toBe(16); expect(norm(b)).toBeCloseTo(1); });
  it("stats", () => { const b = stats(g); expect(b.length).toBe(5); expect(b.every(Number.isFinite)).toBe(true); });
});

describe("featuresFromGray", () => {
  it("returns MODEL.dim finite values, deterministically", () => {
    const g = makeGray((x, y) => (x * 3 + y * 5) % 256);
    const a = featuresFromGray(g, SIDE);
    const b = featuresFromGray(g, SIDE);
    expect(a.length).toBe(MODEL.dim);
    expect(a.every(Number.isFinite)).toBe(true);
    expect(Array.from(a)).toEqual(Array.from(b)); // deterministic
  });

  it("an occluded (blacked-out) crop is farther from a normal crop than realistic intra-class variation is", () => {
    // "normal" = a soft blob (the animal). Intra-class variation is SMOOTH — a small pose shift + a mild
    // brightness change — which the features should treat as near. A hard occlusion (bottom blacked out)
    // is a large structural change that should land farther away.
    const clamp = (v) => Math.max(15, Math.min(240, v));
    const blob = (x, y, ox = 0, oy = 0) => { const dx = x - 32 - ox, dy = y - 28 - oy; return 180 - 0.06 * (dx * dx + dy * dy); };
    const normalA = featuresFromGray(makeGray((x, y) => clamp(blob(x, y))), SIDE);
    const normalB = featuresFromGray(makeGray((x, y) => clamp(blob(x, y, 3, 2) * 0.95)), SIDE); // small shift + 5% dimmer
    const occluded = featuresFromGray(makeGray((x, y) => (y > 38 ? 5 : clamp(blob(x, y)))), SIDE); // bottom occluded
    const dist = (u, v) => { let s = 0; for (let i = 0; i < u.length; i++) s += (u[i] - v[i]) ** 2; return Math.sqrt(s); };
    expect(dist(normalA, occluded)).toBeGreaterThan(dist(normalA, normalB));
  });
});
