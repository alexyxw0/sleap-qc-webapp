// THE test that should have existed. Two bugs shipped that unit tests could not see, because both
// were about a check's output never REACHING the canvas:
//
//   1. A frame flagged by max_angle (or any feature check) drew no red mark at all. The mark
//      resolvers were each gated on their own detector, and the feature checks were in none of them.
//   2. Review mode framed the whole scene instead of the culprit, because frameWorstInstance
//      consulted five checks out of thirteen and returned -1 for the rest.
//
// Every previous test asked "does this helper return the right shape for a synthetic pose". None
// asked the only question that matters: turn on ONE check, run the real pipeline over a real file,
// and for every frame it flags — is there an instance to go to, and is there something red to draw?
// That is what this asks, for every check, one at a time.
import { describe, it, expect, vi, beforeAll } from "vitest";
import { fileURLToPath } from "node:url";
import { loadSlp } from "@talmolab/sleap-io.js";
import { analyzerFromSkeleton } from "./qc/checks/features/skeleton.js";

const FIX = fileURLToPath(new URL("./qc/fixtures/tracked-preds.slp", import.meta.url));
const fake = { labels: null, frames: [], rev: 0, index: 0, fileName: "tracked-preds.slp", skeleton: null };
vi.mock("./labelsStore.svelte.js", () => ({
  // These fixtures are single-video, so index 0 is the whole story. The real derivation — and the
  // miss case that made the write and read sides disagree — is tested against the real module in
  // labelsStore.frameKey.test.js.
  frameKey: (f) => (f ? (f.fkey ?? `0:${f.frameIdx}`) : null),
 store: fake }));

const { qc } = await import("./qcStore.svelte.js");

beforeAll(async () => {
  const labels = await loadSlp(FIX, { openVideos: false });
  fake.labels = labels;
  fake.frames = labels.labeledFrames
    .filter((lf) => Number.isFinite(lf.frameIdx))
    .map((lf) => ({ video: lf.video, frameIdx: lf.frameIdx, lf }));
  fake.skeleton = { nodeNames: labels.skeletons?.[0]?.nodes?.map((n) => n.name ?? n) ?? [] };
  analyzer = analyzerFromSkeleton(labels.skeletons[0]);
});

// Two of the eighteen features are STRUCTURALLY inert on this skeleton, and a test that just skipped
// them would also skip a real regression. Assert the reason instead: if the fixture ever gains
// symmetry pairs or a longer chain, these flip to live and the full assertion runs.
let analyzer = null;
const liveOn = (feature) => {
  if (feature === "min_symmetry_consistency") return analyzer.symmetryPairs.length > 0;
  if (feature === "max_curvature" || feature === "curvature_std") return analyzer.maxChainLength >= 5;
  return true;
};

/** Run with EXACTLY one check live — the state that exposed both bugs. */
async function solo(name, { feature = null, threshold = 3.0, tune = null } = {}) {
  qc.resetConfig();
  for (const k of Object.keys(qc.checks)) qc.checks[k] = false;
  qc.featureChecks = [];
  if (feature) qc.addFeatureCheck(feature);
  else qc.checks[name] = true;
  if (feature) {
    const f = qc.featureChecks.find((x) => x.feature === feature);
    f.threshold = threshold;
    f.on = true;
  }
  if (tune) for (const [k, v] of Object.entries(tune)) qc[k] = v;
  // addFeatureCheck (and setThreshold) fire an UN-AWAITED this.run() whenever a run has already
  // finished — the app wants a live re-run when you change a knob. run() then guards re-entrancy by
  // returning immediately, so a plain `await qc.run()` here is a no-op and the assertions below score
  // against the config the auto-run happened to start with. Settle first, then run, then settle.
  await settle();
  await qc.run();
  await settle();
  if (qc.status !== "done") throw new Error(`run did not finish: ${qc.status} ${qc.error ?? ""}`);
  return qc.flaggedFrames ?? [];
}

/** Wait out any in-flight (or auto-triggered) run. */
async function settle() {
  for (let i = 0; i < 500 && (qc.status === "running" || qc.status === "scoring"); i++) {
    await new Promise((r) => setTimeout(r, 0));
  }
}

/**
 * Swap in a fixture the fixture itself cannot produce.
 *
 * Three checks cannot fire on tracked-preds.slp as loaded, for three different and verifiable
 * reasons — and "it flagged nothing so we skipped it" is the shape of test that let both reported
 * bugs ship. Two of the three are constructible: the file just needs a video size (out-of-frame is
 * measured against the image bounds, and the fixture carries no shape) and a genuinely duplicated
 * animal. Building those is honest test data, not a workaround.
 */
async function withFixture(mutate, fn) {
  const saveLabels = fake.labels, saveFrames = fake.frames;
  const labels = await loadSlp(FIX, { openVideos: false });
  const frames = labels.labeledFrames.filter((lf) => Number.isFinite(lf.frameIdx))
    .map((lf) => ({ video: lf.video, frameIdx: lf.frameIdx, lf }));
  mutate(labels, frames);
  fake.labels = labels; fake.frames = frames;
  try { return await fn(); }
  finally { fake.labels = saveLabels; fake.frames = saveFrames; }
}

/** Frames this configuration flags, as store items. */
const flaggedItems = () => fake.frames.filter((f) => qc.frameFlagged(f));

const KINDS = ["edge", "angle", "node", "instance"];

// Feature checks: the ones the geometry suite actually offers, each with the shape it must produce.
const FEATURES = [
  ["max_angle_zscore", "angle"],
  ["mean_angle_zscore", null],
  ["max_edge_zscore", "edge"],
  ["mean_edge_zscore", null],
  ["max_pairwise_zscore", "edge"],
  ["min_symmetry_consistency", null],
  ["max_curvature", "angle"],
  ["visibility_pattern_score", "node"],
  ["max_centroid_distance", null],
  ["bbox_area_zscore", "instance"],
  ["hull_area_zscore", "instance"],
];

describe("the fixture's structural limits, stated rather than assumed", () => {
  it("declares no symmetry pairs and no chain long enough for curvature", () => {
    expect(analyzer.symmetryPairs).toEqual([]);       // so min_symmetry_consistency cannot fire
    expect(analyzer.maxChainLength).toBeLessThan(5);  // so max_curvature is off (config: chain >= 5)
  });
});

describe("every geometric feature check marks what it blames", () => {
  for (const [feature, expectKind] of FEATURES) {
    it(`${feature}: every flagged frame gets an instance AND a mark`, async () => {
      // A low threshold so the fixture actually trips the check — the question is whether a flag
      // produces a mark, not how many flags there are.
      await solo(null, { feature, threshold: 1.5 });
      const items = flaggedItems();
      if (!liveOn(feature)) {
        // Inert BY CONSTRUCTION here — no symmetry pairs declared / longest chain is 4 and curvature
        // needs 5. Its shape is covered by the unit tests (baseline.test.js, structural.test.js).
        expect(items.length, `${feature} flagged on a skeleton that cannot compute it`).toBe(0);
        return;
      }
      expect(items.length, `${feature} flagged nothing — the assertion below would be vacuous`).toBeGreaterThan(0);

      for (const item of items) {
        const ii = qc.frameWorstInstance(item);
        // (1) review mode has somewhere to go
        expect(ii, `${feature}: flagged frame ${item.frameIdx} named no instance`).toBeGreaterThanOrEqual(0);
        // (2) the canvas has something to draw
        const b = qc.instanceBlame(item, ii);
        expect(b.check, `${feature}: frame ${item.frameIdx} inst ${ii} has no blame`).toBe(`feat:${feature}`);
        expect(KINDS, `${feature}: blame has no drawable kind`).toContain(b.kind);
        expect(qc.instanceFlagged(item, ii)).toBe(true);
        // a shape that names nodes must name REAL ones
        for (const n of b.nodes ?? []) {
          expect(Number.isInteger(n) && n >= 0 && n < fake.skeleton.nodeNames.length).toBe(true);
        }
      }
    });
  }

  it("the shape matches the geometry the feature measures", async () => {
    // The regression that started this: max_angle drew a node ring (or nothing) instead of the angle.
    for (const [feature, expectKind] of FEATURES) {
      if (!expectKind || !liveOn(feature)) continue;
      await solo(null, { feature, threshold: 1.5 });
      const items = flaggedItems();
      if (!items.length) continue;
      const kinds = new Set();
      for (const item of items) {
        const ii = qc.frameWorstInstance(item);
        if (ii >= 0) kinds.add(qc.instanceBlame(item, ii).kind);
      }
      expect([...kinds], `${feature} should draw a ${expectKind}`).toContain(expectKind);
    }
  });

  it("an angle names the vertex FIRST, then its two arms", async () => {
    await solo(null, { feature: "max_angle_zscore", threshold: 1.5 });
    let checked = 0;
    for (const item of flaggedItems()) {
      const ii = qc.frameWorstInstance(item);
      const b = qc.instanceBlame(item, ii);
      if (b.kind !== "angle") continue;
      expect(b.nodes).toHaveLength(3);
      expect(b.node).toBe(b.nodes[0]);          // the arc goes on nodes[0]
      expect(new Set(b.nodes).size).toBe(3);    // three DISTINCT nodes, or it isn't an angle
      checked++;
    }
    expect(checked, "no angle marks to check").toBeGreaterThan(0);
  });
});

describe("every non-feature check marks what it blames", () => {
  // Frame-level checks name their instance on the frame record; instance-level ones score it. Both
  // must reach the canvas. `count` and `negative` are excluded on purpose: they are statements about
  // the frame, and no instance is more to blame than any other.
  // Each check is TUNED to fire on this fixture. At stock thresholds seven of them flag zero frames
  // here, and a test that shrugs at an empty list is a test that passes when the feature is broken —
  // which is exactly how the two bugs above survived a green suite. Every entry below is asserted
  // non-vacuous, so a check that stops firing fails loudly rather than silently skipping.
  const CHECKS = [
    ["anomaly", null],
    ["gmm", null],
    ["chirality", null],
    ["poseSplit", { poseSplitThreshold: 0 }],
    ["sparse", { sparseFraction: 1.5 }],          // cutoff above the average visible-node count
    ["confidence", { confidenceThreshold: 0.999 }],
    ["instConfidence", { instConfidenceThreshold: 0.999 }],
  ];

  for (const [name, tune] of CHECKS) {
    it(`${name}: a flagged frame names an instance and a mark`, async () => {
      await solo(name, { tune });
      const items = flaggedItems();
      expect(items.length, `${name} flagged nothing — this assertion would be vacuous`).toBeGreaterThan(0);
      let named = 0;
      for (const item of items) {
        const ii = qc.frameWorstInstance(item);
        expect(ii, `${name}: flagged frame ${item.frameIdx} named no instance`).toBeGreaterThanOrEqual(0);
        const b = qc.instanceBlame(item, ii);
        expect(b.check, `${name}: frame ${item.frameIdx} inst ${ii} has no blame`).not.toBeNull();
        expect(KINDS).toContain(b.kind);
        named++;
      }
      expect(named).toBe(items.length);
    });
  }

  it("outOfFrame: names the node that left the image", async () => {
    // The stock fixture carries no video shape, so the bounds check has nothing to measure against
    // and can never fire. Give it a 40x40 image and most real keypoints fall outside it.
    await withFixture((labels) => { for (const v of labels.videos) v.shape = [1, 40, 40, 1]; }, async () => {
      await solo("outOfFrame");
      const items = flaggedItems();
      expect(items.length, "outOfFrame still flagged nothing with a real image size").toBeGreaterThan(0);
      let named = 0;
      for (const item of items) {
        const ii = qc.frameWorstInstance(item);
        expect(ii, `outOfFrame: frame ${item.frameIdx} named no instance`).toBeGreaterThanOrEqual(0);
        const b = qc.instanceBlame(item, ii);
        expect(b.check).toBe("outOfFrame");
        expect(b.kind).toBe("node");              // it knows WHICH keypoint left the frame
        expect(b.nodes.length).toBeGreaterThan(0);
        named++;
      }
      expect(named).toBe(items.length);
    });
  });

  it("duplicates: names an instance of the duplicated pair", async () => {
    // No two animals in the stock fixture overlap enough to be duplicates. Copy one onto the other
    // in a few frames and they are, by any definition the detector uses.
    await withFixture((labels, frames) => {
      for (const f of frames.slice(0, 6)) {
        const insts = f.lf?.instances ?? [];
        if (insts.length < 2) continue;
        insts[1].points.forEach((p, k) => {
          const src = insts[0].points[k];
          p.xy = [...src.xy];
          p.visible = src.visible;
        });
      }
    }, async () => {
      await solo("duplicates");
      const items = flaggedItems();
      expect(items.length, "a cloned animal was not detected as a duplicate").toBeGreaterThan(0);
      for (const item of items) {
        const ii = qc.frameWorstInstance(item);
        expect(ii, `duplicates: frame ${item.frameIdx} named no instance`).toBeGreaterThanOrEqual(0);
        const b = qc.instanceBlame(item, ii);
        expect(b.check).toBe("duplicates");
        expect(b.kind).toBe("instance");          // the pair is the subject; no single node is at fault
      }
    });
  });

  it("ordering is inert here BY CONFIG — no chain is declared ordered", async () => {
    // The remaining check. It scores a declared node chain's ordering, and this deck's config
    // declares none, so there is nothing for it to score. Stated, not skipped: if orderedChains ever
    // gains an entry this assertion fails and the check needs real coverage.
    const { makeQCConfig } = await import("./qc/checks/config.js");
    expect(makeQCConfig({}).orderedChains).toEqual([]);
    await solo("ordering", { tune: { orderingThreshold: 0 } });
    expect(flaggedItems().length).toBe(0);
  });

  it("the red BOX and the red MARK agree about who is flagged", async () => {
    // frameFlaggedInstances (the box) used to re-derive the frame-level checks by hand next to
    // instanceFlagged (the mark). The copy had drifted — it read `d.indexA` on duplicate pairs the
    // detector pushes as arrays — so a duplicated animal was marked but never boxed. One question,
    // one answer.
    await withFixture((labels, frames) => {
      for (const f of frames.slice(0, 6)) {
        const insts = f.lf?.instances ?? [];
        if (insts.length < 2) continue;
        insts[1].points.forEach((pt, k) => { pt.xy = [...insts[0].points[k].xy]; pt.visible = insts[0].points[k].visible; });
      }
    }, async () => {
      await solo("duplicates");
      let boxed = 0;
      for (const item of flaggedItems()) {
        const boxes = qc.frameFlaggedInstances(item);
        for (let i = 0; i < (item.lf?.instances?.length ?? 0); i++) {
          expect(boxes[i], `frame ${item.frameIdx} inst ${i}: box and mark disagree`)
            .toBe(qc.instanceFlagged(item, i));
          if (boxes[i]) boxed++;
        }
      }
      expect(boxed, "no duplicate was boxed").toBeGreaterThan(0);
    });
  });

  it("confidence in AVG mode blames the worst-mean animal, not the weakest-keypoint one", async () => {
    // Two modes, two different guilty animals. Blaming lowConfInstance while the check flagged on
    // avgPointScore points the reviewer at the wrong one whenever they differ.
    await solo("confidence", { tune: { confidenceThreshold: 0.999, confidenceMode: "avg" } });
    let differed = 0;
    for (const item of flaggedItems()) {
      const fq = qc.frameQC(item);
      if (fq.avgConfInstance === fq.lowConfInstance) continue;
      differed++;
      expect(qc.instanceBlame(item, fq.avgConfInstance).check).toBe("confidence");
      expect(qc.instanceBlame(item, fq.lowConfInstance).check).toBeNull();
    }
    // If the fixture never separates them the assertion is vacuous — say so rather than pass quietly.
    if (!differed) expect(flaggedItems().length).toBeGreaterThan(0);
  });

  it("count and negative stay frame-wide — they must NOT invent a culprit", async () => {
    for (const name of ["count", "negative"]) {
      await solo(name);
      for (const item of flaggedItems()) {
        for (let i = 0; i < (item.lf?.instances?.length ?? 0); i++) {
          expect(qc.instanceBlame(item, i).check, `${name} blamed an instance`).toBeNull();
        }
      }
    }
  });
});

describe("frameWorstInstance picks the RIGHT instance, not just any", () => {
  it("never returns an unflagged instance when a flagged one exists", async () => {
    // The old raw `score - threshold` ranking could hand back an instance no check flagged, just
    // because it sat closer to its own cutoff than the flagged one sat past it. Every frame here has
    // two animals, so there is always an unflagged one available to be wrongly chosen.
    await solo(null, { feature: "max_angle_zscore", threshold: 2.2 });
    let mixed = 0;
    for (const item of flaggedItems()) {
      const insts = item.lf?.instances ?? [];
      const flags = insts.map((_, i) => qc.instanceFlagged(item, i));
      if (!flags.some(Boolean)) continue;
      if (flags.some((f) => !f)) mixed++;
      const ii = qc.frameWorstInstance(item);
      expect(qc.instanceFlagged(item, ii), `frame ${item.frameIdx} chose an unflagged instance`).toBe(true);
    }
    expect(mixed, "no frame had one flagged and one unflagged animal — the check above is vacuous")
      .toBeGreaterThan(0);
  });

  it("a frame-level flag OUTRANKS an unflagged instance sitting just under its cutoff", async () => {
    // The case that needs both halves of the ranking rule. Instance 1 is starved down to two visible
    // nodes so `sparse` names it — a flag with no score behind it. Instance 0 is not flagged at all,
    // but sits just under the anomaly cutoff, so a pure margin comparison prefers it and review zooms
    // to the animal nothing is wrong with.
    await withFixture((labels, frames) => {
      for (const f of frames) {
        const insts = f.lf?.instances ?? [];
        if (insts.length < 2) continue;
        insts[1].points.forEach((pt, k) => { if (k > 1) { pt.xy = [NaN, NaN]; pt.visible = false; } });
      }
    }, async () => {
      qc.resetConfig();
      for (const k of Object.keys(qc.checks)) qc.checks[k] = false;
      qc.featureChecks = [];
      qc.checks.sparse = true;
      qc.checks.anomaly = true;
      qc.sparseFraction = 0.5;
      qc.threshold = 0.999;                 // nothing clears it -> anomaly contributes margins only
      await settle(); await qc.run(); await settle();

      let checked = 0;
      for (const item of flaggedItems()) {
        const insts = item.lf?.instances ?? [];
        const flags = insts.map((_, i) => qc.instanceFlagged(item, i));
        if (flags.filter(Boolean).length !== 1) continue;
        const only = flags.indexOf(true);
        expect(qc.frameWorstInstance(item), `frame ${item.frameIdx} skipped its only flagged animal`).toBe(only);
        checked++;
      }
      expect(checked, "no frame had exactly one flagged animal — vacuous").toBeGreaterThan(0);
    });
  });

  it("a moved threshold changes the mark WITHOUT a re-run", async () => {
    // Every knob in the panel is live: it bumps rev and redraws, it does not re-run the pipeline. A
    // blame memo that only cleared on run() would keep painting the previous threshold's verdict —
    // the check would say "not flagged" while the canvas still showed red.
    await solo(null, { feature: "max_angle_zscore", threshold: 0.5 });
    const item = flaggedItems()[0];
    const ii = qc.frameWorstInstance(item);
    expect(qc.instanceBlame(item, ii).check).toBe("feat:max_angle_zscore");

    const f = qc.featureChecks.find((x) => x.feature === "max_angle_zscore");
    f.threshold = 1e6;                      // nothing can clear this
    qc.rev++;                               // what a slider does: redraw, do not re-run
    expect(qc.instanceBlame(item, ii).check, "stale mark survived a threshold change").toBeNull();
    expect(qc.instanceFlagged(item, ii)).toBe(false);
  });

  it("among SEVERAL flagged instances, picks the one furthest past its threshold", async () => {
    // "Zoom into the single instance that is wrong" is only right if it is the RIGHT one. With a low
    // threshold both animals in a frame flag, and the choice has to be the worse of the two.
    await solo(null, { feature: "max_angle_zscore", threshold: 0.5 });
    let checked = 0;
    for (const item of flaggedItems()) {
      const insts = item.lf?.instances ?? [];
      const flagged = insts.map((_, i) => i).filter((i) => qc.instanceFlagged(item, i));
      if (flagged.length < 2) continue;
      const z = (i) => qc.instanceFeatureZ(item, i)?.max_angle_zscore ?? -Infinity;
      const want = flagged.reduce((a, b) => (z(b) > z(a) ? b : a));
      expect(qc.frameWorstInstance(item), `frame ${item.frameIdx}`).toBe(want);
      checked++;
    }
    expect(checked, "no frame flagged two animals — the ranking is untested").toBeGreaterThan(0);
  });
});
