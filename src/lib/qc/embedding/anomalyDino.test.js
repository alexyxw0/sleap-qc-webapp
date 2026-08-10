// The claim this feature rests on is not "AnomalyDINO runs" — it is "AnomalyDINO catches the fault
// that CLS-kNN cannot". A keypoint two pixels off the nostril still LOOKS almost entirely like a
// nose, so its CLS token barely moves; only a handful of its patch tokens do. If that head-to-head
// does not come out the right way, the option is not worth offering, so it is the first test here.
import { describe, it, expect } from "vitest";
import { buildMemoryBank, patchDistances, aggregate, anomalyDinoScores, ANOMALY_DINO } from "./anomalyDino.js";
import { unpackPatchTokens } from "./patchTokens.js";
import { knnOutlierScoresRef } from "./outlier.js";

const P = 8;

/** A descriptor of `T` unit tokens, built from explicit per-token directions in a small basis. */
function desc(dirs) {
  const out = new Int8Array(dirs.length * P);
  dirs.forEach((d, t) => {
    const v = new Float32Array(P);
    // A smooth, distinct unit direction per "content id".
    for (let p = 0; p < P; p++) v[p] = Math.cos(d * 1.7 + p * 0.9);
    let s = 0; for (const x of v) s += x * x;
    const inv = 127 / Math.sqrt(s);
    for (let p = 0; p < P; p++) out[t * P + p] = Math.round(v[p] * inv);
  });
  return out;
}

const NORMAL = [1, 2, 3, 4]; // what an ordinary crop's four tokens contain
const range = (n) => Array.from({ length: n }, (_, i) => i);

describe("the head-to-head that justifies the option", () => {
  it("scores a locally-wrong crop above a normal one, where CLS-kNN barely separates them", () => {
    // 40 normal crops with small per-crop variation, plus ONE whose last token is replaced.
    const jitter = (i, t) => NORMAL[t] + (i % 5) * 0.004;
    const descs = range(40).map((i) => desc(NORMAL.map((_, t) => jitter(i, t))));
    const faultIdx = descs.length;
    descs.push(desc([NORMAL[0], NORMAL[1], NORMAL[2], 9])); // one of four regions is wrong

    const ref = range(30);
    const ad = anomalyDinoScores(descs, ref, P);
    const worstNormal = Math.max(...range(40).map((i) => ad[i]));
    expect(ad[faultIdx], "the locally-wrong crop must be the top-scoring one").toBeGreaterThan(worstNormal);

    // The CLS analogue: one mean vector per crop, which is what averaging a local defect away means.
    const cls = descs.map((d) => {
      const v = new Float32Array(P);
      for (let t = 0; t < d.length / P; t++) for (let p = 0; p < P; p++) v[p] += d[t * P + p];
      let s = 0; for (const x of v) s += x * x;
      const inv = 1 / (Math.sqrt(s) || 1);
      for (let p = 0; p < P; p++) v[p] *= inv;
      return v;
    });
    const knn = knnOutlierScoresRef(cls, ref, 6);
    const sep = (arr) => (arr[faultIdx] - Math.max(...range(40).map((i) => arr[i])))
      / (Math.max(...range(40).map((i) => arr[i])) || 1e-9);
    // Both may rank it first; the point is the MARGIN. Patch-level puts real distance between the
    // fault and the worst normal crop, which is what survives a threshold.
    expect(sep(ad)).toBeGreaterThan(sep(knn));
  });
});

describe("buildMemoryBank", () => {
  const descs = range(10).map(() => desc(NORMAL));

  it("keeps every token when they fit in the budget", () => {
    const bank = buildMemoryBank(descs, [0, 1, 2], P, 1000);
    expect(bank.n).toBe(3 * 4);
    expect(bank.P).toBe(P);
    expect(bank.data.length).toBe(bank.n * P);
  });

  it("subsamples down to the budget rather than blowing past it", () => {
    for (const b of [1, 7, 13, 39]) {
      const bank = buildMemoryBank(descs, range(10), P, b);
      expect(bank.n, `budget ${b}`).toBe(Math.min(b, 40));
      expect(bank.owner.length).toBe(bank.n);
      expect(bank.data.length).toBe(bank.n * P);
    }
  });

  it("covers every grid POSITION, not just every crop", () => {
    // A single global stride over the concatenated tokens can lock onto a position and bank e.g. only
    // tokens 0 and 2 of every crop — a bank that has never seen the bottom-left of anything, which
    // then calls every bottom-left an anomaly. Half the budget is the regime where that bites.
    const bank = buildMemoryBank(descs, range(10), P, 20); // 20 of 40, i.e. stride 2 globally
    const positions = new Set();
    // reconstruct which position each banked token was, by matching it back to its source descriptor
    for (let b = 0; b < bank.n; b++) {
      const src = unpackPatchTokens(descs[bank.owner[b]], P);
      for (let t = 0; t < 4; t++) {
        let same = true;
        for (let p = 0; p < P; p++) if (Math.abs(src[t * P + p] - bank.data[b * P + p]) > 1e-6) { same = false; break; }
        if (same) { positions.add(t); break; }
      }
    }
    expect(positions.size, "the bank missed whole grid positions").toBe(4);
  });

  it("spreads the subsample across source crops instead of taking the first few whole", () => {
    // A bank drawn from crop 0 alone is a bank of one animal in one pose — it would call every other
    // crop in the file an anomaly.
    const bank = buildMemoryBank(descs, range(10), P, 10);
    expect(new Set(Array.from(bank.owner)).size).toBeGreaterThan(3);
  });

  it("records which crop each token came from", () => {
    const bank = buildMemoryBank(descs, [2, 5], P, 1000);
    expect(new Set(Array.from(bank.owner))).toEqual(new Set([2, 5]));
  });

  it("is null when the reference has nothing usable", () => {
    expect(buildMemoryBank(descs, [], P, 100)).toBeNull();
    expect(buildMemoryBank([null, null], [0, 1], P, 100)).toBeNull();
  });
});

describe("patchDistances", () => {
  it("is ~0 for a crop the bank already contains, and high for unseen content", () => {
    const descs = [desc(NORMAL), desc([7, 7, 7, 7])];
    const bank = buildMemoryBank(descs, [0], P, 1000);
    for (const d of patchDistances(descs[0], bank)) expect(d).toBeLessThan(1e-3);
    for (const d of patchDistances(descs[1], bank)) expect(d).toBeGreaterThan(0.1);
  });

  it("localizes: only the wrong token is far", () => {
    const descs = [desc(NORMAL), desc([NORMAL[0], NORMAL[1], NORMAL[2], 9])];
    const bank = buildMemoryBank(descs, [0], P, 1000);
    const d = patchDistances(descs[1], bank);
    expect(d[3]).toBeGreaterThan(0.1);
    for (const t of [0, 1, 2]) expect(d[t]).toBeLessThan(1e-3);
  });

  it("skipOwner excludes a crop's own tokens — else every reference crop scores a perfect 0", () => {
    // The reference is a subsample OF the scored set here (unlike the paper's few-shot setting), so
    // without this a fifth of the file scores 0 and drags the median the robust-z is measured against.
    const descs = [desc([7, 7, 7, 7]), desc(NORMAL), desc(NORMAL)];
    const bank = buildMemoryBank(descs, [0, 1, 2], P, 1000);
    expect(Math.max(...patchDistances(descs[0], bank))).toBeLessThan(1e-3);        // finds itself
    expect(Math.max(...patchDistances(descs[0], bank, 0))).toBeGreaterThan(0.1);   // must not
  });
});

describe("aggregate — mean of the top-q, not the max and not the mean", () => {
  const d = [0.9, 0.8, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1];

  it("averages the worst q fraction", () => {
    expect(aggregate(d, 0.25)).toBeCloseTo((0.9 + 0.8) / 2, 6); // top 2 of 8
  });

  it("is not the max — one noisy token cannot carry a crop", () => {
    expect(aggregate([0.9, 0, 0, 0, 0, 0, 0, 0], 0.25)).toBeCloseTo(0.45, 6);
  });

  it("is not the mean — a real local fault is not diluted by correct background", () => {
    const mean = d.reduce((a, b) => a + b, 0) / d.length;
    expect(aggregate(d, 0.25)).toBeGreaterThan(mean * 2);
  });

  it("always takes at least one token, and never more than all of them", () => {
    expect(aggregate(d, 0)).toBeCloseTo(0.9, 6);
    expect(aggregate(d, 5)).toBeCloseTo(d.reduce((a, b) => a + b, 0) / d.length, 6);
    expect(aggregate([], 0.25)).toBe(0);
  });

  it("defaults to a quarter — 1% of 16 pooled tokens would BE the max it argues against", () => {
    expect(ANOMALY_DINO.q).toBe(0.25);
    expect(Math.ceil(ANOMALY_DINO.q * 16)).toBe(4);
  });
});

describe("anomalyDinoScores", () => {
  it("scores a crop with no patch features 0 — the bottom of the scale, never a flag", () => {
    // An older cache entry has a CLS vector and no patch tokens. Scoring it HIGH would flag clean
    // frames for a bookkeeping reason; the store reports the shortfall separately (patchCoverage).
    const descs = [desc(NORMAL), desc(NORMAL), desc(NORMAL), null, desc([9, 9, 9, 9])];
    const s = anomalyDinoScores(descs, [0, 1, 2], P);
    expect(s[3]).toBe(0);
    expect(s[4]).toBeGreaterThan(0);
  });

  it("does not let a crop score itself clean just for being IN the reference", () => {
    // The reference here is a subsample OF the scored set (the paper's is a separate few-shot set), so
    // every reference crop finds its own tokens at distance 0. Left unhandled, a fifth of the file
    // scores a perfect 0 — including the faulty ones that happened to be sampled — and the median the
    // robust-z is measured against moves with it. This is the wiring, not the primitive: patchDistances
    // takes the owner to skip, and anomalyDinoScores has to actually pass it.
    const descs = [desc([9, 9, 9, 9]), ...range(9).map(() => desc(NORMAL))];
    const s = anomalyDinoScores(descs, range(10), P); // crop 0 is faulty AND in the reference
    expect(s[0], "the anomaly was hidden by its own tokens").toBeGreaterThan(0.1);
    expect(s[0]).toBeGreaterThan(Math.max(...range(9).map((i) => s[i + 1])));
  });

  it("returns all-zero rather than throwing when there is no usable reference", () => {
    const descs = [desc(NORMAL), desc(NORMAL)];
    expect(Array.from(anomalyDinoScores(descs, [], P))).toEqual([0, 0]);
    expect(Array.from(anomalyDinoScores([], [0], P))).toEqual([]);
  });

  it("honours the bank budget without changing the ranking it produces", () => {
    const descs = range(30).map((i) => desc(NORMAL.map((v, t) => v + (i % 7) * 0.003 * (t + 1))));
    descs.push(desc([NORMAL[0], NORMAL[1], NORMAL[2], 9]));
    const small = anomalyDinoScores(descs, range(20), P, { bankTokens: 40 }); // half the tokens
    const big = anomalyDinoScores(descs, range(20), P, { bankTokens: 1000 });
    const top = (a) => a.indexOf(Math.max(...a));
    expect(top(Array.from(small))).toBe(descs.length - 1);
    expect(top(Array.from(big))).toBe(descs.length - 1);
  });
});
