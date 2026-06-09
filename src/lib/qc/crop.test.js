import { describe, it, expect } from "vitest";
import { cropRect } from "./crop.js";

describe("cropRect", () => {
  const W = 1000;
  const H = 800;

  it("centers a square crop on the point when well inside", () => {
    expect(cropRect(500, 400, 100, W, H)).toEqual({ x: 450, y: 350, w: 100, h: 100 });
  });

  it("clamps at the top-left edge without shrinking", () => {
    expect(cropRect(10, 10, 100, W, H)).toEqual({ x: 0, y: 0, w: 100, h: 100 });
  });

  it("clamps at the bottom-right edge without shrinking", () => {
    expect(cropRect(995, 795, 100, W, H)).toEqual({ x: 900, y: 700, w: 100, h: 100 });
  });

  it("never extends outside the image", () => {
    for (const [cx, cy] of [[0, 0], [W, H], [500, 0], [0, 400]]) {
      const r = cropRect(cx, cy, 200, W, H);
      expect(r.x).toBeGreaterThanOrEqual(0);
      expect(r.y).toBeGreaterThanOrEqual(0);
      expect(r.x + r.w).toBeLessThanOrEqual(W);
      expect(r.y + r.h).toBeLessThanOrEqual(H);
    }
  });

  it("clamps the size down when it exceeds an image dimension", () => {
    const r = cropRect(400, 400, 2000, W, H);
    expect(r).toEqual({ x: 0, y: 0, w: W, h: H });
  });
});
