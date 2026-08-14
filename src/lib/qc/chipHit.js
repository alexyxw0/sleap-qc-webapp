// Hit-testing for the keypoint drag-select. Extracted because the tolerance is the whole feature:
// the chips are small and the gaps between them are real, so a drag along a row kept skipping one
// whenever the pointer passed through a gap or drifted a few pixels above the row.
//
// The rule is "nearest chip within SLOP", not "the chip under the pointer". Zero distance means
// inside, so a clean pass behaves exactly as it did before — the tolerance only rescues near-misses.

/** Distance from a point to a rect: 0 inside, otherwise the shortest gap to its edge. */
export const distToRect = (r, x, y) =>
  Math.hypot(Math.max(r.left - x, 0, x - r.right), Math.max(r.top - y, 0, y - r.bottom));

/**
 * Index of the nearest chip within `slop` px of (x, y), or -1.
 *
 * `rects` is [{ left, right, top, bottom }] in chip order. Ties resolve to the LOWER index (strict
 * <) so a point exactly between two chips in a gap picks deterministically rather than depending on
 * DOM order.
 */
export function nearestChip(rects, x, y, slop = 12) {
  // Acceptance (<= slop) is separate from the tie-break (strict <, so the lower index wins). Folding
  // them together by seeding bestD with slop meant a distance EQUAL to the slop never matched — and
  // with slop 0 that excluded distance 0, i.e. a point inside a chip.
  let best = -1, bestD = Infinity;
  for (let i = 0; i < rects.length; i++) {
    const d = distToRect(rects[i], x, y);
    if (d <= slop && d < bestD) { bestD = d; best = i; }
  }
  return best;
}

/**
 * The selection a drag from `anchor` to `cur` produces, given what was selected BEFORE it started.
 *
 * A drag is a RANGE, not a trail of paint. Painting could only ever add to what it had touched, so
 * sweeping forward and back in one motion left everything selected — the reverse stroke did nothing,
 * because those chips were already in the painted state. Deriving the whole selection from (anchor,
 * cur) instead means the range shrinks as the pointer comes back and every chip it leaves behind
 * returns to `baseline`, which is what "swipe back to undo it" means.
 *
 * `baseline` is a Set of selected indices; the result is a new Set. `on` is the direction the anchor
 * decided: true selects the range, false deselects it.
 */
export function rangeSelection(baseline, anchor, cur, on) {
  const next = new Set(baseline);
  if (anchor < 0 || cur < 0) return next;
  const lo = Math.min(anchor, cur), hi = Math.max(anchor, cur);
  for (let i = lo; i <= hi; i++) {
    if (on) next.add(i);
    else next.delete(i);
  }
  return next;
}
