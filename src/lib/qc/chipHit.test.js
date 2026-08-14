// The keypoint chips are small and the gaps between them are real, so a drag along a row kept
// skipping one whenever the pointer passed through a gap or drifted a few pixels above the row.
// These pin the tolerance — and, just as importantly, that the tolerance does not make the drag
// grab things it should not.
import { describe, it, expect } from "vitest";
import { distToRect, nearestChip } from "./chipHit.js";

/** 13 chips of 46x22, 6px apart, wrapping to a second row 6px below — a real skeleton's row. */
function row() {
  const rects = [];
  let x = 0, y = 0;
  for (let i = 0; i < 13; i++) {
    if (i === 7) { x = 0; y = 28; }
    rects.push({ left: x, right: x + 46, top: y, bottom: y + 22 });
    x += 52;
  }
  return rects;
}
const R = row();
const centre = (i) => [R[i].left + 23, R[i].top + 11];

describe("distToRect", () => {
  const r = { left: 10, right: 20, top: 10, bottom: 20 };
  it("is zero anywhere inside", () => {
    expect(distToRect(r, 15, 15)).toBe(0);
    expect(distToRect(r, 10, 20)).toBe(0);   // on the edge
  });
  it("is the shortest gap to the edge outside", () => {
    expect(distToRect(r, 25, 15)).toBe(5);            // straight out to the right
    expect(distToRect(r, 15, 4)).toBe(6);             // straight up
    expect(distToRect(r, 23, 23)).toBeCloseTo(Math.hypot(3, 3), 9);  // diagonal from a corner
  });
});

describe("nearestChip", () => {
  it("hits the chip the pointer is inside", () => {
    for (const i of [0, 3, 6, 7, 12]) expect(nearestChip(R, ...centre(i))).toBe(i);
  });

  it("rescues the gap between two chips — the miss that started this", () => {
    const gap = [R[3].right + 3, R[3].top + 11];      // dead centre of a 6px gap
    expect(nearestChip(R, ...gap)).toBeGreaterThanOrEqual(0);
  });

  it("resolves a tie to the lower index, deterministically", () => {
    // Exactly equidistant from 3 and 4. Depending on DOM order here would make the drag flaky.
    const gap = [R[3].right + 3, R[3].top + 11];
    expect(nearestChip(R, ...gap)).toBe(3);
    expect(nearestChip(R, ...gap)).toBe(3);
  });

  it("forgives drifting off the row by a few pixels", () => {
    const [x] = centre(5);
    expect(nearestChip(R, x, R[5].top - 4), "4px above").toBe(5);
    expect(nearestChip(R, x, R[5].top - 10), "10px above, still inside slop").toBe(5);
  });

  it("does NOT forgive being properly off the row", () => {
    const [x] = centre(5);
    expect(nearestChip(R, x, R[5].top - 20)).toBe(-1);
    expect(nearestChip(R, 600, 300)).toBe(-1);
  });

  it("between two rows it takes the nearer one, not the earlier one", () => {
    // Row one ends at 22, row two starts at 28. A point at 26 is 4px from one and 2px from the other.
    const [x] = centre(0);
    expect(nearestChip(R, x, 26)).toBe(7);
  });

  it("a point inside the second row is not stolen by the first", () => {
    const [x] = centre(2);
    expect(nearestChip(R, x, 31)).toBe(9);   // row two spans 28..50
  });

  it("the slop is a parameter, and zero means strict containment", () => {
    const gap = [R[3].right + 3, R[3].top + 11];
    expect(nearestChip(R, ...gap, 0)).toBe(-1);
    expect(nearestChip(R, ...centre(3), 0)).toBe(3);
  });

  it("an empty row hits nothing rather than throwing", () => {
    expect(nearestChip([], 5, 5)).toBe(-1);
  });
});
