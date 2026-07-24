import { describe, it, expect } from "vitest";
import { instancePointsBox, nodePointBox } from "./focusBox.js";

const pt = (x, y) => ({ xy: [x, y] });
const NAN = { xy: [Number.NaN, Number.NaN] };

describe("focusBox", () => {
  it("instancePointsBox spans the placed points (ignoring NaN)", () => {
    expect(instancePointsBox([pt(10, 20), pt(40, 30), NAN])).toEqual({ x: 10, y: 20, w: 30, h: 10 });
  });
  it("instancePointsBox is null when nothing is placed", () => {
    expect(instancePointsBox([NAN, NAN])).toBeNull();
    expect(instancePointsBox([])).toBeNull();
    expect(instancePointsBox(undefined)).toBeNull();
  });
  it("nodePointBox is a zero-size box at the node, or null if unplaced", () => {
    expect(nodePointBox([pt(5, 6), pt(7, 8)], 1)).toEqual({ x: 7, y: 8, w: 0, h: 0 });
    expect(nodePointBox([pt(5, 6), NAN], 1)).toBeNull();
    expect(nodePointBox([pt(5, 6)], 3)).toBeNull();
  });
});
