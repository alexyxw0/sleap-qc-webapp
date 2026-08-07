import { describe, it, expect } from "vitest";
import { outOfFrameNodes, checkFrameBounds, videoBounds } from "./outOfFrame.js";

const W = 640, H = 480;

describe("outOfFrameNodes", () => {
  it("flags coordinates beyond each edge", () => {
    const pose = [[-1, 10], [10, -1], [W + 1, 10], [10, H + 1], [10, 10]];
    expect(outOfFrameNodes(pose, W, H)).toEqual([0, 1, 2, 3]);
  });
  it("accepts the exact boundary and everything inside", () => {
    expect(outOfFrameNodes([[0, 0], [W, H], [W / 2, H / 2]], W, H)).toEqual([]);
  });
  it("IGNORES NaN — in SLEAP that means unlabelled, not out-of-frame", () => {
    const pose = [[NaN, NaN], [NaN, 10], [10, NaN], [undefined, 1], [-5, 5]];
    expect(outOfFrameNodes(pose, W, H)).toEqual([4]);   // only the real out-of-bounds point
  });
  it("ignores non-finite coordinates (Infinity) rather than reporting them", () => {
    expect(outOfFrameNodes([[Infinity, 0], [0, -Infinity]], W, H)).toEqual([]);
  });
  it("honours a margin", () => {
    expect(outOfFrameNodes([[-8, 10]], W, H, 0)).toEqual([0]);
    expect(outOfFrameNodes([[-8, 10]], W, H, 10)).toEqual([]);  // within tolerance
  });
  it("reports nothing when bounds are unusable (poses-only file)", () => {
    for (const [w, h] of [[0, H], [W, 0], [undefined, undefined], [NaN, NaN]]) {
      expect(outOfFrameNodes([[-999, -999]], w, h)).toEqual([]);
    }
  });
  it("tolerates holes in the pose array", () => {
    expect(outOfFrameNodes([null, undefined, [-1, -1]], W, H)).toEqual([2]);
  });
});

describe("checkFrameBounds", () => {
  it("aggregates over instances and names the FIRST offender deterministically", () => {
    const r = checkFrameBounds([
      [[10, 10], [20, 20]],            // clean
      [[10, 10], [-5, 20], [W + 3, 1]],// two out
      [[-1, -1]],                      // one out
    ], W, H);
    expect(r.isOutOfFrame).toBe(true);
    expect(r.nOutOfFrame).toBe(3);
    expect(r.outOfFrameInstance).toBe(1);   // lowest instance with an offender
    expect(r.outOfFrameNode).toBe(1);       // lowest node within it
    expect(r.byInstance).toEqual([[], [1, 2], [0]]);
  });
  it("clean frame reports no offender", () => {
    const r = checkFrameBounds([[[1, 1]], [[2, 2]]], W, H);
    expect(r).toMatchObject({ isOutOfFrame: false, nOutOfFrame: 0, outOfFrameInstance: -1, outOfFrameNode: -1 });
  });
  it("an all-NaN frame is NOT flagged (that's Sparse's job, not this check's)", () => {
    const r = checkFrameBounds([[[NaN, NaN], [NaN, NaN]]], W, H);
    expect(r.isOutOfFrame).toBe(false);
  });
  it("no frames / no bounds is safe", () => {
    expect(checkFrameBounds([], W, H).isOutOfFrame).toBe(false);
    expect(checkFrameBounds(null, W, H).isOutOfFrame).toBe(false);
    expect(checkFrameBounds([[[-9, -9]]], undefined, undefined).isOutOfFrame).toBe(false);
  });
});

describe("videoBounds", () => {
  it("reads [nFrames, height, width, channels]", () => {
    expect(videoBounds({ shape: [100, 480, 640, 1] })).toEqual({ w: 640, h: 480 });
  });
  it("null when the shape is missing or degenerate", () => {
    for (const v of [null, {}, { shape: null }, { shape: [10] }, { shape: [10, 0, 0, 1] }]) {
      expect(videoBounds(v)).toBeNull();
    }
  });
});
