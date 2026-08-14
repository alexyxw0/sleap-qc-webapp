// The proofreading queue is an ORDER over the whole file, derived from three detectors on incomparable
// scales. String-matching the component proves nothing about that; this drives the real store over the
// real fixture and checks the ordering it produces.
import { describe, it, expect, vi, beforeAll } from "vitest";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { loadSlp } from "@talmolab/sleap-io.js";

const FIX = fileURLToPath(new URL("./qc/fixtures/tracked-preds.slp", import.meta.url));

// A stand-in for labelsStore holding the fixture, shaped exactly as the real one builds it.
const fake = { labels: null, frames: [], rev: 0, index: 0, fileName: "tracked-preds.slp", skeleton: null };
vi.mock("./labelsStore.svelte.js", () => ({
  // These fixtures are single-video, so index 0 is the whole story. The real derivation — and the
  // miss case that made the write and read sides disagree — is tested against the real module in
  // labelsStore.frameKey.test.js.
  frameKey: (f) => (f ? (f.fkey ?? `0:${f.frameIdx}`) : null),
 store: fake }));

const { qc } = await import("./qcStore.svelte.js");
const { nodeEmbeddingStores } = await import("./nodeEmbeddingStore.svelte.js");

beforeAll(async () => {
  const labels = await loadSlp(FIX, { openVideos: false });
  fake.labels = labels;
  fake.frames = labels.labeledFrames
    .filter((lf) => Number.isFinite(lf.frameIdx))
    .map((lf) => ({ video: lf.video, frameIdx: lf.frameIdx, lf }));
  fake.skeleton = { nodeNames: labels.skeletons?.[0]?.nodes?.map((n) => n.name ?? n) ?? [] };
});

describe("before the automatic QC has run", () => {
  it("has no queue, and names everything that is missing", () => {
    expect(qc.proofreadReady).toBe(false);
    expect(qc.proofreadRanked).toEqual([]);
    expect(qc.proofreadUsing).toEqual([]);
    expect(qc.proofreadMissing).toEqual(["Anomaly", "GMM", "max_angle", "mean_angle", "AnomalyDINO"]);
  });
});

// Read the pools from the source rather than restating them: the tier changed once (mean_angle out,
// AnomalyDINO in) and a hard-coded copy here silently kept testing the old rule.
const SRC = readFileSync("src/lib/qcStore.svelte.js", "utf8");
const listFrom = (name) => SRC.match(new RegExp(`${name} = \\[([^\\]]*)\\]`))[1].match(/"(\w+)"/g).map((q) => q.slice(1, -1));
const SIGNALS = listFrom("PF_SIGNALS");
const PRIORITY = listFrom("PF_PRIORITY_SIGNALS");

describe("after a run", () => {
  beforeAll(async () => {
    qc.setChecks(["anomaly", "gmm"], true);
    await qc.run();
  });

  it("is ready once the units are computed", () => {
    expect(qc.status).toBe("done");
    expect(qc.proofreadReady).toBe(true);
    // The geometric set is complete; AnomalyDINO simply was not run here, and its absence is
    // reported rather than treated as an error — ONE signal is an order, four is a better one.
    expect(qc.proofreadUsing).toEqual(["Anomaly", "GMM", "max_angle", "mean_angle"]);
    expect(qc.proofreadMissing).toEqual(["AnomalyDINO"]);
  });

  it("ONE signal is enough — the queue does not demand the whole set", () => {
    // A file scored only by AnomalyDINO reported "run the automatic QC first" while holding a
    // perfectly good ranking, built from the one detector the user had deliberately chosen.
    const sig = qc.proofreadSignals;
    expect(Object.values(sig).filter(Boolean).length).toBeGreaterThan(0);
    expect(qc.proofreadReady).toBe(true);
    // and the gate is "some", not "every"
    const src = readFileSync("src/lib/qcStore.svelte.js", "utf8");
    const ready = src.slice(src.indexOf("get proofreadReady()"), src.indexOf("get proofreadRanked()"));
    expect(ready).toMatch(/proofreadUsing\.length > 0/);
    expect(ready).not.toMatch(/proofreadMissing\.length === 0/);
  });

  it("ranks every ANIMAL, not every frame — a frame with two suspects appears twice", () => {
    const q = qc.proofreadRanked;
    const instances = fake.frames.reduce((n, f) => n + (f.lf?.instances?.length ?? 0), 0);
    expect(q.length).toBe(instances);
    expect(q.length).toBeGreaterThan(fake.frames.length); // multi-animal frames contribute more than one
    // every (frame, animal) exactly once, and every one of them reachable
    const keys = q.map((r) => `${r.i}:${r.inst}`);
    expect(new Set(keys).size).toBe(q.length);
    for (let i = 0; i < fake.frames.length; i++) {
      const n = fake.frames[i].lf?.instances?.length ?? 0;
      for (let k = 0; k < n; k++) expect(keys, `frame ${i} animal ${k} missing`).toContain(`${i}:${k}`);
    }
  });

  it("reaches past the flag thresholds — near-misses are the point", () => {
    expect(qc.proofreadRanked.length).toBeGreaterThan(qc.flaggedFrameCount);
  });

  it("is ordered worst-first by EVIDENCE, with agreement breaking ties", () => {
    // Not by `score`: score is assigned as 1 - k/span AFTER the sort, so asserting it is monotone
    // asserts that a counter counts. `evidence` is the quantity that actually does the ordering.
    const q = qc.proofreadRanked;
    for (let k = 1; k < q.length; k++) {
      const a = q[k - 1], b = q[k];
      if (a.anglePriority !== b.anglePriority) continue; // tier boundary — its own test owns that
      expect(a.evidence).toBeGreaterThanOrEqual(b.evidence);
      if (a.evidence === b.evidence) expect(a.agree).toBeGreaterThanOrEqual(b.agree);
    }
  });

  it("a frame flagged ONLY by out-of-frame still reaches the review queue", () => {
    // outOfFrame had no FRAME_SEVERITY entry, so flagConfidence returned null for such a frame and
    // flaggedRanked dropped it — flagged in the count, unreachable in review.
    const s = readFileSync("src/lib/qcStore.svelte.js", "utf8");
    expect(s).toMatch(/outOfFrame: 0\.7,/); // has a severity at all
    expect(s).toContain("if (c.outOfFrame && fq.isOutOfFrame) bump(FRAME_SEVERITY.outOfFrame);");
  });

  it("the culprit keypoint resolves against real data, not just a mock", () => {
    const q = qc.proofreadRanked.slice(0, 40);
    const nodes = q.map((r) => qc.proofreadNodeFor(fake.frames[r.i], r.inst, r.by));
    const named = nodes.filter((ni) => ni >= 0);
    // all -1 would mean attribution is silently broken and every pass targets keypoint 0
    expect(named.length).toBeGreaterThan(nodes.length * 0.6);
    expect(new Set(named).size).toBeGreaterThan(1); // and it is not the same node every time
    for (const ni of named) expect(ni).toBeLessThan(fake.skeleton.nodeNames.length);
  });

  it("scores stay in [0,1] with the worst row at 1", () => {
    const q = qc.proofreadRanked;
    for (const r of q) {
      expect(r.score).toBeGreaterThanOrEqual(0);
      expect(r.score).toBeLessThanOrEqual(1);
      expect(r.agree).toBeGreaterThanOrEqual(0);
      expect(r.agree).toBeLessThanOrEqual(4);
      for (const k of ["anomaly", "gmm", "angle", "meanAngle"]) {
        const p = r.pct[k];
        if (p != null) { expect(p).toBeGreaterThanOrEqual(0); expect(p).toBeLessThanOrEqual(1); }
      }
    }
    expect(q[0].score).toBeCloseTo(1, 10);
  });

  it("the angle checks sort first, unconditionally", () => {
    const q = qc.proofreadRanked;
    const hot = q.filter((r) => r.anglePriority);
    expect(hot.length, "no angle-priority rows in the fixture").toBeGreaterThan(0);
    expect(hot.length).toBeLessThan(q.length); // ...and it isn't promoting everything
    // every one of them is ahead of every row that isn't — a guarantee, not a tendency
    const lastHot = q.findLastIndex((r) => r.anglePriority);
    expect(lastHot).toBe(hot.length - 1);
    for (let k = 0; k < hot.length; k++) expect(q[k].anglePriority).toBe(true);
  });

  it("an angle check alone promotes a row over one the other detectors hate", () => {
    const q = qc.proofreadRanked;
    const angleOnly = q.find((r) => r.anglePriority && (r.pct.anomaly ?? 0) < 0.9 && (r.pct.gmm ?? 0) < 0.9);
    const otherHot = q.find((r) => !r.anglePriority && ((r.pct.anomaly ?? 0) >= 0.98 || (r.pct.gmm ?? 0) >= 0.98));
    if (angleOnly && otherHot) expect(q.indexOf(angleOnly)).toBeLessThan(q.indexOf(otherHot));
  });

  it("the priority signals carry more weight than anomaly/gmm inside a tier", () => {
    const s = readFileSync("src/lib/qcStore.svelte.js", "utf8");
    const w = s.match(/PF_WEIGHT = \{([^}]*)\}/)[1];
    const weights = Object.fromEntries([...w.matchAll(/(\w+):\s*(\d+)/g)].map((m) => [m[1], Number(m[2])]));
    const prio = s.match(/PF_PRIORITY_SIGNALS = \[([^\]]*)\]/)[1].match(/"(\w+)"/g).map((q) => q.slice(1, -1));
    // every priority signal outweighs every diffuse one — stated as the rule, not as one literal
    for (const p of prio) for (const d of ["anomaly", "gmm"]) {
      expect(weights[p], `${p} does not outweigh ${d}`).toBeGreaterThan(weights[d]);
    }
    expect(s).toMatch(/-2 \* Math\.log\(pv\)/);   // Fisher, whichever weight the key resolves to
  });

  it("max_angle and AnomalyDINO — and only those — are the priority tier", () => {
    // The explicit requirement: those two ALWAYS come first. mean_angle is the weaker half of the
    // angle pair (lift 3.5 vs 4.5) and earns its place through weight like everything else.
    expect(PRIORITY).toEqual(["angle", "nodeDino"]);
    const s = readFileSync("src/lib/qcStore.svelte.js", "utf8");
    const prio = s.match(/PF_PRIORITY_SIGNALS = \[([^\]]*)\]/)[1];
    for (const k of ["anomaly", "gmm", "meanAngle"]) expect(prio).not.toContain(`"${k}"`);
    // ...and it only exists when the pass actually ran AnomalyDINO
    expect(s).toMatch(/st\.scorer === "anomalyDino"/);
    expect(s).toContain("adLive ? (nes.worstNodeAtKey(fk, ii)?.z ?? null) : null");
  });

  it("agreement outranks a lone extreme — that is the whole point of combining them", () => {
    // Combining by MAX put a single 100th-percentile signal above three at the 99th, so the queue
    // interleaved 1-of-3 rows above 2-of-3 rows. Evidence should accumulate instead.
    const q = qc.proofreadRanked;
    const mean = (rows) => rows.reduce((a, r) => a + r.agree, 0) / Math.max(1, rows.length);
    expect(mean(q.slice(0, 20))).toBeGreaterThan(mean(q.slice(-20)));
    expect(mean(q.slice(0, 20))).toBeGreaterThan(mean(q.slice(20, 60)));
  });

  it("a lone extreme still beats three mediocre scores", () => {
    // ...and the reverse guard: a plain mean would have buried a single decisive detector.
    const q = qc.proofreadRanked;
    const lone = q.find((r) => r.agree === 1 && Math.max(...Object.values(r.pct)) >= 0.995);
    const bland = q.find((r) => r.agree === 0 && Math.max(...Object.values(r.pct)) < 0.8);
    if (lone && bland) expect(q.indexOf(lone)).toBeLessThan(q.indexOf(bland));
  });

  it("carries the raw per-detector values, so a row can explain its own rank", () => {
    const q = qc.proofreadRanked;
    const withAll = q.filter((r) => r.anomaly != null && r.gmm != null && r.angle != null);
    expect(withAll.length).toBeGreaterThan(0);
    for (const r of withAll.slice(0, 20)) {
      expect(r.anomaly).toBeGreaterThanOrEqual(0);
      expect(r.anomaly).toBeLessThanOrEqual(1);
      expect(r.gmm).toBeGreaterThanOrEqual(0);
      expect(r.gmm).toBeLessThanOrEqual(1);
      expect(r.angle).toBeGreaterThanOrEqual(0); // |z|
      expect(Number.isFinite(r.angle)).toBe(true);
    }
  });

  it("the top of the queue really is where the detectors are loudest", () => {
    const q = qc.proofreadRanked;
    const mean = (rows, k) => {
      const v = rows.map((r) => r[k]).filter((x) => x != null);
      return v.reduce((a, b) => a + b, 0) / (v.length || 1);
    };
    const head = q.slice(0, 20), tail = q.slice(-20);
    // at least one detector has to be markedly hotter at the top, or the ordering means nothing
    const hotter = ["anomaly", "gmm", "angle"].filter((k) => mean(head, k) > mean(tail, k));
    expect(hotter.length).toBeGreaterThan(0);
  });

  it("the order does NOT depend on which checks are ticked — only on what ran", () => {
    const before = qc.proofreadRanked.map((r) => r.i);
    qc.setChecks(["gmm"], false);
    expect(qc.proofreadReady).toBe(true); // the unit is still computed
    expect(qc.proofreadRanked.map((r) => r.i)).toEqual(before);
    qc.setChecks(["gmm"], true);
  });

  it("the order does NOT depend on the flag thresholds either", () => {
    const before = qc.proofreadRanked.map((r) => r.i);
    const t = qc.threshold;
    qc.threshold = 0.05; // flag almost everything
    expect(qc.proofreadRanked.map((r) => r.i)).toEqual(before);
    qc.threshold = t;
  });

  it("every row names the animal that drove it and keeps each signal's percentile", () => {
    for (const r of qc.proofreadRanked.slice(0, 25)) {
      const n = fake.frames[r.i].lf.instances.length;
      expect(r.inst, `frame ${r.i}`).toBeGreaterThanOrEqual(0);
      expect(r.inst).toBeLessThan(n); // a real instance, not a stale index
      // `by` names why the row is where it is: the loudest ANGLE signal when an angle promoted it,
      // otherwise the loudest of all four.
      const pool = r.anglePriority ? PRIORITY : SIGNALS;
      expect(pool).toContain(r.by);
      for (const k of pool) {
        if (r.pct[k] != null) expect(r.pct[k]).toBeLessThanOrEqual(r.pct[r.by] + 1e-12);
      }
    }
  });

  it("explains itself in words, naming the culprit keypoint", () => {
    const nodes = fake.skeleton.nodeNames;
    const seen = new Set();
    for (const r of qc.proofreadRanked.slice(0, 12)) {
      const v = qc.proofreadVerdict(fake.frames[r.i], r.inst, r.by);
      expect(v, `frame ${r.i}`).toBeTruthy();
      expect(v.issue.length).toBeGreaterThan(6);
      expect(v.issue).not.toMatch(/undefined|NaN/);
      if (v.node >= 0) expect(nodes).toContain(v.nodeName);
      seen.add(v.issue);
    }
    expect(seen.size, "every frame got the same verdict — attribution isn't working").toBeGreaterThan(1);
  });

  it("a directional feature says WHICH way it deviates", () => {
    const dir = qc.proofreadRanked
      .slice(0, 25)
      .map((r) => qc.proofreadVerdict(fake.frames[r.i], r.inst, r.by))
      .filter((v) => /\((increased|decreased)\)/.test(v?.issue ?? ""));
    expect(dir.length, "no verdict carried a direction").toBeGreaterThan(0);
  });

  it("explains a frame even when nothing is ticked — the queue reaches past the thresholds", () => {
    const r = qc.proofreadRanked[0];
    const before = qc.proofreadVerdict(fake.frames[r.i], r.inst, r.by);
    qc.setChecks(["anomaly", "gmm"], false);
    // instanceIssue goes quiet here by design; the proofreading verdict must not
    expect(qc.instanceIssue(fake.frames[r.i], r.inst)).toBeNull();
    expect(qc.proofreadVerdict(fake.frames[r.i], r.inst, r.by)).toEqual(before);
    qc.setChecks(["anomaly", "gmm"], true);
  });

  it("a near-miss frame still gets a verdict — those are the ones worth a human", () => {
    const mid = qc.proofreadRanked[Math.floor(qc.proofreadRanked.length / 2)];
    const v = qc.proofreadVerdict(fake.frames[mid.i], mid.inst, mid.by);
    expect(v).toBeTruthy();
    expect(v.issue).toBeTruthy();
  });

  it("the flag distribution counts by the SAME rule the ranking uses", () => {
    const q = qc.proofreadRanked;
    const d = qc.proofreadFlagCounts;
    expect(d.total).toBe(q.length);
    for (const k of ["angle", "meanAngle", "anomaly", "gmm"]) {
      // recount independently — a distribution that disagrees with the queue explains nothing
      expect(d.per[k], k).toBe(q.filter((r) => (r.pct[k] ?? 0) >= 0.95).length);
      expect(d.per[k]).toBeLessThanOrEqual(d.total);
    }
    expect(d.priority).toBe(q.filter((r) => r.anglePriority).length);
    expect(d.agree.reduce((a, b) => a + b, 0)).toBe(q.length); // every row lands in exactly one bucket
    expect(d.agree.length).toBe(5); // 0..4 detectors
  });

  it("the distribution is memoized alongside the rows", () => {
    expect(qc.proofreadFlagCounts).toBe(qc.proofreadFlagCounts);
  });

  it("is memoized — repeated reads return the same array, not a fresh sort", () => {
    expect(qc.proofreadRanked).toBe(qc.proofreadRanked);
  });

  it("a correction does not reshuffle the queue mid-pass", () => {
    const before = qc.proofreadRanked.map((r) => r.i);
    qc.rescoreInstance(fake.frames[before[0]], 0); // in-place rescore, models unchanged
    expect(qc.proofreadRanked.map((r) => r.i)).toEqual(before);
  });

  it("a fresh run DOES rebuild it", async () => {
    const first = qc.proofreadRanked;
    fake.rev++; // an edit: forces run() to rebuild the context and refit
    await qc.run();
    expect(qc.proofreadRanked).not.toBe(first); // new models -> new snapshot
    expect(qc.proofreadRanked.length).toBe(first.length);
  });
});

// "Always prioritise AnomalyDINO (if it ran) and max_angle." The angle checks were already a tier
// that sorts ahead of everything; AnomalyDINO joins them — but only when the per-keypoint pass
// actually ran it, because a kNN pass is a different (and much weaker) claim about the same patches.
describe("AnomalyDINO joins the priority tier", () => {
  const nes = nodeEmbeddingStores.dino;
  const P = Object.getPrototypeOf(nes);
  const def = (k, v) => Object.defineProperty(P, k, { configurable: true, ...v });
  const restore = () => {
    def("hasResults", { get: () => false });
    def("nodeStats", { get: () => [] });
    def("scoringOf", { value: () => "knn" });
    def("worstNodeAtKey", { value: () => null });
    nes.resultRev++;
  };

  /** Pretend a per-keypoint pass ran with `scorer`, scoring `hot` (a "fkey:inst" set) at the top. */
  const stub = (scorer, hot) => {
    def("hasResults", { get: () => true });
    def("nodeStats", { get: () => [{ node: 0, count: 50, scored: true, refCount: 10, scorer }] });
    // scoringOf is what a per-keypoint MODEL overrides its baseline through, and the weight resolver
    // consults it first — a stub without it reports "knn" whatever nodeStats says.
    def("scoringOf", { value: () => scorer });
    def("worstNodeAtKey", { value: (fk, ii) => ({ node: 0, z: hot.has(`${fk}:${ii}`) ? 99 : 0.1 }) });
    nes.resultRev++;
  };

  beforeAll(() => restore());

  it("changes nothing when no per-keypoint pass has run", () => {
    restore();
    const before = qc.proofreadRanked.map((r) => `${r.i}:${r.inst}`);
    restore();                                   // same state, fresh evaluation
    expect(qc.proofreadRanked.map((r) => `${r.i}:${r.inst}`)).toEqual(before);
    expect(qc.proofreadRanked.every((r) => r.nodeDino == null)).toBe(true);
  });

  it("promotes an animal AnomalyDINO is alarmed about to the front", () => {
    restore();
    const base = qc.proofreadRanked;
    // pick something the geometry ranks near the BOTTOM, so promotion is unmistakable
    const victim = base[base.length - 1];
    const key = `${victim.i}:${victim.inst}`;
    expect(base.findIndex((r) => `${r.i}:${r.inst}` === key)).toBe(base.length - 1);

    const item = fake.frames[victim.i];
    stub("anomalyDino", new Set([`${item.fkey ?? `0:${item.frameIdx}`}:${victim.inst}`]));
    const after = qc.proofreadRanked;
    const now = after.findIndex((r) => `${r.i}:${r.inst}` === key);
    const row = after[now];
    // Priority gets you INTO the tier; evidence orders you within it. So the contract is not "first",
    // it is "ahead of everything the tier did not promote" — an angle-hot animal with more combined
    // evidence still leads, which is the design and not a regression.
    expect(row.anglePriority, "it did not enter the priority tier").toBe(true);
    expect(row.by, "the verdict does not name what promoted it").toBe("nodeDino");
    const firstPlain = after.findIndex((r) => !r.anglePriority);
    expect(now, "promoted, but still behind an unpromoted animal").toBeLessThan(firstPlain);
    expect(now, "it barely moved").toBeLessThan(base.length - 1);
    restore();
  });

  it("a kNN per-keypoint pass contributes evidence but NOT the priority", () => {
    // kNN over the same patches measures 5.1x chance against AnomalyDINO's 11.0. It is real signal,
    // so it carries weight — but promoting on it would hand the "always first" guarantee to a
    // detector less than half as good as the one the guarantee is for.
    restore();
    const victim = qc.proofreadRanked[qc.proofreadRanked.length - 1];
    const key = `${victim.i}:${victim.inst}`;
    const item = fake.frames[victim.i];

    stub("knn", new Set([`${item.fkey ?? `0:${item.frameIdx}`}:${victim.inst}`]));
    const knnRow = qc.proofreadRanked.find((r) => `${r.i}:${r.inst}` === key);
    expect(knnRow.anglePriority, "a kNN pass was promoted into the tier").toBe(false);
    const knnAt = qc.proofreadRanked.findIndex((r) => `${r.i}:${r.inst}` === key);

    // ...and the SAME animal under AnomalyDINO is promoted, on identical scores
    stub("anomalyDino", new Set([`${item.fkey ?? `0:${item.frameIdx}`}:${victim.inst}`]));
    const adRow = qc.proofreadRanked.find((r) => `${r.i}:${r.inst}` === key);
    expect(adRow.anglePriority).toBe(true);
    expect(qc.proofreadRanked.findIndex((r) => `${r.i}:${r.inst}` === key)).toBeLessThan(knnAt);
    restore();
  });

  it("the appearance weight follows the SCORER, not the slot", () => {
    // kNN 5.1x, AnomalyDINO 11.0x, a fitted model 26.4x — measured lifts over the same patches. One
    // weight for the slot would either flatter the weak case or short-change the strong one, and the
    // difference has to reach the combined evidence, not just sit in a table.
    restore();
    const victim = qc.proofreadRanked[Math.floor(qc.proofreadRanked.length / 2)];
    const key = `${victim.i}:${victim.inst}`;
    const item = fake.frames[victim.i];
    const hot = new Set([`${item.fkey ?? `0:${item.frameIdx}`}:${victim.inst}`]);
    const evidenceUnder = (scorer) => {
      stub(scorer, hot);
      return qc.proofreadRanked.find((r) => `${r.i}:${r.inst}` === key).evidence;
    };
    const knn = evidenceUnder("knn");
    const ad = evidenceUnder("anomalyDino");
    const svm = evidenceUnder("svm");
    expect(ad, "AnomalyDINO weighed no more than kNN").toBeGreaterThan(knn);
    expect(svm, "a fitted model weighed no more than AnomalyDINO").toBeGreaterThan(ad);
    restore();
  });

  it("the angle tier still leads — AnomalyDINO joins it rather than replacing it", () => {
    restore();
    const s = readFileSync("src/lib/qcStore.svelte.js", "utf8");
    // the tier is computed from the run's effective priority list (PF_PRIORITY_SIGNALS, minus the
    // appearance slot when a plain kNN pass is what is scoring it)
    expect(s).toMatch(/prioSignals\.some\(\(k\) => \(r\.pct\[k\] \?\? 0\) >= PF_HOT\)/);
    expect(s).toMatch(/prioSignals = PF_NODE_PRIORITY\.has\(nodeScorer\)/);
    // every priority row sorts ahead of every non-priority row, whichever signal earned it
    const rows = qc.proofreadRanked;
    const lastPrio = rows.reduce((acc, r, k) => (r.anglePriority ? k : acc), -1);
    const firstPlain = rows.findIndex((r) => !r.anglePriority);
    if (lastPrio >= 0 && firstPlain >= 0) expect(lastPrio).toBeLessThan(firstPlain);
  });
});
