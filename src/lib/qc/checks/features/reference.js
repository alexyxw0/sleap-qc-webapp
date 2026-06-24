// Port of sleap/qc/features/reference.py — normalize_pose and the nearest-neighbor reference
// scorer (brute-force euclidean; the Python KD-tree is just a speed optimization that yields
// identical distances).

import { isVisible, visiblePoints } from "../util.js";

const NAN2 = [Number.NaN, Number.NaN];

/** Center a pose at its visible centroid and scale by its bbox diagonal (NaN preserved). */
export function normalizePose(pose) {
  const vis = visiblePoints(pose);
  if (vis.length < 2) return pose.map((p) => [...p]);
  const cx = vis.reduce((s, p) => s + p[0], 0) / vis.length;
  const cy = vis.reduce((s, p) => s + p[1], 0) / vis.length;
  const minX = Math.min(...vis.map((p) => p[0]));
  const minY = Math.min(...vis.map((p) => p[1]));
  const maxX = Math.max(...vis.map((p) => p[0]));
  const maxY = Math.max(...vis.map((p) => p[1]));
  let scale = Math.hypot(maxX - minX, maxY - minY);
  if (scale < 1e-6) scale = 1.0;
  return pose.map((p) => (isVisible(p) ? [(p[0] - cx) / scale, (p[1] - cy) / scale] : [...NAN2]));
}

// Flatten a normalized pose to a vector with NaN imputed to 0 (mirrors np.nan_to_num),
// matching the KD-tree feature space the Python uses.
const flat = (pose) => pose.flatMap((p) => [Number.isNaN(p[0]) ? 0 : p[0], Number.isNaN(p[1]) ? 0 : p[1]]);
const l2 = (u, v) => Math.hypot(...u.map((x, i) => x - v[i]));

export class NearestNeighborScorer {
  constructor({ normalize = true } = {}) {
    this.normalize = normalize;
    this._refs = null; // flattened reference vectors
  }
  fit(poses) {
    const norm = this.normalize ? poses.map(normalizePose) : poses;
    this._refs = norm.map(flat);
    return this;
  }
  /** Nearest-neighbor distance of a pose against the reference set. */
  score(pose) {
    const q = flat(this.normalize ? normalizePose(pose) : pose);
    let best = Infinity;
    let idx = -1;
    for (let i = 0; i < this._refs.length; i++) {
      const d = l2(q, this._refs[i]);
      if (d < best) { best = d; idx = i; }
    }
    return { nnDistance: best, nnIndex: idx };
  }
  /** Leave-one-out NN distance for every reference pose (training-time signal). */
  looDistances() {
    const out = [];
    for (let i = 0; i < this._refs.length; i++) {
      let best = Infinity;
      for (let j = 0; j < this._refs.length; j++) {
        if (i === j) continue;
        const d = l2(this._refs[i], this._refs[j]);
        if (d < best) best = d;
      }
      out.push(Number.isFinite(best) ? best : 0);
    }
    return out;
  }
}
