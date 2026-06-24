// Port of sleap/qc/frame_level.py — frame-level checks: instance count, negative frame,
// duplicate detection (bbox IoU + node-wise overlap). Pure geometry, no model.

import { isVisible, dist } from "./util.js";

function median(xs) {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * Detect frames whose instance count differs from the per-video (or global) typical count.
 *
 * Differs from the upstream sleap/qc checker in two ways, because that one missed real cases:
 *  - the expected count is the median of NON-EMPTY frames — empty/background frames (count 0) are
 *    not evidence of how many animals a frame should have, and including them dragged the median
 *    down so genuinely-incomplete frames were never flagged.
 *  - both directions are reported: `isIncomplete` (too few / missing) AND `isOvercount` (too many
 *    / a spurious extra instance), since an extra instance is just as wrong as a missing one and
 *    the upstream "< expected" silently ignored it. The expected is rounded for the comparison
 *    (a frame has a whole number of instances).
 */
export class InstanceCountChecker {
  constructor(perVideo = true) {
    this.perVideo = perVideo;
    this.expectedCounts = new Map();
    this.globalExpected = 0;
  }
  fit(frameCounts, videoIds = null) {
    const nonEmpty = (xs) => xs.filter((c) => c > 0);
    const ne = nonEmpty(frameCounts);
    this.globalExpected = median(ne.length ? ne : frameCounts);
    if (this.perVideo && videoIds) {
      const byVid = new Map();
      frameCounts.forEach((c, i) => {
        if (c <= 0) return; // empties don't define the expected animal count
        const v = videoIds[i];
        if (!byVid.has(v)) byVid.set(v, []);
        byVid.get(v).push(c);
      });
      for (const [v, counts] of byVid) this.expectedCounts.set(v, median(counts));
    }
    return this;
  }
  check(instanceCount, videoId = null) {
    const expectedRaw =
      this.perVideo && videoId != null && this.expectedCounts.has(videoId)
        ? this.expectedCounts.get(videoId)
        : this.globalExpected;
    const expected = Math.round(expectedRaw);
    return {
      isIncomplete: instanceCount < expected, // missing instance(s)
      isOvercount: instanceCount > expected, // extra / spurious instance(s)
      isWrongCount: instanceCount !== expected,
      expectedCount: expectedRaw,
      actualCount: instanceCount,
      countDifference: instanceCount - expected,
    };
  }
}

/** A negative (background) frame that still carries instances is inconsistent. */
export const checkNegativeFrame = (isNegative, instanceCount) =>
  Boolean(isNegative) && instanceCount > 0;

/** IoU of the axis-aligned bounding boxes of two instances' visible points. */
export function computeInstanceIou(poseA, poseB) {
  const va = poseA.filter(isVisible);
  const vb = poseB.filter(isVisible);
  if (va.length < 2 || vb.length < 2) return 0;
  const box = (v) => [
    Math.min(...v.map((p) => p[0])), Math.min(...v.map((p) => p[1])),
    Math.max(...v.map((p) => p[0])), Math.max(...v.map((p) => p[1])),
  ];
  const [aminx, aminy, amaxx, amaxy] = box(va);
  const [bminx, bminy, bmaxx, bmaxy] = box(vb);
  const iw = Math.max(0, Math.min(amaxx, bmaxx) - Math.max(aminx, bminx));
  const ih = Math.max(0, Math.min(amaxy, bmaxy) - Math.max(aminy, bminy));
  const inter = iw * ih;
  const areaA = (amaxx - aminx) * (amaxy - aminy);
  const areaB = (bmaxx - bminx) * (bmaxy - bminy);
  const union = areaA + areaB - inter;
  return union > 0 ? inter / union : 0;
}

/** Node-wise overlap at commonly-visible nodes (for partial-duplicate detection). */
function computeNodeOverlap(poseA, poseB, distanceThreshold = 10.0) {
  const common = [];
  for (let i = 0; i < poseA.length; i++) {
    if (isVisible(poseA[i]) && isVisible(poseB[i])) common.push(i);
  }
  if (common.length === 0) {
    return { commonNodes: [], overlappingNodes: [], meanDistance: Infinity,
      minDistance: Infinity, maxDistance: Infinity, overlapRatio: 0 };
  }
  const distances = [];
  const overlapping = [];
  for (const node of common) {
    const d = dist(poseA[node], poseB[node]);
    distances.push(d);
    if (d < distanceThreshold) overlapping.push(node);
  }
  return {
    commonNodes: common,
    overlappingNodes: overlapping,
    meanDistance: distances.reduce((s, d) => s + d, 0) / distances.length,
    minDistance: Math.min(...distances),
    maxDistance: Math.max(...distances),
    overlapRatio: overlapping.length / common.length,
  };
}

/** Detect duplicate instance pairs by IoU first, then node-overlap (partial dupes). */
export function detectDuplicates(
  instances,
  { iouThreshold = 0.5, nodeDistanceThreshold = 10.0, nodeOverlapRatio = 0.8 } = {},
) {
  const dupes = [];
  for (let i = 0; i < instances.length; i++) {
    for (let j = i + 1; j < instances.length; j++) {
      const iou = computeInstanceIou(instances[i], instances[j]);
      const overlap = computeNodeOverlap(instances[i], instances[j], nodeDistanceThreshold);
      let reason = null;
      if (iou > iouThreshold) reason = "iou";
      else if (overlap.commonNodes.length >= 2 && overlap.overlapRatio > nodeOverlapRatio)
        reason = "node_overlap";
      if (reason) dupes.push({ indexA: i, indexB: j, iou, nodeOverlap: overlap, reason });
    }
  }
  return dupes;
}
