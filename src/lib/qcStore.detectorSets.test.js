// detectorSets() feeds BOTH the Detector-overlap viz and the manual-check ranking. It used to be built
// purely from a per-frame scan, so a detector that flagged ZERO frames produced no entry at all and
// vanished from both — indistinguishable from "not supported here".
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("./labelsStore.svelte.js", () => ({ store: { frames: [], labels: null, skeleton: null } }));
const { store } = await import("./labelsStore.svelte.js");
const { qc, APPEARANCE_LABELS } = await import("./qcStore.svelte.js");
const { keypointModels } = await import("./keypointModels.svelte.js");

/** A loaded keypoint slot whose scores all sit BELOW any threshold: ready, but flags nothing. */
const silentSlot = () => ({
  node: "nose", status: "done", message: "", resultRev: 1, count: 3,
  get hasResults() { return true; }, info: { hasEmb: true, hasModel: true },
  frameZByKey: () => 0.1, instProbByKey: () => 0.1, instProbEntries: () => new Map().entries(),
  flaggedFrameKeysAt: () => [], flaggedCountAt: () => 0, rescore() {}, reset() {},
});

describe("detectorSets includes enabled+ready detectors that flag nothing", () => {
  beforeEach(() => {
    qc.resetConfig();
    keypointModels.slots = [];
    keypointModels.rev++;
    store.frames = [{ fkey: "0:1" }, { fkey: "0:2" }, { fkey: "0:3" }];
  });

  it("omits a detector that is enabled but NOT ready (nothing loaded)", () => {
    qc.checks.noseAppearance = true;
    expect(qc.detectorSets().sets.map((s) => s.id)).not.toContain("noseAppearance");
  });

  it("INCLUDES a ready detector with an empty flagged set, at count 0", () => {
    keypointModels.slots = [{ id: 1, store: silentSlot() }];
    keypointModels.rev++;
    keypointModels.threshold = 0.9;
    qc.checks.noseAppearance = true;
    const d = qc.detectorSets().sets.find((s) => s.id === "noseAppearance");
    expect(d).toBeDefined();                   // present...
    expect(d.set.size).toBe(0);                // ...at zero, rather than missing entirely
    expect(d.label).toBe(APPEARANCE_LABELS.noseAppearance.full);
  });

  it("a disabled detector stays out", () => {
    keypointModels.slots = [{ id: 1, store: silentSlot() }];
    keypointModels.rev++;
    qc.checks.noseAppearance = false;
    expect(qc.detectorSets().sets.map((s) => s.id)).not.toContain("noseAppearance");
  });

  it("reports the frame total and emits no duplicate ids", () => {
    const r = qc.detectorSets();
    expect(r.total).toBe(3);
    const ids = r.sets.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
