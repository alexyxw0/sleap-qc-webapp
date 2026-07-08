import { describe, it, expect, vi } from "vitest";

// RUNTIME test: actually executes embeddingStore.run() (a .svelte.js reactive store) end-to-end with
// the DOM + DINO model mocked. This exercises the exact browser control flow that a production build
// and the pure-math tests do NOT — it would have caught the "z is out of scope → run() throws → stuck
// at scoring → checkbox never unlocks" bug, because that made run() never reach status "done".

// Minimal fakes for the few DOM APIs run() touches (we mock embed(), so pixels don't matter — the
// canvas just has to not throw). No jsdom needed.
globalThis.document = {
  createElement: () => ({
    width: 0, height: 0,
    getContext: () => ({ fillStyle: "", fillRect() {}, drawImage() {}, getImageData: () => ({ data: new Uint8ClampedArray(4), width: 1, height: 1 }) }),
    toDataURL: () => "data:image/jpeg;base64,AA==",
  }),
};
globalThis.requestAnimationFrame = (cb) => { cb(performance.now()); return 0; };

// Mock the DINO model: no CDN, no network, no real inference. Distinct vector per call so the
// embedding set isn't degenerate (varying by an internal counter).
let embN = 0;
vi.mock("./qc/embedding/dino.js", () => ({
  MODEL: { id: "test", name: "test", dim: 384, patch: 14, input: 224 },
  ensureModel: async () => ({ id: "test", dim: 384, input: 224 }),
  embed: async () => { embN++; const v = new Float32Array(384); for (let i = 0; i < 384; i++) v[i] = Math.sin(i * 0.1 + embN); return v; },
  isLoaded: () => true,
}));

// Mock the labels store: a small multi-frame, multi-instance fake dataset (≥2 placed points per
// instance so squareBox yields a box), with a fake decoded frame image.
const vA = { filename: "a", shape: [10, 100, 100, 1] };
const frame = (frameIdx, nInst) => ({
  video: vA, frameIdx,
  lf: { instances: Array.from({ length: nInst }, () => ({ points: [{ xy: [10, 10] }, { xy: [30, 40] }, { xy: [22, 28] }] })) },
});
const fakeFrames = [frame(0, 2), frame(1, 1), frame(2, 2)];
vi.mock("./labelsStore.svelte.js", () => ({
  store: { labels: { videos: [vA] }, frames: fakeFrames, fileName: "test.pkg.slp", getFrameImage: async () => ({ width: 100, height: 100 }) },
}));

const { embeddingStore } = await import("./embeddingStore.svelte.js");

describe("embeddingStore.run() — runtime", () => {
  it("runs to completion: reaches 'done', exposes results, unlocks (hasResults), builds per-frame z", async () => {
    await embeddingStore.run();
    // The regression guard: a throw anywhere in run() (like the z-scope bug) leaves status stuck and
    // hasResults false — the exact 'stuck at scoring / checkbox uncheckable' symptom.
    expect(embeddingStore.status).toBe("done");
    expect(embeddingStore.hasResults).toBe(true);
    expect(embeddingStore.results.z.length).toBe(5); // 2 + 1 + 2 instances embedded
    // frameZ must be keyed "videoIdx:frameIdx" so the DINO QC check can join on it.
    expect(embeddingStore.frameZByKey("0:0")).not.toBeNull();
    expect(embeddingStore.frameZByKey("0:2")).not.toBeNull();
    expect(embeddingStore.flaggedFrameKeys().length).toBeGreaterThanOrEqual(0);
  });
});
