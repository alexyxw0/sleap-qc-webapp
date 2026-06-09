// Worst-first review queue (TDD stub — see queue.test.js).

const NOT_IMPL = () => {
  throw new Error("not implemented");
};

/**
 * Return a copy of `keypoints` ordered worst-first by `sortBy` (default "p_error"),
 * descending, with a deterministic tie-break on keypointKey so ordering is stable.
 */
export function buildQueue(_keypoints, _opts) {
  return NOT_IMPL();
}

/**
 * Worst-first queue of keypoints not yet decided. `stateOf` maps a keypointKey to a
 * review state; "unreviewed" comes before "skipped"; accepted/rejected/corrected drop out.
 */
export function pendingQueue(_keypoints, _stateOf, _opts) {
  return NOT_IMPL();
}

/** The next keypoint to review (highest priority pending), or null if none remain. */
export function nextPending(_keypoints, _stateOf, _opts) {
  return NOT_IMPL();
}
