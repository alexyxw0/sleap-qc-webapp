// The proofreading window's zoom. The invariant that matters is not "it zooms" — it is that the
// image point under the pointer does not move while it does. Drift of a few pixels per notch is
// invisible in a screenshot, throws nothing, and makes the control feel broken to use.
import { describe, it, expect } from "vitest";
import { fitScale, clampCenter, panForZoom, clampZoom } from "./zoomView.js";

describe("fitScale", () => {
  it("picks the binding axis", () => {
    expect(fitScale({ w: 800, h: 400 }, { w: 200, h: 200 })).toBe(2);   // height binds
    expect(fitScale({ w: 400, h: 800 }, { w: 200, h: 200 })).toBe(2);   // width binds
    expect(fitScale({ w: 100, h: 400 }, { w: 200, h: 200 })).toBe(0.5); // shrink to fit
  });
});

describe("clampCenter", () => {
  it("holds the view inside the image", () => {
    expect(clampCenter(0, 100, 1000)).toBe(100);      // pushed off the left edge
    expect(clampCenter(9999, 100, 1000)).toBe(900);   // ...and the right
    expect(clampCenter(500, 100, 1000)).toBe(500);    // comfortably inside: untouched
  });

  it("centres the axis when the window is wider than the picture", () => {
    // Otherwise the clamp range inverts (lo > hi) and the picture jitters against an impossible bound.
    expect(clampCenter(0, 800, 1000)).toBe(500);
    expect(clampCenter(9999, 800, 1000)).toBe(500);
  });
});

describe("panForZoom holds the point under the pointer", () => {
  /** Where an image point lands on screen, in CSS px from the canvas centre. */
  const screenOf = (p, centre, s) => (p - centre) * s;

  it("keeps the pointed-at pixel fixed across a zoom in", () => {
    const base = 500, s = 2, ns = 2.3, m = 137;      // pointer 137 px right of centre
    const c = 500;
    const p = c + m / s;                             // the image point under the pointer
    const pan = panForZoom(c, base, m, s, ns);
    const c2 = base + pan;
    expect(screenOf(p, c2, ns)).toBeCloseTo(m, 9);   // still 137 px right of centre
  });

  it("holds it on zoom OUT too", () => {
    const base = 500, s = 4, ns = 2.5, m = -212;
    const c = 480;                                   // already panned
    const p = c + m / s;
    const c2 = base + panForZoom(c, base, m, s, ns);
    expect(screenOf(p, c2, ns)).toBeCloseTo(m, 9);
  });

  it("does not drift over a long wheel sequence", () => {
    // The failure this is really about: each notch computes a pan, and a formula that accumulates
    // onto the previous one instead of deriving from the current centre creeps a little every time.
    let uz = 1, pan = 0;
    const base = 500, fit = 2, m = 90;
    let c = base;
    const p0 = c + m / (fit * uz);
    for (let i = 0; i < 40; i++) {
      const nz = uz * (i % 2 ? 1 / 1.15 : 1.15 * 1.15);   // in, out, net zoom in
      const s = fit * uz, ns = fit * nz;
      pan = panForZoom(c, base, m, s, ns);
      uz = nz;
      c = base + pan;                                     // no clamping: interior of a large image
      expect(screenOf(p0, c, ns), `notch ${i}`).toBeCloseTo(m, 6);
    }
  });

  it("zooming exactly at the centre never pans", () => {
    expect(panForZoom(500, 500, 0, 2, 4)).toBe(0);
  });

  it("recovers from a clamped centre instead of compounding the offset", () => {
    // At an edge the clamp has already moved the centre away from base+pan. Deriving from the
    // clamped centre is what stops the next zoom from inheriting that discrepancy.
    const base = 500, clamped = 120, s = 2, ns = 3, m = 40;
    const p = clamped + m / s;
    const c2 = base + panForZoom(clamped, base, m, s, ns);
    expect(screenOf(p, c2, ns)).toBeCloseTo(m, 9);
  });
});

describe("clampZoom", () => {
  it("never goes below the fit, never past the cap", () => {
    expect(clampZoom(0.2, 12)).toBe(1);   // below the fit would letterbox for no reason
    expect(clampZoom(50, 12)).toBe(12);
    expect(clampZoom(3.5, 12)).toBe(3.5);
  });
});
