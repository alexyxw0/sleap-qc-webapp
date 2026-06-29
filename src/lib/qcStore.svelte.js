// qcStore.svelte.js
//
// Runs the ported QC detection on demand and exposes results for the UI. Detection is split
// into selectable "units" — anomaly (ZScore), gmm (GaussianMixture probability), chirality,
// and the frame-level checks (count / negative / duplicates). The user picks which to run in
// the sidebar; each unit's result is MEMOIZED, so re-selecting a previously-computed technique
// never recomputes. The flagged set is the UNION of the enabled (and computed) checks.
// (Pose-split / chimera is NOT a standalone check — it's the `pose_split_score` feature folded
// into the anomaly/GMM vector, so it surfaces through those scores like the desktop GUI.)

import {
  buildContext,
  ensureFeatures,
  computeAnomalyUnit,
  computeGmmUnit,
  computeFrameUnit,
  computeChiralityUnit,
  chiralityScoreOne,
  computeOrderingUnit,
  orderingScoreOne,
  computePoseSplitUnit,
  poseSplitScoreOne,
} from "./qc/checks/detector.js";
import { makeQCConfig } from "./qc/checks/config.js";
import { topIssue, confidence, withDirection, DIRECTIONAL_FEATURES, issueForFeature } from "./qc/checks/explain.js";
import { visibilityMask } from "./qc/checks/util.js";
import { qcResultsCsv } from "./qc/csv.js";
import { store } from "./labelsStore.svelte.js";

// A user-facing check maps to a computable unit. count/negative/duplicates share one frame unit.
const UNIT_OF = {
  anomaly: "anomaly",
  gmm: "gmm",
  chirality: "chirality",
  ordering: "ordering",
  poseSplit: "poseSplit",
  count: "frame",
  sparse: "frame",
  confidence: "frame",
  instConfidence: "frame",
  negative: "frame",
  duplicates: "frame",
};

// Friendly labels for the run-timing breakdown (which compute step each unit corresponds to).
const UNIT_LABEL = {
  context: "Context + poses",
  features: "Feature vector",
  anomaly: "Anomaly",
  gmm: "GMM (EM fit)",
  chirality: "Chirality",
  ordering: "Chain ordering",
  poseSplit: "Split pose",
  frame: "Frame checks",
  derive: "Aggregate",
};

// Wait for the browser to actually PAINT before resuming. A step's compute is synchronous and seizes
// the main thread, so its "running" state must paint first — and setTimeout(0) does NOT guarantee a
// paint (the macrotask can run before the next render), which left the progress bar stuck on long
// runs. Two rAFs straddle a render opportunity; fall back to setTimeout off the main thread (tests).
const nextPaint = () =>
  new Promise((resolve) => {
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    else setTimeout(resolve, 0);
  });

// Frame-level checks are binary (flag / no flag), so they carry no score of their own. To rank
// them sensibly in review mode (worst-first), each gets a fixed SEVERITY in [0,1] — a wrong
// instance count or a barely-localized instance is the most concerning; a stray duplicate or a
// negative frame with instances is the least. Used as the flag-confidence contribution.
const FRAME_SEVERITY = {
  count: 0.9, // missing / extra animal
  sparse: 0.85, // an instance localized by too few visible nodes
  confidence: 0.6, // a weak predicted keypoint
  instConfidence: 0.62, // a low-confidence instance (whole-instance uncertainty)
  negative: 0.45, // a negative frame that still has instances
  duplicates: 0.4, // overlapping / duplicated instances
};

class QCStore {
  status = $state("idle"); // idle | running | done | error
  error = $state(null);
  threshold = $state(0.7); // anomaly (ZScore) flag
  gmmThreshold = $state(0.95); // GMM anomaly (1 − likelihood-percentile) flag — top ~5%
  chiralityThreshold = $state(0.5); // L/R-flip flag ([0,1] wrong-side fraction; hard rule forces >=0.9)
  orderingThreshold = $state(0.3); // chain-ordering flag (combined: a crossing -> 1.0, else order_inversion_rate)
  poseSplitThreshold = $state(0.5); // chimera flag: saturating split score (raw split 1.0 -> 0.5)
  sparseFraction = $state(0.5); // "sparse instance" cutoff as a fraction of the dataset's average visible-node count
  confidenceThreshold = $state(0.3); // flag a predicted instance whose keypoint confidence scores below this
  confidenceMode = $state("avg"); // keypoint-confidence mode: "avg" (mean over visible keypoints, default) or "min" (weakest visible keypoint)
  instConfidenceThreshold = $state(0.3); // flag a predicted instance whose instance-level score is below this
  baselineSource = $state("all"); // outlier reference: "all" labeled instances, or "user"-annotated only
  reviewOrder = $state("severity"); // review-mode frame order: "severity" | "detectors" | "frame"
  rev = $state(0); // bump when results / selection change
  ranAtRev = -1; // store.rev at the time QC last ran (for staleness)

  // Which detection techniques to run / include. The flagged frames are the UNION of the
  // enabled-and-computed checks. Defaults ON: anomaly, chirality, gmm, duplicates. The frame /
  // structural checks (sparse, confidence, negative) default OFF — enable them as needed. count is on.
  checks = $state({ anomaly: true, gmm: true, chirality: true, ordering: false, poseSplit: true, count: true, sparse: false, confidence: false, instConfidence: false, negative: false, duplicates: true });

  // User-built per-feature checks: drag a feature out of the GMM/anomaly vector to flag instances
  // where THAT single feature is an outlier (|z| >= its threshold). Each: { id, feature, threshold, on }.
  // They reuse the Anomaly unit's ZScore fit (means/stds) + per-instance contributions.
  featureChecks = $state([]);

  #ctx = null; // shared frame/pose/feature context for the current labels
  #ctxLabels = null; // identity of the labels #ctx was built for
  #ctxRev = -1; // store.rev the #ctx was built at — bumps when instances are edited in place
  #ctxBaselineSource = "all"; // baselineSource the #ctx was fit with (rebuild on change)
  #avgVisKey = null; // #ctx the cached average visible-node count was computed for
  #avgVisCache = 0; // memoized mean per-instance visible-node count
  #computed = {}; // unit -> result maps (the memoization cache)
  #featureSeq = 0; // id counter for user feature-checks
  #progress = null; // { steps: [{ key, label, status, ms }], done, total } — live during run, kept after

  // Derived per-frame maps (rebuilt from #computed after each run).
  #instanceScores = new Map(); // "v:f:i" -> anomaly score
  #contributions = new Map();
  #gmmScores = new Map(); // "v:f:i" -> GMM anomaly
  #frameResults = new Map(); // "v:f" -> FrameQC
  #instFeatureZ = new Map(); // "v:f:i" -> { feature: |z| } for active feature-checks
  #frameFeatureZ = new Map(); // "v:f" -> { feature: max|z| over instances } for active feature-checks
  #frameAnom = new Map(); // "v:f" -> max anomaly score
  #frameGmm = new Map(); // "v:f" -> max GMM score
  #gmmWorst = new Map(); // "v:f:i" -> GMM leave-one-out worst node (computed lazily)
  #gmmWorstFeat = new Map(); // "v:f:i" -> GMM most-improbable feature NAME (computed lazily)
  #anomalyAttr = new Map(); // "v:f:i" -> { node, dir, feature } for the anomaly's dominant feature (lazy)
  #chiralityScores = new Map(); // "v:f:i" -> L/R-flip [0,1] score
  #chiralityWorst = new Map(); // "v:f:i" -> a node from a wrong pair, -1 if none
  #frameChir = new Map(); // "v:f" -> max chirality score
  #orderingScores = new Map(); // "v:f:i" -> chain-ordering [0,1] combined score
  #orderingWorst = new Map(); // "v:f:i" -> the out-of-order interior node, -1 if none
  #orderInversion = new Map(); // "v:f:i" -> raw order_inversion_rate (for CSV)
  #chainIntersection = new Map(); // "v:f:i" -> raw chain_intersection_count (for CSV)
  #frameOrdering = new Map(); // "v:f" -> max ordering score
  #poseSplitScores = new Map(); // "v:f:i" -> chimera split score [0,1]
  #poseSplitWorst = new Map(); // "v:f:i" -> a bridge-edge node, -1 if none
  #framePoseSplit = new Map(); // "v:f" -> max split score

  get hasResults() {
    this.rev;
    return Object.keys(this.#computed).length > 0;
  }
  /** Whether the loaded labels contain any predicted instances (enables the confidence check). */
  get hasPredictions() {
    this.rev;
    return this.#ctx?.hasPredictions ?? false;
  }
  /** Mean per-instance visible-node count (non-NaN coords) across the dataset, memoized on the ctx. */
  get avgVisibleNodes() {
    this.rev;
    const poses = this.#ctx?.allPoses;
    if (!poses?.length) return 0;
    if (this.#avgVisKey === this.#ctx) return this.#avgVisCache;
    let sum = 0;
    for (const pose of poses) for (const xy of pose) if (!Number.isNaN(xy?.[0])) sum++;
    this.#avgVisKey = this.#ctx;
    this.#avgVisCache = sum / poses.length;
    return this.#avgVisCache;
  }
  /** "Sparse instance" cutoff, derived from the data: `sparseFraction` × the average visible-node count
   *  (min 1). Falls back to 2 before a context exists. Read live by every sparse check + the slider. */
  get sparseThreshold() {
    const avg = this.avgVisibleNodes;
    return avg > 0 ? Math.max(1, Math.round(avg * this.sparseFraction)) : 2;
  }
  /** The frame's keypoint-confidence value for the active mode: weakest ("min") or mean ("avg"). */
  #kpConf(fq) {
    return this.confidenceMode === "avg" ? fq.avgPointScore : fq.minPointScore;
  }
  /** Whether the loaded labels contain any user-annotated instances (for the baseline-source choice). */
  get hasUserInstances() {
    this.rev;
    return this.#ctx?.userMask?.some(Boolean) ?? false;
  }
  /** Switch the outlier baseline source ("all" | "user") and re-fit/recompute if QC has run. */
  setBaselineSource(src) {
    if (src === this.baselineSource) return;
    this.baselineSource = src;
    this.rev++;
    if (this.status === "done") this.run(); // run() rebuilds the context against the new reference
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
    return Object.keys(this.checks).filter((n) => this.checkPending(n)).length
      + (this.featureCheckActive && !this.checkReady("anomaly") ? 1 : 0);
  }

  /** Per-step run timing (live while running, retained after) — drives the progress bar + breakdown. */
  get runProgress() {
    this.rev;
    // Return a FRESH copy (incl. fresh step objects) each call. #progress is mutated in place behind
    // a stable reference, and Svelte 5 deriveds short-circuit on ===, so the timing panel's
    // {@const totalMs = …reduce} (and the per-step {s.ms}) would freeze at the initial all-0 state —
    // showing "0 ms" forever. A new object/array each rev makes the derived + each re-evaluate.
    const p = this.#progress;
    return p ? { done: p.done, total: p.total, steps: p.steps.map((s) => ({ ...s, sub: s.sub ? s.sub.map((x) => ({ ...x })) : undefined })) } : null;
  }
  toggleCheck(name) {
    if (name in this.checks) {
      this.checks[name] = !this.checks[name];
      this.rev++;
    }
  }

  /** Enable/disable a set of checks at once (a category toggle) — one rev bump => one re-run. */
  setChecks(names, value) {
    for (const n of names) if (n in this.checks) this.checks[n] = value;
    this.rev++;
  }

  // --- per-feature checks (drag a feature out of the GMM/anomaly vector as its own check) ---
  /** true if any user feature-check is enabled — then the Anomaly unit must be computed for its z's. */
  get featureCheckActive() {
    this.rev;
    return this.featureChecks.some((f) => f.on);
  }
  addFeatureCheck(feature) {
    if (!feature || this.featureChecks.some((f) => f.feature === feature)) return; // one check per feature
    this.featureChecks.push({ id: ++this.#featureSeq, feature, threshold: 3.0, on: true });
    this.#refreshFeatureChecks();
  }
  removeFeatureCheck(id) {
    this.featureChecks = this.featureChecks.filter((f) => f.id !== id);
    this.#refreshFeatureChecks();
  }
  toggleFeatureCheck(id) {
    const f = this.featureChecks.find((x) => x.id === id);
    if (f) { f.on = !f.on; this.#refreshFeatureChecks(); }
  }
  /** Right-click "solo": enable ONLY these built-in checks; disable every other check + feature check. */
  soloChecks(names) {
    const keep = new Set(names);
    for (const k of Object.keys(this.checks)) this.checks[k] = keep.has(k);
    let featOff = false;
    for (const f of this.featureChecks) if (f.on) { f.on = false; featOff = true; }
    this.rev++;
    if (featOff) this.#refreshFeatureChecks();
  }
  /** Right-click "solo" a custom feature check: enable ONLY it; disable every built-in + other feature check. */
  soloFeatureCheck(id) {
    for (const k of Object.keys(this.checks)) this.checks[k] = false;
    for (const f of this.featureChecks) f.on = f.id === id;
    this.rev++;
    this.#refreshFeatureChecks();
  }
  setFeatureThreshold(id, v) {
    const f = this.featureChecks.find((x) => x.id === id);
    if (f) { f.threshold = v; this.rev++; } // a threshold change doesn't move |z| -> no re-derive
  }
  #refreshFeatureChecks() {
    this.rev++;
    if (this.checkReady("anomaly")) { this.#deriveFeatureChecks(); this.rev++; }
    else if (this.status === "done") this.run(); // anomaly unit absent -> run() will add + compute it
  }
  /** Frames flagged by a single feature-check, for its UI count. */
  featureCheckCount(id) {
    this.rev;
    const f = this.featureChecks.find((x) => x.id === id);
    if (!f || !f.on) return 0;
    let n = 0;
    for (const fm of this.#frameFeatureZ.values()) if ((fm[f.feature] ?? -1) >= f.threshold) n++;
    return n;
  }
  /** Recompute the per-instance / per-frame |z| maps for the ACTIVE feature-checks (reuses the
   *  Anomaly det's means/stds + raw contributions). Re-run on add/remove/toggle, NOT on threshold. */
  #deriveFeatureChecks() {
    this.#instFeatureZ = new Map();
    this.#frameFeatureZ = new Map();
    const a = this.#computed.anomaly;
    const feats = [...new Set(this.featureChecks.filter((f) => f.on).map((f) => f.feature))];
    if (!a?.det || !a.featureNames || !feats.length) return;
    const fIdx = new Map(feats.map((f) => [f, a.featureNames.indexOf(f)]));
    for (const [key, c] of this.#contributions) {
      const fk = key.slice(0, key.lastIndexOf(":"));
      const zs = {};
      for (const feature of feats) {
        const j = fIdx.get(feature);
        if (j < 0) continue;
        const raw = c[feature];
        if (raw == null || !Number.isFinite(raw)) continue;
        const z = Math.abs((raw - a.det.means[j]) / (a.det.stds[j] || 1e-6));
        zs[feature] = z;
        const fm = this.#frameFeatureZ.get(fk) ?? {};
        if (z > (fm[feature] ?? -1)) { fm[feature] = z; this.#frameFeatureZ.set(fk, fm); }
      }
      this.#instFeatureZ.set(key, zs);
    }
  }

  /** Number of frames flagged by the UNION of the currently-enabled (and computed) checks. */
  get flaggedFrameCount() {
    this.rev;
    const c = this.checks;
    const u = new Set();
    if (c.anomaly) for (const [fk, s] of this.#frameAnom) if (s >= this.threshold) u.add(fk);
    if (c.gmm) for (const [fk, s] of this.#frameGmm) if (s >= this.gmmThreshold) u.add(fk);
    if (c.chirality) for (const [fk, s] of this.#frameChir) if (s >= this.chiralityThreshold) u.add(fk);
    if (c.ordering) for (const [fk, s] of this.#frameOrdering) if (s >= this.orderingThreshold) u.add(fk);
    if (c.poseSplit) for (const [fk, s] of this.#framePoseSplit) if (s >= this.poseSplitThreshold) u.add(fk);
    for (const f of this.featureChecks) if (f.on) for (const [fk, fm] of this.#frameFeatureZ) if ((fm[f.feature] ?? -1) >= f.threshold) u.add(fk);
    for (const [fk, fq] of this.#frameResults) {
      if (
        (c.count && fq.isWrongCount) ||
        (c.sparse && fq.minVisibleNodeCount < this.sparseThreshold) ||
        (c.confidence && this.#kpConf(fq) < this.confidenceThreshold) ||
        (c.instConfidence && fq.minInstScore < this.instConfidenceThreshold) ||
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
    if (name === "chirality") {
      let n = 0;
      for (const s of this.#frameChir.values()) if (s >= this.chiralityThreshold) n++;
      return n;
    }
    if (name === "ordering") {
      let n = 0;
      for (const s of this.#frameOrdering.values()) if (s >= this.orderingThreshold) n++;
      return n;
    }
    if (name === "poseSplit") {
      let n = 0;
      for (const s of this.#framePoseSplit.values()) if (s >= this.poseSplitThreshold) n++;
      return n;
    }
    let n = 0;
    for (const fq of this.#frameResults.values()) {
      if (
        (name === "count" && fq.isWrongCount) ||
        (name === "sparse" && fq.minVisibleNodeCount < this.sparseThreshold) ||
        (name === "confidence" && this.#kpConf(fq) < this.confidenceThreshold) ||
        (name === "instConfidence" && fq.minInstScore < this.instConfidenceThreshold) ||
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
    // Threshold-aware: only a score that actually CLEARS its check's threshold contributes, so the
    // heat chip / grid / timeline never read "high" on a frame the verdict calls "looks ok"
    // (e.g. a GMM score of 0.94 sitting just under the 0.95 GMM threshold).
    if (this.checks.anomaly) {
      const a = this.#frameAnom.get(fk);
      if (a != null && a >= this.threshold) s = s == null ? a : Math.max(s, a);
    }
    if (this.checks.gmm) {
      const g = this.#frameGmm.get(fk);
      if (g != null && g >= this.gmmThreshold) s = s == null ? g : Math.max(s, g);
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
      isOvercount: c.count ? fq.isOvercount : false,
      isWrongCount: c.count ? fq.isWrongCount : false,
      isEmpty: c.count ? fq.isEmpty : false,
      isSparse: c.sparse ? fq.minVisibleNodeCount < this.sparseThreshold : false,
      isLowConf: c.confidence ? this.#kpConf(fq) < this.confidenceThreshold : false,
      isLowInstConf: c.instConfidence ? fq.minInstScore < this.instConfidenceThreshold : false,
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
    if (c.chirality) {
      const s = this.#frameChir.get(fk);
      if (s != null && s >= this.chiralityThreshold) return true;
    }
    if (c.ordering) {
      const s = this.#frameOrdering.get(fk);
      if (s != null && s >= this.orderingThreshold) return true;
    }
    if (c.poseSplit) {
      const s = this.#framePoseSplit.get(fk);
      if (s != null && s >= this.poseSplitThreshold) return true;
    }
    const fm = this.#frameFeatureZ.get(fk);
    if (fm) for (const f of this.featureChecks) if (f.on && (fm[f.feature] ?? -1) >= f.threshold) return true;
    return hasFrameIssue(this.frameQC(item));
  }

  /**
   * Every ENABLED check currently flagging this frame, as `{ key, label, score }` (score is
   * null for the boolean frame checks). Same union logic as frameFlagged, but it names which
   * detectors agree so the sidebar can show "what's flagging this frame" at a glance.
   */
  frameFlaggingChecks(item) {
    this.rev;
    if (!item) return [];
    const fk = this.#fkey(item);
    const c = this.checks;
    const out = [];
    const score = (on, map, thr, key, label) => {
      if (!on) return;
      const s = map.get(fk);
      if (s != null && s >= thr) out.push({ key, label, score: s });
    };
    score(c.chirality, this.#frameChir, this.chiralityThreshold, "chirality", "L/R flip");
    score(c.ordering, this.#frameOrdering, this.orderingThreshold, "ordering", "Out of order");
    score(c.poseSplit, this.#framePoseSplit, this.poseSplitThreshold, "poseSplit", "Split pose");
    score(c.anomaly, this.#frameAnom, this.threshold, "anomaly", "Anomaly");
    score(c.gmm, this.#frameGmm, this.gmmThreshold, "gmm", "GMM");
    for (const f of this.featureChecks) {
      if (!f.on) continue;
      const z = this.#frameFeatureZ.get(fk)?.[f.feature];
      if (z != null && z >= f.threshold) out.push({ key: `feat:${f.id}`, label: f.feature.replace(/_zscore$/, ""), score: z });
    }
    const fq = this.#frameResults.get(fk);
    if (fq) {
      if (c.count && fq.isWrongCount) out.push({ key: "count", label: fq.isEmpty ? "Empty frame" : fq.isOvercount ? "Extra instance" : "Missing instance", score: null });
      if (c.sparse && fq.minVisibleNodeCount < this.sparseThreshold) out.push({ key: "sparse", label: `Sparse instance (${fq.minVisibleNodeCount} node${fq.minVisibleNodeCount === 1 ? "" : "s"})`, score: null });
      if (c.confidence && this.#kpConf(fq) < this.confidenceThreshold) {
        const avg = this.confidenceMode === "avg";
        const nm = !avg && fq.lowConfNode >= 0 ? store.skeleton?.nodeNames?.[fq.lowConfNode] ?? `node ${fq.lowConfNode}` : "";
        out.push({ key: "confidence", label: `Low ${avg ? "avg" : "keypoint"} conf${nm ? ` · ${nm}` : ""}`, score: this.#kpConf(fq) });
      }
      if (c.instConfidence && fq.minInstScore < this.instConfidenceThreshold) out.push({ key: "instConfidence", label: "Low instance conf", score: fq.minInstScore });
      if (c.negative && fq.isNegativeWithInstances) out.push({ key: "negative", label: "Negative", score: null });
      if (c.duplicates && (fq.duplicatePairs?.length ?? 0) > 0) out.push({ key: "duplicates", label: "Duplicate", score: null });
    }
    return out;
  }

  // --- confidence channel is absent in this build (inert) ---
  /** GMM probability anomaly for an instance, or null. */
  gmmScore(item, instIdx) {
    this.rev;
    if (!item) return null;
    return this.#gmmScores.get(`${this.#fkey(item)}:${instIdx}`) ?? null;
  }
  /** Is this instance flagged by any enabled score-based check (anomaly OR GMM)? */
  instanceFlagged(item, instIdx) {
    this.rev;
    if (!item) return false;
    const key = `${this.#fkey(item)}:${instIdx}`;
    if (this.checks.anomaly) {
      const a = this.#instanceScores.get(key);
      if (a != null && a >= this.threshold) return true;
    }
    if (this.checks.gmm) {
      const g = this.#gmmScores.get(key);
      if (g != null && g >= this.gmmThreshold) return true;
    }
    if (this.checks.chirality) {
      const s = this.#chiralityScores.get(key);
      if (s != null && s >= this.chiralityThreshold) return true;
    }
    if (this.checks.ordering) {
      const s = this.#orderingScores.get(key);
      if (s != null && s >= this.orderingThreshold) return true;
    }
    if (this.checks.poseSplit) {
      const s = this.#poseSplitScores.get(key);
      if (s != null && s >= this.poseSplitThreshold) return true;
    }
    const zs = this.#instFeatureZ.get(key);
    if (zs) for (const f of this.featureChecks) if (f.on && (zs[f.feature] ?? -1) >= f.threshold) return true;
    return false;
  }

  /** Per-detector flagged-FRAME sets over EVERY enabled check (instance-level reduced to frames +
   *  the frame-level checks + custom feature checks) for the overlap viz. Reuses frameFlaggingChecks
   *  so any newly-enabled check shows up automatically. { total, sets:[{ id, label, set:Set<frame> }] }. */
  detectorSets() {
    this.rev;
    const frames = store.frames ?? [];
    const LABEL = { anomaly: "Anomaly", gmm: "GMM", chirality: "Chirality", ordering: "Ordering", poseSplit: "Pose split", count: "Count", sparse: "Sparse", confidence: "Confidence", instConfidence: "Inst conf", negative: "Negative", duplicates: "Duplicates" };
    const ORDER = ["anomaly", "gmm", "chirality", "ordering", "poseSplit", "count", "sparse", "confidence", "instConfidence", "negative", "duplicates"];
    const byKey = new Map();
    for (let i = 0; i < frames.length; i++) {
      for (const f of this.frameFlaggingChecks(frames[i])) {
        let e = byKey.get(f.key);
        if (!e) {
          e = { id: f.key, label: f.key.startsWith("feat:") ? f.label : LABEL[f.key] ?? f.key, set: new Set() };
          byKey.set(f.key, e);
        }
        e.set.add(i);
      }
    }
    const sets = [...byKey.values()].sort((a, b) => (ORDER.indexOf(a.id) + 1 || 99) - (ORDER.indexOf(b.id) + 1 || 99));
    return { total: frames.length, sets };
  }

  /** Per-instance boolean array: is each instance flagged by ANY enabled check (instance- AND the
   *  per-instance-attributable frame-level checks)? Used to draw a bbox around flagged instances. */
  frameFlaggedInstances(item) {
    this.rev;
    const lf = item?.lf;
    if (!lf) return [];
    const n = lf.instances.length;
    const out = new Array(n).fill(false);
    for (let i = 0; i < n; i++) if (this.instanceFlagged(item, i)) out[i] = true; // anomaly/gmm/chirality/ordering/poseSplit
    const fq = this.#frameResults.get(this.#fkey(item));
    if (fq) {
      const c = this.checks;
      const mark = (i) => { if (i >= 0 && i < n) out[i] = true; };
      if (c.sparse && fq.minVisibleNodeCount < this.sparseThreshold) mark(fq.sparsestInstance);
      if (c.confidence && this.#kpConf(fq) < this.confidenceThreshold) mark(this.confidenceMode === "avg" ? fq.avgConfInstance : fq.lowConfInstance);
      if (c.instConfidence && fq.minInstScore < this.instConfidenceThreshold) mark(fq.lowInstance);
      if (c.negative && fq.isNegativeWithInstances) out.fill(true); // a negative frame: every instance is spurious
      if (c.duplicates) for (const d of fq.duplicatePairs ?? []) { mark(d.indexA); mark(d.indexB); }
      // count (wrong total) has no per-instance attribution -> not boxed
    }
    return out;
  }
  #gmmFlagged(key) {
    if (!this.checks.gmm) return false;
    const g = this.#gmmScores.get(key);
    return g != null && g >= this.gmmThreshold;
  }
  /**
   * Which node the GMM thinks is wrong: leave-one-node-out attribution — the node whose
   * removal most raises the instance's mixture log-likelihood. Computed lazily for the
   * current frame's instances only (a handful per frame), then cached. -1 if none stands out.
   */
  gmmWorstNode(item, instIdx) {
    this.rev;
    if (!item || !this.checks.gmm) return -1;
    const det = this.#computed.gmm?.det;
    const fx = this.#computed.gmm?.fx;
    if (!det || !fx) return -1;
    const key = `${this.#fkey(item)}:${instIdx}`;
    if (this.#gmmWorst.has(key)) return this.#gmmWorst.get(key);
    const inst = item.lf?.instances?.[instIdx];
    const pose = inst?.numpy?.({ invisibleAsNaN: true });
    if (!pose) {
      this.#gmmWorst.set(key, -1);
      return -1;
    }
    const clean = (row) => row.map((f) => (Number.isNaN(f) ? 0 : f === Infinity ? 10 : f === -Infinity ? -10 : f));
    // reuse the instance's NN distance across all masks (it is not node-specific) so each
    // leave-one-out only re-runs the cheap per-node features, not the O(n) NN search.
    const baseNN = fx.nn.score(pose).nnDistance;
    const baseLL = det.logLikelihoodOne(clean(fx.extractFeatures(pose, baseNN)));
    let worst = -1;
    let bestImprove = 1e-6; // require a meaningful improvement to claim a node
    for (let k = 0; k < pose.length; k++) {
      if (Number.isNaN(pose[k]?.[0])) continue; // already invisible — nothing to remove
      const masked = pose.map((p, idx) => (idx === k ? [Number.NaN, Number.NaN] : p));
      const ll = det.logLikelihoodOne(clean(fx.extractFeatures(masked, baseNN)));
      const improve = ll - baseLL;
      if (improve > bestImprove) {
        bestImprove = improve;
        worst = k;
      }
    }
    this.#gmmWorst.set(key, worst);
    return worst;
  }
  /**
   * Which FEATURE the GMM finds most improbable for an instance — the feature with the largest
   * contribution to the Mahalanobis distance under the most-responsible component (`det.worstFeature`).
   * Re-extracts the vector from the pose (so it works even when only GMM is enabled). Lazy + cached.
   * Returns the feature name, or null.
   */
  gmmWorstFeature(item, instIdx) {
    this.rev;
    if (!item || !this.checks.gmm) return null;
    const det = this.#computed.gmm?.det;
    const fx = this.#computed.gmm?.fx;
    if (!det || !fx) return null;
    const key = `${this.#fkey(item)}:${instIdx}`;
    if (this.#gmmWorstFeat.has(key)) return this.#gmmWorstFeat.get(key);
    const pose = item.lf?.instances?.[instIdx]?.numpy?.({ invisibleAsNaN: true });
    let name = null;
    if (pose) {
      const clean = (row) => row.map((f) => (Number.isNaN(f) ? 0 : f === Infinity ? 10 : f === -Infinity ? -10 : f));
      const w = det.worstFeature(clean(fx.extractFeatures(pose)));
      name = w.index >= 0 ? fx.featureNames[w.index] ?? null : null;
    }
    this.#gmmWorstFeat.set(key, name);
    return name;
  }
  /**
   * Which node the geometric anomaly (ZScore) verdict is about: the culprit node/edge of its
   * dominant feature (`topIssue`) — e.g. the isolated invisible node, the far "isolated" node,
   * the most length-deviant edge. Lazy + cached per instance. Returns -1 when the winning
   * feature is a whole-instance one (mean_*, bbox/hull/nn, visibility_rate) with no single node.
   */
  anomalyWorstNode(item, instIdx) {
    this.rev;
    return this.#anomalyAttribution(item, instIdx).node;
  }
  /**
   * Resolve the anomaly's dominant feature (`topIssue`) to `{ node, dir, feature }` — the
   * culprit node and the signed direction (+1 increased / -1 decreased vs the learned mean,
   * 0 when not directional). Lazy + cached per instance. `node` is -1 for whole-instance
   * features (area z-scores still carry a `dir` for the verbal verdict, just no node).
   */
  #anomalyAttribution(item, instIdx) {
    const empty = { node: -1, dir: 0, feature: null };
    if (!item || !this.checks.anomaly) return empty;
    const key = `${this.#fkey(item)}:${instIdx}`;
    if (this.#anomalyAttr.has(key)) return this.#anomalyAttr.get(key);
    let res = empty;
    const fx = this.#computed.anomaly?.fx;
    const contributions = this.#contributions.get(key);
    if (fx?.baseline && contributions) {
      const { feature } = topIssue(contributions);
      const pose = item.lf?.instances?.[instIdx]?.numpy?.({ invisibleAsNaN: true });
      if (feature && pose) {
        if (feature === "visibility_pattern_score") {
          // lives on the co-visibility model, not the baseline extractor
          res = { node: fx.visibility?.worstNode(visibilityMask(pose)) ?? -1, dir: 0, feature };
        } else if (feature === "bbox_area_zscore" || feature === "hull_area_zscore") {
          // whole-instance, but the contribution is a signed z -> a direction with no node
          res = { node: -1, dir: Math.sign(contributions[feature] ?? 0), feature };
        } else {
          const a = fx.baseline.attribute(pose)[feature];
          res = { node: a?.nodes?.[0] ?? -1, dir: a?.dir ?? 0, feature };
        }
      }
    }
    this.#anomalyAttr.set(key, res);
    return res;
  }
  /**
   * The single node to indicate for a flagged instance (drives the red ring + zoom):
   * chirality's wrong-pair node, else the anomaly's dominant-feature culprit node, else the
   * GMM's own leave-one-out node.
   */
  faultyNodeFor(item, instIdx) {
    this.rev;
    if (!item) return -1;
    const key = `${this.#fkey(item)}:${instIdx}`;
    if (this.checks.chirality) {
      const s = this.#chiralityScores.get(key);
      if (s != null && s >= this.chiralityThreshold) {
        const n = this.#chiralityWorst.get(key) ?? -1;
        if (n >= 0) return n;
      }
    }
    if (this.checks.ordering) {
      const s = this.#orderingScores.get(key);
      if (s != null && s >= this.orderingThreshold) {
        const n = this.#orderingWorst.get(key) ?? -1;
        if (n >= 0) return n;
      }
    }
    if (this.checks.poseSplit) {
      const s = this.#poseSplitScores.get(key);
      if (s != null && s >= this.poseSplitThreshold) {
        const n = this.#poseSplitWorst.get(key) ?? -1;
        if (n >= 0) return n;
      }
    }
    if (this.checks.anomaly) {
      const a = this.#instanceScores.get(key);
      if (a != null && a >= this.threshold) {
        const n = this.anomalyWorstNode(item, instIdx);
        if (n >= 0) return n;
      }
    }
    if (this.#gmmFlagged(key)) return this.gmmWorstNode(item, instIdx);
    return -1;
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

  /**
   * Worst flagging confidence in `[0,1]` for a frame — the max over the enabled checks that
   * flag it (anomaly / gmm / chirality scores; the boolean frame checks count/negative/
   * duplicates contribute 1.0 since a structural issue is certain). `null` if not flagged.
   * This is the score the QC-review popup orders flagged frames by (worst-first).
   */
  flagConfidence(item) {
    this.rev;
    if (!item) return null;
    const fk = this.#fkey(item);
    const c = this.checks;
    let best = null;
    const bump = (v) => { if (v != null && (best == null || v > best)) best = v; };
    if (c.anomaly) { const s = this.#frameAnom.get(fk); if (s != null && s >= this.threshold) bump(s); }
    if (c.gmm) { const s = this.#frameGmm.get(fk); if (s != null && s >= this.gmmThreshold) bump(s); }
    if (c.chirality) { const s = this.#frameChir.get(fk); if (s != null && s >= this.chiralityThreshold) bump(s); }
    if (c.ordering) { const s = this.#frameOrdering.get(fk); if (s != null && s >= this.orderingThreshold) bump(s); }
    if (c.poseSplit) { const s = this.#framePoseSplit.get(fk); if (s != null && s >= this.poseSplitThreshold) bump(s); }
    for (const f of this.featureChecks) {
      if (!f.on) continue;
      const z = this.#frameFeatureZ.get(fk)?.[f.feature];
      if (z != null && z >= f.threshold) bump(1 / (1 + Math.exp(-(z - f.threshold)))); // sigmoid -> [0,1] for ranking
    }
    const fq = this.#frameResults.get(fk);
    if (fq) {
      // binary frame checks contribute a fixed SEVERITY (not a flat 1) so review mode orders them
      // by concern: count / sparse first, negative / duplicates last.
      if (c.count && fq.isWrongCount) bump(FRAME_SEVERITY.count);
      if (c.sparse && fq.minVisibleNodeCount < this.sparseThreshold) bump(FRAME_SEVERITY.sparse);
      if (c.confidence && this.#kpConf(fq) < this.confidenceThreshold) bump(FRAME_SEVERITY.confidence);
      if (c.instConfidence && fq.minInstScore < this.instConfidenceThreshold) bump(FRAME_SEVERITY.instConfidence);
      if (c.negative && fq.isNegativeWithInstances) bump(FRAME_SEVERITY.negative);
      if (c.duplicates && (fq.duplicatePairs?.length ?? 0) > 0) bump(FRAME_SEVERITY.duplicates);
    }
    return best;
  }

  /** Flagged frames as store-frame indices, ordered per `reviewOrder`:
   *  "severity" → worst single flag first (flagConfidence desc); "detectors" → most detectors
   *  agreeing first (intersection count desc, then severity); "frame" → chronological. */
  get flaggedRanked() {
    this.rev;
    const frames = store.frames ?? [];
    const order = this.reviewOrder;
    const ranked = [];
    for (let i = 0; i < frames.length; i++) {
      const conf = this.flagConfidence(frames[i]);
      if (conf == null) continue;
      const n = order === "detectors" ? this.frameFlaggingChecks(frames[i]).length : 0;
      ranked.push({ i, conf, n });
    }
    if (order === "frame") ranked.sort((a, b) => a.i - b.i);
    else if (order === "detectors") ranked.sort((a, b) => b.n - a.n || b.conf - a.conf || a.i - b.i);
    else ranked.sort((a, b) => b.conf - a.conf || a.i - b.i);
    return ranked.map((r) => r.i);
  }

  /**
   * Cheap re-score of ONE edited instance against the already-fitted models — NO refit. The
   * expensive part of QC (baseline stats, GMM EM, NN, the chirality model) is memoized in
   * #computed; this re-extracts the edited pose's features and re-runs only the per-instance
   * scorers, updating that instance's score/contribution maps + re-deriving. Used by the review
   * loop so correcting a node immediately surfaces the next-biggest issue (the verdict + ring
   * update) without a full, distribution-shifting re-run. No-op if the units aren't computed yet.
   */
  rescoreInstance(item, instIdx) {
    if (!item || instIdx < 0) return;
    const fx = this.#computed.anomaly?.fx ?? this.#computed.gmm?.fx;
    const pose = item.lf?.instances?.[instIdx]?.numpy?.({ invisibleAsNaN: true });
    if (!fx || !pose) return;
    const key = `${this.#fkey(item)}:${instIdx}`;
    const raw = fx.extractFeatures(pose);
    const clean = raw.map((f) => (Number.isNaN(f) ? 0 : f === Infinity ? 10 : f === -Infinity ? -10 : f));

    if (this.#computed.anomaly?.det) {
      const s = this.#computed.anomaly.det.scoreOne(clean);
      this.#computed.anomaly.instanceScores.set(key, Number.isFinite(s) ? s : 0);
      const c = {};
      fx.featureNames.forEach((n, j) => (c[n] = raw[j] ?? 0));
      this.#computed.anomaly.contributions.set(key, c);
    }
    if (this.#computed.gmm?.det) {
      const g = this.#computed.gmm.det.scoreOne(clean);
      this.#computed.gmm.gmmScores.set(key, Number.isFinite(g) ? g : 0);
    }
    if (this.#computed.chirality?.model) {
      const { score, worstNode } = chiralityScoreOne(this.#computed.chirality.model, pose);
      this.#computed.chirality.chiralityScores.set(key, score);
      this.#computed.chirality.chiralityWorst.set(key, worstNode);
    }
    if (this.#computed.ordering?.chains?.length) {
      const r = orderingScoreOne(this.#computed.ordering.chains, pose);
      this.#computed.ordering.orderingScores.set(key, r.score);
      this.#computed.ordering.orderInversion.set(key, r.orderInversion);
      this.#computed.ordering.chainIntersection.set(key, r.chainIntersection);
      this.#computed.ordering.orderingWorst.set(key, r.worstNode);
    }
    if (this.#computed.poseSplit?.fx) {
      const r = poseSplitScoreOne(this.#computed.poseSplit.fx, pose);
      this.#computed.poseSplit.poseSplitScores.set(key, r.score);
      this.#computed.poseSplit.poseSplitWorst.set(key, r.worstNode);
    }
    this.#derive(); // rebuild frame-max maps + clear the lazy attribution caches for this key
    this.rev++;
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
    const aScore = this.#instanceScores.get(key);
    const gScore = this.#gmmScores.get(key);
    const chScore = this.#chiralityScores.get(key);
    const ordScore = this.#orderingScores.get(key);
    const psScore = this.#poseSplitScores.get(key);
    if (aScore == null && gScore == null && chScore == null && ordScore == null && psScore == null) return null;

    // Chirality wins the verdict: a whole-instance L/R flip is the dominant, most-actionable error.
    if (this.checks.chirality && chScore != null && chScore >= this.chiralityThreshold) {
      const cn = this.#chiralityWorst.get(key) ?? -1;
      const cName = cn >= 0 ? store.skeleton?.nodeNames?.[cn] ?? `node ${cn}` : null;
      return { score: chScore, confidence: confidence(chScore), feature: null, issue: "Whole-instance L/R flip", worstNode: cn, worstNodeName: cName, worstNodeDist: null };
    }
    // Split pose / chimera — a whole-instance structural error (two animals in one), under chirality.
    if (this.checks.poseSplit && psScore != null && psScore >= this.poseSplitThreshold) {
      const pn = this.#poseSplitWorst.get(key) ?? -1;
      const pName = pn >= 0 ? store.skeleton?.nodeNames?.[pn] ?? `node ${pn}` : null;
      return { score: psScore, confidence: confidence(psScore), feature: null, issue: "Split pose / chimera", worstNode: pn, worstNodeName: pName, worstNodeDist: null };
    }
    // Chain-ordering (out-of-order keypoints), just under chirality.
    if (this.checks.ordering && ordScore != null && ordScore >= this.orderingThreshold) {
      const on = this.#orderingWorst.get(key) ?? -1;
      const oName = on >= 0 ? store.skeleton?.nodeNames?.[on] ?? `node ${on}` : null;
      const xings = this.#chainIntersection.get(key) ?? 0;
      return { score: ordScore, confidence: confidence(ordScore), feature: null, issue: xings >= 1 ? "Out-of-order keypoints (chain crosses)" : "Out-of-order keypoints", worstNode: on, worstNodeName: oName, worstNodeDist: null };
    }

    if (aScore == null && gScore == null) return null;
    const wn = this.faultyNodeFor(item, instIdx);
    const worstNodeName = wn >= 0 ? store.skeleton?.nodeNames?.[wn] ?? `node ${wn}` : null;
    // Prefer the anomaly explanation (per-feature attribution); otherwise GMM gives a density
    // verdict, now named by its most-improbable feature (the max Mahalanobis-distance dimension)
    // and localized to its leave-one-out node.
    const gFlag = this.#gmmFlagged(key);
    const useGmm = aScore == null || (gFlag && this.checks.gmm && !(this.checks.anomaly && aScore >= this.threshold));
    let base;
    if (useGmm) {
      const wf = this.gmmWorstFeature(item, instIdx);
      const sub = issueForFeature(wf);
      base = { score: gScore ?? 0, confidence: confidence(gScore ?? 0), feature: wf, issue: sub ? `Improbable pose · ${sub}` : "Improbable pose" };
    } else {
      base = { score: aScore, confidence: confidence(aScore), ...topIssue(this.#contributions.get(key)) };
    }
    // For a z-score feature, append "(increased)"/"(decreased)" from the signed deviation.
    if (!useGmm && DIRECTIONAL_FEATURES.has(base.feature)) {
      base.issue = withDirection(base.issue, this.#anomalyAttribution(item, instIdx).dir);
    }
    return {
      ...base,
      worstNode: wn,
      worstNodeName,
      worstNodeDist: null,
    };
  }
  frameTopIssue(item) {
    this.rev;
    if (!item) return null;
    const worst = this.frameWorstInstance(item);
    return worst < 0 ? null : this.instanceIssue(item, worst);
  }
  /**
   * The instance most responsible for this frame being flagged — the one furthest over its
   * threshold across the enabled score-checks (live, so it tracks the threshold sliders).
   */
  frameWorstInstance(item) {
    this.rev;
    if (!item) return -1;
    const fk = this.#fkey(item);
    const insts = item.lf?.instances ?? [];
    let best = -1;
    let bestMargin = -Infinity;
    for (let i = 0; i < insts.length; i++) {
      const key = `${fk}:${i}`;
      let margin = -Infinity;
      if (this.checks.anomaly) {
        const a = this.#instanceScores.get(key);
        if (a != null) margin = Math.max(margin, a - this.threshold);
      }
      if (this.checks.gmm) {
        const g = this.#gmmScores.get(key);
        if (g != null) margin = Math.max(margin, g - this.gmmThreshold);
      }
      if (this.checks.chirality) {
        const s = this.#chiralityScores.get(key);
        if (s != null) margin = Math.max(margin, s - this.chiralityThreshold);
      }
      if (this.checks.ordering) {
        const s = this.#orderingScores.get(key);
        if (s != null) margin = Math.max(margin, s - this.orderingThreshold);
      }
      if (this.checks.poseSplit) {
        const s = this.#poseSplitScores.get(key);
        if (s != null) margin = Math.max(margin, s - this.poseSplitThreshold);
      }
      if (margin > bestMargin) {
        bestMargin = margin;
        best = i;
      }
    }
    return best;
  }

  /**
   * The faulty location to zoom to for an instance: the faulty node (chirality's wrong-pair
   * node, the anomaly culprit, or the GMM's leave-one-out node). Falls back to the whole-instance
   * box when a flagged instance has no single standout node (e.g. a GMM density flag).
   */
  faultyTarget(item, instIdx) {
    this.rev;
    if (!item) return null;
    const pts = item.lf?.instances?.[instIdx]?.points;
    const wn = this.faultyNodeFor(item, instIdx);
    const p0 = wn >= 0 ? pts?.[wn]?.xy : null;
    if (!p0 || Number.isNaN(p0[0])) {
      // no standout node — frame the whole instance so the user still lands on the problem
      if (!this.instanceFlagged(item, instIdx)) return null;
      const box = instanceBox(pts);
      return box ? { nodes: [], primary: -1, box } : null;
    }
    return { nodes: [wn], primary: wn, box: { x: p0[0], y: p0[1], w: 0, h: 0 } };
  }

  #computeUnit(unit) {
    if (unit === "anomaly") return computeAnomalyUnit(this.#ctx);
    if (unit === "gmm") return computeGmmUnit(this.#ctx);
    if (unit === "frame") return computeFrameUnit(this.#ctx);
    if (unit === "chirality") return computeChiralityUnit(this.#ctx);
    if (unit === "ordering") return computeOrderingUnit(this.#ctx);
    if (unit === "poseSplit") return computePoseSplitUnit(this.#ctx);
    return null;
  }

  // Rebuild the derived per-frame maps from whatever units are currently computed.
  #derive() {
    this.#instanceScores = this.#computed.anomaly?.instanceScores ?? new Map();
    this.#contributions = this.#computed.anomaly?.contributions ?? new Map();
    this.#gmmScores = this.#computed.gmm?.gmmScores ?? new Map();
    this.#frameResults = this.#computed.frame?.frameResults ?? new Map();
    this.#chiralityScores = this.#computed.chirality?.chiralityScores ?? new Map();
    this.#chiralityWorst = this.#computed.chirality?.chiralityWorst ?? new Map();
    this.#orderingScores = this.#computed.ordering?.orderingScores ?? new Map();
    this.#orderingWorst = this.#computed.ordering?.orderingWorst ?? new Map();
    this.#orderInversion = this.#computed.ordering?.orderInversion ?? new Map();
    this.#chainIntersection = this.#computed.ordering?.chainIntersection ?? new Map();
    this.#poseSplitScores = this.#computed.poseSplit?.poseSplitScores ?? new Map();
    this.#poseSplitWorst = this.#computed.poseSplit?.poseSplitWorst ?? new Map();

    const frameMax = (src, dst) => {
      dst.clear();
      for (const [key, s] of src) {
        const fk = key.slice(0, key.lastIndexOf(":"));
        if (s > (dst.get(fk) ?? -1)) dst.set(fk, s);
      }
    };
    this.#frameAnom = new Map();
    this.#frameGmm = new Map();
    this.#frameChir = new Map();
    this.#frameOrdering = new Map();
    this.#framePoseSplit = new Map();
    frameMax(this.#instanceScores, this.#frameAnom);
    frameMax(this.#gmmScores, this.#frameGmm);
    frameMax(this.#chiralityScores, this.#frameChir);
    frameMax(this.#orderingScores, this.#frameOrdering);
    frameMax(this.#poseSplitScores, this.#framePoseSplit);
    this.#gmmWorst = new Map(); // lazy leave-one-out cache — invalidated whenever results change
    this.#gmmWorstFeat = new Map(); // lazy GMM worst-feature cache — same invalidation
    this.#anomalyAttr = new Map(); // lazy anomaly-attribution cache — same invalidation
    this.#deriveFeatureChecks(); // per-feature |z| maps for the user feature-checks
  }

  /** Run the enabled checks that aren't already computed (incremental + memoized). */
  async run() {
    if (!store.labels || this.status === "running") return;
    this.status = "running";
    this.error = null;

    // Rebuild the context (re-snapshots poses + clears the memoized units) when the labels changed —
    // a new file (identity) OR an in-place instance edit (store.rev bumps without changing identity)
    // OR a baseline-source switch. Otherwise reuse the memoized context + already-computed units.
    const rebuild = store.labels !== this.#ctxLabels || store.rev !== this.#ctxRev || this.baselineSource !== this.#ctxBaselineSource;
    const need = new Set();
    for (const [name, on] of Object.entries(this.checks)) if (on) need.add(UNIT_OF[name]);
    if (this.featureCheckActive) need.add("anomaly"); // feature-checks reuse the anomaly ZScore fit
    const units = [...need].filter((u) => rebuild || !this.#computed[u]); // (rebuild clears #computed below)
    const usesFeatures = units.includes("anomaly") || units.includes("gmm"); // shared 18-feature build

    // The live step list — each step is run timed, yielding to the event loop first so the progress
    // bar repaints before a (possibly slow) blocking compute. Retained after the run as a breakdown.
    const steps = [];
    if (rebuild) steps.push({ key: "context", label: UNIT_LABEL.context, status: "pending", ms: 0 });
    if (usesFeatures) steps.push({ key: "features", label: UNIT_LABEL.features, status: "pending", ms: 0 });
    for (const u of units) steps.push({ key: u, label: UNIT_LABEL[u] ?? u, status: "pending", ms: 0 });
    steps.push({ key: "derive", label: UNIT_LABEL.derive, status: "pending", ms: 0 });
    this.#progress = { steps, done: 0, total: steps.length };
    this.rev++;
    await nextPaint(); // let "Running…" + the bar paint before the compute

    const runStep = async (key, fn) => {
      const step = steps.find((s) => s.key === key);
      if (step) { step.status = "running"; this.rev++; await nextPaint(); } // paint "running" before the blocking compute
      const t = performance.now();
      fn();
      if (step) { step.ms = performance.now() - t; step.status = "done"; this.#progress.done++; this.rev++; }
    };

    try {
      if (rebuild) await runStep("context", () => {
        this.#ctx = buildContext(store.labels, makeQCConfig({ useGmm: false, baselineSource: this.baselineSource }));
        this.#ctxLabels = store.labels;
        this.#ctxRev = store.rev;
        this.#ctxBaselineSource = this.baselineSource;
        this.#computed = {};
      });
      if (usesFeatures) {
        const fresh = !this.#ctx._fx; // attach the per-metric breakdown only when features are (re)built
        await runStep("features", () => ensureFeatures(this.#ctx)); // pre-build once → clean anomaly/gmm timings
        const fstep = steps.find((s) => s.key === "features");
        if (fresh && fstep && this.#ctx._fx?._timings) {
          fstep.sub = Object.entries(this.#ctx._fx._timings).map(([label, ms]) => ({ label, ms }));
          this.rev++;
        }
      }
      for (const unit of units) await runStep(unit, () => { this.#computed[unit] = this.#computeUnit(unit); });
      await runStep("derive", () => this.#derive());
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

  /** Whether QC results can be exported (anomaly unit computed — it supplies score + the 18 features). */
  get canExportCsv() {
    this.rev;
    return !!store.labels && this.checkReady("anomaly");
  }

  /**
   * Every scored instance as a CSV string in the reference `qc_results.csv` format, or null if
   * the anomaly unit hasn't been computed. Iterates videos -> labeled frames -> instances in the
   * same order as the detection context, so the "v:f:i" keys line up with the stored scores.
   *
   * The `score`/`confidence` columns mirror the desktop GUI's detector selection: it reports
   * **GMM** when n_instances >= 50 (and the GMM unit has been computed), else the **ZScore**
   * anomaly. `top_issue` + the 18 features are detector-independent (they come from the same
   * contributions either way). Falls back to ZScore per-instance if a GMM score is missing.
   */
  toCsv() {
    this.rev;
    if (!this.canExportCsv) return null;
    const useGmm = this.checkReady("gmm") && this.#instanceScores.size >= 50; // 50 = gmmMinSamples
    const records = [];
    store.labels.videos.forEach((video, vIdx) => {
      for (const lf of store.labels.labeledFrames.filter((f) => f.video === video)) {
        lf.instances.forEach((inst, iIdx) => {
          const key = `${vIdx}:${lf.frameIdx}:${iIdx}`;
          if (!this.#instanceScores.has(key)) return; // unscored -> no contributions either
          const zScore = this.#instanceScores.get(key);
          const score = useGmm ? this.#gmmScores.get(key) ?? zScore : zScore;
          records.push({ videoIdx: vIdx, frameIdx: lf.frameIdx, instIdx: iIdx, score, contributions: this.#contributions.get(key), orderInversion: this.#orderInversion.get(key) ?? 0, chainIntersection: this.#chainIntersection.get(key) ?? 0 });
        });
      }
    });
    return qcResultsCsv(records);
  }

  /** Build the CSV and trigger a browser download (mirrors editStore.save's download). */
  downloadCsv() {
    const csv = this.toCsv();
    if (csv == null) return;
    const base = (store.fileName || "labels").replace(/\.(pkg\.)?slp$/i, "");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `${base}.qc_results.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  /** Ordered feature names making up the shared anomaly/GMM vector (read-only transparency panel). */
  get vectorFeatures() {
    this.rev;
    return this.#computed.anomaly?.featureNames ?? [];
  }
  /** Raw per-feature contributions `{ name: value }` for an instance (the vector the scorers see), or null. */
  contributionsFor(item, instIdx) {
    this.rev;
    if (!item || instIdx < 0) return null;
    return this.#contributions.get(`${this.#fkey(item)}:${instIdx}`) ?? null;
  }
  /** Top features driving the Anomaly/GMM flag on a frame (its worst instance), by signed z vs the
   *  fitted distribution. Each `{ feature, z }` — z>0 = above the norm, z<0 = below. [] if no anomaly fit. */
  frameTopFeatures(item, n = 5) {
    this.rev;
    const a = this.#computed.anomaly;
    if (!a?.det?.means || !a.featureNames) return [];
    const c = this.contributionsFor(item, this.frameWorstInstance(item));
    if (!c) return [];
    const rows = [];
    a.featureNames.forEach((name, j) => {
      const raw = c[name];
      if (raw == null || !Number.isFinite(raw)) return;
      const z = (raw - a.det.means[j]) / (a.det.stds[j] || 1e-6);
      if (Number.isFinite(z)) rows.push({ feature: name, z });
    });
    return rows.sort((p, q) => Math.abs(q.z) - Math.abs(p.z)).slice(0, n);
  }
  /** Every ENABLED check's status for a frame, for the opt-in "all checks" detail view. Each:
   *  { key, label, score, threshold, flagged, lowerIsWorse?, unit?, detail? }. */
  frameDetectorDetails(item) {
    this.rev;
    if (!item) return [];
    const fk = this.#fkey(item);
    const c = this.checks;
    const out = [];
    const sc = (on, map, thr, key, label) => {
      if (!on) return;
      const s = map.get(fk) ?? null;
      out.push({ key, label, score: s, threshold: thr, flagged: s != null && s >= thr });
    };
    sc(c.anomaly, this.#frameAnom, this.threshold, "anomaly", "Anomaly");
    sc(c.gmm, this.#frameGmm, this.gmmThreshold, "gmm", "GMM");
    sc(c.chirality, this.#frameChir, this.chiralityThreshold, "chirality", "Chirality");
    sc(c.ordering, this.#frameOrdering, this.orderingThreshold, "ordering", "Ordering");
    sc(c.poseSplit, this.#framePoseSplit, this.poseSplitThreshold, "poseSplit", "Pose split");
    const fm = this.#frameFeatureZ.get(fk);
    for (const f of this.featureChecks) {
      if (!f.on) continue;
      const z = fm?.[f.feature] ?? null;
      out.push({ key: `feat:${f.id}`, label: f.feature.replace(/_zscore$/, ""), score: z, threshold: f.threshold, flagged: z != null && z >= f.threshold, unit: "σ" });
    }
    const fq = this.#frameResults.get(fk);
    if (fq) {
      if (c.count) out.push({ key: "count", label: "Instance count", flagged: fq.isWrongCount, detail: fq.isEmpty ? "empty" : `${fq.actualInstanceCount} / ${fq.expectedInstanceCount}` });
      if (c.sparse) out.push({ key: "sparse", label: "Sparse instance", flagged: fq.minVisibleNodeCount < this.sparseThreshold, detail: `${fq.minVisibleNodeCount} min nodes` });
      if (c.confidence) { const kp = this.#kpConf(fq); out.push({ key: "confidence", label: "Keypoint conf", score: kp, threshold: this.confidenceThreshold, flagged: kp < this.confidenceThreshold, lowerIsWorse: true }); }
      if (c.instConfidence) out.push({ key: "instConfidence", label: "Instance conf", score: fq.minInstScore, threshold: this.instConfidenceThreshold, flagged: fq.minInstScore < this.instConfidenceThreshold, lowerIsWorse: true });
      if (c.negative) out.push({ key: "negative", label: "Negative frame", flagged: fq.isNegativeWithInstances, detail: fq.isNegativeWithInstances ? "has instances" : "—" });
      if (c.duplicates) out.push({ key: "duplicates", label: "Duplicates", flagged: (fq.duplicatePairs?.length ?? 0) > 0, detail: `${fq.duplicatePairs?.length ?? 0} pair(s)` });
    }
    return out;
  }

  reset() {
    this.status = "idle";
    this.error = null;
    this.#ctx = null;
    this.#ctxLabels = null;
    this.#ctxRev = -1;
    this.#computed = {};
    this.#progress = null; // drop the prior run's timing breakdown
    this.#derive();
    // NOTE: this.checks (the user's enabled-technique preferences) intentionally persist.
    this.ranAtRev = -1;
    this.rev++;
  }
}

export function hasFrameIssue(fq) {
  if (!fq) return false;
  return fq.isWrongCount || fq.isSparse || fq.isLowConf || fq.isLowInstConf || fq.isNegativeWithInstances || (fq.duplicatePairs?.length ?? 0) > 0;
}

// Bounding box (image space) over an instance's placed points — the zoom fallback when a
// flagged instance has no single standout node.
function instanceBox(pts) {
  const xs = [];
  const ys = [];
  for (const p of pts ?? []) {
    const x = p?.xy?.[0];
    const y = p?.xy?.[1];
    if (x != null && !Number.isNaN(x)) {
      xs.push(x);
      ys.push(y);
    }
  }
  if (!xs.length) return null;
  const minx = Math.min(...xs);
  const miny = Math.min(...ys);
  return { x: minx, y: miny, w: Math.max(...xs) - minx, h: Math.max(...ys) - miny };
}

// green (low) -> red (high) heat for an anomaly score in [0,1].
export const heatColor = (score) => `hsl(${Math.round(140 * (1 - Math.max(0, Math.min(1, score))))}, 80%, 55%)`;

export const qc = new QCStore();
