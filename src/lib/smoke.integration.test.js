// The blank-canvas regression was a TDZ inside Viewer's draw effect: the build passed, every unit test
// passed, and the app rendered nothing. Components aren't mounted in this suite, so these lock the
// contracts the components depend on — the things that were actually wrong.
import { describe, it, expect, vi } from "vitest";

vi.mock("./labelsStore.svelte.js", () => ({
  store: { frames: [], labels: null, skeleton: { nodeNames: ["nose", "head"] }, current: null,
           setIndex() {}, syncFrameImage() {} },
}));
vi.mock("./editStore.svelte.js", () => ({ edit: { selInstance: -1, selNode: -1, select() {} } }));
vi.mock("./viewStore.svelte.js", () => ({ view: { requestFocus() {} } }));

const { keypointLabels } = await import("./keypointLabels.svelte.js");
const { keypointModels } = await import("./keypointModels.svelte.js");
const { proofread } = await import("./proofreadSession.svelte.js");

describe("label keys are the numeric fkey everywhere", () => {
  it("fkey helpers produce the SAME key as the (video, frame, inst) form", () => {
    keypointLabels.clear();
    keypointLabels.markAt("0:412", 1, "nose", true);
    // must be visible to the numeric API the candidates / few-shot matcher / CSV all use
    expect(keypointLabels.isBad(0, 412, 1, "nose")).toBe(true);
    expect(keypointLabels.isReviewed(0, 412, 1)).toBe(true);
    expect(keypointLabels.isBadAt("0:412", 1, "nose")).toBe(true);
  });

  it("a video OBJECT can never leak into a key — rows() would emit NaN", () => {
    keypointLabels.clear();
    keypointLabels.markAt("2:7", 0, "nose", true);
    const r = keypointLabels.rows();
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ video: 2, frameIdx: 7, inst: 0 });
    for (const v of Object.values(r[0])) expect(Number.isNaN(v)).toBe(false);
    expect(keypointLabels.toCsv()).not.toMatch(/NaN|object Object/);
  });

  it("in-app labels are visible to few-shot's numeric lookup (the whole point of labelling)", () => {
    keypointLabels.clear();
    keypointLabels.markAt("0:5", 0, "nose", true);   // as the viewer now does
    keypointLabels.markAt("0:6", 0, "nose", false);
    const { pos, neg } = keypointLabels.forNode("nose");
    expect([...pos]).toEqual(["0:5:0"]);              // matches "${video}:${frame_idx}:${inst}"
    expect([...neg]).toEqual(["0:6:0"]);
  });
});

describe("proofread session contracts the Viewer relies on", () => {
  it("dispatch tolerates an empty queue instead of throwing into the key handler", () => {
    keypointModels.slots = [];
    keypointModels.rev++;
    for (const id of ["faulty", "clean", "unset", "next", "prev", "nextUnreviewed",
                      "first", "last", "cycleKeypoint", "zoom", "help", "exit"]) {
      expect(() => proofread.dispatch({ id })).not.toThrow();
    }
    expect(() => proofread.dispatch({ id: "toggleKeypoint", digit: 1 })).not.toThrow();
    expect(() => proofread.dispatch({ id: "nope" })).not.toThrow();
  });
  it("current is null (not undefined-deref) with nothing loaded", () => {
    expect(proofread.current).toBeNull();
    expect(proofread.queue).toEqual([]);
    expect(proofread.reviewedCount).toBe(0);
  });
});
