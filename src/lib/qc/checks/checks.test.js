import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { loadSlp } from "@talmolab/sleap-io.js";
import {
  InstanceCountChecker, checkNegativeFrame, computeInstanceIou, detectDuplicates,
} from "./frameLevel.js";
import { normalizePose } from "./features/reference.js";
import { computeCurvature, computeConvexHull } from "./features/structural.js";
import { VisibilityModel } from "./features/visibility.js";
import { SkeletonAnalyzer } from "./features/skeleton.js";
import { ZScoreDetector, fitAndScoreLabels } from "./detector.js";

const NAN = [Number.NaN, Number.NaN];

describe("frame-level checks", () => {
  it("instance count flags below-median frames", () => {
    const c = new InstanceCountChecker(false).fit([2, 2, 2, 1]);
    expect(c.check(1).isIncomplete).toBe(true);
    expect(c.check(2)).toMatchObject({ isIncomplete: false, expectedCount: 2 });
  });

  it("instance count flags over-count too (an extra / spurious instance)", () => {
    const c = new InstanceCountChecker(false).fit([2, 2, 2, 2]);
    expect(c.check(3)).toMatchObject({ isOvercount: true, isWrongCount: true, isIncomplete: false });
    expect(c.check(1)).toMatchObject({ isOvercount: false, isWrongCount: true, isIncomplete: true });
    expect(c.check(2).isWrongCount).toBe(false);
  });

  it("instance count: expected ignores empty frames (so they can't drag the median to 0)", () => {
    // 4 empty/background frames + 3 two-instance frames: median over ALL is 0 (would flag nothing);
    // over non-empty it's 2, so 1-instance frames are correctly flagged as incomplete.
    const c = new InstanceCountChecker(false).fit([0, 0, 0, 0, 2, 2, 2]);
    expect(c.check(2).expectedCount).toBe(2);
    expect(c.check(1).isIncomplete).toBe(true);
  });

  it("negative frame with instances is inconsistent", () => {
    expect(checkNegativeFrame(true, 1)).toBe(true);
    expect(checkNegativeFrame(true, 0)).toBe(false);
    expect(checkNegativeFrame(false, 3)).toBe(false);
  });

  it("IoU is 1 for identical boxes and 0 when disjoint", () => {
    const sq = [[0, 0], [10, 0], [10, 10], [0, 10]];
    expect(computeInstanceIou(sq, sq)).toBeCloseTo(1, 6);
    const far = sq.map(([x, y]) => [x + 100, y + 100]);
    expect(computeInstanceIou(sq, far)).toBe(0);
  });

  it("detects duplicate instances by IoU, not disjoint ones", () => {
    const sq = [[0, 0], [10, 0], [10, 10], [0, 10]];
    const far = sq.map(([x, y]) => [x + 100, y]);
    expect(detectDuplicates([sq, sq])).toHaveLength(1);
    expect(detectDuplicates([sq, sq])[0].reason).toBe("iou");
    expect(detectDuplicates([sq, far])).toHaveLength(0);
  });
});

describe("reference / normalize_pose", () => {
  it("is translation + scale invariant", () => {
    const pose = [[0, 0], [10, 0], [5, 8]];
    const moved = pose.map(([x, y]) => [x * 3 + 100, y * 3 - 50]);
    const a = normalizePose(pose);
    const b = normalizePose(moved);
    a.forEach((p, i) => { expect(p[0]).toBeCloseTo(b[i][0], 6); expect(p[1]).toBeCloseTo(b[i][1], 6); });
  });
  it("preserves invisible NaN", () => {
    const out = normalizePose([[0, 0], NAN, [5, 8]]);
    expect(Number.isNaN(out[1][0])).toBe(true);
    expect(Number.isNaN(out[0][0])).toBe(false);
  });
});

describe("structural features", () => {
  it("curvature is 0 for a straight chain and pi/2 for a right angle", () => {
    expect(computeCurvature([[0, 0], [1, 0], [2, 0]], [0, 1, 2]).maxCurvature).toBeCloseTo(0, 6);
    expect(computeCurvature([[0, 1], [0, 0], [1, 0]], [0, 1, 2]).maxCurvature).toBeCloseTo(Math.PI / 2, 6);
  });
  it("convex hull of a 10x10 square: area 100, compactness pi/4", () => {
    const h = computeConvexHull([[0, 0], [10, 0], [10, 10], [0, 10]]);
    expect(h.hullArea).toBeCloseTo(100, 6);
    expect(h.compactness).toBeCloseTo(Math.PI / 4, 6);
  });
});

describe("visibility model", () => {
  it("flags a co-visibility violation", () => {
    const m = new VisibilityModel().fit([[true, true], [true, true], [true, true]]);
    const r = m.score([true, false]); // node1 expected visible (p=1) but isn't
    expect(r.nViolations).toBe(1);
    expect(r.patternScore).toBeCloseTo(0.5, 6);
  });
});

describe("skeleton analyzer", () => {
  it("finds the spine of a linear chain", () => {
    const a = new SkeletonAnalyzer(4, [[0, 1], [1, 2], [2, 3]]);
    expect(a.maxChainLength).toBe(4);
    expect(a.getCurvatureChains()[0]).toEqual([0, 1, 2, 3]);
  });
});

describe("ZScoreDetector", () => {
  it("maps max|z| through a sigmoid centered on the threshold", () => {
    const d = new ZScoreDetector(3.0).fit([[-1], [1]]); // mean 0, std 1
    expect(d.scoreOne([3])).toBeCloseTo(0.5, 6); // z = 3 = threshold -> 0.5
    expect(d.scoreOne([0])).toBeLessThan(0.1);
  });
});

describe("full pipeline on a real .slp (sleap-io.js adapter)", () => {
  it("produces per-instance scores in [0,1] + frame results", async () => {
    const FIX = fileURLToPath(new URL("../fixtures/tracked-preds.slp", import.meta.url));
    const labels = await loadSlp(FIX, { openVideos: false });
    const out = fitAndScoreLabels(labels);
    expect(out.featureNames).toHaveLength(19); // 18 geometric + pose_split_score
    expect(out.featureNames).toContain("pose_split_score");
    expect(out.usedGmm).toBe(true); // 201 instances >= gmmMinSamples (50) -> GMM path
    expect(out.instanceScores.size).toBeGreaterThan(0);
    for (const s of out.instanceScores.values()) {
      expect(s).toBeGreaterThanOrEqual(0);
      expect(s).toBeLessThanOrEqual(1);
    }
    expect(out.frameResults.size).toBeGreaterThan(0);
  });
});
