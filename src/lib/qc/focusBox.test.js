import { describe, it, expect } from "vitest";
import { instancePointsBox, nodePointBox, reviewFocusBox, flagPartners } from "./focusBox.js";

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

// Review mode sends you to a frame BECAUSE one instance is wrong, then used to frame the whole
// labeled scene — so on a 1000-px frame the keypoint you were sent to fix was a few pixels wide and
// you zoomed in by hand, every time. These pin the framing that replaced it, including the three
// things the wide framing was right about and which the narrow one must not lose.
describe("reviewFocusBox", () => {
  const inst = (...pts) => ({ points: pts.map(([x, y]) => ({ xy: [x, y] })) });
  const A = inst([100, 100], [140, 160]);   // the flagged animal
  const B = inst([600, 600], [660, 680]);   // a second animal, far away
  const C = inst([120, 110], [150, 170]);   // overlapping A — its duplicate

  it("frames the blamed instance, not the whole scene", () => {
    expect(reviewFocusBox([A, B], 0)).toEqual({ x: 100, y: 100, w: 40, h: 60 });
  });

  it("frames EVERY instance when nothing is blamed — then the frame is the subject", () => {
    // "3 of 2 expected instances" is not about instance 1; zooming into one of them would be a guess.
    expect(reviewFocusBox([A, B], -1)).toEqual({ x: 100, y: 100, w: 560, h: 580 });
  });

  it("pulls in the instance a cross-instance flag is being compared against", () => {
    // Showing one of a duplicate pair is showing half the evidence — you cannot judge it alone.
    expect(reviewFocusBox([A, C, B], 0, [1])).toEqual({ x: 100, y: 100, w: 50, h: 70 });
    expect(reviewFocusBox([A, C, B], 0, [])).toEqual({ x: 100, y: 100, w: 40, h: 60 });
  });

  it("ignores a partner that is the target itself", () => {
    expect(reviewFocusBox([A, B], 0, [0])).toEqual(reviewFocusBox([A, B], 0));
  });

  it("pads a tiny instance to the floor, keeping it CENTRED", () => {
    // Three pixels of animal framed to three pixels is a wall of interpolated grey. Expanding the
    // box rather than capping the zoom is what keeps the subject in the middle of it.
    const tiny = inst([500, 500], [503, 502]);
    const b = reviewFocusBox([tiny], 0, [], 100);
    expect(b.w).toBe(100);
    expect(b.h).toBe(100);
    expect(b.x + b.w / 2).toBeCloseTo(501.5, 6);
    expect(b.y + b.h / 2).toBeCloseTo(501, 6);
  });

  it("leaves a box already bigger than the floor alone", () => {
    expect(reviewFocusBox([A], 0, [], 20)).toEqual({ x: 100, y: 100, w: 40, h: 60 });
  });

  it("pads only the axis that is short", () => {
    const flat = inst([200, 300], [400, 302]); // wide, no height
    const b = reviewFocusBox([flat], 0, [], 100);
    expect(b.w).toBe(200);                     // already past the floor
    expect(b.h).toBe(100);
    expect(b.y + b.h / 2).toBeCloseTo(301, 6);
  });

  it("is null when there is nothing placed to frame", () => {
    expect(reviewFocusBox([], 0)).toBeNull();
    expect(reviewFocusBox([{ points: [NAN] }], 0)).toBeNull();
    expect(reviewFocusBox(undefined, -1)).toBeNull();
  });

  it("falls back to the placed instances when the blamed one has no points", () => {
    // An instance with nothing placed cannot be framed; a null box would leave the view wherever it
    // happened to be, which reads as "review is broken" rather than "this one is empty".
    expect(reviewFocusBox([{ points: [NAN, NAN] }, B], 0, [1])).toEqual({ x: 600, y: 600, w: 60, h: 80 });
  });
});

describe("flagPartners", () => {
  it("names the other half of every duplicate pair the instance is in", () => {
    const fq = { duplicatePairs: [[0, 2], [1, 3], [4, 0]] };
    expect(flagPartners(fq, 0).sort()).toEqual([2, 4]);
    expect(flagPartners(fq, 3)).toEqual([1]);
    expect(flagPartners(fq, 9)).toEqual([]);
  });

  it("is empty, not a throw, when the frame has no duplicate record", () => {
    expect(flagPartners(null, 0)).toEqual([]);
    expect(flagPartners({}, 0)).toEqual([]);
  });
});
