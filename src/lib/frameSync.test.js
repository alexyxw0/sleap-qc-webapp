// The overlay used to arrive a frame ahead of the picture: `current` flips synchronously on navigation
// while the decode takes ~50-100 ms, so the canvas showed the NEW pose over the OLD image. For QC that is
// worse than a stall — a correct pose looks wrong. The store now publishes the image and the frame it
// depicts together, and warms the neighbours so the common case never stalls at all.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";

const read = (p) => readFileSync(p, "utf8");

describe("image and pose are published as a pair", () => {
  const s = read("src/lib/labelsStore.svelte.js");

  it("the store exposes which frame the image actually depicts", () => {
    expect(s).toMatch(/shownItem = \$state\.raw\(null\)/);
    // set in the SAME tick as the image, or the pair can still tear
    const pump = s.slice(s.indexOf("async #pumpFrameImage"), s.indexOf("#prefetchNeighbours()"));
    const img = pump.indexOf("this.frameImage = img ?? null;");
    const shown = pump.indexOf("this.shownItem = item;");
    expect(img).toBeGreaterThan(-1);
    expect(shown, "shownItem is never assigned in the pump").toBeGreaterThan(img);
    expect(shown - img).toBeLessThan(120); // adjacent statements, nothing awaited between
  });

  it("it is cleared with the image, so a new file can't show the old one's pose", () => {
    expect((s.match(/this\.shownItem = null;/g) || []).length).toBeGreaterThanOrEqual(2);
    expect(s).toMatch(/frameImageReady\(\)/);
  });

  it("neighbours are warmed AFTER the wanted frame, never before it", () => {
    const pump = s.slice(s.indexOf("async #pumpFrameImage"));
    const settle = pump.indexOf("else this.#prefetchNeighbours();");
    expect(settle).toBeGreaterThan(-1);
    // it must be in the branch where nothing is still wanted
    expect(pump.slice(settle - 90, settle)).toMatch(/if \(this\.#imgWant !== this\.#imgHave\)/);
    // the method BODY only — slicing to end-of-file would sweep in every other await in the store
    const at = s.indexOf("#prefetchNeighbours() {");
    const fn = s.slice(at, s.indexOf("\n  }\n", at));
    expect(fn).toMatch(/\[i \+ 1, i - 1\]/);
    expect(fn).toMatch(/if \(this\.#imgCache\.has/); // already-warm frames cost nothing
    expect(fn).not.toMatch(/await /); // fire and forget, or it delays what you are looking at
    expect(fn).toMatch(/\.catch\(/); // a failed prefetch must never surface as an unhandled rejection
  });
});

// The source checks above say the code is SHAPED right. This drives the real store and watches what it
// publishes over time, which is the thing that was actually broken.
describe("navigating never exposes a mismatched pair", () => {
  it("shownItem lags `current` for exactly as long as the decode, then catches up", async () => {
    const frames = [0, 1, 2].map((i) => ({ video: "v", frameIdx: i, lf: { instances: [] } }));
    let resolveDecode;
    const decoded = [];
    const { store } = await import("./labelsStore.svelte.js");
    store.labels = { videos: ["v"] };
    store.frames = frames;
    store.index = 0;
    // stand in for the decode so its timing is ours to control
    store.getFrameImage = (item) =>
      new Promise((res) => { decoded.push(item.frameIdx); resolveDecode = () => res({ tag: item.frameIdx }); });

    store.syncFrameImage();
    expect(decoded).toEqual([0]); // the frame you are ON is requested first, alone
    resolveDecode();
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(store.shownItem).toBe(frames[0]);
    expect(store.frameImage.tag).toBe(0);
    expect(store.frameImageReady).toBe(true);
    expect(decoded).toContain(1); // ...and only then is the neighbour warmed

    // navigate: `current` moves at once, but the published pair must NOT
    store.index = 2;
    store.syncFrameImage();
    expect(store.current).toBe(frames[2]);
    expect(store.shownItem).toBe(frames[0]); // still the old frame...
    expect(store.frameImage.tag).toBe(0); // ...with its OWN image. A matched, stale pair.
    expect(store.frameImageReady).toBe(false);

    resolveDecode();
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(store.shownItem).toBe(frames[2]); // both halves swap together
    expect(store.frameImage.tag).toBe(2);
    expect(store.frameImageReady).toBe(true);
  });
});

describe("every canvas computation agrees on which frame is shown", () => {
  const v = read("src/lib/components/Viewer.svelte");

  it("the proofreading window will not paint a mismatched pair either", () => {
    const w = read("src/lib/components/ProofreadWindow.svelte");
    expect(w).toMatch(/let imgFor = \$state\.raw\(null\)/);
    expect(w).toContain("img = r ?? null; imgFor = it;"); // published together
    expect(w).toContain("if (imgFor !== it) return;"); // and nothing paints until they match
  });

  it("the viewer draws the shown frame, not the index", () => {
    expect(v).toMatch(/const shown = \$derived\(store\.shownItem \?\? store\.current\)/);
    expect(v).toContain("const item = shown;");
  });

  it("geometry and hit-testing use the same frame as the drawing", () => {
    // a zoom computed from a different frame's dimensions lands in the wrong place across videos
    expect(v).not.toMatch(/frameDims\(store\.current/);
    expect(v).toMatch(/const lf = shown\?\.lf;/);
  });
});
