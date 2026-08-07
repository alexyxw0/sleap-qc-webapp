import { describe, it, expect } from "vitest";
import { rankNormalize, prototypeDirection, prototypeScores, blendByRank } from "./fewshot.js";
import { parseKeypointLabels } from "../../manualCheck.js";

const auc = (scores, y) => {                       // Mann-Whitney AUC
  const pos = [...scores.keys()].filter((i) => y[i]);
  const neg = [...scores.keys()].filter((i) => !y[i]);
  let w = 0;
  for (const p of pos) for (const n of neg) w += scores[p] > scores[n] ? 1 : scores[p] === scores[n] ? 0.5 : 0;
  return w / (pos.length * neg.length);
};
function rng(seed) { let s = seed; return () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff); }

describe("rankNormalize", () => {
  it("maps to [0,1], preserves order, averages ties", () => {
    const r = rankNormalize([5, 1, 3]);
    expect(r[1]).toBe(0); expect(r[0]).toBe(1); expect(r[2]).toBeCloseTo(0.5);
    const t = rankNormalize([2, 2, 9]);
    expect(t[0]).toBeCloseTo(t[1]);               // ties share a rank
    expect(t[2]).toBe(1);
  });
});

describe("blendByRank", () => {
  it("alpha=0 leaves the base ranking EXACTLY unchanged", () => {
    const base = [0.9, 0.1, 0.5, 0.7];
    const out = blendByRank(base, [1, 1, 1, 1], 0);
    expect([...out]).toEqual(base);               // identity, not merely order-preserving
  });
  it("alpha=1 adopts the few-shot ranking", () => {
    const out = blendByRank([9, 8, 7], [1, 2, 3], 1);
    expect(out[2]).toBeGreaterThan(out[0]);
  });
});

describe("prototypeDirection", () => {
  it("points from the clean centroid toward the faulty one", () => {
    const embs = [new Float64Array([1, 0]), new Float64Array([1, 0]), new Float64Array([0, 1]), new Float64Array([0, 1])];
    const p = prototypeDirection(embs, [0, 1], [2, 3], 1);
    expect(p.w[0]).toBeGreaterThan(0.7); expect(p.w[1]).toBeLessThan(-0.7);
    expect(p.nPos).toBe(2); expect(p.usedGlobal).toBe(false);
  });
  it("falls back to the global mean when labelled negatives are too few", () => {
    const embs = [new Float64Array([1, 0]), new Float64Array([0, 1]), new Float64Array([0, 1])];
    expect(prototypeDirection(embs, [0], [], 3).usedGlobal).toBe(true);
  });
  it("returns null with no positives", () => {
    expect(prototypeDirection([new Float64Array([1, 0])], [], [0])).toBeNull();
  });
});

describe("few-shot actually improves a poorly-transferred ranking", () => {
  it("recovers AUC from a weak transferred model using a handful of labels", () => {
    const r = rng(7), N = 400, D = 8, nPos = 40;
    const y = Array.from({ length: N }, (_, i) => i < nPos);
    const embs = [];
    for (let i = 0; i < N; i++) {
      const v = new Float64Array(D);
      for (let d = 0; d < D; d++) v[d] = r() - 0.5;
      if (y[i]) v[0] += 1.2;                      // the true fault direction is dim 0
      embs.push(v);
    }
    // a TRANSFERRED model: keys off the wrong dimension, so it barely ranks this domain
    const base = embs.map((e, i) => e[3] * 0.9 + (y[i] ? 0.12 : 0) + r() * 0.1);
    const aucBase = auc(base, y);
    expect(aucBase).toBeLessThan(0.68);           // weak, like center→gily zero-shot

    const posIdx = [...Array(10).keys()];         // only 10 labelled faulty
    const negIdx = [...Array(30).keys()].map((k) => nPos + k);
    const proto = prototypeDirection(embs, posIdx, negIdx);
    const blended = blendByRank(base, prototypeScores(embs, proto.w), 0.5);
    const aucFS = auc(blended, y);

    expect(aucFS).toBeGreaterThan(aucBase + 0.1); // a real, substantial lift
    expect(auc(blendByRank(base, prototypeScores(embs, proto.w), 0), y)).toBeCloseTo(aucBase, 10);
  });
});

describe("parseKeypointLabels", () => {
  const csv = [
    "frame_index,frame_idx,video,instance,n_bad_keypoints,bad_keypoints",
    "2,7525,0,0,1,nose",
    "20,8700,0,1,0,",
    "31,9000,1,0,2,nose;ear_l",
  ].join("\n");
  it("keeps the bad_keypoints the frame-level parser discards", () => {
    const r = parseKeypointLabels(csv);
    expect(r.error).toBeUndefined();
    expect(r.rows).toHaveLength(3);
    expect(r.rows[0]).toEqual({ video: 0, frameIdx: 7525, inst: 0, bad: ["nose"] });
    expect(r.rows[1].bad).toEqual([]);            // reviewed-clean instance = a usable NEGATIVE
    expect(r.rows[2].bad).toEqual(["nose", "ear_l"]);
    expect(r.nodes.sort()).toEqual(["ear_l", "nose"]);
  });
  it("rejects a frame-level CSV that has no keypoint column", () => {
    expect(parseKeypointLabels("frame_idx,video,status\n1,0,faulty").error).toMatch(/bad_keypoints/);
  });
});
