// qcStore.svelte.js
//
// Runs the ported QC detection on demand and exposes results for the UI. Detection is split
// into selectable "units" — anomaly (ZScore), gmm (GaussianMixture probability), spatial
// (per-node Mahalanobis), and the frame-level checks (count / negative / duplicates). The
// user picks which to run in the sidebar; each unit's result is MEMOIZED, so re-selecting a
// previously-computed technique never recomputes. The flagged set is the UNION of the
// enabled (and computed) checks.

import {
  buildContext,
  computeAnomalyUnit,
  computeGmmUnit,
  computeSpatialUnit,
  computeFrameUnit,
} from "./qc/checks/detector.js";
import { makeQCConfig } from "./qc/checks/config.js";
import { topIssue, confidence } from "./qc/checks/explain.js";
import { store } from "./labelsStore.svelte.js";

// A user-facing check maps to a computable unit. count/negative/duplicates share one frame unit.
const UNIT_OF = {
  anomaly: "anomaly",
  gmm: "gmm",
  spatial: "spatial",
  count: "frame",
  negative: "frame",
  duplicates: "frame",
};

class QCStore {
  status = $state("idle"); // idle | running | done | error
  error = $state(null);
  threshold = $state(0.7); // anomaly (ZScore) flag
  gmmThreshold = $state(0.95); // GMM anomaly (1 − likelihood-percentile) flag — top ~5%
  spatialThreshold = $state(3.5); // worst-node Mahalanobis >= this => spatial outlier
  uncThreshold = $state(0.6); // (stable build: confidence channel absent; kept for the shared UI)
  rev = $state(0); // bump when results / selection change
  ranAtRev = -1; // store.rev at the time QC last ran (for staleness)

  // Which detection techniques to run / include. The flagged frames are the UNION of the
  // enabled-and-computed checks. GMM is off by default — it's the heaviest, opt-in technique.
  checks = $state({ anomaly: true, gmm: false, spatial: true, count: true, negative: true, duplicates: true });

  #ctx = null; // shared frame/pose/feature context for the current labels
  #ctxLabels = null; // identity of the labels #ctx was built for
  #computed = {}; // unit -> result maps (the memoization cache)

  // Derived per-frame maps (rebuilt from #computed after each run).
  #instanceScores = new Map(); // "v:f:i" -> anomaly score
  #contributions = new Map();
  #gmmScores = new Map(); // "v:f:i" -> GMM anomaly
  #nodeScores = new Map(); // "v:f:i" -> per-node Mahalanobis[]
  #worstNodes = new Map(); // "v:f:i" -> worst node index
  #frameResults = new Map(); // "v:f" -> FrameQC
  #frameAnom = new Map(); // "v:f" -> max anomaly score
  #frameGmm = new Map(); // "v:f" -> max GMM score
  #frameWorst = new Map(); // "v:f" -> worst instance index
  #spatialFlagged = new Set(); // "v:f" with worst-node Mahalanobis >= spatialThreshold

  get hasResults() {
    this.rev;
    return Object.keys(this.#computed).length > 0;
  }
  get stale() {
    this.rev;
    return this.hasResults && store.rev !== this.ranAtRev;
  }

  // ── selection / readiness ──
  /** Whether the unit backing a check has been computed (cached) for the current labels. */
  checkReady(name) {
    this.rev;
    return this.#computed[UNIT_OF[name]] != null;
  }
  /** An enabled check whose unit hasn't been computed yet (waiting on a Run QC). */
  checkPending(name) {
    this.rev;
    return this.checks[name] && !this.checkReady(name);
  }
  /** Number of enabled checks still needing computation. */
  get pendingCount() {
    this.rev;
    return Object.keys(this.checks).filter((n) => this.checkPending(n)).length;
  }
  toggleCheck(name) {
    if (name in this.checks) {
      this.checks[name] = !this.checks[name];
      this.rev++;
    }
  }

  /** Number of frames flagged by the UNION of the currently-enabled (and computed) checks. */
  get flaggedFrameCount() {
    this.rev;
    const c = this.checks;
    const u = new Set();
    if (c.anomaly) for (const [fk, s] of this.#frameAnom) if (s >= this.threshold) u.add(fk);
    if (c.gmm) for (const [fk, s] of this.#frameGmm) if (s >= this.gmmThreshold) u.add(fk);
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

  /** How many frames a single check flags (0 if its unit isn't computed). */
  checkCount(name) {
    this.rev;
    if (!this.checkReady(name)) return 0;
    if (name === "anomaly") {
      let n = 0;
      for (const s of this.#frameAnom.values()) if (s >= this.threshold) n++;
      return n;
    }
    if (name === "gmm") {
      let n = 0;
      for (const s of this.#frameGmm.values()) if (s >= this.gmmThreshold) n++;
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
  #fkey(item) {
    return `${this.#videoIdx(item.video)}:${item.frameIdx}`;
  }

  /** Per-frame heat: max over the enabled score-based checks (anomaly, gmm), or null. */
  frameScore(item) {
    this.rev;
    if (!item) return null;
    const fk = this.#fkey(item);
    let s = null;
    if (this.checks.anomaly) {
      const a = this.#frameAnom.get(fk);
      if (a != null) s = s == null ? a : Math.max(s, a);
    }
    if (this.checks.gmm) {
      const g = this.#frameGmm.get(fk);
      if (g != null) s = s == null ? g : Math.max(s, g);
    }
    return s;
  }
  /** Frame-level QC result, with disabled frame-checks suppressed (so hasFrameIssue respects toggles). */
  frameQC(item) {
    this.rev;
    if (!item) return null;
    const fq = this.#frameResults.get(this.#fkey(item));
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
    const fk = this.#fkey(item);
    const c = this.checks;
    if (c.anomaly) {
      const s = this.#frameAnom.get(fk);
      if (s != null && s >= this.threshold) return true;
    }
    if (c.gmm) {
      const s = this.#frameGmm.get(fk);
      if (s != null && s >= this.gmmThreshold) return true;
    }
    if (c.spatial && this.#spatialFlagged.has(fk)) return true;
    return hasFrameIssue(this.frameQC(item));
  }

  // --- confidence channel is absent in this build (inert) ---
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
    return this.#worstNodes.get(`${this.#fkey(item)}:${instIdx}`) ?? -1;
  }

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
  /** Anomaly score for an instance, or null. */
  instanceScore(item, instIdx) {
    this.rev;
    if (!item) return null;
    return this.#instanceScores.get(`${this.#fkey(item)}:${instIdx}`) ?? null;
  }
  /** { score, issue, feature, worstNode, worstNodeName, worstNodeDist } or null. */
  instanceIssue(item, instIdx) {
    this.rev;
    if (!item) return null;
    const key = `${this.#fkey(item)}:${instIdx}`;
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
  frameTopIssue(item) {
    this.rev;
    if (!item) return null;
    const worst = this.#frameWorst.get(this.#fkey(item));
    return worst == null ? null : this.instanceIssue(item, worst);
  }
  frameWorstInstance(item) {
    this.rev;
    if (!item) return -1;
    return this.#frameWorst.get(this.#fkey(item)) ?? -1;
  }

  /**
   * The faulty location to zoom to for an instance: the spatial worst node, plus an adjacent
   * node when that skeleton-edge neighbour is ALSO a spatial outlier (a faulty node-pair).
   */
  faultyTarget(item, instIdx) {
    this.rev;
    if (!item || !this.checks.spatial) return null;
    const key = `${this.#fkey(item)}:${instIdx}`;
    const wn = this.#worstNodes.get(key);
    if (wn == null || wn < 0) return null;
    const pts = item.lf?.instances?.[instIdx]?.points;
    const p0 = pts?.[wn]?.xy;
    if (!p0 || Number.isNaN(p0[0])) return null;

    const xs = [p0[0]];
    const ys = [p0[1]];
    const nodes = [wn];
    const ns = this.#nodeScores.get(key);
    const sk = store.skeleton;
    if (ns && sk) {
      let partner = -1;
      let bestM = this.spatialThreshold;
      for (const e of sk.edges ?? []) {
        const a = sk.index(e.source?.name ?? e.source);
        const b = sk.index(e.destination?.name ?? e.destination);
        const other = a === wn ? b : b === wn ? a : -1;
        if (other < 0) continue;
        const m = ns[other];
        if (m != null && !Number.isNaN(m) && m >= bestM) {
          bestM = m;
          partner = other;
        }
      }
      const p1 = partner >= 0 ? pts?.[partner]?.xy : null;
      if (p1 && !Number.isNaN(p1[0])) {
        nodes.push(partner);
        xs.push(p1[0]);
        ys.push(p1[1]);
      }
    }
    const minx = Math.min(...xs);
    const miny = Math.min(...ys);
    return { nodes, primary: wn, box: { x: minx, y: miny, w: Math.max(...xs) - minx, h: Math.max(...ys) - miny } };
  }

  #computeUnit(unit) {
    if (unit === "anomaly") return computeAnomalyUnit(this.#ctx);
    if (unit === "gmm") return computeGmmUnit(this.#ctx);
    if (unit === "spatial") return computeSpatialUnit(this.#ctx);
    if (unit === "frame") return computeFrameUnit(this.#ctx);
    return null;
  }

  // Rebuild the derived per-frame maps from whatever units are currently computed.
  #derive() {
    this.#instanceScores = this.#computed.anomaly?.instanceScores ?? new Map();
    this.#contributions = this.#computed.anomaly?.contributions ?? new Map();
    this.#gmmScores = this.#computed.gmm?.gmmScores ?? new Map();
    this.#nodeScores = this.#computed.spatial?.nodeScores ?? new Map();
    this.#worstNodes = this.#computed.spatial?.worstNodes ?? new Map();
    this.#frameResults = this.#computed.frame?.frameResults ?? new Map();

    const frameMax = (src, dst) => {
      dst.clear();
      for (const [key, s] of src) {
        const fk = key.slice(0, key.lastIndexOf(":"));
        if (s > (dst.get(fk) ?? -1)) dst.set(fk, s);
      }
    };
    this.#frameAnom = new Map();
    this.#frameGmm = new Map();
    frameMax(this.#instanceScores, this.#frameAnom);
    frameMax(this.#gmmScores, this.#frameGmm);

    // worst instance per frame — prefer anomaly, else GMM (for the verdict / zoom target)
    this.#frameWorst = new Map();
    const worstSrc = this.#instanceScores.size ? this.#instanceScores : this.#gmmScores;
    const best = new Map();
    for (const [key, s] of worstSrc) {
      const fk = key.slice(0, key.lastIndexOf(":"));
      if (s > (best.get(fk) ?? -1)) {
        best.set(fk, s);
        this.#frameWorst.set(fk, Number(key.slice(key.lastIndexOf(":") + 1)));
      }
    }

    this.#spatialFlagged = new Set();
    for (const [key, ns] of this.#nodeScores) {
      let m = -Infinity;
      for (const v of ns) if (!Number.isNaN(v) && v > m) m = v;
      if (m >= this.spatialThreshold) this.#spatialFlagged.add(key.slice(0, key.lastIndexOf(":")));
    }
  }

  /** Run the enabled checks that aren't already computed (incremental + memoized). */
  async run() {
    if (!store.labels || this.status === "running") return;
    this.status = "running";
    this.error = null;
    this.rev++;
    await new Promise((r) => setTimeout(r, 0)); // let "Running…" paint before the blocking compute
    try {
      if (store.labels !== this.#ctxLabels) {
        this.#ctx = buildContext(store.labels, makeQCConfig({ useGmm: false }));
        this.#ctxLabels = store.labels;
        this.#computed = {};
      }
      // compute the units the enabled checks need, skipping anything already cached
      const need = new Set();
      for (const [name, on] of Object.entries(this.checks)) if (on) need.add(UNIT_OF[name]);
      for (const unit of need) {
        if (!this.#computed[unit]) this.#computed[unit] = this.#computeUnit(unit);
      }
      this.#derive();
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
    this.#ctx = null;
    this.#ctxLabels = null;
    this.#computed = {};
    this.#derive();
    // NOTE: this.checks (the user's enabled-technique preferences) intentionally persist.
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
