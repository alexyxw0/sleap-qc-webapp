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

// Which SHAPE a feature blames. The sidebar could already name the feature; the canvas could only
// ring a node — so an angle flag and a length flag drew the same mark. `kind` is what lets the
// viewer draw the thing the check actually measured.
describe("attribute() names the shape, not just the nodes", () => {
  it('max_edge_zscore is an "edge": exactly the two endpoints it measured', () => {
    const pose = chainPose();
    pose[3] = [60, 0]; // edge 2-3 stretched from ~10 to 40
    const a = fitted().attribute(pose).max_edge_zscore;
    expect(a.kind).toBe("edge");
    expect([...a.nodes].sort()).toEqual([2, 3]);
    expect(a.dir).toBe(1); // longer than the norm
  });

  it('max_angle_zscore is an "angle": vertex FIRST, then the two arms', () => {
    const pose = chainPose();
    pose[2] = [20, 25]; // buckles the 1-2-3 joint
    const a = fitted().attribute(pose).max_angle_zscore;
    expect(a.kind).toBe("angle");
    expect(a.nodes).toHaveLength(3);
    // Drawing depends on this order: nodes[0] is where the arc goes, [1] and [2] are the arms.
    expect(a.nodes[0]).toBe(2);
    expect([a.nodes[1], a.nodes[2]].sort()).toEqual([1, 3]);
  });

  it("a length-based feature never claims to be an angle (they draw differently)", () => {
    const pose = chainPose();
    pose[4] = [1000, 1000];
    const out = fitted().attribute(pose);
    for (const f of ["max_edge_zscore", "max_pairwise_zscore"]) {
      if (out[f]) expect(out[f].kind, f).toBe("edge");
    }
  });
});
