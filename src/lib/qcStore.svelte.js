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
  uncThreshold = $state(0.6); // (stable build: confidence channel absent; kept for the shared UI)
  rev = $state(0); // bump when results change
  ranAtRev = -1; // store.rev at the time QC last ran (for staleness)

  #instanceScores = new Map(); // "v:f:i" -> score
  #contributions = new Map(); // "v:f:i" -> { feature: rawValue }
  #frameResults = new Map(); // "v:f" -> FrameQC
  #frameScore = new Map(); // "v:f" -> max instance score
  #frameWorst = new Map(); // "v:f" -> instIdx of the worst instance
  #flaggedFrames = 0;

  get hasResults() {
    return this.status === "done";
  }
  // Results no longer reflect the model if it was edited after the run.
  get stale() {
    this.rev;
    return this.status === "done" && store.rev !== this.ranAtRev;
  }
  get flaggedFrameCount() {
    this.rev;
    return this.#flaggedFrames;
  }

  #videoIdx(video) {
    return store.labels?.videos?.indexOf(video) ?? 0;
  }

  /** Per-frame max anomaly score for a navigable item, or null. */
  frameScore(item) {
    this.rev;
    if (!item) return null;
    return this.#frameScore.get(`${this.#videoIdx(item.video)}:${item.frameIdx}`) ?? null;
  }
  /** Frame-level QC result (count/duplicates/negative) for a navigable item, or null. */
  frameQC(item) {
    this.rev;
    if (!item) return null;
    return this.#frameResults.get(`${this.#videoIdx(item.video)}:${item.frameIdx}`) ?? null;
  }
  /** Whether a frame has any QC concern (anomalous instance OR a frame-level issue). */
  frameFlagged(item) {
    this.rev;
    const s = this.frameScore(item);
    const fq = this.frameQC(item);
    return (s != null && s >= this.threshold) || hasFrameIssue(fq);
  }

  // --- Stable build: the confidence / per-node spatial channels are NOT present here
  //     (this build runs ZScore QC only). These inert accessors let the shared UI render
  //     without those features (their blocks are gated on hasConfidence / yield no rings). ---
  get hasConfidence() {
    return false;
  }
  frameMinConfidence() {
    return null;
  }
  instanceUncertainty() {
    return null;
  }
  worstNodeFor() {
    return -1;
  }
  uncertainNodeFor() {
    return -1;
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
  /** { score, issue, feature, confidence } for an instance, or null. */
  instanceIssue(item, instIdx) {
    this.rev;
    if (!item) return null;
    const key = `${this.#videoIdx(item.video)}:${item.frameIdx}:${instIdx}`;
    const score = this.#instanceScores.get(key);
    if (score == null) return null;
    return { score, confidence: confidence(score), ...topIssue(this.#contributions.get(key)) };
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
      const out = fitAndScoreLabels(store.labels, { config: makeQCConfig({ useGmm: false }) });
      this.#instanceScores = out.instanceScores;
      this.#contributions = out.contributions;
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
      // count flagged frames
      let flagged = 0;
      const frameKeys = new Set([...this.#frameScore.keys(), ...this.#frameResults.keys()]);
      for (const fk of frameKeys) {
        const s = this.#frameScore.get(fk) ?? 0;
        if (s >= this.threshold || hasFrameIssue(this.#frameResults.get(fk))) flagged++;
      }
      this.#flaggedFrames = flagged;
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
    this.#frameResults = new Map();
    this.#frameScore = new Map();
    this.#frameWorst = new Map();
    this.#flaggedFrames = 0;
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
