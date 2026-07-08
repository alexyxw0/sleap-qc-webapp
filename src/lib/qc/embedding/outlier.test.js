import { describe, it, expect } from "vitest";
import { l2norm, knnOutlierScores, nearestNeighbors, robustZ, pca2, buildFrameZ } from "./outlier.js";

// deterministic pseudo-random in [-1,1]
function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return (s / 2 ** 32) * 2 - 1; };
}

describe("l2norm", () => {
  it("scales to unit length", () => {
    const u = l2norm(new Float32Array([3, 4]));
    expect(Math.hypot(u[0], u[1])).toBeCloseTo(1);
  });
});

describe("knnOutlierScores", () => {
  it("gives the isolated points the highest scores", () => {
    const r = rng(7);
    const D = 24;
    const embs = [];
    // 40 tight-cluster points around a base direction
    const base = Array.from({ length: D }, () => r());
    for (let i = 0; i < 40; i++) embs.push(l2norm(Float32Array.from(base, (b) => b + 0.03 * r())));
    // 3 far-away outliers (different directions)
    const outIdx = [40, 41, 42];
    for (let o = 0; o < 3; o++) embs.push(l2norm(Float32Array.from({ length: D }, () => r())));

    const scores = knnOutlierScores(embs, 5);
    const ranked = [...scores.keys()].sort((a, b) => scores[b] - scores[a]);
    expect(new Set(ranked.slice(0, 3))).toEqual(new Set(outIdx)); // the 3 outliers rank top-3
    for (const o of outIdx) expect(scores[o]).toBeGreaterThan(scores[0]); // outlier >> a cluster point
  });
});

describe("nearestNeighbors", () => {
  it("returns the closest rows first", () => {
    const embs = [
      l2norm(new Float32Array([1, 0, 0])),
      l2norm(new Float32Array([0.99, 0.14, 0])), // closest to 0
      l2norm(new Float32Array([0, 1, 0])),
      l2norm(new Float32Array([0, 0, 1])),
    ];
    expect(nearestNeighbors(embs, 0, 1)).toEqual([1]);
  });
});

describe("robustZ", () => {
  it("centers on the median with MAD scale; flags an outlier high", () => {
    const z = robustZ([1, 1, 1, 1, 1, 9]); // one clear outlier
    expect(z[0]).toBeCloseTo(0);
    expect(z[5]).toBeGreaterThan(3);
  });
});

describe("buildFrameZ", () => {
  it("takes the max z per (video,frame) and keys like #fkey (videoIdx:frameIdx)", () => {
    const vA = {}, vB = {};
    const frames = [{ video: vA, frameIdx: 5 }, { video: vA, frameIdx: 5 }, { video: vB, frameIdx: 2 }];
    const vidx = new Map([[vA, 0], [vB, 1]]);
    const recs = [{ fi: 0 }, { fi: 1 }, { fi: 2 }];
    const z = [1.0, 4.2, 3.0];
    const fz = buildFrameZ(recs, z, frames, vidx);
    expect(fz.get("0:5")).toBe(4.2); // max over the two records sharing video0 / frame 5
    expect(fz.get("1:2")).toBe(3.0);
    expect(fz.size).toBe(2);
  });
  it("skips records whose frame is missing", () => {
    const v = {};
    const fz = buildFrameZ([{ fi: 0 }, { fi: 9 }], [2.0, 5.0], [{ video: v, frameIdx: 0 }], new Map([[v, 0]]));
    expect(fz.size).toBe(1);
    expect(fz.get("0:0")).toBe(2.0);
  });
});

describe("pca2", () => {
  it("recovers a planted 2-D structure (coords correlate with the latent factors)", () => {
    const r = rng(3);
    const D = 20, N = 80;
    const dir1 = Array.from({ length: D }, () => r());
    const dir2 = Array.from({ length: D }, () => r());
    const t = [], s = [], embs = [];
    for (let i = 0; i < N; i++) {
      const a = r() * 3, b = r(); // PC1 has 3x the spread of PC2
      t.push(a); s.push(b);
      embs.push(Float32Array.from({ length: D }, (_, d) => a * dir1[d] + b * dir2[d] + 0.02 * r()));
    }
    const { coords } = pca2(embs);
    const corr = (u, w) => { const n = u.length; const mu = u.reduce((p, c) => p + c, 0) / n, mw = w.reduce((p, c) => p + c, 0) / n; let a = 0, b = 0, c = 0; for (let i = 0; i < n; i++) { const du = u[i] - mu, dw = w[i] - mw; a += du * dw; b += du * du; c += dw * dw; } return a / (Math.sqrt(b * c) || 1); };
    const x = coords.map((c) => c[0]);
    expect(Math.abs(corr(x, t))).toBeGreaterThan(0.95); // first PC tracks the dominant latent factor
  });
});
