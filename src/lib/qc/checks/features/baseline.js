// Port of sleap/qc/features/baseline.py — the 12 baseline (v2) per-instance features.

import { isVisible, dist, mean, std, safeMean, safeStd, maxAbs, meanAbs, bbox } from "../util.js";

export const BASELINE_FEATURE_NAMES = [
  "max_edge_zscore", "mean_edge_zscore", "max_angle_zscore", "mean_angle_zscore",
  "max_pairwise_zscore", "mean_pairwise_zscore", "bbox_area_zscore",
  "max_centroid_distance", "centroid_distance_std", "min_symmetry_consistency",
  "visibility_rate", "has_isolated_invisible",
];

const edgeKey = (a, b) => (a < b ? `${a},${b}` : `${b},${a}`);
const norm2 = (v) => Math.hypot(v[0], v[1]);
const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];

export class BaselineFeatureExtractor {
  constructor(edges, nNodes, symmetryPairs = []) {
    this.edges = edges;
    this.nNodes = nNodes;
    this.symmetryPairs = symmetryPairs;
    this.stats = null;
    this._adjacency = null;
  }

  // adjacency[i] = list of neighbor node indices
  _buildAdjacency() {
    const adj = Array.from({ length: this.nNodes }, () => []);
    for (const [s, d] of this.edges) { adj[s].push(d); adj[d].push(s); }
    this._adjacency = adj;
  }

  // joint-angle triplets keyed (center, min(n1,n2), max(n1,n2))
  _angleTriplets() {
    const out = [];
    this._adjacency.forEach((neighbors, center) => {
      if (neighbors.length < 2) return;
      for (let i = 0; i < neighbors.length; i++)
        for (let j = i + 1; j < neighbors.length; j++)
          out.push([center, Math.min(neighbors[i], neighbors[j]), Math.max(neighbors[i], neighbors[j])]);
    });
    return out;
  }

  fit(instances) {
    this._buildAdjacency();
    const edgeLen = new Map(this.edges.map((e) => [edgeKey(e[0], e[1]), []]));
    const pairwise = new Map();
    for (let i = 0; i < this.nNodes; i++)
      for (let j = i + 1; j < this.nNodes; j++) pairwise.set(`${i},${j}`, []);
    const angles = new Map(this._angleTriplets().map((t) => [t.join(","), []]));

    const bboxAreas = [];
    for (const pose of instances) {
      for (const [s, d] of this.edges) {
        if (isVisible(pose[s]) && isVisible(pose[d])) edgeLen.get(edgeKey(s, d)).push(dist(pose[s], pose[d]));
      }
      for (let i = 0; i < this.nNodes; i++)
        for (let j = i + 1; j < this.nNodes; j++)
          if (isVisible(pose[i]) && isVisible(pose[j])) pairwise.get(`${i},${j}`).push(dist(pose[i], pose[j]));
      this._adjacency.forEach((neighbors, center) => {
        if (neighbors.length < 2 || !isVisible(pose[center])) return;
        for (let i = 0; i < neighbors.length; i++)
          for (let j = i + 1; j < neighbors.length; j++) {
            const n1 = neighbors[i], n2 = neighbors[j];
            if (!isVisible(pose[n1]) || !isVisible(pose[n2])) continue;
            const a = this._angle(pose[center], pose[n1], pose[n2]);
            if (a != null) angles.get([center, Math.min(n1, n2), Math.max(n1, n2)].join(",")).push(a);
          }
      });
      const box = bbox(pose);
      if (box) bboxAreas.push((box[2] - box[0]) * (box[3] - box[1]));
    }

    const meanMap = (m) => new Map([...m].map(([k, v]) => [k, safeMean(v)]));
    const stdMap = (m) => new Map([...m].map(([k, v]) => [k, safeStd(v)]));
    this.stats = {
      edgeMeans: meanMap(edgeLen), edgeStds: stdMap(edgeLen),
      pairwiseMeans: meanMap(pairwise), pairwiseStds: stdMap(pairwise),
      angleMeans: meanMap(angles), angleStds: stdMap(angles),
      bboxAreaMean: safeMean(bboxAreas), bboxAreaStd: safeStd(bboxAreas),
    };
    return this;
  }

  // Angle at `center` between vectors to p1, p2 (radians); null if degenerate.
  _angle(center, p1, p2) {
    const v1 = sub(p1, center), v2 = sub(p2, center);
    const n1 = norm2(v1), n2 = norm2(v2);
    if (n1 < 1e-6 || n2 < 1e-6) return null;
    const cos = Math.max(-1, Math.min(1, (v1[0] * v2[0] + v1[1] * v2[1]) / (n1 * n2)));
    return Math.acos(cos);
  }

  extract(pose) {
    if (!this.stats) throw new Error("Must call fit() before extract()");
    const edgeZ = this._edgeZscores(pose);
    const angleZ = this._angleZscores(pose);
    const pwZ = this._pairwiseZscores(pose);
    const cent = this._centroidDistances(pose);
    const [visRate, isolated] = this._visibilityFeatures(pose);
    return [
      maxAbs(edgeZ), meanAbs(edgeZ),
      maxAbs(angleZ), meanAbs(angleZ),
      maxAbs(pwZ), meanAbs(pwZ),
      this._bboxZscore(pose),
      cent.length ? Math.max(...cent) : 0,
      cent.length ? std(cent) : 0,
      this._symmetryConsistency(pose),
      visRate,
      isolated ? 1 : 0,
    ];
  }

  _edgeZscores(pose) {
    const z = [];
    for (const [s, d] of this.edges) {
      if (!isVisible(pose[s]) || !isVisible(pose[d])) continue;
      const k = edgeKey(s, d);
      if (this.stats.edgeMeans.has(k)) z.push((dist(pose[s], pose[d]) - this.stats.edgeMeans.get(k)) / this.stats.edgeStds.get(k));
    }
    return z;
  }
  _angleZscores(pose) {
    const z = [];
    this._adjacency.forEach((neighbors, center) => {
      if (neighbors.length < 2 || !isVisible(pose[center])) return;
      for (let i = 0; i < neighbors.length; i++)
        for (let j = i + 1; j < neighbors.length; j++) {
          const n1 = neighbors[i], n2 = neighbors[j];
          if (!isVisible(pose[n1]) || !isVisible(pose[n2])) continue;
          const a = this._angle(pose[center], pose[n1], pose[n2]);
          if (a == null) continue;
          const k = [center, Math.min(n1, n2), Math.max(n1, n2)].join(",");
          if (this.stats.angleMeans.has(k)) z.push((a - this.stats.angleMeans.get(k)) / this.stats.angleStds.get(k));
        }
    });
    return z;
  }
  _pairwiseZscores(pose) {
    const z = [];
    for (let i = 0; i < this.nNodes; i++)
      for (let j = i + 1; j < this.nNodes; j++) {
        if (!isVisible(pose[i]) || !isVisible(pose[j])) continue;
        const k = `${i},${j}`;
        z.push((dist(pose[i], pose[j]) - this.stats.pairwiseMeans.get(k)) / this.stats.pairwiseStds.get(k));
      }
    return z;
  }
  _bboxZscore(pose) {
    const box = bbox(pose);
    if (!box) return 0;
    const area = (box[2] - box[0]) * (box[3] - box[1]);
    return (area - this.stats.bboxAreaMean) / this.stats.bboxAreaStd;
  }
  _centroidDistances(pose) {
    const vis = pose.filter(isVisible);
    if (vis.length < 2) return [];
    const cx = vis.reduce((s, p) => s + p[0], 0) / vis.length;
    const cy = vis.reduce((s, p) => s + p[1], 0) / vis.length;
    return vis.map((p) => Math.hypot(p[0] - cx, p[1] - cy));
  }
  _symmetryConsistency(pose) {
    if (this.symmetryPairs.length < 2) return 1.0;
    const scores = [];
    for (let i = 0; i < this.symmetryPairs.length; i++) {
      const [l1, r1] = this.symmetryPairs[i];
      if (!isVisible(pose[l1]) || !isVisible(pose[r1])) continue;
      let consistent = 0, total = 0;
      for (let j = 0; j < this.symmetryPairs.length; j++) {
        if (i === j) continue;
        const [l2, r2] = this.symmetryPairs[j];
        if (!isVisible(pose[l2]) || !isVisible(pose[r2])) continue;
        const ratio = dist(pose[l1], pose[l2]) / Math.max(dist(pose[l1], pose[r2]), 1e-6);
        if (ratio < 0.9) consistent += 1;
        else if (ratio <= 1.1) consistent += 0.5;
        total += 1;
      }
      if (total > 0) scores.push(consistent / total);
    }
    return scores.length ? Math.min(...scores) : 1.0;
  }
  _visibilityFeatures(pose) {
    const visMask = pose.map(isVisible);
    const visRate = visMask.filter(Boolean).length / this.nNodes;
    let isolated = false;
    for (let i = 0; i < this.nNodes; i++) {
      if (visMask[i]) continue;
      const nb = this._adjacency[i];
      if (nb.length && nb.every((n) => visMask[n])) { isolated = true; break; }
    }
    return [visRate, isolated];
  }
}
