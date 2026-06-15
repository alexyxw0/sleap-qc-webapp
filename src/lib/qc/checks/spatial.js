// Seam B — egocentric per-node spatial prior (mirrors precompute/qc_precompute/spatial.py).
//
// Fit a per-node 2D Gaussian from the trusted reference set and score each keypoint by its
// Mahalanobis distance — the per-keypoint signal that says WHICH node is wrong. Two
// properties matter:
//   • Mahalanobis divides by the node's own covariance, so it is self-normalizing: an
//     intrinsically mobile node (a fly's foreleg/tail) isn't flagged for the same
//     displacement as a rigid node (thorax). That's the de-bias the instance features lacked.
//   • We normalize each node in a LEAVE-ONE-OUT canonical frame built from the *other*
//     visible nodes, so a single badly-placed node can't corrupt its own normalization
//     frame and smear the anomaly across the whole instance.
//
// (Gross multi-node corruption can still shift the frame; those instances are caught by the
// instance-level ECOD score. The spatial prior's strength is localizing moderate errors.)

import { mean, isVisible } from "./util.js";

function inv2([[a, b], [c, d]]) {
  let det = a * d - b * c;
  if (Math.abs(det) < 1e-9) det = det < 0 ? -1e-9 : 1e-9;
  return [[d / det, -b / det], [-c / det, a / det]];
}

// Canonical frame (centroid + bbox-diagonal scale) from a set of [x,y] points.
function frameOf(points) {
  if (points.length < 2) return null;
  const cx = mean(points.map((p) => p[0]));
  const cy = mean(points.map((p) => p[1]));
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  let scale = Math.hypot(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
  if (scale < 1e-6) scale = 1;
  return { cx, cy, scale };
}

// Normalized coordinate of node k using a frame built from all OTHER visible nodes.
function normalizedLOO(pose, k) {
  if (!isVisible(pose[k])) return null;
  const others = [];
  for (let j = 0; j < pose.length; j++) if (j !== k && isVisible(pose[j])) others.push(pose[j]);
  const f = frameOf(others);
  if (!f) return null;
  return [(pose[k][0] - f.cx) / f.scale, (pose[k][1] - f.cy) / f.scale];
}

export class SpatialPrior {
  /** poses: number[][][] (nInstances × nNodes × 2, NaN for invisible). */
  fit(poses, nNodes, { minSamples = 5, reg = 1e-6 } = {}) {
    this.nNodes = nNodes;
    this.priors = new Array(nNodes).fill(null);
    for (let k = 0; k < nNodes; k++) {
      const pts = [];
      for (const pose of poses) {
        const p = normalizedLOO(pose, k);
        if (p) pts.push(p);
      }
      if (pts.length < minSamples) continue;
      const mx = mean(pts.map((p) => p[0]));
      const my = mean(pts.map((p) => p[1]));
      let sxx = 0, syy = 0, sxy = 0;
      for (const [x, y] of pts) {
        sxx += (x - mx) ** 2;
        syy += (y - my) ** 2;
        sxy += (x - mx) * (y - my);
      }
      const n = pts.length;
      const cov = [[sxx / n + reg, sxy / n], [sxy / n, syy / n + reg]];
      this.priors[k] = { mean: [mx, my], prec: inv2(cov) };
    }
    return this;
  }

  /** Per-node Mahalanobis distance for a pose (NaN where invisible / no prior). */
  nodeMahalanobis(pose) {
    const out = new Array(this.nNodes).fill(Number.NaN);
    for (let k = 0; k < this.nNodes; k++) {
      const pr = this.priors[k];
      if (!pr) continue;
      const p = normalizedLOO(pose, k);
      if (!p) continue;
      const dx = p[0] - pr.mean[0];
      const dy = p[1] - pr.mean[1];
      const [[a, b], [c, d]] = pr.prec;
      out[k] = Math.sqrt(Math.max(0, dx * (a * dx + b * dy) + dy * (c * dx + d * dy)));
    }
    return out;
  }

  /** The single most-anomalous node of a pose. */
  worstNode(pose) {
    const scores = this.nodeMahalanobis(pose);
    let index = -1;
    let dist = -Infinity;
    for (let k = 0; k < scores.length; k++) {
      if (!Number.isNaN(scores[k]) && scores[k] > dist) {
        dist = scores[k];
        index = k;
      }
    }
    return { index, dist: index >= 0 ? dist : Number.NaN, scores };
  }
}
