import { describe, it, expect } from "vitest";
import { instanceScale, nodePatchBox, nodePatchPlan } from "./nodePatch.js";

const pt = (x, y) => ({ xy: [x, y] });
const NAN = { xy: [Number.NaN, Number.NaN] };

describe("nodePatch geometry", () => {
  it("instanceScale = max bbox side over placed nodes; 0 for <2 placed", () => {
    expect(instanceScale([pt(0, 0), pt(10, 20)])).toBe(20); // 10 wide, 20 tall
    expect(instanceScale([pt(5, 5)])).toBe(0); // one node -> no scale
    expect(instanceScale([pt(5, 5), NAN])).toBe(0); // still <2 placed
    expect(instanceScale([])).toBe(0);
  });

  it("nodePatchBox centers a scale-relative square on the node", () => {
    const pts = [pt(0, 0), pt(10, 20)]; // scale 20
    const b = nodePatchBox(pts, 1, 0.3, 1); // node 1 at (10,20), side = max(1, 20*0.3=6) = 6
    expect(b).toEqual({ x: 10 - 3, y: 20 - 3, side: 6, node: 1 });
  });

  it("nodePatchBox honors the minPx floor for tiny instances", () => {
    const pts = [pt(0, 0), pt(2, 0)]; // scale 2 -> 2*0.3=0.6 < minPx
    expect(nodePatchBox(pts, 0, 0.3, 24).side).toBe(24);
  });

  it("nodePatchBox returns null for an unplaced node or a scaleless instance", () => {
    expect(nodePatchBox([pt(0, 0), pt(10, 20)], 0, 0.3, 1)).not.toBeNull();
    expect(nodePatchBox([pt(0, 0), NAN], 1, 0.3, 1)).toBeNull(); // node 1 unplaced
    expect(nodePatchBox([pt(5, 5)], 0, 0.3, 1)).toBeNull(); // no scale (1 node)
  });

  it("nodePatchPlan yields one box per visible node, skipping unplaced ones", () => {
    const plan = nodePatchPlan([pt(0, 0), pt(10, 20), NAN], 0.3, 1);
    expect(plan.map((p) => p.node)).toEqual([0, 1]); // node 2 (NaN) skipped
    expect(plan.every((p) => p.box.side === 6)).toBe(true);
  });
});
