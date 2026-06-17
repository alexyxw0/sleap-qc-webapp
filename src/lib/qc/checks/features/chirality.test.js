import { describe, it, expect } from "vitest";
import { ChiralityModel, inferSymmetryPairsByName } from "./chirality.js";

// Skeleton: 0=nose, 1=tail (midline along +y), 2/3 = ear L/R, 4/5 = paw L/R.
// In a CLEAN pose the "left" member (idx 2, 4) sits on the x<0 side of the midline.
const NAN = [Number.NaN, Number.NaN];
const PAIRS = [[2, 3], [4, 5]];
const MIDLINE = [0, 1];
function clean(flip = false) {
  const lx = flip ? 5 : -5;
  const rx = flip ? -5 : 5;
  return [[0, 10], [0, -10], [lx, 8], [rx, 8], [lx, -8], [rx, -8]];
}
const train = Array.from({ length: 5 }, () => clean());
const fitModel = () => new ChiralityModel().fit(train, { symmetryPairs: PAIRS, midlineIndices: MIDLINE });

describe("chirality name inference", () => {
  it("pairs shared-stem L/R (suffix), ignores a lone side and a cross-stem partner", () => {
    // nose0 tail1 Ear_L2 Ear_R3 Eye_R4 Paw_L5 Paw_R6 -> Ear pair + Paw pair; Eye_R has no Eye_L.
    expect(inferSymmetryPairsByName(["nose", "tail", "Ear_L", "Ear_R", "Eye_R", "Paw_L", "Paw_R"])).toEqual([
      [2, 3],
      [5, 6],
    ]);
  });
  it("handles prefix form with left/right words", () => {
    expect(inferSymmetryPairsByName(["left_eye", "right_eye"])).toEqual([[0, 1]]);
    // NB: single-letter "R_ear" ends in 'r' so the suffix-'r' reading wins (stem 'r_ea'),
    // which does NOT match "L_ear"'s prefix reading (stem 'ear') -> no pair. Faithful to the
    // suffix-before-prefix Python rule; only word forms (left_/right_) pair unambiguously.
    expect(inferSymmetryPairsByName(["L_ear", "R_ear"])).toEqual([]);
  });
  it("a lone _L with no _R yields no pair", () => {
    expect(inferSymmetryPairsByName(["nose", "Ear_L"])).toEqual([]);
  });
});

describe("chirality scoring", () => {
  it("clean ~0, fully flipped ~1", () => {
    const m = fitModel();
    expect(m.scoreInstance(clean()).wrongFraction).toBeCloseTo(0, 6);
    expect(m.scoreInstance(clean(true)).wrongFraction).toBeCloseTo(1, 6);
  });

  it("a partial flip scores the wrong-pair fraction", () => {
    const m = fitModel();
    const p = clean();
    [p[2], p[3]] = [p[3], p[2]]; // flip only the ear pair
    expect(m.scoreInstance(p).wrongFraction).toBeCloseTo(0.5, 6);
    expect([...m.scoreInstance(p).wrongPairs]).toEqual(["2,3"]);
  });

  it("min_pairs floor: a flip with <2 co-visible pairs scores 0", () => {
    const m = fitModel();
    const oneVisible = clean(true);
    oneVisible[4] = NAN;
    oneVisible[5] = NAN; // hide the paw pair -> only 1 scorable pair
    expect(m.scoreInstance(oneVisible).wrongFraction).toBe(0);
  });

  it("never emits NaN on degenerate (all-invisible) input", () => {
    const m = fitModel();
    const r = m.scoreInstance([NAN, NAN, NAN, NAN, NAN, NAN]);
    expect(Number.isFinite(r.wrongFraction)).toBe(true);
    expect(r.wrongFraction).toBe(0);
  });

  it("is invariant to translation + rotation", () => {
    const m = fitModel();
    const rot = (pose, deg, tx, ty) => {
      const a = (deg * Math.PI) / 180;
      const c = Math.cos(a), s = Math.sin(a);
      return pose.map(([x, y]) => (Number.isNaN(x) ? [x, y] : [c * x - s * y + tx, s * x + c * y + ty]));
    };
    expect(m.scoreInstance(rot(clean(), 37, 100, -50)).wrongFraction).toBeCloseTo(0, 6);
    expect(m.scoreInstance(rot(clean(true), 37, 100, -50)).wrongFraction).toBeCloseTo(1, 6);
  });
});
