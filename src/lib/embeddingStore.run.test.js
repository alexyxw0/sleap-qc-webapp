import { describe, it, expect, vi } from "vitest";

// RUNTIME test: actually executes embeddingStore.run() (a .svelte.js reactive store) end-to-end, with
// the DOM (and the DINO model) mocked. This exercises the exact browser control
// flow that a production build and the pure-math tests do NOT — it would have caught the "z is out of
// scope → run() throws → stuck at scoring → checkbox never unlocks" bug (run() never reached "done").

// Minimal DOM fakes for the few APIs run()/embed() touch. getImageData returns a properly-sized buffer
// (varying by a counter) so the crops the store hands the mocked encoder are valid and non-degenerate.
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
import { tokenCount } from "./qc/embedding/patchTokens.js";
let embN = 0;
// Lets one test reproduce the state a warm cache from before patch features puts you in: CLS vectors
// and nothing else. That is the state where AnomalyDINO would silently score everything 0.
let noPatches = false;
vi.mock("./qc/embedding/dinoRemote.js", () => ({
  MODEL: { id: "test", name: "DINO(test)", dim: 384, patch: 14, input: 224, batch: 8 },
  ensureModel: async () => ({ id: "test", name: "DINO(test)", dim: 384, input: 224 }),
  // The real backend returns BOTH products of one forward pass. The instance store asks for patch
  // descriptors now (AnomalyDINO reads them), so this honours patchCfg exactly as production does.
  embedBatch: async (images, patchCfg) => ({
    embs: images.map(() => { embN++; const v = new Float32Array(384); for (let i = 0; i < 384; i++) v[i] = Math.sin(i * 0.1 + embN); return v; }),
    patches: patchCfg && !noPatches ? images.map(() => new Int8Array(tokenCount(patchCfg) * patchCfg.dim)) : null,
  }),
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
  // These fixtures are single-video, so index 0 is the whole story. The real derivation — and the
  // miss case that made the write and read sides disagree — is tested against the real module in
  // labelsStore.frameKey.test.js.
  frameKey: (f) => (f ? (f.fkey ?? `0:${f.frameIdx}`) : null),

  store: {
    labels: { videos: [vA] }, frames: fakeFrames, fileName: "test.pkg.slp",
    // Counted: a re-score must not touch a single frame image. That is the whole reason switching the
    // scorer is arithmetic rather than another pass of inference.
    getFrameImage: async () => { globalThis.__decodes = (globalThis.__decodes ?? 0) + 1; return { width: 100, height: 100 }; },
  },
}));

// Whole-instance scoring is the trained RBF-SVM now (the unsupervised kNN option was removed), and the
// classifier weights are a fetched binary asset. Mock the decision function — this test is about the run
// loop reaching a terminal state, not about the SVM's arithmetic (svm.test.js covers that).
vi.mock("./qc/embedding/appearanceClf.js", async (orig) => ({
  ...(await orig()),
  classifyDecisions: async (embs) => embs.map((_, i) => Math.sin(i * 1.7)),
}));

const { embeddingStores } = await import("./embeddingStore.svelte.js");

// The regression guard: a throw anywhere in run() (like the z-scope bug) leaves the
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
  it("runs to completion with valid results", async () => {
    await embeddingStores.dino.run();
    assertCompleted(embeddingStores.dino);
    expect(embeddingStores.dino.results.coords.length).toBe(5);
  });

  it("a re-run replaces the results rather than accumulating them", async () => {
    await embeddingStores.dino.run();
    assertCompleted(embeddingStores.dino);
    expect(embeddingStores.dino.results.coords.length).toBe(5);
  });

  it("DINO is the only backend the registry exposes", () => {
    expect(Object.keys(embeddingStores)).toEqual(["dino"]);
  });
});


// AnomalyDINO and kNN at WHOLE-INSTANCE granularity. Both existed in this store — kNN was reachable
// only through setMethod(), AnomalyDINO not at all — because the UI treated granularity as the scorer:
// per keypoint got the unsupervised pair, whole instance got the bundled SVM and nothing else. The user
// asked for the choice at both, so this is the store half of it.
describe("whole-instance unsupervised scoring", () => {
  const es = embeddingStores.dino;

  it("keeps patch descriptors for every crop it embeds, so the scorer can be chosen after the run", async () => {
    es.setMethod("trained");
    es.requirePatches = false;
    await es.run();
    const cov = es.patchCoverage;
    expect(cov.total).toBe(5);
    expect(cov.have, "the run kept no patch tokens — AnomalyDINO would score every crop 0").toBe(5);
    expect(cov.full).toBe(true);
    expect(es.canAnomalyDino).toBe(true);
  });

  it("switching the scorer re-scores in place — it does NOT re-run the pass", async () => {
    await es.run();
    const embBefore = embN;
    globalThis.__decodes = 0;
    es.setScorer("anomalyDino");
    await vi.waitFor(() => expect(es.status).toBe("done"));
    expect(es.method).toBe("anomalyDino");
    expect(embN, "switching the scorer ran the encoder again").toBe(embBefore);
    // A warm cache makes a re-RUN look identical by embedding count, so the tell is the decode: run()
    // walks every frame image again, a re-score touches none.
    expect(globalThis.__decodes, "switching the scorer re-ran the whole pass").toBe(0);
    expect(es.results.z.length).toBe(5);
    expect(es.results.z.every(Number.isFinite)).toBe(true);
  });

  it("falls back to kNN when there are no patch tokens, and SAYS it fell back", async () => {
    // The failure this exists for: with no patch features every distance is 0, so every crop scores a
    // perfect 0 and the file reads as flawless. Reporting "AnomalyDINO" there is the worst possible
    // lie for a QC check.
    // Move the crops somewhere this file has never embedded, so the run cannot be served from the
    // in-memory cache — which would hand back the patch tokens this test is trying to be without.
    const move = (dx, dy) => {
      for (const fr of fakeFrames) {
        for (const inst of fr.lf.instances) for (const p of inst.points) { p.xy = [p.xy[0] + dx, p.xy[1] + dy]; }
      }
    };
    move(611, 409);
    noPatches = true;
    try {
      // setMethod fires a re-score that is not awaited, and run() no-ops while one is in flight — so a
      // run() issued straight after it is silently dropped. Settle first, or this test measures the
      // PREVIOUS run's records. (The UI cannot hit this: the run button is disabled while scoring.)
      es.setMethod("trained");
      await vi.waitFor(() => expect(es.status).toBe("done"));
      const n0 = embN;
      await es.run();
      expect(embN - n0, "the crops came from cache — this test never exercised the no-patch path").toBe(5);
      expect(es.patchCoverage.have).toBe(0);
      expect(es.canAnomalyDino).toBe(false);
      es.setScorer("anomalyDino");
      await vi.waitFor(() => expect(es.status).toBe("done"));
      expect(es.method, "the request is remembered — it is the RESULT that fell back").toBe("anomalyDino");
      expect(es.usedScorer, "reported AnomalyDINO on a run with no patch tokens").toBe("knn");
      expect(es.results.z.every(Number.isFinite)).toBe(true);
    } finally {
      // Put the fixture back. Leaving it moved would poison every later test in this file: those crops
      // are now cached WITHOUT patch tokens, so the next AnomalyDINO run would legitimately fall back.
      noPatches = false;
      move(-611, -409);
      es.setMethod("trained");
      await vi.waitFor(() => expect(es.status).toBe("done"));
      await es.run();
    }
  });

  it("reports the scorer that ACTUALLY ran, so a silent fallback cannot read as a clean file", async () => {
    await es.run();
    es.setScorer("anomalyDino");
    await vi.waitFor(() => expect(es.status).toBe("done"));
    expect(es.usedScorer).toBe("anomalyDino");
    es.setScorer("knn");
    await vi.waitFor(() => expect(es.status).toBe("done"));
    expect(es.usedScorer).toBe("knn");
    es.setMethod("trained");
    await vi.waitFor(() => expect(es.status).toBe("done"));
    expect(es.usedScorer).toBe("trained");
  });

  it("the threshold follows the scorer — an SVM cutoff is not a robust z", async () => {
    es.setMethod("trained");
    const svmCut = es.threshold;
    es.setScorer("knn");
    expect(es.threshold).toBe(3.5);
    es.setScorer("anomalyDino");
    expect(es.threshold).toBe(3.5);
    es.setMethod("trained");
    expect(es.threshold).toBe(svmCut);
  });

  it("requirePatches re-embeds the crops a pre-patch cache can only half-serve", async () => {
    // The cache predates patch features, so a warm file serves CLS vectors and no tokens — everything
    // kNN needs, nothing AnomalyDINO does. Without this the only way out would be a new file.
    const move = (dx, dy) => {
      for (const fr of fakeFrames) {
        for (const inst of fr.lf.instances) for (const p of inst.points) { p.xy = [p.xy[0] + dx, p.xy[1] + dy]; }
      }
    };
    move(877, 733);                       // somewhere this file has not embedded
    noPatches = true;
    try {
      es.setMethod("trained");
      await vi.waitFor(() => expect(es.status).toBe("done"));
      await es.run();                     // fills the cache WITHOUT tokens
      expect(es.patchCoverage.have).toBe(0);

      noPatches = false;
      es.requirePatches = false;
      const cold = embN;
      await es.run();
      expect(embN - cold, "a token-less cache entry was reused as if it were complete").toBe(0);
      expect(es.patchCoverage.have, "still no tokens — nothing forced a re-embed").toBe(0);

      es.requirePatches = true;
      const before = embN;
      await es.run();
      expect(embN - before, "requirePatches did not force the re-embed").toBe(5);
      expect(es.patchCoverage.full).toBe(true);
    } finally {
      noPatches = false;
      es.requirePatches = false;
      move(-877, -733);
      es.setMethod("trained");
      await vi.waitFor(() => expect(es.status).toBe("done"));
      await es.run();
    }
  });

  it("setScorer only ever selects an UNSUPERVISED scorer — it cannot silently arm the SVM", () => {
    es.setMethod("knn");
    es.setScorer("nonsense");
    expect(es.method).toBe("knn");   // fell back to kNN, not to "trained"
    es.setScorer("trained");
    expect(es.method).toBe("knn");
  });
});
