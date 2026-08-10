// max_curvature says "somewhere along this chain bends wrong" — a single number over a whole body
// axis. worstCurvatureVertex is what turns that number back into a place on the animal, and its
// off-by-one is silent: computeCurvature indexes BENDS, and bend k is measured at chain[k+1], not
// chain[k]. Get that wrong and the viewer confidently highlights the wrong joint.
import { describe, it, expect } from "vitest";
import { computeCurvature, worstCurvatureVertex } from "./structural.js";

const NAN = [Number.NaN, Number.NaN];
/** Straight 5-node chain along x, 10 apart — zero curvature everywhere. */
const straight = () => Array.from({ length: 5 }, (_, i) => [i * 10, 0]);
const CHAIN = [0, 1, 2, 3, 4];

describe("worstCurvatureVertex", () => {
  it("blames the joint the bend is measured AT, not the bend's index", () => {
    const pose = straight();
    pose[3] = [30, 20]; // the sharp corner is at node 3
    const w = worstCurvatureVertex(pose, CHAIN);
    expect(w.nodes[0]).toBe(3);
    // ...and its arms are the neighbours on either side, in the order the angle drawing wants.
    expect([w.nodes[1], w.nodes[2]].sort()).toEqual([2, 4]);
  });

  it("agrees with computeCurvature about which bend is worst", () => {
    const pose = straight();
    pose[1] = [10, 6];
    pose[3] = [30, 18]; // bigger
    const { curvatures } = computeCurvature(pose, CHAIN);
    const worstK = curvatures.reduce((b, v, k) => (Math.abs(v) > Math.abs(curvatures[b]) ? k : b), 0);
    expect(worstCurvatureVertex(pose, CHAIN).nodes[0]).toBe(CHAIN[worstK + 1]);
    expect(worstCurvatureVertex(pose, CHAIN).curvature).toBe(curvatures[worstK]);
  });

  it("compares by MAGNITUDE — a hard left is as bad as a hard right", () => {
    const pose = straight();
    pose[1] = [10, -25]; // sign-negative but the largest bend
    pose[3] = [30, 5];
    expect(worstCurvatureVertex(pose, CHAIN).nodes[0]).toBe(1);
  });

  it("skips joints it cannot measure instead of ranking NaN first", () => {
    const pose = straight();
    pose[1] = NAN;       // makes bends at nodes 1 and 2 NaN
    pose[3] = [30, 12];  // the only measurable bend
    const w = worstCurvatureVertex(pose, CHAIN);
    expect(w.nodes[0]).toBe(3);
    expect(Number.isNaN(w.curvature)).toBe(false);
  });

  it("returns null when there is nothing to blame", () => {
    expect(worstCurvatureVertex(straight(), [0, 1])).toBeNull(); // too short to have a joint
    expect(worstCurvatureVertex(straight(), null)).toBeNull();
    const allNan = Array.from({ length: 5 }, () => NAN);
    expect(worstCurvatureVertex(allNan, CHAIN)).toBeNull();
  });
});
