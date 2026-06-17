import { describe, it, expect } from "vitest";
import { computePoseSplit, computePoseSplitFallback } from "./poseSplit.js";

const NAN = [Number.NaN, Number.NaN];

// 6-node line skeleton 0-1-2-3-4-5; edge stats learned from ~40 clean ~10-spaced poses.
function chainAdj(n) {
  const adj = Array.from({ length: n }, () => []);
  for (let i = 0; i < n - 1; i++) { adj[i].push(i + 1); adj[i + 1].push(i); }
  return adj;
}
function learnEdgeStats(instances, n) {
  const lens = new Map();
  for (let i = 0; i < n - 1; i++) lens.set(`${i},${i + 1}`, []);
  for (const pts of instances) {
    for (let i = 0; i < n - 1; i++) {
      const a = pts[i], b = pts[i + 1];
      if (!Number.isNaN(a[0]) && !Number.isNaN(b[0])) lens.get(`${i},${i + 1}`).push(Math.hypot(b[0] - a[0], b[1] - a[1]));
    }
  }
  const means = new Map(), stds = new Map();
  for (const [k, v] of lens) {
    const m = v.reduce((s, x) => s + x, 0) / v.length;
    const sd = Math.sqrt(v.reduce((s, x) => s + (x - m) ** 2, 0) / v.length);
    means.set(k, m);
    stds.set(k, Math.max(sd, 1e-6));
  }
  return { means, stds };
}
const cleanInstances = () =>
  Array.from({ length: 40 }, (_, t) => Array.from({ length: 6 }, (_, i) => [i * 10 + Math.sin(t * 7 + i) * 0.4, Math.cos(t * 3 + i) * 0.4]));

const adj = chainAdj(6);
const { means, stds } = learnEdgeStats(cleanInstances(), 6);

describe("pose-split (chimera) graph path", () => {
  it("two clusters joined by one long edge -> high split_score", () => {
    const r = computePoseSplit([[0, 0], [10, 0], [20, 0], [320, 0], [330, 0], [340, 0]], adj, means, stds);
    expect(r.splitScore).toBeGreaterThan(1.0);
    expect(r.splitRatio).toBeCloseTo(0.5, 6);
    expect(r.gapRatio).toBeGreaterThan(10);
    expect(r.bridge).toEqual([2, 3]); // the stretched bridging edge
  });

  it("a normal pose -> low score", () => {
    const pts = Array.from({ length: 6 }, (_, i) => [i * 10, 0]);
    pts[2] = [20, 0.5];
    expect(computePoseSplit(pts, adj, means, stds).splitScore).toBeLessThan(0.5);
  });

  it("a single stray node is not a chimera (balance gate)", () => {
    const pts = Array.from({ length: 6 }, (_, i) => [i * 10, 0]);
    pts[5] = [500, 0];
    const r = computePoseSplit(pts, adj, means, stds);
    expect(r.splitRatio).toBeLessThan(0.2);
    expect(r.splitScore).toBeCloseTo(0, 6);
  });

  it("too few visible nodes -> all-zero", () => {
    const pts = [[0, 0], NAN, NAN, [100, 0], NAN, NAN];
    expect(computePoseSplit(pts, adj, means, stds)).toEqual({ splitScore: 0, splitRatio: 0, gapRatio: 0, bridge: null });
  });

  it("never leaks NaN", () => {
    const pts = Array.from({ length: 6 }, (_, i) => [i * 10, 0]);
    pts[1] = NAN;
    pts[4] = NAN;
    const r = computePoseSplit(pts, adj, means, stds);
    for (const v of [r.splitScore, r.splitRatio, r.gapRatio]) expect(Number.isNaN(v)).toBe(false);
  });

  it("split_ratio + gap_ratio are translation/rotation invariant", () => {
    const pts = [[0, 0], [10, 0], [20, 0], [320, 0], [330, 0], [340, 0]];
    const base = computePoseSplit(pts, adj, means, stds);
    const th = (37 * Math.PI) / 180, c = Math.cos(th), s = Math.sin(th);
    const moved = pts.map(([x, y]) => [c * x - s * y + 123.4, s * x + c * y - 56.7]);
    const rt = computePoseSplit(moved, adj, means, stds);
    expect(rt.splitRatio).toBeCloseTo(base.splitRatio, 6);
    expect(rt.gapRatio).toBeCloseTo(base.gapRatio, 6);
  });
});

describe("pose-split fallback (no adjacency / star)", () => {
  it("no adjacency routes a chimera through the 2-means fallback", () => {
    const r = computePoseSplit([[0, 0], [10, 0], [20, 0], [320, 0], [330, 0], [340, 0]], null, new Map(), new Map());
    expect(r.splitScore).toBeGreaterThan(0);
    expect(r.splitRatio).toBeCloseTo(0.5, 6);
    expect(r.gapRatio).toBeGreaterThan(10);
  });

  it("a uniform line is not bimodal (silhouette floor) -> ~0", () => {
    expect(computePoseSplitFallback([[0, 0], [10, 0], [20, 0], [30, 0]]).splitScore).toBeCloseTo(0, 6);
  });

  it("two tight well-separated clusters -> high", () => {
    const r = computePoseSplitFallback([[0, 0], [4, 0], [0, 4], [200, 0], [204, 0], [200, 4]]);
    expect(r.splitScore).toBeGreaterThan(0);
    expect(r.splitRatio).toBeCloseTo(0.5, 6);
    expect(r.gapRatio).toBeGreaterThan(5);
  });
});
