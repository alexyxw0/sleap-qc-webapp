import { describe, it, expect } from "vitest";
import { VisibilityModel } from "./visibility.js";

const T = true, F = false;

describe("VisibilityModel.worstNode — co-visibility culprit", () => {
  it("blames the node that should be visible but is absent", () => {
    const masks = Array.from({ length: 20 }, () => [T, T, T, T]); // 4 nodes always co-visible
    const m = new VisibilityModel().fit(masks);
    expect(m.worstNode([T, T, F, T])).toBe(2); // node 2 missing though always expected
  });

  it("blames the node that is rarely co-visible yet present", () => {
    const masks = Array.from({ length: 20 }, (_, i) => (i === 19 ? [T, T, T, T] : [T, T, T, F]));
    const m = new VisibilityModel().fit(masks); // node 3 visible only 1/20 -> rare
    expect(m.worstNode([T, T, T, T])).toBe(3); // node 3 present though rarely co-visible
  });

  it("returns -1 for a pose consistent with the learned pattern", () => {
    const masks = Array.from({ length: 20 }, () => [T, T, T, T]);
    const m = new VisibilityModel().fit(masks);
    expect(m.worstNode([T, T, T, T])).toBe(-1);
  });
});
