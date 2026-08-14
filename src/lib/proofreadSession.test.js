// The loop is a state machine over the ranked queue. Tested headless: the components only forward keys.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";

vi.mock("./labelsStore.svelte.js", () => ({
  // These fixtures are single-video, so index 0 is the whole story. The real derivation — and the
  // miss case that made the write and read sides disagree — is tested against the real module in
  // labelsStore.frameKey.test.js.
  frameKey: (f) => (f ? (f.fkey ?? `0:${f.frameIdx}`) : null),

  store: { frames: [], skeleton: { nodeNames: ["nose", "head", "neck"] }, current: null,
           setIndex() {}, syncFrameImage() {} },
}));
vi.mock("./editStore.svelte.js", () => ({ edit: { selInstance: 0, selNode: 0, select(i, n) { this.selInstance = i; this.selNode = n; } } }));
vi.mock("./viewStore.svelte.js", () => ({ view: { requestFocus() {} } }));

const { keypointLabels } = await import("./keypointLabels.svelte.js");
const { keypointModels } = await import("./keypointModels.svelte.js");
const { proofread } = await import("./proofreadSession.svelte.js");
const { edit } = await import("./editStore.svelte.js");

/** Three candidates, descending confidence: nose@f1 .9, nose@f2 .8, nose@f3 .7 */
function seed() {
  const m = new Map([["0:1:0", 0.9], ["0:2:0", 0.8], ["0:3:0", 0.7]]);
  keypointModels.slots = [{ id: 1, store: {
    node: "nose", status: "done", message: "", resultRev: 1, count: 3,
    get hasResults() { return true; }, info: {},
    frameZByKey: () => null, instProbByKey: (k) => m.get(k) ?? null,
    instProbEntries: () => m.entries(), flaggedFrameKeysAt: () => [], flaggedCountAt: () => 0,
    rescore: () => {}, reset() {},
  } }];
  keypointModels.rev++;
}

describe("proofreading loop", () => {
  beforeEach(() => { keypointLabels.clear(); keypointLabels.cursor = 0; keypointLabels.budget = 20; seed(); });

  it("queue is ranked, cursor starts at the most suspicious", () => {
    expect(proofread.queue.map((c) => c.frameIdx)).toEqual([1, 2, 3]);
    expect(proofread.current.frameIdx).toBe(1);
  });

  it("f judges faulty and advances to the next UNJUDGED", () => {
    proofread.dispatch({ id: "faulty" });
    expect(keypointLabels.isBad(0, 1, 0, "nose")).toBe(true);
    expect(proofread.current.frameIdx).toBe(2);          // auto-advanced
    expect(proofread.reviewedCount).toBe(1);
  });

  it("j judges clean — still reviewed, so it isn't re-served", () => {
    proofread.dispatch({ id: "clean" });
    expect(keypointLabels.isReviewed(0, 1, 0)).toBe(true);
    expect(keypointLabels.isBad(0, 1, 0, "nose")).toBe(false);
    expect(proofread.current.frameIdx).toBe(2);
  });

  it("skip-to-unjudged wraps and never lands on a judged candidate", () => {
    proofread.dispatch({ id: "faulty" });   // f1 judged, now at f2
    proofread.dispatch({ id: "faulty" });   // f2 judged, now at f3
    proofread.seek(0);                      // jump back to a judged one
    proofread.dispatch({ id: "nextUnreviewed" });
    expect(proofread.current.frameIdx).toBe(3);   // only unjudged left
  });

  it("when everything is judged it stays put instead of jumping somewhere arbitrary", () => {
    for (let i = 0; i < 3; i++) proofread.dispatch({ id: "clean" });
    const at = proofread.current.frameIdx;
    proofread.dispatch({ id: "nextUnreviewed" });
    expect(proofread.current.frameIdx).toBe(at);
    expect(proofread.reviewedCount).toBe(3);
  });

  it("u un-reviews — a mis-click is recoverable, and few-shot stops using it as a negative", () => {
    proofread.dispatch({ id: "clean" });
    proofread.seek(0);
    expect(keypointLabels.isReviewed(0, 1, 0)).toBe(true);
    proofread.dispatch({ id: "unset" });
    expect(keypointLabels.isReviewed(0, 1, 0)).toBe(false);
    expect(keypointLabels.forNode("nose").neg.size).toBe(0);   // negative withdrawn
  });

  it("digit keys toggle a SPECIFIC keypoint of the current instance", () => {
    proofread.dispatch({ id: "toggleKeypoint", digit: 3 });    // 1-based -> "neck"
    expect(keypointLabels.isBad(0, 1, 0, "neck")).toBe(true);
    proofread.dispatch({ id: "toggleKeypoint", digit: 3 });
    expect(keypointLabels.isBad(0, 1, 0, "neck")).toBe(false);
    proofread.dispatch({ id: "toggleKeypoint", digit: 9 });    // out of range -> no-op
    expect(keypointLabels.badCount).toBe(0);
  });

  it("navigation clamps at both ends", () => {
    proofread.dispatch({ id: "prev" });
    expect(proofread.cursor).toBe(0);
    proofread.dispatch({ id: "last" });
    expect(proofread.cursor).toBe(2);
    proofread.dispatch({ id: "next" });
    expect(proofread.cursor).toBe(2);
    proofread.dispatch({ id: "first" });
    expect(proofread.cursor).toBe(0);
  });

  it("k cycles the targeted keypoint; Escape exits and closes help", () => {
    edit.select(0, 0);
    proofread.dispatch({ id: "cycleKeypoint" });
    expect(edit.selNode).toBe(1);
    keypointLabels.proofreading = true; keypointLabels.helpOpen = true;
    proofread.dispatch({ id: "exit" });
    expect(keypointLabels.proofreading).toBe(false);
    expect(keypointLabels.helpOpen).toBe(false);
  });

  it("budget bounds the pass", () => {
    keypointLabels.budget = 2;
    expect(proofread.queue).toHaveLength(2);
  });
});

describe("keyboard-only session controls", () => {
  beforeEach(() => { keypointLabels.clear(); keypointLabels.cursor = 0; keypointLabels.budget = 20; seed(); });

  it("[ and ] step the budget through the presets and clamp", () => {
    proofread.dispatch({ id: "budgetDown" });
    expect(keypointLabels.budget).toBe(10);
    proofread.dispatch({ id: "budgetDown" });
    expect(keypointLabels.budget).toBe(10);          // clamped low
    for (let i = 0; i < 5; i++) proofread.dispatch({ id: "budgetUp" });
    expect(keypointLabels.budget).toBe(100);         // clamped high
  });

  it("shrinking the budget keeps the cursor inside the queue", () => {
    keypointLabels.cursor = 40;
    proofread.dispatch({ id: "budgetDown" });
    expect(keypointLabels.cursor).toBeLessThanOrEqual(keypointLabels.budget - 1);
  });

  it("e exports the same CSV the button produces, headlessly", () => {
    proofread.dispatch({ id: "faulty" });
    const csv = proofread.exportCsv();
    expect(csv.split("\n")[0]).toMatch(/^frame_index,frame_idx,video,instance/);
    expect(csv).toContain("nose");
    expect(() => proofread.dispatch({ id: "exportCsv" })).not.toThrow();
  });

  it("enterProofread turns the mode on and jumps to the top candidate", () => {
    keypointLabels.proofreading = false;
    proofread.dispatch({ id: "enterProofread" });
    expect(keypointLabels.proofreading).toBe(true);
    expect(proofread.current.frameIdx).toBe(1);      // most suspicious first
  });
});


// The paint gate is a pure decision (draw.test.js proves it), but the WIRING is where the black frame
// actually came from: the effect must consult it, remember the canvas it painted, and never hand
// drawScene a picture of a different frame than the pose it is drawing.
describe("the proofread canvas is wired to the paint gate", () => {
  const w = readFileSync("src/lib/components/ProofreadWindow.svelte", "utf8");

  it("asks shouldHoldPaint instead of testing the pair inline", () => {
    expect(w).toContain("const havePair = imgFor === it;");
    expect(w).toMatch(/if \(shouldHoldPaint\(\{ havePair, paintedEl, canvasEl: c, dimsKnown: hasKnownDims\(it\) \}\)\) return;/);
    // the old inline form is what withheld the very first paint
    expect(w, "still bailing on the raw pair test").not.toMatch(/^\s*if \(imgFor !== it\) return;/m);
  });

  it("remembers WHICH canvas it painted, and records it after painting", () => {
    // A boolean would survive the canvas being destroyed and re-created on close/re-open, and hold a
    // paint that is no longer on screen.
    expect(w).toMatch(/let paintedEl = null;/);
    expect(w).toMatch(/paintedEl = c;\s*\n\s*\}\);/);
    // ...and not as $state: the effect both reads and writes it, so a reactive read would re-run it
    expect(w).not.toMatch(/paintedEl = \$state/);
  });

  it("never draws a picture of one frame under the pose of another", () => {
    // The early paint is the whole point of the change, and this is the line that keeps it honest.
    expect(w).toContain("const image = havePair ? img : null;");
    expect(w).toContain("decoding: !havePair,");
  });
});
