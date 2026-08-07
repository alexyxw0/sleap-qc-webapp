// Port of sleap/qc/features/chirality.py — whole-instance left/right mirror-flip detector.
//
// A reflection preserves every edge length and unsigned angle, so a flipped instance is
// INVISIBLE to the 18-feature vector. Chirality needs a *signed* test: learn each symmetric
// L/R pair's canonical side of the body midline from clean labels, then score the fraction
// of co-visible pairs sitting on the wrong side. The "local tangent" construction (project a
// pair's midpoint onto the nearest midline segment) is the upstream fix that stops a curled-
// but-correct animal from reading as flipped.
//
// JS has no SVD: the PCA midline axis uses the largest-eigenvalue eigenvector of the 2x2
// covariance of the centered points (same direction up to sign; sign is irrelevant because
// fit and score share the axis).

import { isVisible } from "../util.js";

const LR_TOKENS = [["left", "right"], ["l", "r"]];
const SEP = "[ _\\-.]?"; // optional single space / underscore / hyphen / dot

/** Unit vector, or null if degenerate / NaN (minNorm floor). */
function normalizeAxis(v, minNorm = 1e-6) {
  if (!v || v.length !== 2 || Number.isNaN(v[0]) || Number.isNaN(v[1])) return null;
  const n = Math.hypot(v[0], v[1]);
  if (n < minNorm) return null;
  return [v[0] / n, v[1] / n];
}

/** First principal axis of the visible non-excluded points (2x2 covariance eigenvector). */
function pcaAxis(points, excludeSet, minPoints = 2, minNorm = 1e-6) {
  const keep = [];
  for (let i = 0; i < points.length; i++) {
    if (excludeSet.has(i) || !isVisible(points[i])) continue;
    keep.push(points[i]);
  }
  if (keep.length < minPoints) return null;
  let ox = 0, oy = 0;
  for (const p of keep) { ox += p[0]; oy += p[1]; }
  ox /= keep.length;
  oy /= keep.length;
  let maxAbs = 0, sxx = 0, syy = 0, sxy = 0;
  for (const p of keep) {
    const cx = p[0] - ox, cy = p[1] - oy;
    if (Math.abs(cx) > maxAbs) maxAbs = Math.abs(cx);
    if (Math.abs(cy) > maxAbs) maxAbs = Math.abs(cy);
    sxx += cx * cx; syy += cy * cy; sxy += cx * cy;
  }
  if (maxAbs < minNorm) return null; // no spread -> no axis
  const n = keep.length;
  sxx /= n; syy /= n; sxy /= n;
  const tr = sxx + syy;
  const det = sxx * syy - sxy * sxy;
  const disc = Math.sqrt(Math.max(0, (tr * tr) / 4 - det));
  const lam = tr / 2 + disc;
  const ev = Math.abs(sxy) > 1e-12 ? [lam - syy, sxy] : sxx >= syy ? [1, 0] : [0, 1];
  const axis = normalizeAxis(ev, minNorm);
  return axis ? { origin: [ox, oy], axis } : null;
}

/** Ordered visible midline nodes as a polyline, or null if < minNodes visible. */
function midlinePolyline(points, midlineIdx, minNodes = 2) {
  if (!midlineIdx || !midlineIdx.length) return null;
  const poly = [];
  for (const i of midlineIdx) if (i >= 0 && i < points.length && isVisible(points[i])) poly.push(points[i]);
  return poly.length < minNodes ? null : poly;
}

/** Nearest-segment projection of a point onto a polyline -> {foot, tangent} (unit tangent). */
function projectPointToPolyline(point, polyline, minNorm = 1e-6) {
  let bestD2 = Infinity, bestFoot = null, bestTan = null;
  for (let k = 0; k < polyline.length - 1; k++) {
    const a = polyline[k], b = polyline[k + 1];
    const abx = b[0] - a[0], aby = b[1] - a[1];
    const segLen2 = abx * abx + aby * aby;
    if (segLen2 < minNorm * minNorm) continue; // skip degenerate segment
    let t = ((point[0] - a[0]) * abx + (point[1] - a[1]) * aby) / segLen2;
    t = Math.max(0, Math.min(1, t));
    const foot = [a[0] + t * abx, a[1] + t * aby];
    const dx = point[0] - foot[0], dy = point[1] - foot[1];
    const d2 = dx * dx + dy * dy;
    if (d2 < bestD2) {
      bestD2 = d2;
      bestFoot = foot;
      const segLen = Math.sqrt(segLen2);
      bestTan = [abx / segLen, aby / segLen];
    }
  }
  return bestTan == null ? null : { foot: bestFoot, tangent: bestTan };
}

/** Signed side (+1/-1/0) of the "left" member relative to the local midline tangent. 0 = "no info":
 *  excluded from both fit and score, so an ambiguous pose neither teaches nor triggers the check.
 *
 *  Two independent degeneracy gates, both needed on real data:
 *
 *  `minLateral` — SIGN CONFIDENCE. |cross| / |rel| is |sin θ| between the pair's offset and the midline
 *  tangent: ~1 when the pair sits across the spine (normal), ~0 when the members are strung out one behind
 *  the other along it, where the sign is noise.
 *
 *  `minStraddle` — the pair must actually STRADDLE the midline (opposite signed offsets, and neither member
 *  essentially on the axis). A curled animal with its head turned foreshortens both ears onto ONE side of
 *  the spine; "which side is the left ear on" is then undefined, and scoring it produced false flips
 *  (observed: ear_l −15, ear_r −99 — both the same side, ear_l practically on the head→neck segment). The
 *  balance is min(|sL|,|sR|) / |sL − sR|, which is 0.5 for a symmetric pair and → 0 as one member
 *  approaches the axis. */
function signedSideLocal(leftPt, rightPt, polyline, minLateral = 0.2, minStraddle = 0.15) {
  if (!isVisible(leftPt) || !isVisible(rightPt)) return null;
  const mid = [(leftPt[0] + rightPt[0]) / 2, (leftPt[1] + rightPt[1]) / 2];
  const proj = projectPointToPolyline(mid, polyline);
  if (!proj) return null;
  const [tx, ty] = proj.tangent;
  const perp = (p) => tx * (p[1] - proj.foot[1]) - ty * (p[0] - proj.foot[0]);
  const sL = perp(leftPt), sR = perp(rightPt);

  const relNorm = Math.hypot(leftPt[0] - proj.foot[0], leftPt[1] - proj.foot[1]);
  if (relNorm < 1e-9 || Math.abs(sL) / relNorm < minLateral) return 0; // pair lies along the axis
  if (sL * sR >= 0) return 0;                                          // both members on one side
  const sep = Math.abs(sL - sR);
  if (sep < 1e-9 || Math.min(Math.abs(sL), Math.abs(sR)) / sep < minStraddle) return 0; // one on the axis
  return Math.sign(sL);
}

/** Resolve the midline polyline: ordered midline nodes -> axis anchors -> PCA fallback. */
function resolveMidline(points, midlineIdx, axisIdx, excludeSet) {
  const poly = midlinePolyline(points, midlineIdx);
  if (poly) return poly;
  if (axisIdx) {
    const [i, j] = axisIdx;
    if (i >= 0 && i < points.length && j >= 0 && j < points.length && i !== j && isVisible(points[i]) && isVisible(points[j])) {
      const seg = [points[i], points[j]];
      if (Math.hypot(seg[1][0] - seg[0][0], seg[1][1] - seg[0][1]) >= 1e-6) return seg;
    }
  }
  const pca = pcaAxis(points, excludeSet);
  if (!pca) return null;
  return [pca.origin, [pca.origin[0] + pca.axis[0], pca.origin[1] + pca.axis[1]]];
}

/** Learn each pair's canonical side, then score the wrong-side fraction per instance. */
export class ChiralityModel {
  fit(instances, { symmetryPairs, midlineIndices = null, axisIndices = null }) {
    this.symmetryPairs = symmetryPairs;
    this.midlineIndices = midlineIndices;
    this.axisIndices = axisIndices;
    this.excludeSet = new Set();
    for (const [l, r] of symmetryPairs) { this.excludeSet.add(l); this.excludeSet.add(r); }

    const sideSums = new Map(), sideCounts = new Map();
    for (const [l, r] of symmetryPairs) { const k = `${l},${r}`; sideSums.set(k, 0); sideCounts.set(k, 0); }
    for (const points of instances) {
      const poly = resolveMidline(points, midlineIndices, axisIndices, this.excludeSet);
      if (!poly) continue;
      for (const [l, r] of symmetryPairs) {
        if (l >= points.length || r >= points.length || !isVisible(points[l]) || !isVisible(points[r])) continue;
        const side = signedSideLocal(points[l], points[r], poly);
        if (side == null || side === 0) continue; // on-axis = no info
        const k = `${l},${r}`;
        sideSums.set(k, sideSums.get(k) + side);
        sideCounts.set(k, sideCounts.get(k) + 1);
      }
    }
    this.canonicalSide = new Map();
    this.pairSupport = new Map();
    for (const [l, r] of symmetryPairs) {
      const k = `${l},${r}`;
      const c = sideCounts.get(k);
      if (c === 0) continue; // never co-visible/resolvable -> no learned side
      this.canonicalSide.set(k, sideSums.get(k) / c >= 0 ? 1 : -1); // ties -> +1
      this.pairSupport.set(k, c);
    }
    // How many pairs this SKELETON can ever contribute. A 9-node mouse (nose/head/neck/body_*/tail_base
    // + ear_l/ear_r) has exactly ONE, so a hard >=2 floor would make the whole check unreachable.
    this.nLearnedPairs = this.canonicalSide.size;
    return this;
  }

  /** -> { wrongFraction:[0,1], nPairs, wrongPairs:Set(pairKey) }. Never NaN.
   *
   *  `minPairs` defaults to min(2, pairs the skeleton has). Rationale: the floor exists to stop ONE noisy
   *  pair from flagging a whole instance, which is right when a multi-pair skeleton has pairs occluded --
   *  but a skeleton with only one symmetric pair would never be scored at all, silently disabling the
   *  check (exactly the 9-node mouse case: ear_l/ear_r swapped and nothing fired). Single-pair skeletons
   *  are now scored, with signedSideLocal's confidence gate taking over the noise-rejection job. */
  scoreInstance(points, minPairs = null) {
    const poly = resolveMidline(points, this.midlineIndices, this.axisIndices, this.excludeSet);
    if (!poly) return { wrongFraction: 0, nPairs: 0, wrongPairs: new Set() };
    let nPairs = 0, nWrong = 0;
    const wrongPairs = new Set();
    for (const [l, r] of this.symmetryPairs) {
      const k = `${l},${r}`;
      const canonical = this.canonicalSide.get(k);
      if (canonical == null) continue;
      if (l >= points.length || r >= points.length || !isVisible(points[l]) || !isVisible(points[r])) continue;
      const side = signedSideLocal(points[l], points[r], poly);
      if (side == null || side === 0) continue;
      nPairs++;
      if (side !== canonical) { nWrong++; wrongPairs.add(k); }
    }
    const floor = minPairs ?? Math.min(2, this.nLearnedPairs || 2);
    if (nPairs < floor) return { wrongFraction: 0, nPairs, wrongPairs: new Set() };
    return { wrongFraction: nWrong / nPairs, nPairs, wrongPairs };
  }
}

/** First L/R token split of a node name -> { key, side, isLeft } | null. left/right before l/r; suffix before prefix. */
function splitLrToken(name) {
  for (const [leftTok, rightTok] of LR_TOKENS) {
    for (const [tok, isLeft, side] of [[leftTok, true, "left"], [rightTok, false, "right"]]) {
      const suffix = name.match(new RegExp(`^(.+?)${SEP}${tok}$`, "i"));
      if (suffix && suffix[1]) return { key: `S:${suffix[1].toLowerCase()}`, side, isLeft };
      const prefix = name.match(new RegExp(`^${tok}${SEP}(.+)$`, "i"));
      if (prefix && prefix[1]) return { key: `P:${prefix[1].toLowerCase()}`, side, isLeft };
    }
  }
  return null;
}

/** Infer symmetric L/R index pairs from node names (Ear_L/Ear_R, left_eye/right_eye, ...). */
export function inferSymmetryPairsByName(nodeNames) {
  const groups = new Map(); // key -> { left?, right? }
  nodeNames.forEach((name, idx) => {
    const p = splitLrToken(name);
    if (!p) return;
    let bucket = groups.get(p.key);
    if (!bucket) { bucket = {}; groups.set(p.key, bucket); }
    if (bucket[p.side] === undefined) bucket[p.side] = idx; // first per side wins
  });
  const pairs = [];
  const used = new Set();
  for (const bucket of groups.values()) {
    if (bucket.left != null && bucket.right != null) {
      const l = bucket.left, r = bucket.right;
      if (used.has(l) || used.has(r) || l === r) continue;
      pairs.push([l, r]);
      used.add(l);
      used.add(r);
    }
  }
  pairs.sort((a, b) => a[0] - b[0]);
  return pairs;
}

/** Order midline node indices along the spine (either direction — fit and score share the polyline).
 *
 *  NOT by mean raw projection: a 2x2 covariance is invariant under a 180-degree rotation, and the
 *  eigenvector's sign is arbitrary, so the SAME body projects nose-first in one frame and tail-first in the
 *  next. Averaging those projections cancels toward zero and the order comes out SCRAMBLED (observed:
 *  tail_base, body_2, body_3, neck, body_1, nose, head) — which makes the "spine" polyline zigzag, so the
 *  nearest-segment tangent (and therefore every side sign) is meaningless on real, variably-posed data.
 *
 *  Instead: order WITHIN each instance, canonicalize that order by reversal (orient it so the
 *  lower-index endpoint comes first — the endpoints are geometrically determined, so this picks the same
 *  direction every frame), then pool RANKS. */
function orderMidlineByPca(instances, midlineIndices, minPoints = 2) {
  if (!midlineIndices || midlineIndices.length < 2) return midlineIndices;
  const empty = new Set();
  const rankSums = new Map(), rankCounts = new Map();
  for (const i of midlineIndices) { rankSums.set(i, 0); rankCounts.set(i, 0); }
  for (const points of instances) {
    const pca = pcaAxis(points, empty, minPoints);
    if (!pca) continue;
    const vis = midlineIndices.filter((i) => i >= 0 && i < points.length && isVisible(points[i]));
    if (vis.length < 2) continue;
    const proj = new Map(vis.map((i) => [i,
      (points[i][0] - pca.origin[0]) * pca.axis[0] + (points[i][1] - pca.origin[1]) * pca.axis[1]]));
    const order = [...vis].sort((a, b) => proj.get(a) - proj.get(b) || a - b);
    if (order[0] > order[order.length - 1]) order.reverse(); // canonicalize direction
    order.forEach((idx, r) => {
      rankSums.set(idx, rankSums.get(idx) + r / Math.max(order.length - 1, 1)); // normalized rank
      rankCounts.set(idx, rankCounts.get(idx) + 1);
    });
  }
  let any = false;
  for (const c of rankCounts.values()) if (c > 0) { any = true; break; }
  if (!any) return midlineIndices;
  const meanRank = (i) => (rankCounts.get(i) ? rankSums.get(i) / rankCounts.get(i) : 0);
  return midlineIndices
    .map((idx, orig) => ({ idx, orig, m: meanRank(idx) }))
    .sort((a, b) => a.m - b.m || a.orig - b.orig) // stable on ties
    .map((d) => d.idx);
}


/** Pick symmetry pairs + an ordered midline for the unit. Returns null when there's nothing to score. */
export function resolveChiralityInputs(analyzer, nodeNames, allPoses) {
  const pairs = analyzer?.symmetryPairs?.length ? analyzer.symmetryPairs : inferSymmetryPairsByName(nodeNames ?? []);
  if (!pairs || !pairs.length) return null;
  const excludeSet = new Set();
  for (const [l, r] of pairs) { excludeSet.add(l); excludeSet.add(r); }
  const nNodes = analyzer?.nNodes ?? (nodeNames?.length ?? 0);
  const midlineCandidates = [];
  for (let i = 0; i < nNodes; i++) if (!excludeSet.has(i)) midlineCandidates.push(i);
  const midlineIndices = midlineCandidates.length >= 2 ? orderMidlineByPca(allPoses, midlineCandidates) : null;
  return { symmetryPairs: pairs, midlineIndices, axisIndices: null };
}

/** Deterministic ring node from a set of wrong-pair keys: the smallest node index involved. */
export function firstWrongPairNode(wrongPairs) {
  let best = -1;
  for (const k of wrongPairs) {
    const [l, r] = k.split(",").map(Number);
    const m = Math.min(l, r);
    if (best < 0 || m < best) best = m;
  }
  return best;
}
