// qcStore.svelte.js
//
// Runs the ported QC detection (deterministic path: features + frame-level checks +
// ZScore anomaly scoring — NOT the seed-unstable GMM) on the loaded labels, on demand,
// and exposes results for the UI (frame heat, frame issues, per-instance scores).

import { fitAndScoreLabels } from "./qc/checks/detector.js";
import { makeQCConfig } from "./qc/checks/config.js";
import { topIssue, confidence } from "./qc/checks/explain.js";
import { store } from "./labelsStore.svelte.js";

class QCStore {
  status = $state("idle"); // idle | running | done | error
  error = $state(null);
  threshold = $state(0.7);
  spatialThreshold = $state(3.5); // worst-node Mahalanobis >= this => spatial outlier
  uncThreshold = $state(0.6); // (stable build: confidence channel absent; kept for the shared UI)
  rev = $state(0); // bump when results change
  ranAtRev = -1; // store.rev at the time QC last ran (for staleness)

  // Which detection techniques contribute to the flagged set. The flagged frames are the
  // UNION of the enabled checks; the sidebar lets the user toggle each on/off.
  checks = $state({ anomaly: true, spatial: true, count: true, negative: true, duplicates: true });

  #instanceScores = new Map(); // "v:f:i" -> score
  #contributions = new Map(); // "v:f:i" -> { feature: rawValue }
  #nodeScores = new Map(); // "v:f:i" -> per-node spatial Mahalanobis[]
  #worstNodes = new Map(); // "v:f:i" -> worst (most out-of-place) node index
  #frameResults = new Map(); // "v:f" -> FrameQC
  #frameScore = new Map(); // "v:f" -> max instance score
  #frameWorst = new Map(); // "v:f" -> instIdx of the worst instance
  #spatialFlagged = new Set(); // "v:f" frames with a worst-node Mahalanobis >= spatialThreshold

  get hasResults() {
    return this.status === "done";
  }
  // Results no longer reflect the model if it was edited after the run.
  get stale() {
    this.rev;
    return this.status === "done" && store.rev !== this.ranAtRev;
  }
  /** Number of frames flagged by the UNION of the currently-enabled checks. */
  get flaggedFrameCount() {
    this.rev;
    const c = this.checks;
    const u = new Set();
    if (c.anomaly) for (const [fk, s] of this.#frameScore) if (s >= this.threshold) u.add(fk);
    if (c.spatial) for (const fk of this.#spatialFlagged) u.add(fk);
    for (const [fk, fq] of this.#frameResults) {
      if (
        (c.count && fq.isIncomplete) ||
        (c.negative && fq.isNegativeWithInstances) ||
        (c.duplicates && (fq.duplicatePairs?.length ?? 0) > 0)
      ) {
        u.add(fk);
      }
    }
    return u.size;
  }

  /** Toggle a detection technique on/off (re-derives the flagged set via the union). */
  toggleCheck(name) {
    if (name in this.checks) {
      this.checks[name] = !this.checks[name];
      this.rev++;
    }
  }

  /** How many frames a single check flags (independent of whether it's enabled). */
  checkCount(name) {
    this.rev;
    if (name === "anomaly") {
      let n = 0;
      for (const s of this.#frameScore.values()) if (s >= this.threshold) n++;
      return n;
    }
    if (name === "spatial") return this.#spatialFlagged.size;
    let n = 0;
    for (const fq of this.#frameResults.values()) {
      if (
        (name === "count" && fq.isIncomplete) ||
        (name === "negative" && fq.isNegativeWithInstances) ||
        (name === "duplicates" && (fq.duplicatePairs?.length ?? 0) > 0)
      ) {
        n++;
      }
    }
    return n;
  }

  #videoIdx(video) {
    return store.labels?.videos?.indexOf(video) ?? 0;
  }

  /** Per-frame max anomaly score, or null (null also when the Anomaly check is off). */
  frameScore(item) {
    this.rev;
    if (!item || !this.checks.anomaly) return null;
    return this.#frameScore.get(`${this.#videoIdx(item.video)}:${item.frameIdx}`) ?? null;
  }
  /**
   * Frame-level QC result for a navigable item, with disabled frame-checks suppressed so the
   * shared `hasFrameIssue()`-based UI (issue list, red triangle) respects the toggles.
   */
  frameQC(item) {
    this.rev;
    if (!item) return null;
    const fq = this.#frameResults.get(`${this.#videoIdx(item.video)}:${item.frameIdx}`);
    if (!fq) return null;
    const c = this.checks;
    return {
      ...fq,
      isIncomplete: c.count ? fq.isIncomplete : false,
      isNegativeWithInstances: c.negative ? fq.isNegativeWithInstances : false,
      duplicatePairs: c.duplicates ? fq.duplicatePairs : [],
      duplicateReasons: c.duplicates ? fq.duplicateReasons : [],
    };
  }
  /** Whether a frame is flagged by any ENABLED check (the union). */
  frameFlagged(item) {
    this.rev;
    if (!item) return false;
    const fk = `${this.#videoIdx(item.video)}:${item.frameIdx}`;
    const c = this.checks;
    if (c.anomaly) {
      const s = this.#frameScore.get(fk);
      if (s != null && s >= this.threshold) return true;
    }
    if (c.spatial && this.#spatialFlagged.has(fk)) return true;
    return hasFrameIssue(this.frameQC(item)); // count/negative/duplicates, already toggle-filtered
  }

  // --- Stable build: per-node SPATIAL prior is present (drives the red worst-node ring +
  //     the node named in the issue description). The CONFIDENCE channel is NOT — these
  //     inert accessors keep the shared UI's confidence blocks gated off. ---
  get hasConfidence() {
    return false;
  }
  frameMinConfidence() {
    return null;
  }
  instanceUncertainty() {
    return null;
  }
  uncertainNodeFor() {
    return -1;
  }
  /** Worst (most spatially-anomalous) node index for an instance, or -1 (also when Spatial off). */
  worstNodeFor(item, instIdx) {
    this.rev;
    if (!item || !this.checks.spatial) return -1;
    return this.#worstNodes.get(`${this.#videoIdx(item.video)}:${item.frameIdx}:${instIdx}`) ?? -1;
  }

  /**
   * Index (into store.frames) of the nearest flagged frame from `from`, scanning in `dir`
   * (+1 forward / -1 back) with wrap-around. -1 when nothing is flagged. Powers N/P nav.
   */
  seekFlagged(from, dir = 1) {
    this.rev;
    const frames = store.frames;
    const n = frames.length;
    if (!this.hasResults || n === 0) return -1;
    for (let step = 1; step <= n; step++) {
      const i = (((from + dir * step) % n) + n) % n;
      if (this.frameFlagged(frames[i])) return i;
    }
    return -1;
  }
  /** Anomaly score for the instIdx-th instance of a navigable item, or null. */
  instanceScore(item, instIdx) {
    this.rev;
    if (!item) return null;
    return this.#instanceScores.get(`${this.#videoIdx(item.video)}:${item.frameIdx}:${instIdx}`) ?? null;
  }
  /** { score, issue, feature, confidence, worstNode, worstNodeName, worstNodeDist } or null. */
  instanceIssue(item, instIdx) {
    this.rev;
    if (!item) return null;
    const key = `${this.#videoIdx(item.video)}:${item.frameIdx}:${instIdx}`;
    const score = this.#instanceScores.get(key);
    if (score == null) return null;
    const wn = this.checks.spatial ? this.#worstNodes.get(key) : -1;
    const ns = this.#nodeScores.get(key);
    const worstNodeName =
      wn != null && wn >= 0 ? store.skeleton?.nodeNames?.[wn] ?? `node ${wn}` : null;
    return {
      score,
      confidence: confidence(score),
      ...topIssue(this.#contributions.get(key)),
      worstNode: wn ?? -1,
      worstNodeName,
      worstNodeDist: wn != null && wn >= 0 && ns ? ns[wn] : null,
    };
  }
  /** The issue of the worst-scoring instance in a frame, or null. */
  frameTopIssue(item) {
    this.rev;
    if (!item) return null;
    const worst = this.#frameWorst.get(`${this.#videoIdx(item.video)}:${item.frameIdx}`);
    return worst == null ? null : this.instanceIssue(item, worst);
  }

  async run() {
    if (!store.labels || this.status === "running") return;
    this.status = "running";
    this.error = null;
    this.rev++;
    await new Promise((r) => setTimeout(r, 0)); // let "Running…" paint before the blocking compute
    try {
      const out = fitAndScoreLabels(store.labels, {
        config: makeQCConfig({ useGmm: false, spatialPrior: true }),
      });
      this.#instanceScores = out.instanceScores;
      this.#contributions = out.contributions;
      this.#nodeScores = out.nodeScores ?? new Map();
      this.#worstNodes = out.worstNodes ?? new Map();
      this.#frameResults = out.frameResults;
      this.#frameScore = new Map();
      this.#frameWorst = new Map();
      for (const [key, s] of out.instanceScores) {
        const fk = key.slice(0, key.lastIndexOf(":"));
        if (s > (this.#frameScore.get(fk) ?? -1)) {
          this.#frameScore.set(fk, s);
          this.#frameWorst.set(fk, Number(key.slice(key.lastIndexOf(":") + 1)));
        }
      }
      // Spatial-outlier frames: a worst-node Mahalanobis at/above the spatial threshold.
      this.#spatialFlagged = new Set();
      for (const [key, ns] of this.#nodeScores) {
        let maxM = -Infinity;
        for (const m of ns) if (!Number.isNaN(m) && m > maxM) maxM = m;
        if (maxM >= this.spatialThreshold) {
          this.#spatialFlagged.add(key.slice(0, key.lastIndexOf(":")));
        }
      }
      this.ranAtRev = store.rev;
      this.status = "done";
      this.rev++;
    } catch (e) {
      console.error("[qc] run failed:", e);
      this.error = String(e?.message ?? e);
      this.status = "error";
      this.rev++;
    }
  }

  reset() {
    this.status = "idle";
    this.error = null;
    this.#instanceScores = new Map();
    this.#contributions = new Map();
    this.#nodeScores = new Map();
    this.#worstNodes = new Map();
    this.#frameResults = new Map();
    this.#frameScore = new Map();
    this.#frameWorst = new Map();
    this.#spatialFlagged = new Set();
    // NOTE: this.checks (the user's enabled-technique preferences) intentionally persist
    // across files/runs.
    this.ranAtRev = -1;
    this.rev++;
  }
}

export function hasFrameIssue(fq) {
  if (!fq) return false;
  return fq.isIncomplete || fq.isNegativeWithInstances || (fq.duplicatePairs?.length ?? 0) > 0;
}

// green (low) -> red (high) heat for an anomaly score in [0,1].
export const heatColor = (score) => `hsl(${Math.round(140 * (1 - Math.max(0, Math.min(1, score))))}, 80%, 55%)`;

export const qc = new QCStore();
