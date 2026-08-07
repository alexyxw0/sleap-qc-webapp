// Registry of per-keypoint trained detectors — one SLOT per keypoint (nose, ear_l, tail_base, …), each an
// independent (embeddings + calibrated RBF-SVM) pair.
//
// WHY A FACADE: qcStore's APPEARANCE_CHECKS binds ONE store per check, and bundlePrefs/App.svelte call
// reset()/loadModelFromUrl() on it. Rather than teach all of them about a list, this object duck-types the
// same interface and AGGREGATES over the slots. The underlying NoseEmbeddingStore class is untouched, so
// per-slot behaviour (transfer pairing, few-shot adaptation, patch-size guard) keeps working unchanged.
//
// SHARED THRESHOLD: every slot emits a Platt-CALIBRATED fault probability, so the values are directly
// comparable across keypoints and one cutoff is meaningful. Frame score = max probability over all slots;
// attribution names the slot that produced it, which is what lets the reviewer see WHICH keypoint is wrong.
import { NoseEmbeddingStore, noseEmbedding } from "./noseEmbeddingStore.svelte.js";

let seq = 0;

class KeypointModels {
  rev = $state(0);
  threshold = $state(0.5); // shared cutoff over calibrated probabilities
  slots = $state([]);      // [{ id, store }] — slot 0 is the legacy singleton, so old flows keep working

  constructor() {
    this.slots = [{ id: ++seq, store: noseEmbedding }];
  }

  /** Reactive dependency on every slot's results (each store bumps its own resultRev). */
  get resultRev() {
    this.rev;
    let s = 0;
    for (const sl of this.slots) s += sl.store.resultRev;
    return s;
  }
  /** Slots that actually have scores — the ones that contribute. */
  get active() {
    this.resultRev;
    return this.slots.filter((s) => s.store.hasResults);
  }
  get hasResults() { return this.active.length > 0; }
  get count() {
    let n = 0;
    for (const s of this.active) n += s.store.count;
    return n;
  }
  /** Target keypoints currently loaded, e.g. ["nose", "ear_l"]. */
  get nodes() { return this.active.map((s) => s.store.node); }
  get node() { return this.nodes[0] ?? "nose"; } // legacy single-node callers

  addSlot() {
    this.slots = [...this.slots, { id: ++seq, store: new NoseEmbeddingStore() }];
    this.rev++;
    return this.slots[this.slots.length - 1];
  }
  removeSlot(id) {
    if (this.slots.length <= 1) { this.slots[0].store.reset(); this.rev++; return; } // keep one slot
    this.slots = this.slots.filter((s) => s.id !== id);
    this.rev++;
  }

  // ---- aggregate scoring: max calibrated probability across keypoints ----
  frameZByKey(key) {
    let best = null;
    for (const s of this.active) {
      const z = s.store.frameZByKey(key);
      if (z != null && (best == null || z > best)) best = z;
    }
    return best;
  }
  instProbByKey(key) {
    let best = null;
    for (const s of this.active) {
      const p = s.store.instProbByKey(key);
      if (p != null && (best == null || p > best)) best = p;
    }
    return best;
  }
  /** { node, prob } of the highest-scoring keypoint for one instance — the attribution the reviewer sees. */
  worstNodeAt(frameKey, instIdx) {
    let best = null;
    for (const s of this.active) {
      const p = s.store.instProbByKey(`${frameKey}:${instIdx}`);
      if (p != null && (best == null || p > best.prob)) best = { node: s.store.node, prob: p };
    }
    return best;
  }

  /**
   * ACTIVE-LEARNING QUEUE: (instance, keypoint) candidates ranked by the detectors' confidence that the
   * keypoint is wrong, highest first. Labelling from the top is the cheapest way to spend a small budget —
   * the model picks the cases most likely to BE faults, so a handful of labels buys far more signal than
   * labelling at random (offline: 10 target labels moved transfer PR 0.08 -> 0.29).
   *
   * `labelled` marks candidates already reviewed, so the caller can skip or show progress. The ranking is
   * recomputed on every call, so it RE-RANKS as labels arrive — later candidates reflect the adapted model.
   */
  candidates({ limit = 40, includeLabelled = false, isLabelled = null } = {}) {
    this.resultRev;
    const best = new Map(); // "v:f:i" -> { prob, node }
    for (const s of this.active) {
      const node = s.store.node;
      for (const [key, prob] of s.store.instProbEntries()) {
        const cur = best.get(key);
        if (!cur || prob > cur.prob) best.set(key, { prob, node });
      }
    }
    const out = [];
    for (const [key, { prob, node }] of best) {
      const [video, frameIdx, inst] = key.split(":").map(Number);
      const labelled = isLabelled ? !!isLabelled(video, frameIdx, inst, node) : false;
      if (labelled && !includeLabelled) continue;
      out.push({ key, video, frameIdx, inst, node, prob, labelled });
    }
    out.sort((a, b) => b.prob - a.prob);
    return out.slice(0, limit);
  }

  get flaggedFrameCount() { return this.flaggedFrameKeys().length; }
  flaggedFrameKeys() {
    const out = new Set();
    for (const s of this.active) {
      // each slot's own map, judged against the SHARED threshold (calibrated probabilities)
      for (const k of s.store.flaggedFrameKeysAt(this.threshold)) out.add(k);
    }
    return [...out];
  }
  get flaggedCount() {
    let n = 0;
    for (const s of this.active) n += s.store.flaggedCountAt(this.threshold);
    return n;
  }

  /** Status/message roll-up for the panel header. */
  get status() {
    if (this.slots.some((s) => s.store.status === "loading")) return "loading";
    if (this.slots.some((s) => s.store.status === "error")) return "error";
    return this.hasResults ? "done" : "idle";
  }
  get message() {
    const errs = this.slots.filter((s) => s.store.status === "error");
    if (errs.length) return errs[0].store.message;
    const a = this.active;
    if (!a.length) return "Load embeddings + a model to begin.";
    return `${a.length} keypoint${a.length === 1 ? "" : "s"} — ${a.map((s) => s.store.node).join(", ")} · `
      + `${this.flaggedFrameCount} frames flagged`;
  }
  /** Legacy single-slot info (NoseCheck renders per-slot detail itself). */
  get info() { return this.active[0]?.store.info ?? this.slots[0]?.store.info ?? null; }

  reset() {
    for (const s of this.slots) s.store.reset();
    this.slots = [this.slots[0]];
    this.rev++;
  }
  /** bundlePrefs compatibility: route a remembered served model to the first slot. */
  loadModelFromUrl(url) { return this.slots[0].store.loadModelFromUrl(url); }
}

export const keypointModels = new KeypointModels();
