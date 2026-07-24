import { describe, it, expect, vi } from "vitest";

// RUNTIME test: actually executes embeddingStore.run() (a .svelte.js reactive store) end-to-end for
// BOTH backends, with the DOM (and the DINO model) mocked. This exercises the exact browser control
// flow that a production build and the pure-math tests do NOT — it would have caught the "z is out of
// scope → run() throws → stuck at scoring → checkbox never unlocks" bug (run() never reached "done").

// Minimal DOM fakes for the few APIs run()/embed() touch. getImageData returns a properly-sized buffer
// (varying by a counter) so the real CLASSICAL backend produces valid, non-degenerate feature vectors.
let px = 0;
globalThis.document = {
  createElement: () => ({
    width: 0, height: 0,
    getContext: () => ({
      fillStyle: "", fillRect() {}, drawImage() {},
      getImageData: (x, y, w, h) => { px++; const data = new Uint8ClampedArray(w * h * 4); for (let i = 0; i < data.length; i++) data[i] = (i * 7 + px * 31) % 256; return { data, width: w, height: h }; },
    }),
    toDataURL: () => "data:image/jpeg;base64,AA==",
  }),
};
globalThis.requestAnimationFrame = (cb) => { cb(performance.now()); return 0; };

// Mock the DINO backend (the worker-client module): no CDN, no network, no real inference. The store
// hands it BATCHES of raw RGBA crops; return a distinct vector per crop.
let embN = 0;
vi.mock("./qc/embedding/dinoRemote.js", () => ({
  MODEL: { id: "test", name: "DINO(test)", dim: 384, patch: 14, input: 224, batch: 8 },
  ensureModel: async () => ({ id: "test", name: "DINO(test)", dim: 384, input: 224 }),
  embedBatch: async (images) => images.map(() => { embN++; const v = new Float32Array(384); for (let i = 0; i < 384; i++) v[i] = Math.sin(i * 0.1 + embN); return v; }),
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

const { embeddingStores } = await import("./embeddingStore.svelte.js");

// The regression guard for BOTH backends: a throw anywhere in run() (like the z-scope bug) leaves the
// status stuck and hasResults false — the exact 'stuck at scoring / checkbox uncheckable' symptom.
function assertCompleted(es) {
  expect(es.status).toBe("done");
  expect(es.hasResults).toBe(true);
  expect(es.results.z.length).toBe(5); // 2 + 1 + 2 instances embedded
  expect(es.results.z.every(Number.isFinite)).toBe(true);
  // frameZ must be keyed "videoIdx:frameIdx" so the appearance QC check can join on it.
  expect(es.frameZByKey("0:0")).not.toBeNull();
  expect(es.frameZByKey("0:2")).not.toBeNull();
}

describe("embeddingStore.run() — runtime", () => {
  it("classical backend runs to completion with valid results", async () => {
    await embeddingStores.classical.run();
    assertCompleted(embeddingStores.classical);
  });

  it("dino backend runs to completion with valid results, without clobbering the classical store", async () => {
    await embeddingStores.dino.run();
    assertCompleted(embeddingStores.dino);
    expect(embeddingStores.dino.results.coords.length).toBe(5);
    // Both stores coexist: running DINO must not wipe the classical results (they're separate checks).
    assertCompleted(embeddingStores.classical);
  });
});
