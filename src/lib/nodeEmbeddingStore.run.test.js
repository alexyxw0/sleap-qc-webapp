import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";

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
  // Node NAMES matter: keypoint labels are keyed by name, so training cannot join without them.
  store: { labels: { videos: [vA] }, frames: fakeFrames, fileName: "test.pkg.slp",
           skeleton: { nodeNames: ["nose", "ear", "tail"] },
           getFrameImage: async () => ({ width: 100, height: 100 }) },
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

  it("a keypoint subset embeds ONLY those keypoints", async () => {
    const st = new NodeEmbeddingStore("dino");
    st.nodes = [0, 2]; // the fixture's poses have 3 nodes
    await st.run();
    expect(st.status).toBe("done");
    expect(st.nodeStats.map((n) => n.node).sort()).toEqual([0, 2]);
    expect(st.coveredNode(1), "node 1 was not selected but got embedded").toBe(false);
    expect(st.coveredNode(0)).toBe(true);
    // and it really is cheaper — 2 of 3 nodes over the same instances
    expect(st.embeddedCount).toBe(12 * 2);
  });

  it("coverage describes the RUN, not the live selection", async () => {
    const st = new NodeEmbeddingStore("dino");
    st.nodes = [1];
    await st.run();
    expect(st.coverage.requested).toEqual([1]);
    expect([...st.coverage.covered]).toEqual([1]);
    st.nodes = [0, 1, 2]; // re-tick chips WITHOUT re-running
    expect(st.coverage.requested, "results were relabelled by a chip click").toEqual([1]);
    expect(st.coveredNode(0)).toBe(false);
  });

  it("null means every keypoint; an EMPTY selection is refused rather than widened", async () => {
    const all = new NodeEmbeddingStore("dino");
    all.nodes = null;
    await all.run();
    expect(all.coverage.partial).toBe(false);
    expect(all.nodeStats.length).toBe(3);

    const none = new NodeEmbeddingStore("dino");
    none.nodes = [];
    await none.run();
    // widening [] to "all" would silently launch the most expensive possible pass
    expect(none.status).toBe("error");
    expect(none.message).toMatch(/at least one/i);
    expect(none.hasResults).toBe(false);
  });

  it("a selection naming keypoints this file never places says so, distinctly", async () => {
    const st = new NodeEmbeddingStore("dino");
    st.nodes = [7, 8]; // beyond the fixture's 3 nodes
    await st.run();
    expect(st.status).toBe("error");
    expect(st.message).toMatch(/selected keypoints/i); // not the generic "no placed keypoints"
  });

  it("worstNodeFor can only speak for what was embedded", async () => {
    const st = new NodeEmbeddingStore("dino");
    st.nodes = [2];
    await st.run();
    const w = st.worstNodeFor(0, 0);
    expect(w?.node, "attributed a fault to a keypoint it never looked at").toBe(2);
  });

  it("a ✓ stops describing the run once the settings move", async () => {
    const st = new NodeEmbeddingStore("dino");
    st.nodes = [0, 2];
    await st.run();
    expect(st.hasResults).toBe(true);
    expect(st.configDirty, "clean run reported as dirty").toBe(false);
    st.nodes = [0, 1, 2];              // the pass no longer matches the controls
    expect(st.configDirty).toBe(true);
    st.nodes = [0, 2];                 // ...and back
    expect(st.configDirty).toBe(false);
  });

  it("a re-run with the same selection is not dirty", async () => {
    const st = new NodeEmbeddingStore("dino");
    await st.run();
    expect(st.configDirty).toBe(false);
    await st.run();
    expect(st.configDirty).toBe(false);
  });

  it("nothing is dirty before a run — there is no run to disagree with", () => {
    const st = new NodeEmbeddingStore("dino");
    st.nodes = [0];
    expect(st.configDirty).toBe(false);
  });

  it("the cache partition is exposed so a probe cannot miss by a format detail", () => {
    const st = new NodeEmbeddingStore("dino");
    expect(typeof st.cacheId).toBe("string");
    expect(st.cacheId).toContain("dino");
  });

  it("trains on EVERY judged patch of a keypoint — never a sample", async () => {
    const { keypointLabels } = await import("./keypointLabels.svelte.js");
    const st = new NodeEmbeddingStore("dino");
    await st.run();
    keypointLabels.clear();
    // judge 8 of the 12 instances on node 0; leave 4 unjudged
    for (let f = 0; f < 4; f++) {
      for (let ii = 0; ii < 2; ii++) keypointLabels.markAt(`0:${f}`, ii, "nose", (f + ii) % 2 === 0);
    }
    const set = st.trainingSetFor(0);
    expect(set.rows.length, "the training set is not every judged patch").toBe(8);
    expect(set.y.filter((v) => v > 0).length).toBe(4);
    // the 4 unjudged instances must be absent — "not looked at" is not a clean label
    expect(set.rows.length).toBeLessThan(12);
    const t = st.trainableFor(0);
    expect(t).toMatchObject({ n: 8, pos: 4, neg: 4, enough: true });
    keypointLabels.clear();
  });

  it("an unjudged file trains nothing, and says which half is missing", async () => {
    const { keypointLabels } = await import("./keypointLabels.svelte.js");
    const st = new NodeEmbeddingStore("dino");
    await st.run();
    keypointLabels.clear();
    expect(st.trainableFor(0)).toMatchObject({ n: 0, pos: 0, enough: false });
    expect(() => st.trainFor(0)).toThrow();
    // one class only is still not trainable
    for (let f = 0; f < 3; f++) keypointLabels.markAt(`0:${f}`, 0, "nose", true);
    expect(st.trainableFor(0).enough, "one class cannot be learned").toBe(false);
    keypointLabels.clear();
  });

  it("a trained model re-scores its keypoint on the SAME scale the threshold expects", async () => {
    const { keypointLabels } = await import("./keypointLabels.svelte.js");
    const st = new NodeEmbeddingStore("dino");
    await st.run();
    keypointLabels.clear();
    for (let f = 0; f < 6; f++) {
      for (let ii = 0; ii < 2; ii++) keypointLabels.markAt(`0:${f}`, ii, "nose", ii === 0);
    }
    const before = st.pointsForNode(0).map((p) => p.z);
    const { clf, cv } = st.trainFor(0);
    st.applyTrainedModel(0, clf);
    const after = st.pointsForNode(0).map((p) => p.z);
    expect(after).not.toEqual(before);              // it actually re-scored
    expect(st.trainedNode(0)).toBe(true);
    expect(st.trainedNode(1), "only the trained keypoint changed").toBe(false);
    // robust-z, not probabilities: a 0..1 group would silently never clear the 3.5 cutoff
    expect(Math.max(...after.map(Math.abs))).toBeGreaterThan(1);
    expect(cv.nPos + cv.nNeg).toBe(12);
    keypointLabels.clear();
  });

  // The claim the "upload a fitted model" branch makes: label one file, apply the boundary to the next
  // without labelling again. Every step of that is exercised here, end to end, against a real run.
  it("fit -> export -> import -> apply reproduces the same scores on a fresh store", async () => {
    const { keypointLabels } = await import("./keypointLabels.svelte.js");
    const { exportModel, importModel } = await import("./qc/embedding/svmIo.js");
    const a = new NodeEmbeddingStore("dino");
    await a.run();
    keypointLabels.clear();
    for (let f = 0; f < 6; f++) for (let ii = 0; ii < 2; ii++) keypointLabels.markAt(`0:${f}`, ii, "nose", ii === 0);

    const { clf } = a.trainFor(0);
    a.applyTrainedModel(0, clf);
    expect(a.scoringOf(0)).toBe("svm");
    const trained = a.pointsForNode(0).map((p) => p.z);

    const file = exportModel(a.trainedModelFor(0), { node: "nose", source: "a.slp" });
    keypointLabels.clear(); // the second session has NO labels — that is the entire point

    const b = new NodeEmbeddingStore("dino");
    await b.run();
    const unsupervised = b.pointsForNode(0).map((p) => p.z);
    const { clf: back, warning } = importModel(file, { dim: b.dim, node: "nose" });
    expect(warning).toBeNull();

    b.applyTrainedModel(0, back);
    expect(b.scoringOf(0)).toBe("svm");
    const viaFile = b.pointsForNode(0).map((p) => p.z);
    expect(viaFile, "the boundary did not replace the unsupervised scores").not.toEqual(unsupervised);

    // The equality that matters: the file-round-tripped model scores EXACTLY as the in-memory one does.
    // (Not "the same numbers as store a" — the mock encoder is stateful, so b's patches are its own.)
    b.applyTrainedModel(0, clf);
    b.pointsForNode(0).map((p) => p.z).forEach((z, i) => expect(z).toBeCloseTo(viaFile[i], 5));
  });

  it("the registry offers DINO only", () => {
    expect(Object.keys(nodeEmbeddingStores)).toEqual(["dino"]);
  });
});

// scoringOf/trainedModelFor answer "what produced this number". Both were memory that outlived the
// numbers they described, which is the worst kind: confidently wrong rather than absent.
describe("the scoring choice never outlives the scores it describes", () => {
  const src = readFileSync("src/lib/nodeEmbeddingStore.svelte.js", "utf8");

  it("a fresh run drops the trained models and the few-shot blends", () => {
    const body = src.slice(src.indexOf("async run() {"), src.indexOf("this.status = \"loading-model\""));
    for (const f of ["#trainedNodes.clear()", "#fewShot.clear()", "#fsBase.clear()"]) expect(body, f).toContain(f);
    // and it must happen where #z is dropped, not after the embed loop
    expect(body.indexOf("#trainedNodes.clear()")).toBeGreaterThan(body.indexOf("this.#z = [];"));
  });

  it("training a model retires that keypoint's few-shot blend", () => {
    const body = src.slice(src.indexOf("applyTrainedModel(ni, clf)"), src.indexOf("trainedNode(ni)"));
    expect(body).toContain("this.#fewShot.delete(ni)");
    expect(body).toContain("this.#fsBase.delete(ni)");
  });

  it("re-applying few-shot blends the ORIGINAL scores, never a previous blend", () => {
    const body = src.slice(src.indexOf("applyFewShot(ni"), src.indexOf("fewShotInfoFor(ni)"));
    const restore = body.indexOf("this.#fsBase.has(ni)");
    const blend = body.indexOf("blendByRank(");
    expect(restore, "no base snapshot — a second click compounds the shift").toBeGreaterThan(-1);
    expect(restore).toBeLessThan(blend);
  });
});
