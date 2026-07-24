// Per-KEYPOINT crop geometry. The instance-level appearance check embeds one whole-animal crop, so a
// single mislocalized/occluded keypoint barely moves the vector. To catch per-keypoint errors we embed
// a small patch AROUND each node and compare it only to the SAME node type across the file ("nose vs
// noses"). These helpers are pure point-math (image-independent) so they can key the embedding cache;
// clamping to the actual image happens at draw time (same as squareBox in embeddingStore).

/** Scale of an instance = the max side of the bbox over its PLACED (non-NaN) nodes. Returns 0 when the
 *  instance has fewer than 2 placed nodes (no meaningful scale — the node patch would be arbitrary). */
export function instanceScale(points) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, n = 0;
  for (const p of points ?? []) {
    const xy = p?.xy;
    if (!xy || Number.isNaN(xy[0]) || Number.isNaN(xy[1])) continue;
    minX = Math.min(minX, xy[0]); minY = Math.min(minY, xy[1]);
    maxX = Math.max(maxX, xy[0]); maxY = Math.max(maxY, xy[1]); n++;
  }
  return n < 2 ? 0 : Math.max(maxX - minX, maxY - minY);
}

/** Square patch centered on node `ni`, sized RELATIVE to the instance's scale (so it's scale-invariant:
 *  a big animal and a small one get proportionally-sized keypoint patches). `frac` is the patch side as
 *  a fraction of the instance's bbox max-side; `minPx` floors it so tiny/degenerate instances still get
 *  a usable patch. Returns `{ x, y, side, node }` or null when node `ni` isn't placed or the instance
 *  has no scale. Box coords are rounded-stable via cropKey at the call site. */
export function nodePatchBox(points, ni, frac = 0.3, minPx = 24) {
  const xy = points?.[ni]?.xy;
  if (!xy || Number.isNaN(xy[0]) || Number.isNaN(xy[1])) return null;
  const scale = instanceScale(points);
  if (scale <= 0) return null; // need ≥2 placed nodes to define a scale
  const side = Math.max(minPx, scale * frac);
  return { x: xy[0] - side / 2, y: xy[1] - side / 2, side, node: ni };
}

/** Every visible node's patch box for one instance, as `[{ node, box }]` (skips unplaced nodes and,
 *  implicitly, whole instances with <2 placed nodes since every box would be null). */
export function nodePatchPlan(points, frac = 0.3, minPx = 24) {
  const out = [];
  const n = points?.length ?? 0;
  for (let ni = 0; ni < n; ni++) {
    const box = nodePatchBox(points, ni, frac, minPx);
    if (box) out.push({ node: ni, box });
  }
  return out;
}
