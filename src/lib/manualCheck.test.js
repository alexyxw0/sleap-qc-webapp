import { describe, it, expect } from "vitest";
import { parseManualCheck, confusion } from "./manualCheck.js";

describe("parseManualCheck", () => {
  it("reads video/frame_idx/status + notes, strips BOM, counts faulty", () => {
    const csv = [
      "﻿frame_index,frame_idx,video,n_instances,n_faulty,status,notes",
      "0,10798,0,1,0,not_faulty,",
      "54,613,1,1,1,faulty,#0: head placement",
      "55,614,1,1,1,faulty,",
    ].join("\n");
    const r = parseManualCheck(csv);
    expect(r.error).toBeUndefined();
    expect(r.total).toBe(3);
    expect(r.faulty).toBe(2);
    expect(r.byKey.get("0:10798").faulty).toBe(false);
    expect(r.byKey.get("1:613")).toEqual({ faulty: true, notes: "#0: head placement" });
  });

  it("honors quoted notes containing commas", () => {
    const csv = 'frame_idx,video,status,notes\n5,0,faulty,"nose off, ear too"';
    expect(parseManualCheck(csv).byKey.get("0:5").notes).toBe("nose off, ear too");
  });

  it("falls back to n_faulty when there is no status column", () => {
    const csv = "frame_idx,video,n_faulty\n5,0,2\n6,0,0";
    const r = parseManualCheck(csv);
    expect(r.byKey.get("0:5").faulty).toBe(true);
    expect(r.byKey.get("0:6").faulty).toBe(false);
  });

  it("treats every frame in the per-keypoint schema as faulty (the file lists only faulty frames)", () => {
    // faulty_keypoints.csv lists ONE ROW PER INSTANCE for reviewed-FAULTY frames only. A clean-instance
    // row (n_bad_keypoints=0) still belongs to a faulty frame, so presence ⇒ frame faulty.
    const csv = [
      "frame_index,frame_idx,video,instance,type,track,score,n_bad_keypoints,bad_keypoints,note,file",
      "92,651,1,0,user,0,0.0,1,nose,nose too far back,f.slp", // frame 1:651 (nose flagged)
      "20,8700,0,1,user,0,0.0,0,,,f.slp", // frame 0:8700 — no keypoint marked, but still a faulty frame
      "45,10472,0,1,user,0,0.0,3,neck;ear_r;body_1,,f.slp", // frame 0:10472
      "46,10472,0,0,user,0,0.0,0,,,f.slp", // same frame, a clean instance -> frame still counted once
    ].join("\n");
    const r = parseManualCheck(csv);
    expect(r.error).toBeUndefined();
    expect(r.total).toBe(3); // 3 unique frames
    expect(r.faulty).toBe(3); // ALL present frames are faulty (incl. 0:8700 with no bad keypoint)
    expect(r.byKey.get("1:651").faulty).toBe(true);
    expect(r.byKey.get("0:8700").faulty).toBe(true);
    expect(r.byKey.get("0:10472").faulty).toBe(true);
    expect(r.byKey.get("1:651").notes).toBe("nose too far back");
  });

  it("errors without a frame_idx column", () => {
    expect(parseManualCheck("a,b\n1,2").error).toMatch(/frame_idx/);
  });
});

describe("confusion", () => {
  it("computes the 2x2 + precision/recall/kappa", () => {
    // 3 both, 1 qcOnly (false pos), 2 manualOnly (missed), 4 neither
    const pairs = [
      ...Array(3).fill({ qc: true, manual: true }),
      ...Array(1).fill({ qc: true, manual: false }),
      ...Array(2).fill({ qc: false, manual: true }),
      ...Array(4).fill({ qc: false, manual: false }),
    ];
    const c = confusion(pairs);
    expect([c.both, c.qcOnly, c.manualOnly, c.neither]).toEqual([3, 1, 2, 4]);
    expect(c.n).toBe(10);
    expect(c.precision).toBeCloseTo(3 / 4); // both / qcFlagged
    expect(c.recall).toBeCloseTo(3 / 5); // both / manualFaulty
    expect(c.accuracy).toBeCloseTo(7 / 10);
    expect(c.kappa).toBeGreaterThan(0);
    expect(c.kappa).toBeLessThan(1);
  });

  it("perfect agreement => kappa 1", () => {
    const c = confusion([{ qc: true, manual: true }, { qc: false, manual: false }]);
    expect(c.kappa).toBeCloseTo(1);
  });
});
