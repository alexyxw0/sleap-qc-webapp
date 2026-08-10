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

// worstNode answers WHICH node; the viewer also needs WHICH WAY, because the check fires on two
// opposite conditions and they call for opposite marks — a cross-hair for "should be here and isn't"
// against a filled dot for "is here and shouldn't be". A single ring for both said nothing.
describe("VisibilityModel.worstNodeDetail — which way the node is wrong", () => {
  it('an expected-but-missing node is "absent"', () => {
    const masks = Array.from({ length: 20 }, () => [T, T, T, T]);
    const d = new VisibilityModel().fit(masks).worstNodeDetail([T, T, F, T]);
    expect(d.node).toBe(2);
    expect(d.kind).toBe("absent");
  });

  it('a rarely-co-visible node that IS labelled is "present"', () => {
    const masks = Array.from({ length: 20 }, (_, i) => (i === 19 ? [T, T, T, T] : [T, T, T, F]));
    const d = new VisibilityModel().fit(masks).worstNodeDetail([T, T, T, T]);
    expect(d.node).toBe(3);
    expect(d.kind).toBe("present");
  });

  it("kind is null when nothing is blamed, so the caller cannot draw a mark for nobody", () => {
    const masks = Array.from({ length: 20 }, () => [T, T, T, T]);
    const d = new VisibilityModel().fit(masks).worstNodeDetail([T, T, T, T]);
    expect(d).toMatchObject({ node: -1, kind: null });
  });

  it("worstNode stays exactly the node worstNodeDetail names (one blame, two readers)", () => {
    const masks = Array.from({ length: 20 }, () => [T, T, T, T]);
    const m = new VisibilityModel().fit(masks);
    for (const mask of [[T, T, F, T], [F, T, T, T], [T, T, T, T]]) {
      expect(m.worstNode(mask)).toBe(m.worstNodeDetail(mask).node);
    }
  });
});
