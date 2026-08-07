// In-app proofreading: the user makes their own per-keypoint ground truth, which feeds few-shot adaptation
// AND must round-trip to the Python trainer's CSV schema so labels aren't trapped in the browser.
import { describe, it, expect, beforeEach } from "vitest";
import { keypointLabels } from "./keypointLabels.svelte.js";
import { parseKeypointLabels } from "./manualCheck.js";

describe("in-app labelling", () => {
  beforeEach(() => keypointLabels.clear());

  it("toggle marks then un-marks, and reports the new state", () => {
    expect(keypointLabels.toggle(0, 12, 0, "nose")).toBe(true);
    expect(keypointLabels.isBad(0, 12, 0, "nose")).toBe(true);
    expect(keypointLabels.toggle(0, 12, 0, "nose")).toBe(false);
    expect(keypointLabels.isBad(0, 12, 0, "nose")).toBe(false);
  });

  it("an instance stays REVIEWED after un-marking — that's a negative, not 'unknown'", () => {
    keypointLabels.toggle(0, 12, 0, "nose");
    keypointLabels.toggle(0, 12, 0, "nose");
    expect(keypointLabels.count).toBe(1);                       // still reviewed
    expect(keypointLabels.badCount).toBe(0);
    const { pos, neg } = keypointLabels.forNode("nose");
    expect(pos.size).toBe(0);
    expect(neg.size).toBe(1);                                    // usable as a clean example
  });

  it("labels from the viewer and from a CSV land in the SAME store", () => {
    keypointLabels.ingest([{ video: 0, frameIdx: 5, inst: 0, bad: ["ear_l"] }], "review csv");
    keypointLabels.toggle(0, 9, 1, "nose");                      // in-app
    expect(keypointLabels.count).toBe(2);
    expect(keypointLabels.source).toBe("in-app");                // provenance reflects the latest
    expect(keypointLabels.forNode("nose").pos.size).toBe(1);
    expect(keypointLabels.forNode("ear_l").pos.size).toBe(1);
  });

  it("tallies per node so the panel can show what's been labelled", () => {
    keypointLabels.toggle(0, 1, 0, "nose");
    keypointLabels.toggle(0, 2, 0, "nose");
    keypointLabels.toggle(0, 3, 0, "tail_base");
    expect(keypointLabels.nodes).toEqual([{ node: "nose", n: 2 }, { node: "tail_base", n: 1 }]);
  });

  it("CSV export round-trips through the Python-side parser", () => {
    keypointLabels.toggle(0, 100, 0, "nose");
    keypointLabels.toggle(1, 200, 2, "ear_r");
    keypointLabels.toggle(1, 200, 2, "nose");                    // two bad nodes on one instance
    keypointLabels.mark(0, 300, 0, "nose", false);               // reviewed clean
    const parsed = parseKeypointLabels(keypointLabels.toCsv());
    expect(parsed.error).toBeUndefined();
    expect(parsed.rows).toHaveLength(3);
    const back = parsed.rows.find((r) => r.frameIdx === 200);
    expect(back).toMatchObject({ video: 1, inst: 2 });
    expect(back.bad.sort()).toEqual(["ear_r", "nose"]);
    expect(parsed.rows.find((r) => r.frameIdx === 300).bad).toEqual([]);  // clean row survives
  });

  it("proofreading mode is an explicit flag, off by default", () => {
    expect(keypointLabels.proofreading).toBe(false);
  });
});

describe("isReviewed — what the guided loop counts as done", () => {
  beforeEach(() => keypointLabels.clear());

  it("false before any judgement", () => {
    expect(keypointLabels.isReviewed(0, 1, 0)).toBe(false);
  });
  it("true after marking FAULTY", () => {
    keypointLabels.mark(0, 1, 0, "nose", true);
    expect(keypointLabels.isReviewed(0, 1, 0)).toBe(true);
  });
  it("true after marking CLEAN — otherwise the loop would re-serve it forever", () => {
    keypointLabels.mark(0, 2, 0, "nose", false);
    expect(keypointLabels.isReviewed(0, 2, 0)).toBe(true);
    expect(keypointLabels.isBad(0, 2, 0, "nose")).toBe(false);
  });
  it("scoped to the instance, not the whole frame", () => {
    keypointLabels.mark(0, 3, 0, "nose", true);
    expect(keypointLabels.isReviewed(0, 3, 0)).toBe(true);
    expect(keypointLabels.isReviewed(0, 3, 1)).toBe(false);   // a second animal is still unjudged
  });
});
