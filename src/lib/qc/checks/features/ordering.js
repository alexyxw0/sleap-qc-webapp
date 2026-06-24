// Port of sleap/qc/features/ordering.py — keypoint chain-ordering via turning angles + crossings.
//
// Detects nodes labeled out of order along an ordered chain (e.g. a tail
// TTI -> Tail_0 -> Tail_1 -> Tail_2 -> TailTip). Consecutive chain segments are vectors
// v_i = node_i - node_{i-1}; the TURNING ANGLE at each interior node (angle between v_i and
// v_{i+1}) is gentle for a correctly-ordered chain (even a curled one) and sharp for a swap. A
// non-adjacent swap additionally makes two non-adjacent segments geometrically CROSS — a strong,
// unambiguous signal. Both metrics are invariant to translation/rotation/uniform-scale (a hard
// geometric rule — no learned per-dataset stats, like chirality).

const DEFAULT_MAX_TURN_ANGLE = (60.0 * Math.PI) / 180; // sharp-reversal threshold (radians)
const EPS = 1e-8;

const isMissing = (p) => !p || Number.isNaN(p[0]) || Number.isNaN(p[1]);

/** Turning (deflection) angle in [0, pi] between consecutive segment vectors; NaN if either is ~0. */
function turningAngle(v1, v2) {
  const n1 = Math.hypot(v1[0], v1[1]);
  const n2 = Math.hypot(v2[0], v2[1]);
  if (n1 < EPS || n2 < EPS) return Number.NaN;
  let cos = (v1[0] * v2[0] + v1[1] * v2[1]) / (n1 * n2);
  cos = Math.max(-1, Math.min(1, cos));
  return Math.acos(cos);
}

/** Whether open segment p1->p2 properly crosses p3->p4 (orientation / signed-area straddle test). */
function segmentsIntersect(p1, p2, p3, p4) {
  const orient = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  const d1 = orient(p3, p4, p1);
  const d2 = orient(p3, p4, p2);
  const d3 = orient(p1, p2, p3);
  const d4 = orient(p1, p2, p4);
  if (d1 > 0 !== d2 > 0 && d3 > 0 !== d4 > 0) {
    // strict straddle on both — guard the collinear/touching (orientation exactly 0) case.
    if (Math.min(Math.abs(d1), Math.abs(d2), Math.abs(d3), Math.abs(d4)) > EPS) return true;
  }
  return false;
}

/**
 * Resolve ordered chains to node-index sequences. A user-declared ordering (lists of node NAMES)
 * is ground truth; otherwise fall back to `autoChains` (index sequences, e.g. curvature chains).
 * Chains with fewer than 3 resolvable nodes are dropped (need an interior turning angle).
 */
export function resolveChains(nodeNames, orderedChainsByName, autoChains) {
  const nameToIdx = new Map((nodeNames ?? []).map((n, i) => [n, i]));
  if (orderedChainsByName?.length) {
    const resolved = [];
    for (const chain of orderedChainsByName) {
      const idx = chain.map((nm) => nameToIdx.get(nm)).filter((i) => i != null);
      if (idx.length >= 3) resolved.push(idx);
    }
    if (resolved.length) return resolved;
  }
  return (autoChains ?? []).filter((c) => c.length >= 3).map((c) => [...c]);
}

/**
 * Detect wrong keypoint order along ordered chains. Returns:
 *  - orderInversionRate: max over chains of the fraction of interior nodes whose turning angle
 *    exceeds `maxTurnAngle`.
 *  - chainIntersectionCount: max over chains of the number of crossing NON-adjacent segment pairs.
 *  - maxTurnAngle (radians): largest turning angle at any interior node.
 *  - worstChain / worstNode: chain + interior node index with the largest turning angle (-1 if none).
 */
export function computeChainOrdering(points, chains, maxTurnAngle = DEFAULT_MAX_TURN_ANGLE) {
  const out = { orderInversionRate: 0, chainIntersectionCount: 0, maxTurnAngle: 0, worstChain: [], worstNode: -1 };
  if (!chains?.length) return out;

  for (const chain of chains) {
    if (chain.length < 3) continue;

    // turning angles at interior nodes
    let nInterior = 0, nInversions = 0;
    for (let i = 1; i < chain.length - 1; i++) {
      const pPrev = points[chain[i - 1]], pCurr = points[chain[i]], pNext = points[chain[i + 1]];
      if (isMissing(pPrev) || isMissing(pCurr) || isMissing(pNext)) continue;
      const v1 = [pCurr[0] - pPrev[0], pCurr[1] - pPrev[1]];
      const v2 = [pNext[0] - pCurr[0], pNext[1] - pCurr[1]];
      const theta = turningAngle(v1, v2);
      if (Number.isNaN(theta)) continue;
      nInterior++;
      if (theta > maxTurnAngle) nInversions++;
      if (theta > out.maxTurnAngle) {
        out.maxTurnAngle = theta;
        out.worstChain = [...chain];
        out.worstNode = chain[i];
      }
    }
    const rate = nInterior > 0 ? nInversions / nInterior : 0;
    if (rate > out.orderInversionRate) out.orderInversionRate = rate;

    // non-adjacent segment crossings
    const segments = [];
    for (let i = 0; i < chain.length - 1; i++) {
      const pa = points[chain[i]], pb = points[chain[i + 1]];
      if (isMissing(pa) || isMissing(pb)) continue;
      segments.push([i, pa, pb]);
    }
    let crossings = 0;
    for (let si = 0; si < segments.length; si++) {
      const [iPos, pa, pb] = segments[si];
      for (let sj = si + 1; sj < segments.length; sj++) {
        const [jPos, pc, pd] = segments[sj];
        if (Math.abs(iPos - jPos) <= 1) continue; // adjacent segments share an endpoint
        if (segmentsIntersect(pa, pb, pc, pd)) crossings++;
      }
    }
    if (crossings > out.chainIntersectionCount) out.chainIntersectionCount = crossings;
  }
  return out;
}
