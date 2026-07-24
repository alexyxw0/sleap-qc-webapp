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
