import { describe, it, expect } from "vitest";
import { BaselineFeatureExtractor } from "./baseline.js";

// 5-node chain skeleton 0-1-2-3-4; stats learned from ~30 clean ~10-spaced poses.
const NAN = [Number.NaN, Number.NaN];
const N = 5;
const edges = [[0, 1], [1, 2], [2, 3], [3, 4]];
const cleanInstances = () =>
  Array.from({ length: 30 }, (_, t) =>
    Array.from({ length: N }, (_, i) => [i * 10 + Math.sin(t * 7 + i) * 0.3, Math.cos(t * 3 + i) * 0.3]));
const fitted = () => new BaselineFeatureExtractor(edges, N, []).fit(cleanInstances());
const chainPose = () => Array.from({ length: N }, (_, i) => [i * 10, 0]);

describe("baseline attribute() — node-level anomaly culprits", () => {
  it("has_isolated_invisible -> the invisible node whose neighbors are all visible", () => {
    const pose = chainPose();
    pose[2] = NAN; // neighbors 1 and 3 visible -> isolated invisible
    expect(fitted().attribute(pose).has_isolated_invisible.nodes).toEqual([2]);
  });

  it("does not flag an invisible node when a neighbor is also invisible", () => {
    const pose = chainPose();
    pose[3] = NAN;
    pose[4] = NAN; // node 3's neighbor 4 is invisible; node 4's only neighbor 3 is invisible
    expect(fitted().attribute(pose).has_isolated_invisible).toBeUndefined();
  });

  it("max_centroid_distance -> the node yanked far from the body", () => {
    const pose = chainPose();
    pose[4] = [1000, 1000];
    expect(fitted().attribute(pose).max_centroid_distance.nodes).toEqual([4]);
  });

  it("max_edge_zscore -> both endpoints + dir=+1 when the edge is stretched (increased)", () => {
    const pose = chainPose();
    pose[0] = [-1000, 0]; // edge (0,1) is much longer than learned
    const e = fitted().attribute(pose).max_edge_zscore;
    expect(e.nodes).toEqual([0, 1]);
    expect(e.dir).toBe(1);
  });

  it("max_edge_zscore -> dir=-1 when the edge is compressed (decreased)", () => {
    const pose = chainPose();
    pose[0] = [9, 0]; // edge (0,1) length ~1 vs learned ~10 -> shorter
    const e = fitted().attribute(pose).max_edge_zscore;
    expect(e.nodes).toEqual([0, 1]);
    expect(e.dir).toBe(-1);
  });

  it("omits whole-instance features (no spurious single-node culprit)", () => {
    const a = fitted().attribute(chainPose());
    expect(a.visibility_rate).toBeUndefined();
    expect(a.bbox_area_zscore).toBeUndefined();
    expect(a.nn_distance).toBeUndefined();
  });
});
