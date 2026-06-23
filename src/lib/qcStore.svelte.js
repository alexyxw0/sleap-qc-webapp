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
  computeAnomalyUnit,
  computeGmmUnit,
  computeFrameUnit,
  computeChiralityUnit,
  chiralityScoreOne,
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
  count: "frame",
  negative: "frame",
  duplicates: "frame",
};

class QCStore {
  status = $state("idle"); // idle | running | done | error
  error = $state(null);
  threshold = $state(0.7); // anomaly (ZScore) flag
  gmmThreshold = $state(0.95); // GMM anomaly (1 − likelihood-percentile) flag — top ~5%
  chiralityThreshold = $state(0.5); // L/R-flip flag ([0,1] wrong-side fraction; hard rule forces >=0.9)
  uncThreshold = $state(0.6); // (stable build: confidence channel absent; kept for the shared UI)
  rev = $state(0); // bump when results / selection change
  ranAtRev = -1; // store.rev at the time QC last ran (for staleness)

  // Which detection techniques to run / include. The flagged frames are the UNION of the
  // enabled-and-computed checks. GMM is off by default — it's the heaviest, opt-in technique.
  checks = $state({ anomaly: true, gmm: false, chirality: true, count: true, negative: true, duplicates: true });

  #ctx = null; // shared frame/pose/feature context for the current labels
  #ctxLabels = null; // identity of the labels #ctx was built for
  #ctxRev = -1; // store.rev the #ctx was built at — bumps when instances are edited in place
  #computed = {}; // unit -> result maps (the memoization cache)

  // Derived per-frame maps (rebuilt from #computed after each run).
  #instanceScores = new Map(); // "v:f:i" -> anomaly score
  #contributions = new Map();
  #gmmScores = new Map(); // "v:f:i" -> GMM anomaly
  #frameResults = new Map(); // "v:f" -> FrameQC
  #frameAnom = new Map(); // "v:f" -> max anomaly score
  #frameGmm = new Map(); // "v:f" -> max GMM score
  #gmmWorst = new Map(); // "v:f:i" -> GMM leave-one-out worst node (computed lazily)
  #gmmWorstFeat = new Map(); // "v:f:i" -> GMM most-improbable feature NAME (computed lazily)
  #anomalyAttr = new Map(); // "v:f:i" -> { node, dir, feature } for the anomaly's dominant feature (lazy)
  #chiralityScores = new Map(); // "v:f:i" -> L/R-flip [0,1] score
  #chiralityWorst = new Map(); // "v:f:i" -> a node from a wrong pair, -1 if none
  #frameChir = new Map(); // "v:f" -> max chirality score

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
    if (c.chirality) for (const [fk, s] of this.#frameChir) if (s >= this.chiralityThreshold) u.add(fk);
    for (const [fk, fq] of this.#frameResults) {
      if (
        (c.count && fq.isWrongCount) ||
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
    let n = 0;
    for (const fq of this.#frameResults.values()) {
      if (
        (name === "count" && fq.isWrongCount) ||
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
      isOvercount: c.count ? fq.isOvercount : false,
      isWrongCount: c.count ? fq.isWrongCount : false,
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
    score(c.anomaly, this.#frameAnom, this.threshold, "anomaly", "Anomaly");
    score(c.gmm, this.#frameGmm, this.gmmThreshold, "gmm", "GMM");
    const fq = this.#frameResults.get(fk);
    if (fq) {
      if (c.count && fq.isWrongCount) out.push({ key: "count", label: fq.isOvercount ? "Extra instance" : "Missing instance", score: null });
      if (c.negative && fq.isNegativeWithInstances) out.push({ key: "negative", label: "Negative", score: null });
      if (c.duplicates && (fq.duplicatePairs?.length ?? 0) > 0) out.push({ key: "duplicates", label: "Duplicate", score: null });
    }
    return out;
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
    return false;
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
    const fq = this.#frameResults.get(fk);
    if (fq && ((c.count && fq.isWrongCount) || (c.negative && fq.isNegativeWithInstances) || (c.duplicates && (fq.duplicatePairs?.length ?? 0) > 0))) bump(1);
    return best;
  }

  /** Flagged frames as store-frame indices, **worst-first** by `flagConfidence` (ties → frame order). */
  get flaggedRanked() {
    this.rev;
    const frames = store.frames ?? [];
    const ranked = [];
    for (let i = 0; i < frames.length; i++) {
      const conf = this.flagConfidence(frames[i]);
      if (conf != null) ranked.push({ i, conf });
    }
    ranked.sort((a, b) => b.conf - a.conf || a.i - b.i);
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
    if (aScore == null && gScore == null && chScore == null) return null;

    // Chirality wins the verdict: a whole-instance L/R flip is the dominant, most-actionable error.
    if (this.checks.chirality && chScore != null && chScore >= this.chiralityThreshold) {
      const cn = this.#chiralityWorst.get(key) ?? -1;
      const cName = cn >= 0 ? store.skeleton?.nodeNames?.[cn] ?? `node ${cn}` : null;
      return { score: chScore, confidence: confidence(chScore), feature: null, issue: "Whole-instance L/R flip", worstNode: cn, worstNodeName: cName, worstNodeDist: null };
    }
    // (Chimera has no dedicated verdict — pose_split_score is a feature, so a chimera surfaces
    // as the anomaly/GMM verdict "Split pose / chimera" via topIssue below.)

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
    frameMax(this.#instanceScores, this.#frameAnom);
    frameMax(this.#gmmScores, this.#frameGmm);
    frameMax(this.#chiralityScores, this.#frameChir);
    this.#gmmWorst = new Map(); // lazy leave-one-out cache — invalidated whenever results change
    this.#gmmWorstFeat = new Map(); // lazy GMM worst-feature cache — same invalidation
    this.#anomalyAttr = new Map(); // lazy anomaly-attribution cache — same invalidation
  }

  /** Run the enabled checks that aren't already computed (incremental + memoized). */
  async run() {
    if (!store.labels || this.status === "running") return;
    this.status = "running";
    this.error = null;
    this.rev++;
    await new Promise((r) => setTimeout(r, 0)); // let "Running…" paint before the blocking compute
    try {
      // Rebuild the context (re-snapshots poses + clears the memoized units) when the labels
      // changed — either a new file (identity) OR an in-place instance edit (store.rev bumps
      // without changing identity). Without the rev check, editing a keypoint and re-running
      // would silently reuse the stale pose snapshot and cached unit results.
      if (store.labels !== this.#ctxLabels || store.rev !== this.#ctxRev) {
        this.#ctx = buildContext(store.labels, makeQCConfig({ useGmm: false }));
        this.#ctxLabels = store.labels;
        this.#ctxRev = store.rev;
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
          records.push({ videoIdx: vIdx, frameIdx: lf.frameIdx, instIdx: iIdx, score, contributions: this.#contributions.get(key) });
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

  reset() {
    this.status = "idle";
    this.error = null;
    this.#ctx = null;
    this.#ctxLabels = null;
    this.#ctxRev = -1;
    this.#computed = {};
    this.#derive();
    // NOTE: this.checks (the user's enabled-technique preferences) intentionally persist.
    this.ranAtRev = -1;
    this.rev++;
  }
}

export function hasFrameIssue(fq) {
  if (!fq) return false;
  return fq.isWrongCount || fq.isNegativeWithInstances || (fq.duplicatePairs?.length ?? 0) > 0;
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
