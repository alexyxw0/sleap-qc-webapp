// Multiple keypoint detectors at once. The registry duck-types the single-store interface qcStore binds
// to, so APPEARANCE_CHECKS / bundlePrefs / App.svelte need no changes — and it must AGGREGATE correctly.
import { describe, it, expect, beforeEach } from "vitest";
import { keypointModels } from "./keypointModels.svelte.js";

/** Minimal stand-in for a loaded slot store. */
function fakeStore(node, frameZ, instProb, { status = "done", count = 10 } = {}) {
  return {
    node, status, message: `${node} ok`, resultRev: 1, count,
    get hasResults() { return frameZ.size > 0; },
    info: { hasEmb: true, hasModel: true, dataset: "d", cv_roc: 0.9 },
    frameZByKey: (k) => frameZ.get(k) ?? null,
    instProbByKey: (k) => instProb.get(k) ?? null,
    flaggedFrameKeysAt: (t) => [...frameZ].filter(([, z]) => z >= t).map(([k]) => k),
    flaggedCountAt: (t) => [...instProb.values()].filter((p) => p >= t).length,
    reset() { frameZ.clear(); instProb.clear(); },
  };
}
const load = (...stores) => { keypointModels.slots = stores.map((store, i) => ({ id: i + 1, store })); keypointModels.rev++; };

describe("keypointModels registry", () => {
  beforeEach(() => { keypointModels.threshold = 0.5; });

  it("starts with one slot and can add/remove", () => {
    keypointModels.reset();
    expect(keypointModels.slots).toHaveLength(1);
    const s = keypointModels.addSlot();
    expect(keypointModels.slots).toHaveLength(2);
    keypointModels.removeSlot(s.id);
    expect(keypointModels.slots).toHaveLength(1);
    keypointModels.removeSlot(keypointModels.slots[0].id);   // never drops below one
    expect(keypointModels.slots).toHaveLength(1);
  });

  it("frame score is the MAX calibrated probability across keypoints", () => {
    load(
      fakeStore("nose", new Map([["0:1", 0.30], ["0:2", 0.90]]), new Map()),
      fakeStore("ear_l", new Map([["0:1", 0.80], ["0:2", 0.10]]), new Map()),
    );
    expect(keypointModels.frameZByKey("0:1")).toBeCloseTo(0.80); // ear_l wins
    expect(keypointModels.frameZByKey("0:2")).toBeCloseTo(0.90); // nose wins
    expect(keypointModels.frameZByKey("0:9")).toBeNull();
  });

  it("attribution names the keypoint that produced the max — the point of multiple models", () => {
    load(
      fakeStore("nose", new Map([["0:1", 0.3]]), new Map([["0:1:0", 0.30]])),
      fakeStore("tail_base", new Map([["0:1", 0.7]]), new Map([["0:1:0", 0.70]])),
    );
    expect(keypointModels.worstNodeAt("0:1", 0)).toEqual({ node: "tail_base", prob: 0.7 });
    expect(keypointModels.worstNodeAt("0:9", 0)).toBeNull();
  });

  it("flagged frames are the UNION across keypoints at the SHARED threshold", () => {
    load(
      fakeStore("nose", new Map([["0:1", 0.9], ["0:2", 0.2]]), new Map()),
      fakeStore("ear_r", new Map([["0:2", 0.6], ["0:3", 0.55]]), new Map()),
    );
    expect(keypointModels.flaggedFrameKeys().sort()).toEqual(["0:1", "0:2", "0:3"]);
    keypointModels.threshold = 0.8;
    expect(keypointModels.flaggedFrameKeys()).toEqual(["0:1"]);   // one shared cutoff, not per-slot
  });

  it("ignores slots with no results and rolls up nodes / counts", () => {
    const empty = fakeStore("ear_l", new Map(), new Map());
    load(fakeStore("nose", new Map([["0:1", 0.9]]), new Map(), { count: 7 }), empty);
    expect(keypointModels.active).toHaveLength(1);
    expect(keypointModels.nodes).toEqual(["nose"]);
    expect(keypointModels.count).toBe(7);
    expect(keypointModels.hasResults).toBe(true);
  });

  it("duck-types everything qcStore's APPEARANCE_CHECKS uses", () => {
    for (const k of ["hasResults", "resultRev", "threshold", "flaggedFrameCount"]) {
      expect(keypointModels[k]).toBeDefined();
    }
    for (const fn of ["frameZByKey", "instProbByKey", "flaggedFrameKeys", "reset", "loadModelFromUrl"]) {
      expect(typeof keypointModels[fn]).toBe("function");
    }
  });
});

describe("guided labelling queue (active learning)", () => {
  const withProbs = (node, pairs) => {
    const m = new Map(pairs);
    return { node, status: "done", message: "", resultRev: 1, count: m.size,
      get hasResults() { return m.size > 0; }, info: { hasEmb: true, hasModel: true },
      frameZByKey: () => null, instProbByKey: (k) => m.get(k) ?? null,
      instProbEntries: () => m.entries(),
      flaggedFrameKeysAt: () => [], flaggedCountAt: () => 0, reset() { m.clear(); } };
  };
  const load = (...st) => { keypointModels.slots = st.map((store, i) => ({ id: i + 1, store })); keypointModels.rev++; };

  it("ranks candidates by confidence, highest first, across keypoints", () => {
    load(
      withProbs("nose", [["0:1:0", 0.20], ["0:5:0", 0.95]]),
      withProbs("ear_l", [["0:1:0", 0.60], ["0:9:1", 0.80]]),
    );
    const q = keypointModels.candidates({ limit: 10 });
    expect(q.map((c) => [c.frameIdx, c.node, +c.prob.toFixed(2)])).toEqual([
      [5, "nose", 0.95], [9, "ear_l", 0.80], [1, "ear_l", 0.60],
    ]);
    // per instance, the WINNING keypoint is the one surfaced (0:1:0 -> ear_l 0.6, not nose 0.2)
    expect(q.find((c) => c.frameIdx === 1).node).toBe("ear_l");
  });

  it("honours the budget", () => {
    load(withProbs("nose", [["0:1:0", 0.9], ["0:2:0", 0.8], ["0:3:0", 0.7]]));
    expect(keypointModels.candidates({ limit: 2 })).toHaveLength(2);
  });

  it("skips already-reviewed candidates by default, and can include them for progress", () => {
    load(withProbs("nose", [["0:1:0", 0.9], ["0:2:0", 0.8]]));
    const reviewed = (v, f) => f === 1;
    expect(keypointModels.candidates({ isLabelled: reviewed }).map((c) => c.frameIdx)).toEqual([2]);
    const all = keypointModels.candidates({ isLabelled: reviewed, includeLabelled: true });
    expect(all).toHaveLength(2);
    expect(all.find((c) => c.frameIdx === 1).labelled).toBe(true);
  });

  it("decomposes the key back into video / frame / instance", () => {
    load(withProbs("nose", [["3:77:2", 0.5]]));
    expect(keypointModels.candidates()[0]).toMatchObject({ video: 3, frameIdx: 77, inst: 2, node: "nose" });
  });

  it("empty when nothing is loaded", () => {
    keypointModels.slots = [{ id: 1, store: withProbs("nose", []) }];
    expect(keypointModels.candidates()).toEqual([]);
  });
});
