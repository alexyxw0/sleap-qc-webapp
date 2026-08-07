// A trainer that reports a good score is worse than no trainer if the score is not honest, so these
// test the CV as hard as the fit: separable data must score high, label noise must score near chance,
// and the model must be the exact shape the existing scorer already consumes.
import { describe, it, expect } from "vitest";
import { fitSvm, rocAuc, averagePrecision, stratifiedFolds, plattCalibrate, MIN_POSITIVES } from "./svmFit.js";
import { rbfDecision, rbfProbability } from "./svm.js";

/** Two Gaussian blobs in `dim` dimensions, deterministic — no RNG, so a failure is reproducible. */
function blobs(nPos, nNeg, dim = 16, sep = 2.5) {
  const rows = [], y = [];
  const rnd = (i, d) => Math.sin(i * 12.9898 + d * 78.233) * 43758.5453 % 1; // deterministic hash noise
  for (let i = 0; i < nPos + nNeg; i++) {
    const isPos = i < nPos;
    const v = new Float32Array(dim);
    for (let d = 0; d < dim; d++) v[d] = rnd(i + 1, d + 1) + (isPos && d === 0 ? sep : 0);
    rows.push(v); y.push(isPos ? 1 : -1);
  }
  return { rows, y };
}

describe("fitting", () => {
  it("learns a separable split and reports it honestly", () => {
    const { rows, y } = blobs(20, 60);
    const { clf, cv, warning } = fitSvm(rows, y);
    expect(cv.roc, "held-out ROC on clearly separable blobs").toBeGreaterThan(0.9);
    expect(cv.nPos).toBe(20);
    expect(cv.nNeg).toBe(60);
    expect(warning).toBeNull();
    expect(clf.nSv).toBeGreaterThan(0);
  });

  it("reports ~chance when the labels carry no signal — the number must not flatter the model", () => {
    // identical distributions, labels assigned arbitrarily: nothing is learnable
    const { rows } = blobs(40, 40, 16, 0);
    const y = rows.map((_, i) => (i % 2 ? 1 : -1));
    const { cv } = fitSvm(rows, y);
    // The point is the ABSENCE of a leak: a fold-scoring bug shows up as ~1.0 on unlearnable labels.
    // A wide band, because chance on 80 rows has real variance and a tight one would just be flaky.
    expect(cv.roc).toBeLessThan(0.8);
    expect(cv.roc).toBeGreaterThan(0.2);
  });

  it("the CV never scores a row with a model that saw it", () => {
    // A leak shows up as a perfect score on noise; the test above is the observable form of it. Here we
    // pin the structural guarantee: k folds, every row in exactly one.
    const y = Array.from({ length: 23 }, (_, i) => (i % 3 ? -1 : 1));
    const parts = stratifiedFolds(y, 4);
    expect(parts.length).toBe(4);
    expect(parts.flat().sort((a, b) => a - b)).toEqual(y.map((_, i) => i));
    for (const f of parts) expect(f.some((i) => y[i] > 0), "a fold with no positives cannot be scored").toBe(true);
  });

  it("caps k rather than making folds it cannot fill", () => {
    const { rows, y } = blobs(3, 30);
    const { cv } = fitSvm(rows, y, { folds: 5 });
    expect(cv.folds).toBeLessThanOrEqual(3); // only 3 positives to spread
    expect(cv.folds).toBeGreaterThanOrEqual(2);
  });
});

describe("the warning", () => {
  it("fires below the positive-count floor and says why", () => {
    const { rows, y } = blobs(4, 40);
    const { warning } = fitSvm(rows, y);
    expect(warning).toBeTruthy();
    expect(warning).toMatch(/4 faulty/);
    expect(warning).toMatch(new RegExp(`${MIN_POSITIVES}`));
    expect(warning).toMatch(/noise, not a measurement/);
  });

  it("is absent once there are enough", () => {
    const { rows, y } = blobs(MIN_POSITIVES + 4, 40);
    expect(fitSvm(rows, y).warning).toBeNull();
  });
});

describe("refusals", () => {
  it("one class cannot be learned, and says so rather than returning a useless model", () => {
    const { rows, y } = blobs(10, 0);
    expect(() => fitSvm(rows, y)).toThrow(/both faulty and clean/i);
  });
  it("mismatched labels are a programming error, not a silent truncation", () => {
    const { rows } = blobs(5, 5);
    expect(() => fitSvm(rows, [1, -1])).toThrow(/same non-zero length/i);
  });
});

describe("the model is exactly what the existing scorer consumes", () => {
  const { rows, y } = blobs(15, 45);
  const { clf } = fitSvm(rows, y);

  it("has every field parseClassifier produces", () => {
    for (const k of ["dim", "nSv", "gamma", "intercept", "threshold", "mean", "scale", "dual", "sv"]) {
      expect(clf[k], k).not.toBeUndefined();
    }
    expect(clf.mean.length).toBe(clf.dim);
    expect(clf.scale.length).toBe(clf.dim);
    expect(clf.dual.length).toBe(clf.nSv);
    expect(clf.sv.length).toBe(clf.nSv * clf.dim);
  });

  it("rbfDecision separates the classes it was trained on", () => {
    const dec = rbfDecision(rows, clf);
    const mPos = y.reduce((s, v, i) => s + (v > 0 ? dec[i] : 0), 0) / 15;
    const mNeg = y.reduce((s, v, i) => s + (v < 0 ? dec[i] : 0), 0) / 45;
    expect(mPos).toBeGreaterThan(mNeg);
  });

  it("is Platt-calibrated, so rbfProbability returns probabilities and not raw decisions", () => {
    expect(clf.plattA).not.toBeNull();
    expect(clf.plattB).not.toBeNull();
    const p = rbfProbability(rows, clf);
    for (const v of p) { expect(v).toBeGreaterThanOrEqual(0); expect(v).toBeLessThanOrEqual(1); }
    const mPos = y.reduce((s, v, i) => s + (v > 0 ? p[i] : 0), 0) / 15;
    const mNeg = y.reduce((s, v, i) => s + (v < 0 ? p[i] : 0), 0) / 45;
    expect(mPos).toBeGreaterThan(mNeg);
  });

  it("is deterministic — the same labels give the same model", () => {
    const a = fitSvm(rows, y).clf, b = fitSvm(rows, y).clf;
    expect(a.nSv).toBe(b.nSv);
    expect(Array.from(a.dual)).toEqual(Array.from(b.dual));
    expect(a.intercept).toBe(b.intercept);
  });
});

describe("the metrics themselves", () => {
  it("rocAuc is 1 when perfectly ordered and 0.5 for a constant score", () => {
    expect(rocAuc([1, 2, 3, 4], [-1, -1, 1, 1])).toBe(1);
    expect(rocAuc([4, 3, 2, 1], [-1, -1, 1, 1])).toBe(0);
    expect(rocAuc([1, 1, 1, 1], [-1, -1, 1, 1])).toBe(0.5); // ties averaged, not counted as wins
    expect(rocAuc([1, 2], [1, 1]), "one class has no ROC").toBeNull();
  });
  it("averagePrecision rewards ranking the positives first", () => {
    expect(averagePrecision([9, 8, 1, 0], [1, 1, -1, -1])).toBe(1);
    expect(averagePrecision([0, 1, 8, 9], [1, 1, -1, -1])).toBeLessThan(0.6);
  });
  it("Platt stays finite when the classes separate perfectly", () => {
    const { A, B } = plattCalibrate([-5, -4, 4, 5], [-1, -1, 1, 1]);
    expect(Number.isFinite(A)).toBe(true);
    expect(Number.isFinite(B)).toBe(true);
  });
});
