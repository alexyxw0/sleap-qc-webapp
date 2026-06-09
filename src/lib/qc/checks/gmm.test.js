import { describe, it, expect } from "vitest";
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
});
