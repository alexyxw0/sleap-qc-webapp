// Image-space boxes for zoom-to-focus. Feed the result to view.requestFocus(box) — the Viewer frames
// it (adds a margin, clamps zoom). Pure so it's testable and reusable across the sidebar panels.

/** Bounding box `{x,y,w,h}` over an instance's PLACED (non-NaN) points, or null if none placed. */
export function instancePointsBox(points) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, n = 0;
  for (const p of points ?? []) {
    const xy = p?.xy;
    if (!xy || Number.isNaN(xy[0]) || Number.isNaN(xy[1])) continue;
    minX = Math.min(minX, xy[0]); minY = Math.min(minY, xy[1]);
    maxX = Math.max(maxX, xy[0]); maxY = Math.max(maxY, xy[1]); n++;
  }
  return n ? { x: minX, y: minY, w: maxX - minX, h: maxY - minY } : null;
}

/** Zero-size point box at one node (the Viewer adds a margin + zooms in), or null if unplaced. */
export function nodePointBox(points, ni) {
  const xy = points?.[ni]?.xy;
  if (!xy || Number.isNaN(xy[0]) || Number.isNaN(xy[1])) return null;
  return { x: xy[0], y: xy[1], w: 0, h: 0 };
}

/**
 * The box the QC-review popup should frame: the instance(s) the flag is ABOUT.
 *
 * `instIdx` is the blamed instance. `partners` are instances the flag cannot be judged without —
 * the other half of a duplicate pair, say: showing one of two overlapping animals is showing half
 * the evidence. Pass `instIdx < 0` (nothing blamed — a wrong instance COUNT, a negative frame) and
 * you get every instance, because then the frame itself is the subject.
 *
 * `minSide` is a floor on the returned box's larger side. Without it a two-node instance three
 * pixels across frames to three pixels, and the reviewer gets a wall of interpolated grey with no
 * way to tell what they are looking at. Expanding the box (rather than capping the zoom) keeps the
 * subject CENTRED while it gains context.
 */
export function reviewFocusBox(instances, instIdx, partners = [], minSide = 0) {
  const want = instIdx < 0
    ? (instances ?? []).map((_, i) => i)
    : [instIdx, ...partners.filter((p) => p !== instIdx)];
  let box = null;
  for (const i of want) {
    const b = instancePointsBox(instances?.[i]?.points);
    if (!b) continue;
    box = box ? {
      x: Math.min(box.x, b.x), y: Math.min(box.y, b.y),
      w: Math.max(box.x + box.w, b.x + b.w) - Math.min(box.x, b.x),
      h: Math.max(box.y + box.h, b.y + b.h) - Math.min(box.y, b.y),
    } : b;
  }
  if (!box) return null;
  // Per AXIS, not on the larger side: an instance lying flat is 200 px wide and 2 px tall, and
  // gating on max(w,h) leaves the short axis at 2 — a box that frames to a sliver.
  if (minSide > 0) {
    if (box.w < minSide) box = { ...box, x: box.x - (minSide - box.w) / 2, w: minSide };
    if (box.h < minSide) box = { ...box, y: box.y - (minSide - box.h) / 2, h: minSide };
  }
  return box;
}

/** Instances a flag cannot be judged without, given the frame's QC record. Duplicate pairs are the
 *  cross-instance case: the flag is about the PAIR, so framing one of them hides the comparison. */
export function flagPartners(fq, instIdx) {
  const out = [];
  for (const [a, b] of fq?.duplicatePairs ?? []) {
    if (a === instIdx) out.push(b);
    else if (b === instIdx) out.push(a);
  }
  return out;
}
