// Out-of-frame keypoints — a VISIBLE keypoint whose coordinate falls outside the image rectangle.
// A hard rule: no threshold, no baseline, no learning. A labelled point at x = -40 or y = height + 12
// cannot be correct, so the frame is flagged outright.
//
// IMPORTANT — this is NOT the same as a NaN coordinate. In SLEAP, NaN means the node was never
// annotated / is not visible, which is completely normal (a partly occluded animal has several). Treating
// NaN as "out of frame" would flag most frames in a typical file; that condition is already covered by the
// **Sparse instance** check (too few visible nodes) and by the `visibility_rate` feature in the anomaly
// vector. So only points with real, finite coordinates are tested here.
//
// `margin` (px) tolerates annotation that sits a hair past the edge; 0 = strictly outside the rectangle.
// Bounds come from the video's `shape` = [nFrames, height, width, channels] (same convention as draw.js).

/** Node indices of VISIBLE keypoints lying outside [−margin, w+margin] × [−margin, h+margin]. */
export function outOfFrameNodes(pose, w, h, margin = 0) {
  const out = [];
  if (!pose || !(w > 0) || !(h > 0)) return out; // no usable bounds -> cannot judge, report nothing
  for (let i = 0; i < pose.length; i++) {
    const p = pose[i];
    if (!p) continue;
    const x = p[0], y = p[1];
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue; // NaN = unlabelled, not out-of-frame
    if (x < -margin || y < -margin || x > w + margin || y > h + margin) out.push(i);
  }
  return out;
}

/**
 * Frame-level verdict over every instance.
 * -> { isOutOfFrame, nOutOfFrame, outOfFrameInstance, outOfFrameNode, byInstance }
 *    `outOfFrameInstance` / `outOfFrameNode` point at the FIRST offender (deterministic: lowest instance,
 *    then lowest node) so the UI can ring it; `byInstance` keeps the full per-instance lists.
 */
export function checkFrameBounds(poses, w, h, margin = 0) {
  const byInstance = [];
  let n = 0, firstInst = -1, firstNode = -1;
  (poses ?? []).forEach((pose, i) => {
    const nodes = outOfFrameNodes(pose, w, h, margin);
    byInstance.push(nodes);
    n += nodes.length;
    if (nodes.length && firstInst < 0) { firstInst = i; firstNode = nodes[0]; }
  });
  return {
    isOutOfFrame: n > 0,
    nOutOfFrame: n,
    outOfFrameInstance: firstInst,
    outOfFrameNode: firstNode,
    byInstance,
  };
}

/** Image bounds from a video record, or null when the file has no shape (poses-only load). */
export function videoBounds(video) {
  const s = video?.shape; // [nFrames, height, width, channels]
  const h = Array.isArray(s) ? s[1] : undefined;
  const w = Array.isArray(s) ? s[2] : undefined;
  return w > 0 && h > 0 ? { w, h } : null;
}
