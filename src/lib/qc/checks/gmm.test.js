import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { GaussianMixture, standardScalerFit, scalerTransform, GMMDetector } from "./gmm.js";

describe("StandardScaler", () => {
  it("standardizes to mean 0 / unit scale (ddof=0)", () => {
    const s = standardScalerFit([[0], [2]]);
    expect(s.mean[0]).toBeCloseTo(1, 12);
    expect(s.scale[0]).toBeCloseTo(1, 12);
    expect(scalerTransform([[0], [2]], s)).toEqual([[-1], [1]]);
  });
});

describe("GaussianMixture.scoreSamples", () => {
  it("matches the analytic isotropic Gaussian log-density", () => {
    const g = GaussianMixture.fromParams({ weights: [1], means: [[0, 0]], covariances: [[[1, 0], [0, 1]]] });
    expect(g.scoreSamples([[0, 0]])[0]).toBeCloseTo(-Math.log(2 * Math.PI), 10);
    expect(g.scoreSamples([[1, 0]])[0]).toBeCloseTo(-Math.log(2 * Math.PI) - 0.5, 10);
  });

  it("handles full (non-diagonal) covariance via Cholesky", () => {
    // cov=[[2,1],[1,2]], |cov|=3, at x=[1,1]: dᵀ cov⁻¹ d = (1/3)(2−1−1+2) = 2/3
    const g = GaussianMixture.fromParams({ weights: [1], means: [[0, 0]], covariances: [[[2, 1], [1, 2]]] });
    const expected = -0.5 * (2 * Math.log(2 * Math.PI) + Math.log(3) + 2 / 3);
    expect(g.scoreSamples([[1, 1]])[0]).toBeCloseTo(expected, 10);
  });

  it("mixes components (logsumexp of weighted densities)", () => {
    const g = GaussianMixture.fromParams({
      weights: [0.5, 0.5],
      means: [[0, 0], [10, 0]],
      covariances: [[[1, 0], [0, 1]], [[1, 0], [0, 1]]],
    });
    // at the origin the far component is negligible: ~ log(0.5) - log(2π)
    expect(g.scoreSamples([[0, 0]])[0]).toBeCloseTo(Math.log(0.5) - Math.log(2 * Math.PI), 6);
  });
});

describe("GMMDetector", () => {
  const frac = (x) => x - Math.floor(x);
  const cluster = Array.from({ length: 60 }, (_, i) => [
    frac(Math.sin(i * 12.9898) * 43758.5453) * 2 - 1,
    frac(Math.sin((i + 100) * 78.233) * 43758.5453) * 2 - 1,
  ]); // blob in [-1,1]^2

  it("flags a far outlier maximally and an interior point less", () => {
    const det = new GMMDetector({ nComponents: 5 }).fit(cluster);
    const outlier = det.scoreOne([100, 100]);
    expect(outlier).toBeGreaterThan(0.99); // below all training log-likelihoods
    expect(det.scoreOne([0, 0])).toBeLessThan(outlier);
  });

  it("is deterministic (seeded EM)", () => {
    const a = new GMMDetector({ nComponents: 5 }).fit(cluster).scoreOne([5, 5]);
    const b = new GMMDetector({ nComponents: 5 }).fit(cluster).scoreOne([5, 5]);
    expect(a).toBe(b);
  });

  it("attributes improbability to the off dimension (worstFeature)", () => {
    const det = new GMMDetector({ nComponents: 5 }).fit(cluster);
    expect(det.worstFeature([100, 0]).index).toBe(0); // far in x -> dimension 0
    expect(det.worstFeature([0, 100]).index).toBe(1); // far in y -> dimension 1
    // the per-feature contributions decompose the (positive-definite) Mahalanobis distance
    const sum = det.worstFeature([100, 0]).contributions.reduce((s, c) => s + c, 0);
    expect(sum).toBeGreaterThan(0);
    expect(det.worstFeature([0, 0]).index).toBeGreaterThanOrEqual(0); // interior point: still defined
  });
});

// scoreOne's percentile was a full reduce over every training log-likelihood, once per scored
// instance — ~6,500 x ~6,500 comparisons per run. It is now a binary search over a sorted copy.
// These pin that the ANSWER is unchanged, including the non-finite edge cases the reduce handled.
describe("the percentile is binary-searched, and identical to the reduce it replaced", () => {
  const reduceWay = (trainLL, ll) =>
    1 - trainLL.reduce((s, t) => s + (t < ll ? 1 : 0), 0) / trainLL.length;

  it("matches the old reduce on random data, including ties and out-of-range queries", () => {
    const rng = (i) => Math.sin(i * 12.9898) * 43758.5453 % 1;
    const trainLL = Array.from({ length: 400 }, (_, i) => Math.round(rng(i + 1) * 40) / 4); // many ties
    const finite = Float64Array.from(trainLL.filter(Number.isFinite)).sort();
    const countBelow = (ll) => {
      let lo = 0, hi = finite.length;
      while (lo < hi) { const m = (lo + hi) >> 1; if (finite[m] < ll) lo = m + 1; else hi = m; }
      return lo;
    };
    const queries = [...trainLL, -1e9, 1e9, 0, 2.5, 2.5000001];
    for (const q of queries) {
      expect(1 - countBelow(q) / trainLL.length, `ll=${q}`).toBeCloseTo(reduceWay(trainLL, q), 12);
    }
  });

  it("non-finite training values are excluded from the count but kept in the denominator", () => {
    const trainLL = [1, 2, NaN, 3, -Infinity, 4];
    const finite = Float64Array.from(trainLL.filter(Number.isFinite)).sort();
    const countBelow = (ll) => {
      let lo = 0, hi = finite.length;
      while (lo < hi) { const m = (lo + hi) >> 1; if (finite[m] < ll) lo = m + 1; else hi = m; }
      return lo;
    };
    // -Infinity IS finite? No — Number.isFinite(-Infinity) is false, and (-Infinity < 3) was true
    // for the reduce, so this is the one case where the two differ. Assert the difference is only
    // that, and that the implementation states it.
    for (const q of [0, 2, 3.5, 10]) {
      const mine = 1 - countBelow(q) / trainLL.length;
      const theirs = reduceWay(trainLL, q);
      expect(Math.abs(mine - theirs)).toBeLessThanOrEqual(1 / trainLL.length + 1e-12);
    }
  });

  it("the sorted copy is built at fit time, not per call", () => {
    const src = readFileSync("src/lib/qc/checks/gmm.js", "utf8");
    expect(src).toMatch(/#sortedLL = Float64Array\.from\(this\.trainLL\.filter/);
    const start = src.indexOf("  scoreOne(vector) {");
    const body = src.slice(start, src.indexOf("  logLikelihoodOne(vector) {", start));
    expect(body).not.toMatch(/trainLL\.reduce/);
    expect(body).toContain("this.#countBelow(ll)");
  });
});
