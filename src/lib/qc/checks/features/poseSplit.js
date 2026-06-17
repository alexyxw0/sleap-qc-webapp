// Port of sleap/qc/features/pose_split.py — chimera (pose-split) detector.
//
// A *chimera* is one labeled instance whose keypoints span two animals (head of A +
// abdomen of B), joined by a single abnormally-stretched "bridging" edge. The graph signal:
//   1. On the visible subgraph, find the edge with the largest length z-score (the bridge).
//   2. Cut it; require a clean split into exactly TWO components.
//   3. split_score = GATED PRODUCT of bridge-z x balance(split_ratio) x gap_term(gap_ratio).
// All three must be high, which suppresses normal poses, single-node strays (unbalanced),
// partial occlusion (>2 components), and two genuinely-close merged animals (small gap).
// Star / short / adjacency-less skeletons use a skeleton-agnostic 2-means bimodality
// fallback (deterministic 2-means here vs sklearn KMeans upstream; the silhouette + gap
// gating makes the exact clustering non-load-bearing).

import { isVisible, dist } from "../util.js";

export const MIN_VISIBLE_NODES = 4;
const EPS = 1e-9;
const FALLBACK_SILHOUETTE_FLOOR = 0.5; // mean silhouette below this => not bimodal
const GAP_FLOOR = 1.5; // gap_ratio must clear this before it contributes
const BAL_LO = 0.18; // balance ramps 0 -> 1 across [0.18, 0.30]
const BAL_HI = 0.30;

const edgeKey = (i, j) => (i < j ? `${i},${j}` : `${j},${i}`);
const d2 = (a, b) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2;

function visibleIndices(points) {
  const out = [];
  for (let i = 0; i < points.length; i++) if (isVisible(points[i])) out.push(i);
  return out;
}

/** Mean distance of a cluster's points to their centroid (0 for < 2 points). */
function clusterSpread(points, indices) {
  if (indices.length < 2) return 0;
  let cx = 0, cy = 0;
  for (const i of indices) { cx += points[i][0]; cy += points[i][1]; }
  cx /= indices.length; cy /= indices.length;
  let s = 0;
  for (const i of indices) s += Math.hypot(points[i][0] - cx, points[i][1] - cy);
  return s / indices.length;
}

/** Connected components of a node set after removing one edge (union-find). */
function componentsAfterCut(nodes, edges, cutEdge) {
  const parent = new Map(nodes.map((n) => [n, n]));
  const find = (x) => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r);
    while (parent.get(x) !== r) { const nx = parent.get(x); parent.set(x, r); x = nx; }
    return r;
  };
  for (const [i, j] of edges) {
    if (i === cutEdge[0] && j === cutEdge[1]) continue;
    const ra = find(i), rb = find(j);
    if (ra !== rb) parent.set(ra, rb);
  }
  const groups = new Map();
  for (const n of nodes) { const r = find(n); if (!groups.has(r)) groups.set(r, []); groups.get(r).push(n); }
  return [...groups.values()];
}

/** Median within-cluster nearest-neighbor spacing (normalizes the boundary gap). */
function typicalWithinSpacing(ptsA, ptsB) {
  const nn = [];
  for (const pts of [ptsA, ptsB]) {
    if (pts.length < 2) continue;
    for (let i = 0; i < pts.length; i++) {
      let best = Infinity;
      for (let j = 0; j < pts.length; j++) if (i !== j) best = Math.min(best, d2(pts[i], pts[j]));
      nn.push(Math.sqrt(best));
    }
  }
  if (!nn.length) return 0;
  nn.sort((a, b) => a - b);
  const m = nn.length >> 1;
  return nn.length % 2 ? nn[m] : (nn[m - 1] + nn[m]) / 2;
}

/** Mean silhouette coefficient for a 2-cluster split (~1 tight+separated, ~0 arbitrary). */
function silhouetteLike(ptsA, ptsB) {
  const scores = [];
  for (const [own, other] of [[ptsA, ptsB], [ptsB, ptsA]]) {
    for (let k = 0; k < own.length; k++) {
      const p = own[k];
      let a = 0;
      if (own.length > 1) { for (let i = 0; i < own.length; i++) a += Math.hypot(own[i][0] - p[0], own[i][1] - p[1]); a /= own.length - 1; }
      let b = 0;
      for (let i = 0; i < other.length; i++) b += Math.hypot(other[i][0] - p[0], other[i][1] - p[1]);
      b = other.length ? b / other.length : 0;
      const denom = Math.max(a, b);
      scores.push(denom > EPS ? (b - a) / denom : 0);
    }
  }
  return scores.length ? scores.reduce((s, x) => s + x, 0) / scores.length : 0;
}

/** split_ratio -> 0..1 balance weight (0 below 0.18, ramps to 1 by 0.30). */
function balanceFactor(splitRatio) {
  if (splitRatio <= BAL_LO) return 0;
  if (splitRatio >= BAL_HI) return 1;
  return (splitRatio - BAL_LO) / (BAL_HI - BAL_LO);
}

/** Gated product of the sub-signals; any one small drives the score toward 0. */
function combineScore(bridgeZ, splitRatio, gapRatio, isFallback, silhouette = 1) {
  const bridgeTerm = Math.max(bridgeZ, 0);
  const balance = balanceFactor(splitRatio);
  const gapTerm = Math.max(gapRatio - GAP_FLOOR, 0);
  if (isFallback) {
    if (silhouette < FALLBACK_SILHOUETTE_FLOOR) return 0;
    return balance * gapTerm;
  }
  return bridgeTerm * balance * gapTerm;
}

/** Heuristic: is the visible subgraph a star (one hub touching ~all edges)? */
function isStarLike(edges, nVis) {
  if (nVis < 4 || edges.length === 0) return false;
  const degree = new Map();
  for (const [i, j] of edges) { degree.set(i, (degree.get(i) ?? 0) + 1); degree.set(j, (degree.get(j) ?? 0) + 1); }
  const maxDeg = Math.max(...degree.values());
  return maxDeg >= nVis - 1 && maxDeg >= edges.length - 1;
}

/** Deterministic 2-means (init at the two farthest visible points) -> labels[] in {0,1}. */
function kmeans2(coords) {
  let i0 = 0, i1 = coords.length > 1 ? 1 : 0, best = -1;
  for (let i = 0; i < coords.length; i++) for (let j = i + 1; j < coords.length; j++) {
    const dd = d2(coords[i], coords[j]);
    if (dd > best) { best = dd; i0 = i; i1 = j; }
  }
  let cA = coords[i0], cB = coords[i1];
  const labels = new Array(coords.length).fill(0);
  for (let iter = 0; iter < 50; iter++) {
    let changed = false;
    for (let k = 0; k < coords.length; k++) {
      const la = d2(coords[k], cA) <= d2(coords[k], cB) ? 0 : 1;
      if (labels[k] !== la) { labels[k] = la; changed = true; }
    }
    let ax = 0, ay = 0, bx = 0, by = 0, nA = 0, nB = 0;
    for (let k = 0; k < coords.length; k++) {
      if (labels[k] === 0) { ax += coords[k][0]; ay += coords[k][1]; nA++; }
      else { bx += coords[k][0]; by += coords[k][1]; nB++; }
    }
    if (nA === 0 || nB === 0) break;
    cA = [ax / nA, ay / nA];
    cB = [bx / nB, by / nB];
    if (!changed) break;
  }
  return labels;
}

/** Skeleton-agnostic 2-means bimodality fallback. -> { splitScore, splitRatio, gapRatio, bridge:null }. */
export function computePoseSplitFallback(points, minVisible = MIN_VISIBLE_NODES) {
  const zero = { splitScore: 0, splitRatio: 0, gapRatio: 0, bridge: null };
  const visIdx = visibleIndices(points);
  if (visIdx.length < minVisible) return { ...zero };
  const coords = visIdx.map((i) => points[i]);
  const labels = kmeans2(coords);
  const ptsA = [], ptsB = [];
  for (let k = 0; k < coords.length; k++) (labels[k] === 0 ? ptsA : ptsB).push(coords[k]);
  if (!ptsA.length || !ptsB.length) return { ...zero };
  const nSmall = Math.min(ptsA.length, ptsB.length);
  const splitRatio = nSmall / visIdx.length;
  let boundaryGap = Infinity;
  for (const a of ptsA) for (const b of ptsB) boundaryGap = Math.min(boundaryGap, d2(a, b));
  boundaryGap = Math.sqrt(boundaryGap);
  const within = typicalWithinSpacing(ptsA, ptsB);
  const gapRatio = boundaryGap / Math.max(within, EPS);
  const silhouette = silhouetteLike(ptsA, ptsB);
  const splitScore = combineScore(gapRatio, splitRatio, gapRatio, true, silhouette);
  return { splitScore, splitRatio, gapRatio, bridge: null };
}

/**
 * Chimera score for one pose. adjacency: array node->neighbor indices (or null);
 * edgeMeans/edgeStds: Maps keyed "min,max" (reuse BaselineFeatureExtractor.stats).
 * -> { splitScore (>=0, unbounded), splitRatio, gapRatio, bridge:[i,j]|null }.
 */
export function computePoseSplit(points, adjacency, edgeMeans, edgeStds, minVisible = MIN_VISIBLE_NODES) {
  const zero = { splitScore: 0, splitRatio: 0, gapRatio: 0, bridge: null };
  const visArr = visibleIndices(points);
  const nVis = visArr.length;
  if (nVis < minVisible) return { ...zero };
  if (!adjacency) return computePoseSplitFallback(points, minVisible);
  const visSet = new Set(visArr);

  const visibleEdges = [];
  const seen = new Set();
  let bestZ = -Infinity, bestEdge = null;
  for (let node = 0; node < adjacency.length; node++) {
    if (!visSet.has(node)) continue;
    for (const nb of adjacency[node]) {
      if (!visSet.has(nb)) continue;
      const lo = Math.min(node, nb), hi = Math.max(node, nb);
      const k = `${lo},${hi}`;
      if (seen.has(k)) continue;
      seen.add(k);
      visibleEdges.push([lo, hi]);
      const mean = edgeMeans?.get(k);
      const std = edgeStds?.get(k);
      if (mean == null || std == null) continue;
      const length = dist(points[lo], points[hi]);
      const z = (length - mean) / Math.max(std, EPS);
      if (z > bestZ) { bestZ = z; bestEdge = [lo, hi]; }
    }
  }

  // Graph signal unusable (no z-scored edge, too few edges, or a star) -> fallback.
  if (!bestEdge || visibleEdges.length < 2 || isStarLike(visibleEdges, nVis)) {
    return computePoseSplitFallback(points, minVisible);
  }

  const nodesList = [...visArr].sort((a, b) => a - b);
  const components = componentsAfterCut(nodesList, visibleEdges, bestEdge);
  if (components.length !== 2) return { ...zero }; // not a clean bridge

  const [idxA, idxB] = components;
  const nSmall = Math.min(idxA.length, idxB.length);
  const splitRatio = nSmall / nVis;
  const cen = (idx) => {
    let cx = 0, cy = 0;
    for (const i of idx) { cx += points[i][0]; cy += points[i][1]; }
    return [cx / idx.length, cy / idx.length];
  };
  const ca = cen(idxA), cb = cen(idxB);
  const gap = Math.hypot(ca[0] - cb[0], ca[1] - cb[1]);
  const maxSpread = Math.max(clusterSpread(points, idxA), clusterSpread(points, idxB));
  const gapRatio = gap / Math.max(maxSpread, EPS);
  const splitScore = combineScore(bestZ, splitRatio, gapRatio, false);
  return { splitScore, splitRatio, gapRatio, bridge: bestEdge };
}
