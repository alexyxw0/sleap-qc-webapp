// qcStore.svelte.js
//
// Runs the ported QC detection (deterministic path: features + frame-level checks +
// ZScore anomaly scoring — NOT the seed-unstable GMM) on the loaded labels, on demand,
// and exposes results for the UI (frame heat, frame issues, per-instance scores).

import { fitAndScoreLabels } from "./qc/checks/detector.js";
import { makeQCConfig } from "./qc/checks/config.js";
import { store } from "./labelsStore.svelte.js";

class QCStore {
  status = $state("idle"); // idle | running | done | error
  error = $state(null);
  threshold = $state(0.7);
  rev = $state(0); // bump when results change
  ranAtRev = -1; // store.rev at the time QC last ran (for staleness)

  #instanceScores = new Map(); // "v:f:i" -> score
  #frameResults = new Map(); // "v:f" -> FrameQC
  #frameScore = new Map(); // "v:f" -> max instance score
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
  /** Anomaly score for the instIdx-th instance of a navigable item, or null. */
  instanceScore(item, instIdx) {
    this.rev;
    if (!item) return null;
    return this.#instanceScores.get(`${this.#videoIdx(item.video)}:${item.frameIdx}:${instIdx}`) ?? null;
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
      this.#frameResults = out.frameResults;
      this.#frameScore = new Map();
      for (const [key, s] of out.instanceScores) {
        const fk = key.slice(0, key.lastIndexOf(":"));
        this.#frameScore.set(fk, Math.max(this.#frameScore.get(fk) ?? 0, s));
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
    this.#frameResults = new Map();
    this.#frameScore = new Map();
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
