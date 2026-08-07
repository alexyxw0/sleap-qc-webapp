import { describe, it, expect, vi } from "vitest";

// RUNTIME test: executes nodeEmbeddingStore.run() end-to-end for BOTH backends, DOM + DINO mocked. It
// exercises the per-node planning, batched embed, per-node grouping + scoring, and the frame-level QC
// interface — the browser control flow the pure tests don't reach (the "stuck at scoring" class of bug).

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

let embN = 0;
vi.mock("./qc/embedding/dinoRemote.js", () => ({
  MODEL: { id: "test", name: "DINO(test)", dim: 384, patch: 14, input: 224, batch: 8 },
  ensureModel: async () => ({ id: "test", name: "DINO(test)", dim: 384, input: 224 }),
  embedBatch: async (images) => images.map(() => { embN++; const v = new Float32Array(384); for (let i = 0; i < 384; i++) v[i] = Math.sin(i * 0.1 + embN); return v; }),
  isLoaded: () => true,
}));

// 6 frames × 2 instances = 12 instances, each with 3 placed nodes -> 12 patches PER NODE (above the
// MIN_PER_NODE=8 floor, so every node group actually scores).
const vA = { filename: "a", shape: [10, 100, 100, 1] };
const frame = (frameIdx, nInst) => ({
  video: vA, frameIdx,
  lf: { instances: Array.from({ length: nInst }, () => ({ points: [{ xy: [10, 10] }, { xy: [30, 40] }, { xy: [22, 28] }] })) },
});
const fakeFrames = [frame(0, 2), frame(1, 2), frame(2, 2), frame(3, 2), frame(4, 2), frame(5, 2)];
vi.mock("./labelsStore.svelte.js", () => ({
  store: { labels: { videos: [vA] }, frames: fakeFrames, fileName: "test.pkg.slp", getFrameImage: async () => ({ width: 100, height: 100 }) },
}));

const { nodeEmbeddingStores, NodeEmbeddingStore } = await import("./nodeEmbeddingStore.svelte.js");
// A second instance, built directly rather than via the registry: the run loop is per-store, so this is
// what proves one store's results survive another store's run.
const second = new NodeEmbeddingStore("dino");

function assertCompleted(es) {
  expect(es.status).toBe("done");
  expect(es.hasResults).toBe(true);
  // 12 instances × 3 nodes = 36 patches; 3 node groups, each scored (12 ≥ MIN_PER_NODE).
  expect(es.nodeStats.length).toBe(3);
  expect(es.nodeStats.every((n) => n.scored && n.count === 12)).toBe(true);
  // Each node has a real graph (12 points with finite z + coords).
  for (const ns of es.nodeStats) {
    const pts = es.pointsForNode(ns.node);
    expect(pts.length).toBe(12);
    expect(pts.every((p) => Number.isFinite(p.z) && Number.isFinite(p.x) && Number.isFinite(p.y))).toBe(true);
  }
  // Frame-level QC interface populated + keyed "videoIdx:frameIdx".
  expect(es.frameZByKey("0:0")).not.toBeNull();
  expect(es.frameZByKey("0:5")).not.toBeNull();
  expect(es.selectedNode).not.toBeNull();
}

describe("nodeEmbeddingStore.run() — runtime", () => {
  it("runs to completion with a scored graph per keypoint", async () => {
    await second.run();
    assertCompleted(second);
  });

  it("a second store runs without clobbering the first", async () => {
    await nodeEmbeddingStores.dino.run();
    assertCompleted(nodeEmbeddingStores.dino);
    assertCompleted(second); // per-node stores hold their own results
  });

  it("the registry offers DINO only", () => {
    expect(Object.keys(nodeEmbeddingStores)).toEqual(["dino"]);
  });
});
