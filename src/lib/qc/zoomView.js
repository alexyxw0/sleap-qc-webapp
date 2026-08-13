// Pan/zoom arithmetic for a canvas that shows a fitted region of a larger image.
//
// Pure, because this is the part that goes wrong silently. A zoom that drifts by a few pixels per
// notch looks fine in a screenshot and is maddening to use, and nothing throws — so the invariant
// ("the image point under the pointer does not move") has to be asserted, not eyeballed.
//
// The model: a BASE centre from the auto-fit, plus a user pan in image space, clamped so the picture
// cannot be dragged off the window.

/** Scale at which `view` (image px) exactly fits inside `box` (CSS px). */
export const fitScale = (box, view) => Math.min(box.w / view.w, box.h / view.h);

/**
 * Centre the view can actually show, given the scale: pinned to the middle on any axis where the
 * window is wider than the picture, otherwise held far enough in that no edge pulls away.
 */
export function clampCenter(c, half, extent) {
  if (half * 2 >= extent) return extent / 2;
  return Math.max(half, Math.min(extent - half, c));
}

/**
 * The user pan that holds one image point still while the scale changes.
 *
 * `c` is the currently displayed centre (already clamped), `base` the fitted centre the pan is
 * measured from, `m` the pointer's offset from the canvas centre in CSS px, `s`/`ns` the old and new
 * scales. Derived from the CLAMPED centre rather than accumulated onto the previous pan: at the edge
 * of an image the clamp has already moved the centre away from `base + pan`, and adding to a stale
 * pan there is exactly how a zoom drifts.
 *
 *   point under pointer  p = c + m/s
 *   hold it:             c' = p − m/ns
 *   pan is relative:     pan' = c' − base = (c − base) + m·(1/s − 1/ns)
 */
export const panForZoom = (c, base, m, s, ns) => (c - base) + m * (1 / s - 1 / ns);

/** Clamp a zoom multiplier to [1, max] — 1 is the fit, below it would letterbox for no reason. */
export const clampZoom = (z, max) => Math.max(1, Math.min(max, z));
