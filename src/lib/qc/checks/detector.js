// Port of sleap/qc/detector.py + gmm.py — orchestrates the per-instance feature vector
// (18 features) into an anomaly score and runs the frame-level checks.
//
// Detector selection mirrors Python: GaussianMixture when n_instances >= gmm_min_samples
// (50), else the ZScoreDetector. The GMM *scoring* matches sklearn to ~1e-9 (validated by
// loading sklearn's fitted params); the EM *fit* is a faithful re-implementation but is
// not bit-identical to sklearn (different RNG / k-means init).

import { mean, std, visibilityMask } from "./util.js";
import { GMMDetector } from "./gmm.js";
import { makeQCConfig, shouldUseCurvature } from "./config.js";
import { BaselineFeatureExtractor, BASELINE_FEATURE_NAMES } from "./features/baseline.js";
import { computeCurvature, computeConvexHull } from "./features/structural.js";
import { VisibilityModel } from "./features/visibility.js";
import { NearestNeighborScorer } from "./features/reference.js";
import { analyzerFromSkeleton } from "./features/skeleton.js";
import { InstanceCountChecker, checkNegativeFrame, detectDuplicates } from "./frameLevel.js";
import { ChiralityModel, resolveChiralityInputs, firstWrongPairNode } from "./features/chirality.js";
import { computePoseSplit } from "./features/poseSplit.js";
import { resolveChains, computeChainOrdering, linearizeChains } from "./features/ordering.js";

const V3_FEATURE_NAMES = [
  "max_curvature", "curvature_std", "visibility_pattern_score",
  "nn_distance", "hull_area_zscore", "hull_compactness",
];

/** Fallback detector: max |z| across features -> sigmoid around a threshold. */
export class ZScoreDetector {
  constructor(threshold = 3.0) {
    this.threshold = threshold;
    this.means = null;
    this.stds = null;
  }
  fit(matrix) {
    const valid = matrix.filter((row) => row.every((x) => !Number.isNaN(x)));
    const nf = matrix[0]?.length ?? 0;
    this.means = Array.from({ length: nf }, (_, j) => mean(valid.map((r) => r[j])));
    this.stds = Array.from({ length: nf }, (_, j) => Math.max(std(valid.map((r) => r[j])), 1e-6));
    return this;
  }
  scoreOne(vector) {
    if (vector.some((x) => Number.isNaN(x))) return Number.NaN;
    let maxZ = 0;
    for (let j = 0; j < vector.length; j++) {
      const z = Math.abs((vector[j] - this.means[j]) / this.stds[j]);
      if (z > maxZ) maxZ = z;
    }
    return 1 / (1 + Math.exp(-(maxZ - this.threshold))); // sigmoid
  }
}

export class LabelQCDetector {
  constructor(config = makeQCConfig()) {
    this.config = config;
    this.usedGmm = false;
  }

  /** @param instances poses number[][][]; analyzer SkeletonAnalyzer. */
  fit({ instances, analyzer, frameCounts = [], videoIds = null }) {
    this.fitFeatures(instances, analyzer);

    // GMM for a large enough reference set, else the z-score fallback (mirrors Python).
    if (instances.length >= this.config.gmmMinSamples && this.config.useGmm) {
      this.detector = new GMMDetector({
        nComponents: this.config.gmmNComponents,
        percentileThreshold: this.config.gmmPercentileThreshold,
      }).fit(this.rawMatrix);
      this.usedGmm = true;
    } else {
      this.detector = new ZScoreDetector(3.0).fit(this.rawMatrix);
      this.usedGmm = false;
    }

    this.countChecker = new InstanceCountChecker(true).fit(frameCounts, videoIds);
    return this;
  }

  /**
   * Fit the feature extractors + build the per-instance feature matrix (raw + cleaned).
   * `fitMask` (per-instance, aligned with `instances`) selects the "normal" REFERENCE subset —
   * the baseline stats / NN reference / detectors are fit on it, but the matrix (for scoring) is
   * built over ALL `instances`. `null` => all (the default, identical to the old behavior). Used
   * to fit on user-annotated instances only so predictions are measured against clean ground truth.
   */
  fitFeatures(instances, analyzer, fitMask = null) {
    this.analyzer = analyzer;
    const fitPoses = fitMask ? instances.filter((_, i) => fitMask[i]) : instances;
    this.baseline = new BaselineFeatureExtractor(analyzer.edges, analyzer.nNodes, analyzer.symmetryPairs).fit(fitPoses);
    this.visibility = new VisibilityModel().fit(fitPoses.map(visibilityMask));
    this.nn = new NearestNeighborScorer({ normalize: true }).fit(fitPoses);
    const looNN = this.nn.looDistances(); // leave-one-out, aligned with fitPoses
    const areas = fitPoses.map((p) => computeConvexHull(p).hullArea).filter((a) => a > 0);
    this._hullStats = { mean: areas.length ? mean(areas) : 1, std: areas.length ? std(areas) : 1 };
    // node->neighbors adjacency, reused by the pose_split_score feature (chimera bridging edge).
    this._adjacency = Array.from({ length: analyzer.nNodes }, () => []);
    for (const [s, d] of analyzer.edges) { this._adjacency[s].push(d); this._adjacency[d].push(s); }
    this.featureNames = [...BASELINE_FEATURE_NAMES, ...V3_FEATURE_NAMES];
    // Matrix over ALL instances; a fit row reuses its LOO NN distance (avoids self-match), a
    // non-fit row gets the full NN to the fit set. `fitRows` are the matrix rows used to fit.
    const fitIdxByAll = new Map();
    let fi = 0;
    instances.forEach((_, i) => { if (!fitMask || fitMask[i]) fitIdxByAll.set(i, fi++); });
    this.rawMatrix = instances.map((p, i) =>
      this.extractFeatures(p, !fitMask || fitMask[i] ? looNN[fitIdxByAll.get(i)] : null),
    );
    this.cleanMatrix = this.rawMatrix.map((row) =>
      row.map((f) => (Number.isNaN(f) ? 0 : f === Infinity ? 10 : f === -Infinity ? -10 : f)),
    );
    this.fitRows = [...fitIdxByAll.keys()];
    return this;
  }
  /** The clean feature rows used to fit the detectors (the baseline-source subset). */
  get fitCleanMatrix() {
    return this.fitRows.map((r) => this.cleanMatrix[r]);
  }
  get fitRawMatrix() {
    return this.fitRows.map((r) => this.rawMatrix[r]);
  }

  /** 18-dim geometric feature vector for one pose. */
  extractFeatures(pose, nnDistance = null) {
    const baseline = this.baseline.extract(pose);
    const v3 = [];

    if (shouldUseCurvature(this.config, this.analyzer.maxChainLength)) {
      const chains = this.analyzer.getCurvatureChains();
      if (chains.length) {
        const c = computeCurvature(pose, chains[0]);
        v3.push(c.maxCurvature, c.curvatureStd);
      } else v3.push(0, 0);
    } else v3.push(0, 0);

    v3.push(this.visibility.score(visibilityMask(pose)).patternScore);
    v3.push(nnDistance != null ? nnDistance : this.nn.score(pose).nnDistance);

    const hull = computeConvexHull(pose);
    v3.push((hull.hullArea - this._hullStats.mean) / Math.max(this._hullStats.std, 1e-6), hull.compactness);

    return [...baseline, ...v3];
  }

  /** Anomaly score (0..1) + raw feature contributions for a pose. */
  scoreInstance(pose) {
    const features = this.extractFeatures(pose);
    const clean = features.map((f) =>
      Number.isNaN(f) ? 0 : f === Infinity ? 10 : f === -Infinity ? -10 : f,
    );
    const score = this.detector.scoreOne(clean);
    const contributions = {};
    this.featureNames.forEach((n, i) => (contributions[n] = features[i] ?? 0));
    return { score: Number.isFinite(score) ? score : 0, contributions };
  }

  /** Frame-level QC for a frame's poses. `conf` is the per-instance {minScore,minNode} (predicted). */
  checkFrame(poses, videoId, isNegative = false, conf = null) {
    const count = this.countChecker.check(poses.length, videoId);
    // Weakest visible keypoint across the frame's predicted instances (threshold-free — the store
    // applies the live cutoff). Lets confidence scores act as QC when some labels are predicted.
    let minPointScore = Infinity, lowConfInstance = -1, lowConfNode = -1;
    let avgPointScore = Infinity, avgConfInstance = -1; // worst per-instance MEAN keypoint confidence
    let minInstScore = Infinity, lowInstance = -1; // worst INSTANCE-level confidence (inst.score)
    if (conf) conf.forEach((c, i) => {
      if (c.minScore < minPointScore) { minPointScore = c.minScore; lowConfInstance = i; lowConfNode = c.minNode; }
      if (c.avgScore < avgPointScore) { avgPointScore = c.avgScore; avgConfInstance = i; }
      if (c.instScore < minInstScore) { minInstScore = c.instScore; lowInstance = i; }
    });
    // A negative (background) frame is intentionally empty/odd-count — exempt it from the count
    // check (otherwise its 0 instances would always read as "missing"). So a NON-negative frame
    // with no instances is flagged (0 < expected), while a negative empty frame is not.
    const counted = !isNegative;
    // Sparsest instance's visible-node count (threshold-free — the store applies the live cutoff).
    // An instance localized by only a node or two is barely usable; the anomaly check can't catch
    // it reliably because it's baseline-relative, so this deterministic count does.
    let minVisibleNodeCount = Infinity, sparsestInstance = -1;
    if (counted) {
      poses.forEach((pose, i) => {
        let v = 0;
        for (const xy of pose) if (!Number.isNaN(xy?.[0])) v++;
        if (v < minVisibleNodeCount) { minVisibleNodeCount = v; sparsestInstance = i; }
      });
    }
    const fq = {
      isIncomplete: counted && count.isIncomplete,
      isOvercount: counted && count.isOvercount,
      isWrongCount: counted && count.isWrongCount,
      isEmpty: counted && poses.length === 0,
      expectedInstanceCount: Math.round(count.expectedCount),
      actualInstanceCount: poses.length,
      minVisibleNodeCount,
      sparsestInstance,
      minPointScore,
      lowConfInstance,
      lowConfNode,
      avgPointScore,
      avgConfInstance,
      minInstScore,
      lowInstance,
      isNegativeWithInstances: checkNegativeFrame(isNegative, poses.length),
      duplicatePairs: [],
      duplicateReasons: [],
    };
    if (poses.length >= 2) {
      for (const d of detectDuplicates(poses, {
        iouThreshold: this.config.duplicateIouThreshold,
        nodeDistanceThreshold: this.config.duplicateNodeDistanceThreshold,
        nodeOverlapRatio: this.config.duplicateNodeOverlapRatio,
      })) {
        fq.duplicatePairs.push([d.indexA, d.indexB]);
        fq.duplicateReasons.push(d.reason);
      }
    }
    return fq;
  }
}

const videoIdString = (video, idx) =>
  typeof video?.filename === "string" && video.filename ? video.filename : String(idx);

/**
 * Run the full QC pipeline on a sleap-io.js Labels (fit + score). Returns instance
 * anomaly scores + frame results, keyed by "videoIdx:frameIdx[:instIdx]".
 *
 * `getInstances(lf)` selects which instances to use (default: all). The Python module
 * fits/scores user_instances; for prediction proofreading the Seam-A refinement scores
 * predicted instances against reference stats (future).
 */
export function fitAndScoreLabels(labels, { config = makeQCConfig(), getInstances } = {}) {
  if (!labels.skeletons?.length) throw new Error("Labels must have at least one skeleton");
  const analyzer = analyzerFromSkeleton(labels.skeletons[0]);
  const pick = getInstances ?? ((lf) => lf.instances);
  const toPose = (inst) => inst.numpy({ invisibleAsNaN: true });

  const frames = [];
  const allPoses = [];
  const frameCounts = [];
  const videoIds = [];
  labels.videos.forEach((video, videoIdx) => {
    const vid = videoIdString(video, videoIdx);
    for (const lf of labels.labeledFrames.filter((f) => f.video === video)) {
      const poses = pick(lf).map(toPose);
      frames.push({ videoIdx, frameIdx: lf.frameIdx, isNegative: lf.isNegative ?? false, poses, vid });
      allPoses.push(...poses);
      frameCounts.push(poses.length);
      videoIds.push(vid);
    }
  });

  const det = new LabelQCDetector(config).fit({ instances: allPoses, analyzer, frameCounts, videoIds });

  const instanceScores = new Map();
  const contributions = new Map();
  const frameResults = new Map();
  for (const f of frames) {
    f.poses.forEach((pose, instIdx) => {
      const key = `${f.videoIdx}:${f.frameIdx}:${instIdx}`;
      const r = det.scoreInstance(pose);
      instanceScores.set(key, r.score);
      contributions.set(key, r.contributions);
    });
    frameResults.set(`${f.videoIdx}:${f.frameIdx}`, det.checkFrame(f.poses, f.vid, f.isNegative, f.conf));
  }
  return {
    instanceScores, contributions,
    frameResults, featureNames: det.featureNames, usedGmm: det.usedGmm,
  };
}

// ───────────────────────────── Selectable, memoizable QC ─────────────────────────────
//
// A "unit" is one computable block — 'anomaly' (ZScore), 'gmm' (GaussianMixture
// probability), 'frame' (count / negative / duplicates).
// The qcStore computes only the selected units and caches each, so re-selecting a
// previously-computed technique never recomputes. `buildContext` gathers frames/poses once;
// the shared feature matrix (used by anomaly + gmm) is built lazily the first time it's needed.

/** Gather frames + poses once. The feature matrix is built lazily (see ensureFeatures). */
export function buildContext(labels, config = makeQCConfig()) {
  if (!labels.skeletons?.length) throw new Error("Labels must have at least one skeleton");
  const analyzer = analyzerFromSkeleton(labels.skeletons[0]);
  const toPose = (inst) => inst.numpy({ invisibleAsNaN: true });
  // Weakest VISIBLE keypoint confidence for a predicted instance — {minScore, minNode}; Infinity
  // for a user instance (no per-point scores). Used by the prediction-confidence QC check.
  const instConf = (inst) => {
    let minScore = Infinity, minNode = -1, sum = 0, count = 0;
    const pts = inst.points ?? [];
    for (let k = 0; k < pts.length; k++) {
      const p = pts[k];
      if (p?.visible && typeof p.score === "number") {
        if (p.score < minScore) { minScore = p.score; minNode = k; }
        sum += p.score; count++;
      }
    }
    return {
      minScore, minNode, // weakest visible keypoint
      avgScore: count ? sum / count : Infinity, // mean visible-keypoint confidence
      instScore: typeof inst.score === "number" ? inst.score : Infinity, // instance-level score
    };
  };
  const frames = [];
  const allPoses = [];
  const frameCounts = [];
  const videoIds = [];
  const userMask = []; // per-instance (allPoses order): true = user-annotated, false = predicted
  let hasPredictions = false;
  labels.videos.forEach((video, videoIdx) => {
    const vid = videoIdString(video, videoIdx);
    for (const lf of labels.labeledFrames.filter((f) => f.video === video)) {
      const poses = lf.instances.map(toPose);
      const conf = lf.instances.map(instConf);
      frames.push({ videoIdx, frameIdx: lf.frameIdx, isNegative: lf.isNegative ?? false, poses, conf, vid });
      allPoses.push(...poses);
      frameCounts.push(poses.length);
      videoIds.push(vid);
      for (const inst of lf.instances) {
        const predicted = inst.score != null; // PredictedInstance carries an instance-level score
        userMask.push(!predicted);
        if (predicted) hasPredictions = true;
      }
    }
  });
  return { config, analyzer, frames, allPoses, frameCounts, videoIds, userMask, hasPredictions, labels, _fx: null };
}

// The shared feature matrix + extractors (built once; reused by anomaly + gmm). This is the
// expensive part (incl. the O(n^2) NN feature), so it is computed at most once per context.
// Exported so the store can pre-build (and time) it once, keeping the anomaly/gmm step timings clean.
export function ensureFeatures(ctx) {
  if (!ctx._fx) {
    // baselineSource "user" fits the reference on user-annotated instances only — but fall back to
    // "all" if there are none (a pure-predictions file), so it never fits on an empty set.
    const useUser = ctx.config.baselineSource === "user" && ctx.userMask?.some(Boolean);
    let fitMask = useUser ? ctx.userMask : null;
    // Large datasets: the baseline stats / NN reference / GMM only need a representative SAMPLE, and
    // the NN reference is O(ref²). Cap the fit set so huge files stay feasible — ALL instances are
    // still scored against this reference, just fit on at most MAX_REF of them.
    const max = ctx.config.maxReferenceSize ?? MAX_REF;
    const refCount = fitMask ? fitMask.reduce((a, b) => a + (b ? 1 : 0), 0) : ctx.allPoses.length;
    if (refCount > max) fitMask = capReference(fitMask, ctx.allPoses.length, max);
    ctx._fx = new LabelQCDetector(ctx.config).fitFeatures(ctx.allPoses, ctx.analyzer, fitMask);
  }
  return ctx._fx;
}

const MAX_REF = 4000; // default reference-set cap (see ensureFeatures); overridable via config.maxReferenceSize

/** Evenly-spaced boolean mask selecting at most `max` of the eligible instances (baseMask, or all). */
function capReference(baseMask, n, max) {
  const eligible = [];
  for (let i = 0; i < n; i++) if (!baseMask || baseMask[i]) eligible.push(i);
  if (eligible.length <= max) return baseMask;
  const out = new Array(n).fill(false);
  const stride = eligible.length / max;
  for (let k = 0; k < max; k++) out[eligible[Math.floor(k * stride)]] = true;
  return out;
}

// Visit each instance once, aligned with the flat allPoses / feature-matrix row order.
function eachInstance(ctx, fn) {
  let row = 0;
  for (const f of ctx.frames) {
    for (let i = 0; i < f.poses.length; i++) {
      fn(f, i, row, `${f.videoIdx}:${f.frameIdx}:${i}`);
      row++;
    }
  }
}

/** ZScore geometric anomaly: per-instance score + raw feature contributions. */
export function computeAnomalyUnit(ctx) {
  const fx = ensureFeatures(ctx);
  const det = new ZScoreDetector(3.0).fit(fx.fitRawMatrix);
  const instanceScores = new Map();
  const contributions = new Map();
  eachInstance(ctx, (f, i, row, key) => {
    const s = det.scoreOne(fx.cleanMatrix[row]);
    instanceScores.set(key, Number.isFinite(s) ? s : 0);
    const c = {};
    fx.featureNames.forEach((n, j) => (c[n] = fx.rawMatrix[row][j] ?? 0));
    contributions.set(key, c);
  });
  // `fx` (the fitted feature extractor) lets the store attribute a flagged instance's
  // dominant feature to its culprit node on demand (fx.baseline.attribute), so the anomaly
  // verdict can name *which* node — e.g. the isolated invisible node. `det` is returned so a
  // single edited instance can be re-scored against the same fit (no refit) in the review loop.
  return { instanceScores, contributions, featureNames: fx.featureNames, fx, det };
}

/** GaussianMixture probability anomaly: per-instance 1 − percentile(log-likelihood). */
export function computeGmmUnit(ctx) {
  const fx = ensureFeatures(ctx);
  const gmmScores = new Map();
  let det = null;
  try {
    det = new GMMDetector({
      nComponents: ctx.config.gmmNComponents,
      percentileThreshold: ctx.config.gmmPercentileThreshold,
    }).fit(fx.fitRawMatrix);
  } catch {
    det = null; // too few instances to fit a mixture — leave the unit empty
  }
  if (det) {
    eachInstance(ctx, (f, i, row, key) => {
      const s = det.scoreOne(fx.cleanMatrix[row]);
      gmmScores.set(key, Number.isFinite(s) ? s : 0);
    });
  }
  // `det` + the shared feature extractor (ctx._fx) let the store localize a flagged
  // instance to a node on demand (leave-one-node-out), so GMM can show *where* it's wrong.
  return { gmmScores, fitted: det != null, det, fx };
}

/** Frame-level checks: instance count, negative-with-instances, duplicates. */
export function computeFrameUnit(ctx) {
  const det = new LabelQCDetector(ctx.config);
  det.countChecker = new InstanceCountChecker(true).fit(ctx.frameCounts, ctx.videoIds);
  const frameResults = new Map();
  for (const f of ctx.frames) {
    frameResults.set(`${f.videoIdx}:${f.frameIdx}`, det.checkFrame(f.poses, f.vid, f.isNegative, f.conf));
  }
  return { frameResults };
}

/**
 * Chirality — whole-instance L/R mirror flip. Learns each symmetric pair's canonical side
 * from the file's own instances (fit on ctx.allPoses), then scores the wrong-side fraction
 * per instance. Coordinate-only; self-disables (empty maps) when the skeleton has no
 * symmetry pairs (and none can be name-inferred). A hard rule promotes a majority-wrong
 * instance (fraction >= 0.5) to a >= 0.9 score so it always clears the flag threshold.
 */
export function computeChiralityUnit(ctx) {
  const sk = ctx.labels?.skeletons?.[0];
  const names = sk?.nodeNames ?? sk?.nodes?.map((n) => n.name) ?? [];
  const inputs = resolveChiralityInputs(ctx.analyzer, names, ctx.allPoses);
  if (!inputs) return { chiralityScores: new Map(), chiralityWorst: new Map(), fitted: false };
  const model = new ChiralityModel().fit(ctx.allPoses, inputs);
  const chiralityScores = new Map();
  const chiralityWorst = new Map();
  eachInstance(ctx, (f, i, row, key) => {
    const { score, worstNode } = chiralityScoreOne(model, ctx.allPoses[row]);
    chiralityScores.set(key, score);
    chiralityWorst.set(key, worstNode);
  });
  // `model` is returned so a single edited instance can be re-scored without refitting.
  return { chiralityScores, chiralityWorst, model, fitted: true };
}

/** Score one pose against a fitted ChiralityModel — the hard rule + wrong-pair node, shared by
 *  the batch unit and the review loop's single-instance re-score. */
export function chiralityScoreOne(model, pose) {
  const r = model.scoreInstance(pose);
  const score = r.wrongFraction >= 0.5 ? Math.max(0.9, r.wrongFraction) : r.wrongFraction; // hard rule
  return { score: Number.isFinite(score) ? score : 0, worstNode: r.wrongPairs.size ? firstWrongPairNode(r.wrongPairs) : -1 };
}

/**
 * Keypoint chain-ordering — flags instances whose keypoints are labeled out of order along an
 * ordered chain (sharp turning angles and/or self-crossing segments). Deterministic / scale-
 * invariant (a hard rule, like chirality), keyed to the skeleton's curvature chains. Per instance
 * it returns the raw `orderInversionRate` + `chainIntersectionCount` (also written to the CSV) and
 * a combined `score` for flagging: a crossing forces 1.0, else the inversion rate.
 */
export function computeOrderingUnit(ctx) {
  const sk = ctx.labels?.skeletons?.[0];
  const names = sk?.nodeNames ?? sk?.nodes?.map((n) => n.name) ?? [];
  // Only run ordering on SEQUENTIAL segments — split chains at junction nodes (any node whose
  // skeleton degree != 2) so a hub (e.g. `nose` -> ear_left/ear_right/trunk) is never a flagged
  // interior. Fully general: `analyzer.degree` is derived from the skeleton's edges, so this adapts
  // to whatever topology the file has (star, tail, multi-limb …) with no per-skeleton assumptions.
  const chains = linearizeChains(
    resolveChains(names, ctx.config.orderedChains ?? null, ctx.analyzer.getCurvatureChains()),
    ctx.analyzer.degree,
  );
  const orderingScores = new Map();
  const orderInversion = new Map();
  const chainIntersection = new Map();
  const orderingWorst = new Map();
  if (chains.length) {
    eachInstance(ctx, (f, i, row, key) => {
      const r = orderingScoreOne(chains, ctx.allPoses[row]);
      orderInversion.set(key, r.orderInversion);
      chainIntersection.set(key, r.chainIntersection);
      orderingWorst.set(key, r.worstNode);
      orderingScores.set(key, r.score);
    });
  }
  return { orderingScores, orderInversion, chainIntersection, orderingWorst, chains, fitted: chains.length > 0 };
}

/** Score one pose against the ordered chains — shared by the batch unit and the review re-score. */
export function orderingScoreOne(chains, pose) {
  const r = computeChainOrdering(pose, chains);
  return {
    score: r.chainIntersectionCount >= 1 ? 1.0 : r.orderInversionRate, // a crossing forces a flag
    orderInversion: r.orderInversionRate,
    chainIntersection: r.chainIntersectionCount,
    worstNode: r.worstNode,
  };
}

/**
 * Split pose / chimera — one instance whose keypoints span two animals, joined by an abnormally
 * stretched "bridging" edge (see features/poseSplit.js). A standalone structural check (its own
 * toggle + threshold + bridge-node attribution) rather than a feature folded into the GMM/anomaly
 * vector. Uses the fitted edge-length stats (the bridge z-score), so it depends on the same `fx`.
 */
export function poseSplitScoreOne(fx, pose) {
  const ps = computePoseSplit(pose, fx._adjacency, fx.baseline.stats.edgeMeans, fx.baseline.stats.edgeStds);
  return {
    score: ps.splitScore / (ps.splitScore + 1), // saturating [0,1]: raw 1 -> 0.5, larger -> 1
    splitScore: ps.splitScore,
    worstNode: ps.bridge ? ps.bridge[0] : -1, // an endpoint of the over-stretched bridge edge
  };
}

export function computePoseSplitUnit(ctx) {
  const fx = ensureFeatures(ctx);
  const poseSplitScores = new Map();
  const poseSplitWorst = new Map();
  eachInstance(ctx, (f, i, row, key) => {
    const r = poseSplitScoreOne(fx, ctx.allPoses[row]);
    poseSplitScores.set(key, r.score);
    poseSplitWorst.set(key, r.worstNode);
  });
  return { poseSplitScores, poseSplitWorst, fx };
}

