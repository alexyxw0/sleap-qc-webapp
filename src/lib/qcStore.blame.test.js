// The sidebar's flagged-check rows named a problem without naming WHERE it was: "sparse instance",
// "low keypoint confidence", "Appearance · keypoint" — and then you hunted for it by eye. Every one of
// those already had an instance attached somewhere in the store; blamedInstanceFor is what reads it, and
// it is what decides whether a row renders as a link or as dead text. Two things must hold:
//   - it never points at an instance the check did not actually flag (a link to a clean animal is worse
//     than no link — it teaches you to distrust the row), and
//   - it says -1, rather than 0, for the checks that are genuinely about the frame.
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("./labelsStore.svelte.js", () => ({
  store: { frames: [], labels: null, skeleton: { nodeNames: ["nose", "ear", "tail"] } },
}));
const { store } = await import("./labelsStore.svelte.js");
const { qc } = await import("./qcStore.svelte.js");
const { keypointModels } = await import("./keypointModels.svelte.js");

const ITEM = { fkey: "0:7", lf: { instances: [{}, {}, {}] } }; // one frame, three animals

/** A keypoint-model slot whose per-instance probabilities are dictated by the test. */
const slot = (byInst) => ({
  node: "nose", status: "done", message: "", resultRev: 1, count: 3,
  get hasResults() { return true; }, info: { hasEmb: true, hasModel: true },
  frameZByKey: () => Math.max(...Object.values(byInst)),
  instProbByKey: (k) => byInst[k] ?? null,
  instProbEntries: () => Object.entries(byInst)[Symbol.iterator](),
  flaggedFrameKeysAt: () => [], flaggedCountAt: () => 0, rescore() {}, reset() {},
});

describe("blamedInstanceFor", () => {
  beforeEach(() => {
    qc.resetConfig();
    keypointModels.slots = [];
    keypointModels.rev++;
    store.frames = [ITEM];
  });

  it("is -1 for the checks that describe the FRAME, not an animal in it", () => {
    // "2 of 3 expected instances" is not about instance #1 — a link here would be a guess.
    for (const k of ["count", "negative", "outOfFrame"]) {
      expect(qc.blamedInstanceFor(ITEM, k), k).toBe(-1);
    }
  });

  it("is -1 with nothing computed, so a row degrades to plain text instead of jumping to instance 0", () => {
    for (const k of ["anomaly", "gmm", "chirality", "ordering", "poseSplit",
                     "sparse", "confidence", "instConfidence", "duplicates",
                     "dino", "nodeDino", "noseAppearance", "feat:nope"]) {
      expect(qc.blamedInstanceFor(ITEM, k), k).toBe(-1);
    }
  });

  it("never throws, whatever it is handed", () => {
    expect(qc.blamedInstanceFor(null, "anomaly")).toBe(-1);
    expect(qc.blamedInstanceFor(ITEM, "not-a-check")).toBe(-1);
    expect(qc.blamedInstanceFor({ fkey: "0:7" }, "sparse")).toBe(-1); // no instances at all
  });

  describe("per-keypoint appearance", () => {
    it("names the highest-scoring instance ABOVE the threshold", () => {
      keypointModels.slots = [{ id: 1, store: slot({ "0:7:0": 0.2, "0:7:1": 0.95, "0:7:2": 0.8 }) }];
      keypointModels.rev++;
      keypointModels.threshold = 0.7;
      expect(qc.blamedInstanceFor(ITEM, "noseAppearance")).toBe(1);
    });

    it("blames nobody when the frame's best score is BELOW the threshold", () => {
      keypointModels.slots = [{ id: 1, store: slot({ "0:7:0": 0.2, "0:7:1": 0.5 }) }];
      keypointModels.rev++;
      keypointModels.threshold = 0.9;
      // The regression this guards: argmax without the threshold test always returns SOME instance,
      // so an unflagged frame's row still linked somewhere.
      expect(qc.blamedInstanceFor(ITEM, "noseAppearance")).toBe(-1);
    });

    it("follows the threshold as the reviewer moves it", () => {
      keypointModels.slots = [{ id: 1, store: slot({ "0:7:0": 0.6, "0:7:1": 0.95 }) }];
      keypointModels.rev++;
      keypointModels.threshold = 0.5;
      expect(qc.blamedInstanceFor(ITEM, "noseAppearance")).toBe(1);
      keypointModels.threshold = 0.99;
      expect(qc.blamedInstanceFor(ITEM, "noseAppearance")).toBe(-1);
    });

    it("ignores instances the check has no score for, rather than treating null as 0", () => {
      keypointModels.slots = [{ id: 1, store: slot({ "0:7:2": 0.99 }) }];
      keypointModels.rev++;
      keypointModels.threshold = 0.7;
      expect(qc.blamedInstanceFor(ITEM, "noseAppearance")).toBe(2);
    });
  });

  it("answers for every key frameDetectorDetails can emit — a new check cannot silently fall through", () => {
    // Turn everything on so the details list is as wide as it gets, then demand a well-formed answer
    // for each row. -1 is a legitimate answer; undefined or a fabricated index is not.
    for (const k of Object.keys(qc.checks)) qc.checks[k] = true;
    for (const d of qc.frameDetectorDetails(ITEM)) {
      const i = qc.blamedInstanceFor(ITEM, d.key);
      expect(Number.isInteger(i), `${d.key} -> ${i}`).toBe(true);
      expect(i, `${d.key} pointed past the frame's instances`).toBeLessThan(ITEM.lf.instances.length);
      expect(i).toBeGreaterThanOrEqual(-1);
    }
  });
});
