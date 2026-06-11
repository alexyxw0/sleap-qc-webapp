// Port of sleap/qc/detector.py + gmm.py — orchestrates the per-instance feature vector
// (18 features) into an anomaly score and runs the frame-level checks.
//
// Detector selection mirrors Python: GaussianMixture when n_instances >= gmm_min_samples
// (50), else the ZScoreDetector. The GMM *scoring* matches sklearn to ~1e-9 (validated by
// loading sklearn's fitted params); the EM *fit* is a faithful re-implementation but is
// not bit-identical to sklearn (different RNG / k-means init).

import { mean, std, visibilityMask } from "./util.js";
import { GMMDetector } from "./gmm.js";
import { SpatialPrior } from "./spatial.js";
import { makeQCConfig, shouldUseCurvature } from "./config.js";
import { BaselineFeatureExtractor, BASELINE_FEATURE_NAMES } from "./features/baseline.js";
import { computeCurvature, computeConvexHull } from "./features/structural.js";
import { VisibilityModel } from "./features/visibility.js";
import { NearestNeighborScorer } from "./features/reference.js";
import { analyzerFromSkeleton } from "./features/skeleton.js";
import { InstanceCountChecker, checkNegativeFrame, detectDuplicates } from "./frameLevel.js";

export const V3_FEATURE_NAMES = [
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
    this.analyzer = analyzer;
    this.baseline = new BaselineFeatureExtractor(analyzer.edges, analyzer.nNodes, analyzer.symmetryPairs).fit(instances);
    this.visibility = new VisibilityModel().fit(instances.map(visibilityMask));
    this.nn = new NearestNeighborScorer({ normalize: true }).fit(instances);
    this._trainingNN = this.nn.looDistances();

    const areas = instances.map((p) => computeConvexHull(p).hullArea).filter((a) => a > 0);
    this._hullStats = { mean: areas.length ? mean(areas) : 1, std: areas.length ? std(areas) : 1 };

    this.featureNames = [...BASELINE_FEATURE_NAMES, ...V3_FEATURE_NAMES];
    const matrix = instances.map((p, i) => this.extractFeatures(p, this._trainingNN[i]));

    // GMM for a large enough reference set, else the z-score fallback (mirrors Python).
    if (instances.length >= this.config.gmmMinSamples && this.config.useGmm) {
      this.detector = new GMMDetector({
        nComponents: this.config.gmmNComponents,
        percentileThreshold: this.config.gmmPercentileThreshold,
      }).fit(matrix);
      this.usedGmm = true;
    } else {
      this.detector = new ZScoreDetector(3.0).fit(matrix);
      this.usedGmm = false;
    }

    // Per-node spatial prior — drives the per-keypoint "worst node" indicator (the red ring).
    // Pure geometry; independent of the instance scorer above.
    this.spatial = this.config.spatialPrior
      ? new SpatialPrior().fit(instances, analyzer.nNodes)
      : null;

    this.countChecker = new InstanceCountChecker(true).fit(frameCounts, videoIds);
    return this;
  }

  /** 18-dim feature vector for one pose. */
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
    const out = { score: Number.isFinite(score) ? score : 0, contributions };
    if (this.spatial) {
      const w = this.spatial.worstNode(pose);
      out.nodeScores = w.scores;
      out.worstNode = w.index;
      out.worstNodeDist = w.dist;
    }
    return out;
  }

  /** Frame-level QC for a frame's poses. */
  checkFrame(poses, videoId, isNegative = false) {
    const count = this.countChecker.check(poses.length, videoId);
    const fq = {
      isIncomplete: count.isIncomplete,
      expectedInstanceCount: Math.round(count.expectedCount),
      actualInstanceCount: poses.length,
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
  const nodeScores = new Map(); // key -> per-node Mahalanobis[]
  const worstNodes = new Map(); // key -> worst node index
  const frameResults = new Map();
  for (const f of frames) {
    f.poses.forEach((pose, instIdx) => {
      const key = `${f.videoIdx}:${f.frameIdx}:${instIdx}`;
      const r = det.scoreInstance(pose);
      instanceScores.set(key, r.score);
      contributions.set(key, r.contributions);
      if (r.nodeScores) {
        nodeScores.set(key, r.nodeScores);
        worstNodes.set(key, r.worstNode);
      }
    });
    frameResults.set(`${f.videoIdx}:${f.frameIdx}`, det.checkFrame(f.poses, f.vid, f.isNegative));
  }
  return {
    instanceScores, contributions, nodeScores, worstNodes,
    frameResults, featureNames: det.featureNames, usedGmm: det.usedGmm,
  };
}
