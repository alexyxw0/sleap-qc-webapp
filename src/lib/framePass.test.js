// The frame pass is a state machine over the ranked queue: where the cursor is, which animal the digits
// hit, and what each key does to the label store. That is all testable without mounting anything, and it
// is where the bugs would be.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";

const NODES = ["nose", "earL", "earR", "tail"];
const mkFrame = (frameIdx, nInst) => ({
  video: "v", frameIdx,
  // spread, so a bounding box is a real box — every point on one coordinate proves nothing
  lf: { instances: Array.from({ length: nInst }, () => ({ points: NODES.map((_, k) => ({ xy: [10 + k * 10, 10 + k * 12], visible: true })) })) },
});
// frame 0 has two animals, the rest one — the multi-animal case is the one that breaks
const frames = [mkFrame(0, 2), mkFrame(1, 1), mkFrame(2, 1), mkFrame(3, 1)];

const fakeStore = {
  frames, index: 0, rev: 0,
  labels: { videos: ["v"] },
  skeleton: { nodeNames: NODES },
  get current() { return frames[this.index]; },
  setIndex(i) { this.index = i; },
  syncFrameImage() {},
  getFrameImage: async () => null,
};
// One row per ANIMAL, worst-first. Frame 0 has two animals, so it appears TWICE — the case that used
// to lose one of them.
const rankedRows = [
  { i: 2, inst: 0, by: "anomaly" },
  { i: 0, inst: 1, by: "gmm" },
  { i: 0, inst: 0, by: "angle" },
  { i: 3, inst: 0, by: "angle" },
  { i: 1, inst: 0, by: "angle" },
];
let culprit = -1; // what the store blames, per test
const fakeQc = {
  proofreadReady: true,
  proofreadRanked: rankedRows,
  proofreadNodeFor: () => culprit,
};
const fakeEdit = { selInstance: -1, selNode: -1, select(i, n) { this.selInstance = i; this.selNode = n; } };
const dispatched = [];

vi.mock("./labelsStore.svelte.js", () => ({ store: fakeStore }));
vi.mock("./qcStore.svelte.js", () => ({ qc: fakeQc }));
vi.mock("./editStore.svelte.js", () => ({ edit: fakeEdit }));
vi.mock("./viewStore.svelte.js", () => ({ view: { requestFocus() {} } }));
vi.mock("./proofreadSession.svelte.js", () => ({
  proofread: { dispatch: (a) => dispatched.push(a.id) },
}));

const { framePass } = await import("./framePass.svelte.js");
const { keypointLabels } = await import("./keypointLabels.svelte.js");
const { proofreadWindow } = await import("./proofreadWindow.svelte.js");

beforeEach(() => {
  keypointLabels.clear();
  framePass.reset();
  fakeEdit.select(-1, -1);
  fakeStore.index = 0;
  dispatched.length = 0;
  culprit = -1;
});

describe("who owns the keyboard", () => {
  it("whenever the window is up with a ranking to walk", () => {
    proofreadWindow.close();
    expect(framePass.active).toBe(false);
    proofreadWindow.showTab("frames");
    expect(framePass.active).toBe(true);
    fakeQc.proofreadReady = false;
    expect(framePass.active).toBe(false); // nothing ranked -> nothing to drive
    fakeQc.proofreadReady = true;
  });

  it("keeps the keyboard on other panes, so a keystroke can't leak into the model's queue", () => {
    proofreadWindow.showTab("keys");
    expect(framePass.active).toBe(true);
    proofreadWindow.setTab("labels");
    expect(framePass.active).toBe(true);
    proofreadWindow.setTab("frames");
  });
});

describe("walking the queue", () => {
  it("starts at the worst animal and moves in RANK order, not frame order", () => {
    expect([framePass.frameIndex, framePass.instIdx]).toEqual([2, 0]); // rank 1
    framePass.step(1);
    expect([framePass.frameIndex, framePass.instIdx]).toEqual([0, 1]); // rank 2 — not frame 3
    framePass.step(1);
    expect([framePass.frameIndex, framePass.instIdx]).toEqual([0, 0]); // rank 3 — same frame again
    framePass.step(1);
    expect(framePass.frameIndex).toBe(3); // rank 4
  });

  it("visits a frame once per suspect animal, so the second is never skipped", () => {
    framePass.seek(1);
    expect([framePass.frameIndex, framePass.instIdx]).toEqual([0, 1]);
    framePass.step(1);
    expect([framePass.frameIndex, framePass.instIdx]).toEqual([0, 0]); // same frame, other animal
    expect(framePass.siblings.length).toBe(2);
  });

  it("moves the main viewer with it, so the two can't show different frames", () => {
    framePass.seek(3);
    expect(fakeStore.index).toBe(3);
  });

  it("clamps at both ends instead of wrapping", () => {
    framePass.step(-5);
    expect(framePass.at).toBe(0);
    framePass.seek(999);
    expect(framePass.at).toBe(rankedRows.length - 1);
  });

  it("skip-to-unjudged walks past ANIMALS already judged, and wraps", () => {
    framePass.seek(0); // frame 2, animal 0
    framePass.toggleKeypointNumber(1); // judge it
    framePass.seek(0);
    framePass.nextUnreviewed();
    expect(framePass.reviewedHere).toBe(false);
  });

  it("judging one animal does NOT tick off its neighbour in the same frame", () => {
    framePass.seek(1); // frame 0, animal 1
    framePass.toggleKeypointNumber(1);
    expect(framePass.reviewedHere).toBe(true);
    framePass.step(1); // frame 0, animal 0
    expect(framePass.frameIndex).toBe(0);
    expect(framePass.reviewedHere).toBe(false); // the second animal is still outstanding
  });

  it("says so rather than jumping somewhere arbitrary when everything is judged", () => {
    for (let k = 0; k < rankedRows.length; k++) { framePass.seek(k); framePass.toggleKeypointNumber(1); }
    framePass.nextUnreviewed();
    expect(framePass.hint).toMatch(/every animal/i);
  });
});

describe("landing on what was actually flagged", () => {
  it("selects the animal the row is about, not instance 0", () => {
    framePass.seek(1); // frame 0's SECOND animal
    expect(framePass.instIdx).toBe(1);
    // ...so a digit lands on that animal without cycling first
    framePass.toggleKeypointNumber(1);
    expect(keypointLabels.isBad(0, 0, 1, "nose")).toBe(true);
    expect(keypointLabels.isBad(0, 0, 0, "nose")).toBe(false);
  });

  it("pre-targets the keypoint the driving signal blames", () => {
    culprit = 2; // earR
    framePass.seek(0);
    expect(fakeEdit.selNode).toBe(2);
    framePass.judge(true); // f now acts on it with no hunting
    expect(keypointLabels.isBad(0, 2, 0, "earR")).toBe(true);
  });

  it("a whole-instance feature blames no keypoint, and that is not an error", () => {
    culprit = -1;
    framePass.seek(0);
    expect(framePass.culpritNode).toBe(-1);
    expect(fakeEdit.selInstance).toBe(0); // the animal is still selected
  });

  it("the focus box wraps the flagged animal with room around it", () => {
    framePass.seek(0);
    const b = framePass.focusBox;
    expect(b).toBeTruthy();
    // the fixture's pose spans (10,10)-(40,46); the box must contain it WITH margin on every side
    expect(b.x).toBeLessThan(10);
    expect(b.y).toBeLessThan(10);
    expect(b.x + b.w).toBeGreaterThan(40);
    expect(b.y + b.h).toBeGreaterThan(46);
    expect(b.w).toBeGreaterThan(30); // padded well beyond the 30px pose width
  });

  it("a pose with no placed points has no box, rather than a broken one", () => {
    const orig = fakeStore.frames[2].lf.instances[0].points;
    fakeStore.frames[2].lf.instances[0].points = [{ xy: [NaN, NaN] }];
    framePass.seek(0); // frame 2
    expect(framePass.focusBox).toBeNull();
    fakeStore.frames[2].lf.instances[0].points = orig;
  });

  it("the box follows the animal you cycle to", () => {
    framePass.seek(2); // frame 0, animal 0
    const first = framePass.focusBox;
    framePass.cycleInstance();
    expect(framePass.instIdx).toBe(1);
    expect(framePass.focusBox).toEqual(first); // same coords in this fixture, but recomputed per animal
    expect(framePass.focusBox).not.toBe(first);
  });
});

describe("labelling from the keyboard", () => {
  it("a digit toggles that keypoint on the targeted animal, and targets it", () => {
    framePass.seek(2); // frame 0, animal 0
    framePass.toggleKeypointNumber(2); // earL
    expect(keypointLabels.isBad(0, 0, 0, "earL")).toBe(true);
    expect(fakeEdit.selNode).toBe(1); // targeting followed the digit, so f/j act on it
    framePass.toggleKeypointNumber(2);
    expect(keypointLabels.isBad(0, 0, 0, "earL")).toBe(false); // toggles back
  });

  it("f / j write to the TARGETED keypoint and do not advance — a frame has several", () => {
    framePass.seek(0);
    framePass.toggleKeypointNumber(3); // target earR
    const where = framePass.at;
    framePass.judge(true);
    expect(keypointLabels.isBad(0, 2, 0, "earR")).toBe(true);
    framePass.judge(false);
    expect(keypointLabels.isBad(0, 2, 0, "earR")).toBe(false);
    expect(framePass.at).toBe(where); // still on the same frame
  });

  it("judging with nothing targeted asks for a target instead of guessing", () => {
    framePass.seek(0);
    fakeEdit.select(0, -1);
    framePass.judge(true);
    expect(framePass.hint).toMatch(/pick a keypoint/i);
    expect(keypointLabels.count).toBe(0);
  });

  it("digits follow the selected animal on a multi-animal frame", () => {
    framePass.seek(2); // frame 0, animal 0
    framePass.cycleInstance();
    expect(framePass.instIdx).toBe(1);
    framePass.toggleKeypointNumber(1);
    expect(keypointLabels.isBad(0, 0, 1, "nose")).toBe(true);
    expect(keypointLabels.isBad(0, 0, 0, "nose")).toBe(false); // not the other animal
  });

  it("cycling moves the CURSOR too, so the verdict describes the animal the digits hit", () => {
    framePass.seek(2); // frame 0, animal 0
    framePass.cycleInstance();
    expect(framePass.current.inst).toBe(1); // the row followed, not just the selection
    expect(framePass.at).toBe(1);
  });

  it("cycling animals on a single-animal frame says so rather than silently doing nothing", () => {
    framePass.seek(0); // frame 2, one animal
    framePass.cycleInstance();
    expect(framePass.hint).toMatch(/one animal/i);
    expect(framePass.instIdx).toBe(0);
  });

  it("a leftover animal selection can't point past a smaller frame's instances", () => {
    framePass.inst = 1; // as if carried over from the two-animal frame
    framePass.cursor = 0; // frame 2, ONE animal
    expect(framePass.instIdx).toBe(0); // clamped, so the digit still lands somewhere real
  });

  it("faultySet is what drawScene needs, keyed inst:node", () => {
    framePass.seek(1); // frame 0, animal 1
    framePass.toggleKeypointNumber(4); // tail
    expect([...framePass.faultySet]).toEqual(["1:3"]); // keyed by the animal it was marked on
  });

  it("an out-of-range digit is ignored, not stored under undefined", () => {
    framePass.seek(0);
    framePass.toggleKeypointNumber(9); // only 4 nodes
    expect(keypointLabels.count).toBe(0);
  });
});

describe("the queue is walkable without turning the mode on", () => {
  it("movement actions are separable from labelling ones", () => {
    for (const id of ["next", "prev", "first", "last", "nextUnreviewed"]) {
      expect(framePass.isMove(id), id).toBe(true);
    }
    for (const id of ["faulty", "clean", "unset", "toggleKeypoint", "cycleInstance", "exportCsv"]) {
      expect(framePass.isMove(id), id).toBe(false);
    }
  });

  it("the viewer routes MOVES to the pass even with proofreading off", () => {
    // Otherwise `n` fell through to the viewer's own frame stepping, which walks the file numerically
    // and makes a ranked queue look like it isn't sorted at all.
    const src = readFileSync("src/lib/components/Viewer.svelte", "utf8");
    expect(src).toContain("} else if (framePass.active) {");
    expect(src).toMatch(/framePass\.isMove\(a\.id\)/);
  });

  it("upcoming() exposes the next rows so the order can be checked, not trusted", () => {
    framePass.seek(0);
    const up = framePass.upcoming(3);
    expect(up.length).toBe(3);
    expect(up[0]).toBe(framePass.queue[1]);
    expect(up.map((r) => r.i)).toEqual(rankedRows.slice(1, 4).map((r) => r.i));
    framePass.seek(framePass.length - 1);
    expect(framePass.upcoming(3)).toEqual([]); // nothing after the last row
  });
});

describe("the cursor and the animal being judged can never disagree", () => {
  it("clicking an animal moves the CURSOR to its row, not just the selection", () => {
    framePass.seek(2); // frame 0, animal 0
    framePass.selectInstance(1);
    expect(framePass.instIdx).toBe(1);
    expect(framePass.current.inst).toBe(1); // the row followed — score/verdict describe this animal
    expect(framePass.at).toBe(1);
  });

  it("an animal deleted mid-pass refuses the judgement instead of marking its neighbour", () => {
    framePass.seek(1); // frame 0, animal 1
    fakeStore.frames[0].lf.instances.length = 1; // the pose editor removed it under us
    expect(framePass.instStale).toBe(true);
    framePass.toggleKeypointNumber(1);
    framePass.judge(true);
    expect(keypointLabels.count, "wrote to the surviving animal").toBe(0);
    expect(framePass.hint).toMatch(/deleted/i);
    fakeStore.frames[0] = mkFrame(0, 2); // restore for the other tests
  });

  it("a re-ranked queue re-lands the cursor instead of leaving the viewer on the old row", () => {
    framePass.seek(3); // frame 3
    const swapped = [{ i: 1, inst: 0, by: "angle" }, { i: 2, inst: 0, by: "gmm" }];
    const original = fakeQc.proofreadRanked;
    fakeQc.proofreadRanked = swapped;
    framePass.resync();
    expect(framePass.at).toBeLessThan(swapped.length); // clamped into the new, shorter queue
    expect(fakeStore.index).toBe(framePass.frameIndex); // and the viewer followed it
    fakeQc.proofreadRanked = original;
  });

  it("resync on an emptied queue resets rather than pointing at nothing", () => {
    const original = fakeQc.proofreadRanked;
    fakeQc.proofreadRanked = [];
    framePass.resync();
    expect(framePass.at).toBe(0);
    expect(framePass.current).toBeNull();
    fakeQc.proofreadRanked = original;
  });
});

describe("dispatch", () => {
  it("maps the shared keymap ids onto the frame pass", () => {
    framePass.seek(0);
    framePass.dispatch({ id: "next" });
    expect(framePass.at).toBe(1);
    framePass.dispatch({ id: "prev" });
    expect(framePass.at).toBe(0);
    framePass.dispatch({ id: "last" });
    expect(framePass.at).toBe(rankedRows.length - 1);
    framePass.dispatch({ id: "first" });
    expect(framePass.at).toBe(0);
    framePass.dispatch({ id: "toggleKeypoint", digit: 1 });
    expect(keypointLabels.isBad(0, 2, 0, "nose")).toBe(true);
  });

  it("hands session-level actions to the other pass rather than reimplementing them", () => {
    for (const id of ["exportCsv", "help", "exit", "budgetUp"]) framePass.dispatch({ id });
    expect(dispatched).toEqual(["exportCsv", "help", "exit", "budgetUp"]);
  });

  it("reset returns to the top of the queue for a new file", () => {
    framePass.seek(2);
    framePass.reset();
    expect(framePass.at).toBe(0);
    expect(framePass.inst).toBe(0);
    expect(framePass.hint).toBe("");
  });
});
