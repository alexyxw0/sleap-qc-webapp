// Apply reviewer corrections back onto the sleap-io.js model, keyed by track (TDD stub —
// see corrections.test.js). track_id, NOT positional instance_idx (QC Context §8).

const NOT_IMPL = () => {
  throw new Error("not implemented");
};

/** Find the instance in (video_idx, frame_idx) whose track matches track_id, or null. */
export function findInstance(_labels, _ref) {
  return NOT_IMPL();
}

/**
 * Set node_idx of the matched instance to xy (marking it visible). Returns true on
 * success, false if the target instance/node wasn't found.
 */
export function applyCorrection(_labels, _correction) {
  return NOT_IMPL();
}
